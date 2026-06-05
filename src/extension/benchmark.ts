/**
 * Shared, auth-agnostic benchmark core for the pre-review AI pass.
 *
 * Both the standalone script (`scripts/bench.ts`) and the in-pi command
 * (`/story-review-bench`) call into this module. Callers are responsible for
 * resolving models + auth (the script via a standalone `ModelRegistry`, the pi
 * command via `ctx.modelRegistry`); this module only takes already-resolved
 * targets, runs the model, computes metrics, and scores each run.
 *
 * It reuses the EXACT system prompt and user-message construction the product
 * uses (imported from `pre-review.ts`), so results reflect real behavior.
 */
import { completeSimple, type Model } from '@earendil-works/pi-ai';
import type { ReviewHunk, ReviewThinkingLevel } from '../lib/shared/review.ts';
import { parseReviewHunks, summarizePatchFiles } from './diff.ts';
import {
	REVIEW_PROMPT,
	buildReviewUserMessage,
	extractJson,
	parsePreReview,
	type HunkRef
} from './pre-review.ts';

// ===========================================================================
// CONFIG: tunable scoring weights and thresholds.
//
// `quality` (0-100) is a weighted sum of five sub-metrics; the weights MUST sum
// to 1. Each sub-metric is documented at its computation site in `scoreRun`.
// ===========================================================================
export interface ScoreWeights {
	/** Fraction of canonical hunks assigned to exactly one patch (clean partition coverage). */
	hunkCoverage: number;
	/** How completely causalityOrder covers the changeset (unique resolved ids / total hunks). */
	causalityCompleteness: number;
	/** 1 − (over-assigned hunks / total): penalises hunks placed in more than one patch. */
	partitionSoundness: number;
	/** Fraction of partition chunks carrying a non-empty "why this exists" cue. */
	cueCoverage: number;
	/** Whether the model surfaced a useful number of review comments (capped). */
	commentsSignal: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
	hunkCoverage: 0.45,
	causalityCompleteness: 0.2,
	partitionSoundness: 0.15,
	cueCoverage: 0.1,
	commentsSignal: 0.1
};

/** commentsSignal saturates once a run produces this many comments. */
export const EXPECTED_COMMENTS = 3;

/** Floor on cost when computing efficiency, so a $0 (uncosted) run is not infinite. */
const COST_EPSILON = 1e-6;

export interface BenchConfig {
	weights?: ScoreWeights;
	expectedComments?: number;
	/** Changeset title shown to the model (defaults to a generic label). */
	title?: string;
	/** Base description shown to the model (defaults to "working tree (git diff HEAD)"). */
	baseDescription?: string;
	/** Repository root passed to the model message (defaults to process.cwd()). */
	cwd?: string;
	/** Whether to request review comments (defaults to true). */
	suggestComments?: boolean;
}

/** A fully-resolved benchmark target: model + auth + thinking level. Auth resolution lives in callers. */
export interface ResolvedTarget {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	thinkingLevel: ReviewThinkingLevel;
}

/** Raw, scoring-relevant measurements for a single run. */
export interface BenchMetrics {
	jsonValid: boolean;
	/** fraction of canonical hunks assigned to exactly one patch */
	hunkCoverage: number;
	/** unique resolved causalityOrder ids */
	causalityResolved: number;
	/** canonical hunks placed in more than one patch */
	overAssignedHunks: number;
	/** total canonical hunks in the changeset */
	totalHunks: number;
	/** partition chunks (file groups within patches) emitted */
	chunkCount: number;
	/** partition chunks carrying a non-empty cue */
	chunksWithCue: number;
	counts: { patches: number; cues: number; comments: number; causalityOrder: number };
	latencyMs: number;
	tokens: { input: number; output: number; total: number };
	costUsd: number;
}

export interface BenchScore {
	/** 0-100, weighted sum of sub-metrics; 0 when JSON is invalid (hard gate). */
	quality: number;
	/** quality per dollar = quality / max(costUsd, ε). */
	efficiency: number;
	costUsd: number;
	latencyMs: number;
	totalTokens: number;
	/** Per-sub-metric breakdown (each 0-1) for transparency / debugging. */
	breakdown: {
		hunkCoverage: number;
		causalityCompleteness: number;
		partitionSoundness: number;
		cueCoverage: number;
		commentsSignal: number;
	};
}

export interface BenchResult {
	modelKey: string;
	provider: string;
	modelId: string;
	thinkingLevel: ReviewThinkingLevel;
	ok: boolean;
	error?: string;
	metrics: BenchMetrics;
	score: BenchScore;
	rawOutput: string;
}

