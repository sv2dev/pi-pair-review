import { completeSimple, type Model, type UserMessage } from '@earendil-works/pi-ai';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type {
	ReviewChunk,
	ReviewFinding,
	ReviewHunk,
	ReviewPart,
	ReviewSeverity,
	ReviewSide,
	ReviewSmartPartition,
	ReviewThinkingLevel
} from '../lib/shared/review.ts';
import { getReviewSession, markPreReviewDone, markPreReviewFailed, markPreReviewRunning } from './store.ts';
import { parseReviewHunks, trimPatchForModel } from './diff.ts';

export const REVIEW_PROMPT = `You are the first-pass reviewer for a paired code review session.
Return strict JSON only. No markdown, no prose outside the JSON.

JSON shape:
{
  "overview": "2-4 sentence description of what the whole change does",
  "assessment": "2-4 sentence readout of what the review flagged (risks/concerns); empty string if nothing notable",
  "patches": [
    { "title": "imperative, commit-like", "brief": "what changed in this patch and why", "hunks": [ {"file": "path", "oldStart": 10, "newStart": 12} ] }
  ],
  "causalityOrder": [ {"file": "path", "oldStart": 10, "newStart": 12} ],
  "cues": [ { "file": "path", "hunks": [{"file": "path", "oldStart": 10, "newStart": 12}], "text": "why this chunk exists, connected to earlier changes (e.g. 'Because the signature changed above, this call site is updated to match')" } ],
  "comments": [ {"severity": "critical|high|medium|low", "title": "...", "file": "path", "line": 123, "side": "additions|deletions", "rationale": "...", "recommendation": "..."} ]
}

Rules:
- Use the supplied hunk list to reference hunks. Each reference is {file, oldStart, newStart} taken verbatim from that list.
- Every changed hunk must appear in exactly one patch.
- "patches" are ordered as a story that builds understanding: foundational/definitional patches first, then the patches that build on them. The story arc reflects impact.
- "causalityOrder" lists hunks in the order a reader should review them to understand causality: definitions before usages.
- A "cue" is a SHORT note answering "why does this chunk exist". Emit ONE cue for EVERY chunk — that is, for each file's hunks within each patch, covering every changed file in every patch (do not leave chunks without a cue). Phrase cues causally, following "causalityOrder": when a chunk depends on an earlier change, reference it ("Because we changed X above, we now change Y here"); for a foundational chunk with no predecessor, state what it establishes that later chunks build on.
- "comments" are concrete review concerns (no more than 20). Use an empty array if there are none. Include only issues or high-risk areas visible from the diff.`;

export interface HunkRef {
	file: string;
	oldStart: number;
	newStart: number;
}

/** Inputs needed to construct the pre-review user message. Mirrors the relevant ReviewSession fields. */
export interface ReviewMessageInput {
	title: string;
	baseDescription: string;
	cwd: string;
	files: { path: string; additions: number; deletions: number; changeType: string }[];
	patch: string;
	suggestComments?: boolean;
}

/**
 * Builds the exact user message sent to the model during the pre-review pass.
 * Shared by {@link runPreReview} and the model benchmark so both exercise identical input.
 */
export function buildReviewUserMessage(input: ReviewMessageInput): UserMessage {
	const hunks = parseReviewHunks(input.patch);
	const suggestComments = input.suggestComments ?? true;
	return {
		role: 'user',
		timestamp: Date.now(),
		content: [
			{
				type: 'text',
				text: `Review target: ${input.title}\nBase: ${input.baseDescription}\nRepository: ${input.cwd}\nSuggest comments: ${suggestComments ? 'yes' : 'no; return an empty comments array'}\n\nChanged files:\n${input.files
					.map((file) => `- ${file.path} (+${file.additions}/-${file.deletions}, ${file.changeType})`)
					.join('\n')}\n\nChanged hunks (reference these as {file, oldStart, newStart}):\n${hunks
					.map((hunk) => `- ${hunk.file} -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines}`)
					.join('\n')}\n\nDiff:\n${trimPatchForModel(input.patch)}`
			}
		]
	};
}

interface ParsedPatch {
	title: string;
	brief?: string;
	hunks: HunkRef[];
}

interface ParsedCue {
	file: string;
	hunks: HunkRef[];
	text: string;
}

export interface ParsedPreReview {
	overview?: string;
	assessment?: string;
	patches: ParsedPatch[];
	causalityOrder: HunkRef[];
	cues: ParsedCue[];
	comments: Omit<ReviewFinding, 'id' | 'source'>[];
}

export async function runPreReview(
	sessionId: string,
	ctx: ExtensionCommandContext,
	model: Model<any> | undefined = ctx.model,
	thinkingLevel: ReviewThinkingLevel = 'off',
	suggestComments = true
): Promise<void> {
	const session = getReviewSession(sessionId);
	if (!session) return;

	if (!model) {
		markPreReviewFailed(sessionId, 'No model selected; AI review is unavailable.');
		return;
	}

	markPreReviewRunning(sessionId, `${model.provider}/${model.id}${thinkingLevel !== 'off' ? `:${thinkingLevel}` : ''}`);

	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			markPreReviewFailed(sessionId, auth.ok ? `No API key available for ${model.provider}.` : auth.error);
			return;
		}

		const hunks = parseReviewHunks(session.patch);
		const userMessage = buildReviewUserMessage({
			title: session.title,
			baseDescription: session.baseDescription,
			cwd: session.cwd,
			files: session.files,
			patch: session.patch,
			suggestComments
		});

		const response = await completeSimple(
			model,
			{ systemPrompt: REVIEW_PROMPT, messages: [userMessage] },
			{ apiKey: auth.apiKey, headers: auth.headers, reasoning: thinkingLevel === 'off' ? undefined : thinkingLevel }
		);

		const text = response.content
			.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
			.map((part) => part.text)
			.join('\n');

		const parsed = parsePreReview(text);

		// Map model hunk references → canonical hunk ids.
		const resolveHunkId = (ref: HunkRef): string | undefined =>
			hunks.find((hunk) => hunk.file === ref.file && hunk.oldStart === ref.oldStart && hunk.newStart === ref.newStart)?.id;

		const smart = buildSmartPartition(parsed.patches, parsed.cues, resolveHunkId);

		const causalityOrder = dedupe(parsed.causalityOrder.flatMap((ref) => {
			const id = resolveHunkId(ref);
			return id ? [id] : [];
		}));

		const comments: ReviewFinding[] = suggestComments
			? parsed.comments.map((comment, index) => ({
					...comment,
					id: `agent-${index + 1}`,
					source: 'agent' as const
				}))
			: [];

		markPreReviewDone(sessionId, {
			overview: parsed.overview,
			assessment: parsed.assessment,
			comments,
			smart,
			causalityOrder
		});
	} catch (error) {
		markPreReviewFailed(sessionId, error instanceof Error ? error.message : String(error));
	}
}

