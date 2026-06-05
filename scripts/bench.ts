/**
 * Model benchmark for the pre-review AI pass (standalone harness).
 *
 * Compares how different models (x thinking levels) perform at producing the structured
 * review JSON the product relies on, tracking quality (a deterministic 0-100 score built
 * from JSON validity, hunk coverage, causality completeness, partition soundness, cue
 * coverage, and comment signal) and cost (latency, tokens, $, quality-per-dollar).
 *
 * Run/score logic is shared with the in-pi command via src/extension/benchmark.ts; this
 * file only handles standalone auth/model resolution + CLI presentation.
 *
 * Changeset under review = the current working-tree diff of this repo (`git diff HEAD`).
 *
 * Run:   bun scripts/bench.ts
 *
 * Cost control: only the models listed in TARGETS below are run. Expensive models
 * (gpt-5.5, opus, etc.) are commented out / opt-in. Local providers (ollama) are
 * NEVER run and are skipped defensively even if a TARGET matches one.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Model } from '@earendil-works/pi-ai';
import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { parseReviewHunks, summarizePatchFiles } from '../src/extension/diff.ts';
import type { ReviewThinkingLevel } from '../src/lib/shared/review.ts';
import { rankResults, runBenchmark, type BenchResult, type ResolvedTarget } from '../src/extension/benchmark.ts';

// ---------------------------------------------------------------------------
// Targets: which models (x thinking levels) to run.
//
// `idMatch` is matched as a substring against each available model's `id`.
// `thinkingLevels` are the reasoning efforts to try ('off' = no reasoning).
//
// Keep spend low: for this trial only gpt-5.4-mini is enabled. Uncomment the
// expensive entries below to expand the comparison (each line = real $ spend).
// ---------------------------------------------------------------------------
interface Target {
	idMatch: string;
	thinkingLevels: ReviewThinkingLevel[];
	/** Optional provider preference when an idMatch resolves to several models. */
	preferProvider?: string;
}

const TARGETS: Target[] = [
	// --- TRIAL (enabled): cheap mini model, 2 runs total ---
	{ idMatch: 'gpt-5.4-mini', thinkingLevels: ['off', 'medium'], preferProvider: 'openai-codex' }

	// --- OPT-IN / EXPENSIVE (commented out to control spend) ---
	// { idMatch: 'gpt-5.4', thinkingLevels: ['off', 'medium'], preferProvider: 'openai-codex' },
	// { idMatch: 'gpt-5.5', thinkingLevels: ['medium', 'high'], preferProvider: 'openai-codex' },
	// { idMatch: 'claude-opus-4-8', thinkingLevels: ['off', 'medium'], preferProvider: 'anthropic' },
	// { idMatch: 'claude-sonnet-4-6', thinkingLevels: ['off', 'medium'], preferProvider: 'anthropic' },
];

// Providers we treat as local/offline. NEVER run these (no cost, but disallowed).
const LOCAL_PROVIDER_PATTERNS = [/ollama/i, /local/i, /lmstudio/i, /llama\.?cpp/i];

function isLocalProvider(provider: string): boolean {
	return LOCAL_PROVIDER_PATTERNS.some((re) => re.test(provider));
}