const emptyMetrics = (): BenchMetrics => ({
	jsonValid: false,
	hunkCoverage: 0,
	causalityResolved: 0,
	overAssignedHunks: 0,
	totalHunks: 0,
	chunkCount: 0,
	chunksWithCue: 0,
	counts: { patches: 0, cues: 0, comments: 0, causalityOrder: 0 },
	latencyMs: 0,
	tokens: { input: 0, output: 0, total: 0 },
	costUsd: 0
});

/**
 * Deterministic per-run score.
 *
 * Hard gate: invalid JSON is unusable by the product → quality 0.
 * Otherwise quality (0-100) = 100 × Σ weightᵢ · sub-metricᵢ, where each
 * sub-metric is normalised to 0-1:
 *   - hunkCoverage:          fraction of canonical hunks in exactly one patch.
 *   - causalityCompleteness: min(1, unique-resolved causalityOrder ids / total hunks).
 *   - partitionSoundness:    1 − (hunks assigned to >1 patch / total).
 *   - cueCoverage:           chunks with a non-empty cue / total chunks.
 *   - commentsSignal:        min(commentCount, EXPECTED_COMMENTS) / EXPECTED_COMMENTS.
 *
 * efficiency = quality / max(costUsd, ε) (quality per dollar).
 */
export function scoreRun(
	metrics: BenchMetrics,
	weights: ScoreWeights = DEFAULT_WEIGHTS,
	expectedComments: number = EXPECTED_COMMENTS
): BenchScore {
	const total = Math.max(metrics.totalHunks, 0);

	const hunkCoverage = clamp01(metrics.hunkCoverage);
	const causalityCompleteness = total === 0 ? 1 : clamp01(metrics.causalityResolved / total);
	const partitionSoundness = total === 0 ? 1 : clamp01(1 - metrics.overAssignedHunks / total);
	const cueCoverage = metrics.chunkCount === 0 ? 0 : clamp01(metrics.chunksWithCue / metrics.chunkCount);
	const commentsSignal = clamp01(Math.min(metrics.counts.comments, expectedComments) / expectedComments);

	const breakdown = { hunkCoverage, causalityCompleteness, partitionSoundness, cueCoverage, commentsSignal };

	const weighted =
		weights.hunkCoverage * hunkCoverage +
		weights.causalityCompleteness * causalityCompleteness +
		weights.partitionSoundness * partitionSoundness +
		weights.cueCoverage * cueCoverage +
		weights.commentsSignal * commentsSignal;

	// Hard gate: invalid JSON is unusable downstream.
	const quality = metrics.jsonValid ? 100 * weighted : 0;
	const efficiency = quality / Math.max(metrics.costUsd, COST_EPSILON);

	return {
		quality,
		efficiency,
		costUsd: metrics.costUsd,
		latencyMs: metrics.latencyMs,
		totalTokens: metrics.tokens.total,
		breakdown
	};
}

/**
 * Computes scoring-relevant metrics from a parsed model output, resolving the
 * model's `{file, oldStart, newStart}` refs to canonical hunk ids exactly as
 * pre-review does.
 */