function buildSmartPartition(
	patches: ParsedPatch[],
	cues: ParsedCue[],
	resolveHunkId: (ref: HunkRef) => string | undefined
): ReviewSmartPartition | undefined {
	const parts: ReviewPart[] = [];
	const chunks: ReviewChunk[] = [];

	patches.forEach((patch, partIndex) => {
		const partId = `part-${partIndex + 1}`;

		// Group this patch's resolved hunk ids by file, preserving first-seen file order.
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

		if (byFile.size === 0) return;

		parts.push({
			id: partId,
			kind: 'patch',
			title: patch.title,
			brief: patch.brief,
			order: parts.length
		});

		for (const [file, hunkIds] of byFile) {
			const cue = cues.find((candidate) => candidate.file === file && candidate.hunks.some((ref) => hunkIds.includes(resolveHunkId(ref) ?? '')))?.text;
			chunks.push({
				id: `chunk-${partIndex + 1}-${slugify(file)}`,
				partId,
				file,
				hunkIds,
				cue
			});
		}
	});

	if (parts.length === 0) return undefined;
	return { parts, chunks };
}

export function parsePreReview(text: string): ParsedPreReview {
	const json = extractJson(text);
	const parsed = JSON.parse(json) as {
		overview?: unknown;
		assessment?: unknown;
		patches?: unknown;
		causalityOrder?: unknown;
		cues?: unknown;
		comments?: unknown;
	};

	return {
		overview: asString(parsed.overview),
		assessment: typeof parsed.assessment === 'string' ? parsed.assessment.trim() : undefined,
		patches: Array.isArray(parsed.patches) ? parsed.patches.flatMap((item) => normalizePatch(item)) : [],
		causalityOrder: Array.isArray(parsed.causalityOrder) ? parsed.causalityOrder.flatMap((item) => normalizeHunkRef(item)) : [],
		cues: Array.isArray(parsed.cues) ? parsed.cues.flatMap((item) => normalizeCue(item)) : [],
		comments: Array.isArray(parsed.comments) ? parsed.comments.flatMap((item) => normalizeFinding(item)) : []
	};
}

function normalizeHunkRef(item: unknown): HunkRef[] {
	if (!item || typeof item !== 'object') return [];
	const value = item as Record<string, unknown>;
	const file = asString(value.file);
	const oldStart = asNumber(value.oldStart);
	const newStart = asNumber(value.newStart);
	if (!file || oldStart === undefined || newStart === undefined) return [];
	return [{ file, oldStart, newStart }];
}

function normalizePatch(item: unknown): ParsedPatch[] {
	if (!item || typeof item !== 'object') return [];
	const value = item as Record<string, unknown>;
	const title = asString(value.title);
	if (!title) return [];
	const hunks = Array.isArray(value.hunks) ? value.hunks.flatMap((entry) => normalizeHunkRef(entry)) : [];
	return [{ title, brief: asString(value.brief), hunks }];
}

function normalizeCue(item: unknown): ParsedCue[] {
	if (!item || typeof item !== 'object') return [];
	const value = item as Record<string, unknown>;
	const file = asString(value.file);
	const cueText = asString(value.text);
	if (!file || !cueText) return [];
	const hunks = Array.isArray(value.hunks) ? value.hunks.flatMap((entry) => normalizeHunkRef(entry)) : [];
	return [{ file, hunks, text: cueText }];
}

function normalizeFinding(item: unknown): Omit<ReviewFinding, 'id' | 'source'>[] {
	if (!item || typeof item !== 'object') return [];
	const value = item as Record<string, unknown>;
	const title = asString(value.title);
	const rationale = asString(value.rationale);
	if (!title || !rationale) return [];

	return [
		{
			severity: normalizeSeverity(value.severity),
			title,
			file: asString(value.file),
			line: asNumber(value.line),
			side: normalizeSide(value.side),
			rationale,
			recommendation: asString(value.recommendation)
		}
	];
}

export function extractJson(text: string): string {
	const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
	if (fenced?.[1]) return fenced[1];
	const first = text.indexOf('{');
	const last = text.lastIndexOf('}');
	if (first >= 0 && last > first) return text.slice(first, last + 1);
	return text;
}

function normalizeSeverity(value: unknown): ReviewSeverity {
	return value === 'critical' || value === 'high' || value === 'medium' || value === 'low' ? value : 'medium';
}

function normalizeSide(value: unknown): ReviewSide {
	return value === 'deletions' ? 'deletions' : 'additions';
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function slugify(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'file';
}

function dedupe(values: string[]): string[] {
	return [...new Set(values)];
}