function gitDiffHead(): string {
	const result = spawnSync('git', ['diff', '--no-ext-diff', '--find-renames', 'HEAD'], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	if (result.status !== 0) {
		throw new Error(`git diff HEAD failed: ${result.stderr || result.error?.message}`);
	}
	return result.stdout;
}

function resolveTargetModels(target: Target, available: Model<any>[]): Model<any>[] {
	const matches = available.filter((m) => m.id.includes(target.idMatch));
	if (matches.length === 0) return [];

	// Skip local/offline providers entirely.
	const remote = matches.filter((m) => !isLocalProvider(m.provider));
	if (remote.length === 0) return [];

	// If a provider is preferred and present, use only that one. Otherwise take the first.
	if (target.preferProvider) {
		const preferred = remote.find((m) => m.provider === target.preferProvider);
		if (preferred) return [preferred];
	}
	return [remote[0]!];
}

async function main(): Promise<void> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const repoRoot = process.cwd();

	console.log('Pre-review model benchmark');
	console.log('==========================');

	// --- Registry / auth (standalone, from ~/.pi config) ---
	let registry: ModelRegistry;
	try {
		const authStorage = AuthStorage.create();
		registry = ModelRegistry.create(authStorage);
		const loadError = registry.getError();
		if (loadError) console.warn(`models.json load warning: ${loadError}`);
	} catch (error) {
		console.error('Failed to instantiate ModelRegistry standalone:', error);
		console.error('Cannot proceed without registry/auth. Aborting.');
		process.exit(1);
	}

	const available = registry.getAvailable();
	console.log(`Registry: ${available.length} models with configured auth.`);

	// --- Changeset = working-tree diff ---
	const patch = gitDiffHead();
	if (!patch.trim()) {
		console.error('No working-tree changes (git diff HEAD is empty). Aborting.');
		process.exit(1);
	}
	const files = summarizePatchFiles(patch);
	const canonicalHunks = parseReviewHunks(patch);
	console.log(`Changeset: ${files.length} files, ${canonicalHunks.length} hunks, ${patch.length} diff chars.`);

	// --- Resolve targets (model + auth + thinking level) ---
	const targets: ResolvedTarget[] = [];
	for (const target of TARGETS) {
		const models = resolveTargetModels(target, available);
		if (models.length === 0) {
			console.warn(`Skip target "${target.idMatch}": no available remote model matched.`);
			continue;
		}
		for (const model of models) {
			const auth = await registry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				console.warn(`Skip ${model.provider}/${model.id}: ${auth.ok ? `no API key for ${model.provider}` : auth.error}`);
				continue;
			}
			for (const thinkingLevel of target.thinkingLevels) {
				targets.push({ model, apiKey: auth.apiKey, headers: auth.headers, thinkingLevel });
			}
		}
	}

	if (targets.length === 0) {
		console.error('No runs planned. Check TARGETS / model availability / auth.');
		process.exit(1);
	}

	console.log(`Planned ${targets.length} run(s):`);
	for (const t of targets) console.log(`  - ${t.model.provider}/${t.model.id} @ ${t.thinkingLevel}`);
	console.log('');

	// --- Run + score (shared core) ---
	const results = await runBenchmark({
		patch,
		targets,
		config: { title: 'Benchmark changeset', baseDescription: 'working tree (git diff HEAD)', cwd: repoRoot }
	});

	// --- Comparison table (ranked by quality desc, cost asc) ---
	const ranked = rankResults(results);
	console.log('\nComparison (ranked by quality)');
	console.log('==============================');
	printTable(ranked);

	const totalSpend = results.reduce((sum, r) => sum + r.metrics.costUsd, 0);
	console.log(`\nTotal $ spent: $${totalSpend.toFixed(4)}`);

	// --- Persist results (full JSON incl. scores + raw output) ---
	const benchDir = join(repoRoot, 'bench');
	mkdirSync(benchDir, { recursive: true });
	const resultsPath = join(benchDir, `results-${timestamp}.json`);
	writeFileSync(
		resultsPath,
		JSON.stringify(
			{
				timestamp,
				repoRoot,
				changeset: { files: files.length, hunks: canonicalHunks.length, diffChars: patch.length },
				totalSpendUsd: totalSpend,
				results: ranked
			},
			null,
			2
		)
	);
	console.log(`\nFull results (incl. scores + raw model output) written to: ${resultsPath}`);
}

function printTable(results: BenchResult[]): void {
	const header = ['model', 'think', 'quality', 'eff/$', 'json', 'hunkCov', 'caus', 'cmt', 'ms', 'tok', '$'];
	const rows = results.map((r) => [
		r.modelId,
		r.thinkingLevel,
		r.ok ? r.score.quality.toFixed(1) : 'ERR',
		r.ok ? r.score.efficiency.toFixed(0) : '-',
		r.ok ? (r.metrics.jsonValid ? 'yes' : 'no') : '-',
		r.ok && r.metrics.jsonValid ? `${(r.metrics.hunkCoverage * 100).toFixed(0)}%` : '-',
		String(r.metrics.counts.causalityOrder),
		String(r.metrics.counts.comments),
		String(r.metrics.latencyMs),
		String(r.metrics.tokens.total),
		r.metrics.costUsd.toFixed(4)
	]);

	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
	const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');

	console.log(fmt(header));
	console.log(widths.map((w) => '-'.repeat(w)).join('  '));
	for (const row of rows) console.log(fmt(row));

	for (const r of results) {
		if (!r.ok && r.error) console.log(`\n[error] ${r.modelKey} @ ${r.thinkingLevel}: ${r.error}`);
		if (r.ok && !r.metrics.jsonValid) {
			console.log(`\n[invalid JSON] ${r.modelKey} @ ${r.thinkingLevel} raw snippet:`);
			console.log(r.rawOutput.slice(0, 800));
		}
	}
}

main().catch((error) => {
	console.error('Benchmark crashed:', error);
	process.exit(1);
});