export function computeMetrics(rawOutput: string, canonicalHunks: ReviewHunk[], latencyMs: number, tokens: BenchMetrics['tokens'], costUsd: number): BenchMetrics {
	const metrics = emptyMetrics();
	metrics.latencyMs = latencyMs;
	metrics.tokens = tokens;
	metrics.costUsd = costUsd;
	metrics.totalHunks = canonicalHunks.length;

	try {
		JSON.parse(extractJson(rawOutput)); // jsonValid mirrors pre-review's parse path
		metrics.jsonValid = true;
	} catch {
		metrics.jsonValid = false;
		return metrics;
	}

	const parsed = parsePreReview(rawOutput);
	metrics.counts = {
		patches: parsed.patches.length,
		cues: parsed.cues.length,
		comments: parsed.comments.length,
		causalityOrder: parsed.causalityOrder.length
	};

	const resolveHunkId = (ref: HunkRef): string | undefined =>
		canonicalHunks.find((h) => h.file === ref.file && h.oldStart === ref.oldStart && h.newStart === ref.newStart)?.id;

	// --- hunk → patch assignment counts (dedupe within a patch) ---
	const assignmentCount = new Map<string, number>();
	for (const patch of parsed.patches) {
		const seenInPatch = new Set<string>();
		for (const ref of patch.hunks) {
			const id = resolveHunkId(ref);
			if (!id || seenInPatch.has(id)) continue;
			seenInPatch.add(id);
			assignmentCount.set(id, (assignmentCount.get(id) ?? 0) + 1);
		}
	}

	if (canonicalHunks.length > 0) {
		const exactlyOne = canonicalHunks.filter((h) => assignmentCount.get(h.id) === 1).length;
		metrics.hunkCoverage = exactlyOne / canonicalHunks.length;
		metrics.overAssignedHunks = canonicalHunks.filter((h) => (assignmentCount.get(h.id) ?? 0) > 1).length;
	} else {
		metrics.hunkCoverage = 1;
	}

	// --- causalityOrder: unique resolved ids ---
	const resolvedCausality = new Set<string>();
	for (const ref of parsed.causalityOrder) {
		const id = resolveHunkId(ref);
		if (id) resolvedCausality.add(id);
	}
	metrics.causalityResolved = resolvedCausality.size;

	// --- chunks (file groups within patches) + cue coverage ---
	// Mirror pre-review's smart partition: one chunk per (patch, file) with resolved hunks.
	let chunkCount = 0;
	let chunksWithCue = 0;
	for (const patch of parsed.patches) {
		const byFile = new Map<string, string[]>();
		for (const ref of patch.hunks) {
			const id = resolveHunkId(ref);
			if (!id) continue;
			const existing = byFile.get(ref.file);
			if (existing) {
				if (!existing.includes(id)) existing.push(id);
			} else {
				byFile.set(ref.file, [id]);
			}
		}
		for (const [file, hunkIds] of byFile) {
			chunkCount += 1;
			const cue = parsed.cues.find(
				(candidate) => candidate.file === file && candidate.hunks.some((ref) => hunkIds.includes(resolveHunkId(ref) ?? ''))
			)?.text;
			if (cue && cue.trim()) chunksWithCue += 1;
		}
	}
	metrics.chunkCount = chunkCount;
	metrics.chunksWithCue = chunksWithCue;

	return metrics;
}

/**
 * Runs each resolved target against the changeset and scores it.
 * Pure of auth/registry concerns: targets already carry apiKey + headers.
 */
export async function runBenchmark(input: { patch: string; targets: ResolvedTarget[]; config?: BenchConfig }): Promise<BenchResult[]> {
	const config = input.config ?? {};
	const weights = config.weights ?? DEFAULT_WEIGHTS;
	const expectedComments = config.expectedComments ?? EXPECTED_COMMENTS;

	const files = summarizePatchFiles(input.patch);
	const canonicalHunks = parseReviewHunks(input.patch);

	const userMessage = buildReviewUserMessage({
		title: config.title ?? 'Benchmark changeset',
		baseDescription: config.baseDescription ?? 'working tree (git diff HEAD)',
		cwd: config.cwd ?? process.cwd(),
		files,
		patch: input.patch,
		suggestComments: config.suggestComments ?? true
	});

	const results: BenchResult[] = [];
	for (const target of input.targets) {
		const { model, thinkingLevel } = target;
		const modelKey = `${model.provider}/${model.id}`;

		const result: BenchResult = {
			modelKey,
			provider: model.provider,
			modelId: model.id,
			thinkingLevel,
			ok: false,
			metrics: emptyMetrics(),
			score: scoreRun(emptyMetrics(), weights, expectedComments),
			rawOutput: ''
		};
		result.metrics.totalHunks = canonicalHunks.length;

		try {
			const start = Date.now();
			const response = await completeSimple(
				model,
				{ systemPrompt: REVIEW_PROMPT, messages: [userMessage] },
				{
					apiKey: target.apiKey,
					headers: target.headers,
					reasoning: thinkingLevel === 'off' ? undefined : thinkingLevel
				}
			);
			const latencyMs = Date.now() - start;

			const text = response.content
				.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
				.map((part) => part.text)
				.join('\n');
			result.rawOutput = text;

			const usage = response.usage;
			const tokens = usage ? { input: usage.input, output: usage.output, total: usage.totalTokens } : { input: 0, output: 0, total: 0 };
			const costUsd = usage?.cost?.total ?? 0;

			result.metrics = computeMetrics(text, canonicalHunks, latencyMs, tokens, costUsd);
			result.score = scoreRun(result.metrics, weights, expectedComments);
			result.ok = true;
		} catch (error) {
			result.error = error instanceof Error ? error.message : String(error);
		}

		results.push(result);
	}

	return results;
}

/** Ranks results by quality desc, tiebreaking by cost asc. Failed runs sink to the bottom. */
export function rankResults(results: BenchResult[]): BenchResult[] {
	return [...results].sort((a, b) => {
		if (a.ok !== b.ok) return a.ok ? -1 : 1;
		if (b.score.quality !== a.score.quality) return b.score.quality - a.score.quality;
		return a.score.costUsd - b.score.costUsd;
	});
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return value < 0 ? 0 : value > 1 ? 1 : value;
}
