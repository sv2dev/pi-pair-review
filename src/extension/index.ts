import { complete, getSupportedThinkingLevels, type Model, type UserMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { attributeCommitHunks, buildDiffCommandFromTokens, enumerateCommits, parseReviewHunks, splitArgs, summarizePatchFiles } from './diff.ts';
import { createReviewSession } from './store.ts';
import { closeReviewWebServer, ensureReviewWebServer } from './server.ts';
import { runPreReview } from './pre-review.ts';
import { readReviewUiSettings } from './settings.ts';
import type { DiffMode } from './diff.ts';
import { pickRecommendedModelId, RECOMMENDED_REVIEW_MODEL_IDS } from '../lib/shared/review.ts';
import type { ReviewCommit, ReviewFileSummary, ReviewThinkingLevel } from '../lib/shared/review.ts';
import { rankResults, runBenchmark, type BenchResult, type ResolvedTarget } from './benchmark.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ACTIVE_CWD_ENTRY = 'pi-active-cwd';

type FeedbackTodo = { text: string; status: 'open' | 'done' | 'blocked'; note?: string };

export default function storyReviewExtension(pi: ExtensionAPI) {
	let feedbackTodos: FeedbackTodo[] = [];

	pi.registerTool({
		name: 'story_review_mark_feedback_item',
		label: 'Mark Review Feedback Item',
		description: 'Mark a Story Review feedback item as done or blocked after handling it.',
		promptSnippet: 'Mark individual Story Review feedback items as done or blocked.',
		promptGuidelines: [
			'When Story Review feedback is present, handle every feedback item. After completing or blocking each individual item, immediately call story_review_mark_feedback_item for that item before starting the next item.'
		],
		parameters: Type.Object({
			index: Type.Integer({ minimum: 1, description: '1-based index of the feedback item.' }),
			status: Type.Union([Type.Literal('done'), Type.Literal('blocked')], { description: 'Whether the feedback item was completed or could not be completed.' }),
			note: Type.Optional(Type.String({ description: 'Short reason when blocked, or optional completion note.' }))
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const item = feedbackTodos[params.index - 1];
			if (!item) {
				return { content: [{ type: 'text', text: `No Story Review feedback item ${params.index}.` }], details: {}, isError: true };
			}
			item.status = params.status;
			item.note = params.note;
			renderFeedbackTodoWidget(ctx, feedbackTodos);
			return { content: [{ type: 'text', text: `Marked feedback item ${params.index} ${params.status}.` }], details: {} };
		}
	});

	pi.registerCommand('story-review', {
		description: 'Open a guided web code review for the current git diff',
		getArgumentCompletions: (prefix) => {
			const options = ['--cwd', '--unstaged', '-u', '--staged', '-s', '--cached', '--uncommitted', '-c', '--branch', '--base', '--target'];
			const matches = options.filter((option) => option.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			let parsedArgs: { cwd?: string; diffTokens: string[] };
			let reviewCwd: string;
			try {
				parsedArgs = parseReviewArgs(args);
				reviewCwd = await resolveReviewCwd(pi, ctx, parsedArgs.cwd);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
				return;
			}

			const hasUncommittedChanges = await hasUncommittedChangesInWorktree(pi, reviewCwd);
			const diffCommand = buildDiffCommandFromTokens(parsedArgs.diffTokens, { hasUncommittedChanges });
			const diff = await pi.exec(diffCommand.command[0]!, diffCommand.command.slice(1), { cwd: reviewCwd, timeout: 30_000 });

			if (diff.code !== 0) {
				ctx.ui.notify(diff.stderr || 'Failed to read git diff', 'error');
				return;
			}

			const patch = diff.stdout.trimEnd();
			if (!patch.trim()) {
				ctx.ui.notify(`No ${diffCommand.baseDescription} found`, 'warning');
				return;
			}

			const server = await ensureReviewWebServer();
			const reviewModels = ctx.modelRegistry.getAvailable();
			const recommendedModelId = pickRecommendedModelId(reviewModels.map((model) => model.id));
			const recommendedModel = recommendedModelId ? reviewModels.find((model) => model.id === recommendedModelId) : undefined;

			const files = summarizePatchFiles(patch);
			const hunks = parseReviewHunks(patch);
			const commits = await enumerateCommits(reviewCwd, diffCommand.mode, diffCommand.base);
			await attributeCommitHunks(reviewCwd, commits, hunks);

			const returnFocusApp = getFrontmostAppName();
			const session = createReviewSession({
				cwd: reviewCwd,
				envPwd: process.env.PWD,
				title: `Review ${diffCommand.baseDescription}`,
				baseDescription: diffCommand.baseDescription,
				diffMode: diffCommand.mode,
				diffBase: diffCommand.base,
				patch,
				files,
				commits,
				agentReview: {
					models: reviewModels.map((model) => ({
						key: modelKey(model),
						provider: model.provider,
						id: model.id,
						name: model.name,
						thinkingLevels: getSupportedThinkingLevels(model)
					})),
					defaultModelKey: recommendedModel ? modelKey(recommendedModel) : ctx.model ? modelKey(ctx.model) : reviewModels[0] ? modelKey(reviewModels[0]) : undefined,
					defaultThinkingLevel: 'off'
				},
				onFeedback: (feedback) => {
					feedbackTodos = extractFeedbackTodos(feedback);
					renderFeedbackTodoWidget(ctx, feedbackTodos);
					void summarizeFeedbackTodos(ctx, feedbackTodos, feedback).then((summaries) => {
						if (summaries.length !== feedbackTodos.length) return;
						feedbackTodos = feedbackTodos.map((todo, index) => ({ ...todo, text: summaries[index] ?? todo.text }));
						renderFeedbackTodoWidget(ctx, feedbackTodos);
					});
					deferEditorInsert(ctx, feedback, returnFocusApp);
				},
				onAgentReview: ({ modelKey: key, thinkingLevel, suggestComments }) => {
					const model = reviewModels.find((candidate) => modelKey(candidate) === key);
					if (!model) {
						ctx.ui.notify(`Review model not available: ${key}`, 'error');
						return;
					}
					void runPreReview(session.id, ctx, model, thinkingLevel, suggestComments);
				}
			});

			await maybeAutorunPreReview(ctx, session.id, reviewModels, { mode: diffCommand.mode, files, commits });

			const url = server.urlForReview(session.id);
			openUrl(url);
			ctx.ui.notify(`Story review opened: ${url}${reviewCwd !== ctx.cwd ? ` (${reviewCwd})` : ''}`, 'info');
		}
	});

	pi.registerCommand('story-review-bench', {
		description: 'Benchmark review models on the current git diff (scores quality, cost, latency)',
		getArgumentCompletions: (prefix) => {
			const matches = RECOMMENDED_REVIEW_MODEL_IDS.filter((id) => id.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			let reviewCwd: string;
			try {
				reviewCwd = await resolveReviewCwd(pi, ctx, undefined);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
				return;
			}

			// Changeset = working-tree diff (git diff HEAD), reusing the existing exec pattern.
			const diff = await pi.exec('git', ['diff', '--no-ext-diff', '--find-renames', 'HEAD'], { cwd: reviewCwd, timeout: 30_000 });
			if (diff.code !== 0) {
				ctx.ui.notify(diff.stderr || 'Failed to read git diff HEAD', 'error');
				return;
			}
			const patch = diff.stdout.trimEnd();
			if (!patch.trim()) {
				ctx.ui.notify('No working-tree changes (git diff HEAD is empty)', 'warning');
				return;
			}

			// Resolve targets: explicit model id substrings from args, else the recommended list.
			const requestedIds = splitArgs(args.trim());
			const idMatches = requestedIds.length > 0 ? requestedIds : [...RECOMMENDED_REVIEW_MODEL_IDS];
			const available = ctx.modelRegistry.getAvailable();

			const targets: ResolvedTarget[] = [];
			const seen = new Set<string>();
			for (const idMatch of idMatches) {
				const lower = idMatch.toLowerCase();
				const match = available.find((model) => model.id.toLowerCase().includes(lower) && !isLocalProvider(model.provider));
				if (!match || seen.has(modelKey(match))) continue;
				seen.add(modelKey(match));
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(match);
				if (!auth.ok || !auth.apiKey) {
					ctx.ui.notify(`Skipping ${modelKey(match)}: ${auth.ok ? 'no API key' : auth.error}`, 'warning');
					continue;
				}
				targets.push({ model: match, apiKey: auth.apiKey, headers: auth.headers, thinkingLevel: 'off' });
			}

			if (targets.length === 0) {
				ctx.ui.notify('No benchmarkable models matched (check model ids / configured auth)', 'error');
				return;
			}

			ctx.ui.notify(`Benchmarking ${targets.length} model(s) — this runs ${targets.length} paid model call(s).`, 'info');

			const results = await runBenchmark({
				patch,
				targets,
				config: { title: `Benchmark ${reviewCwd}`, baseDescription: 'working tree (git diff HEAD)', cwd: reviewCwd }
			});
			const ranked = rankResults(results);

			// Persist full JSON (incl. scores + raw output).
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			const benchDir = join(reviewCwd, 'bench');
			let resultsPath: string | undefined;
			try {
				mkdirSync(benchDir, { recursive: true });
				resultsPath = join(benchDir, `results-${timestamp}.json`);
				const totalSpendUsd = results.reduce((sum, r) => sum + r.metrics.costUsd, 0);
				writeFileSync(
					resultsPath,
					JSON.stringify({ timestamp, repoRoot: reviewCwd, totalSpendUsd, results: ranked }, null, 2)
				);
			} catch (error) {
				ctx.ui.notify(`Benchmark ran but writing results failed: ${error instanceof Error ? error.message : String(error)}`, 'warning');
			}

			ctx.ui.notify(formatBenchTable(ranked, resultsPath), 'info');
		}
	});

	pi.on('session_shutdown', async () => {
		await closeReviewWebServer();
	});
}

// Providers treated as local/offline; never benchmarked (disallowed by the task).
const LOCAL_PROVIDER_PATTERNS = [/ollama/i, /local/i, /lmstudio/i, /llama\.?cpp/i];

function isLocalProvider(provider: string): boolean {
	return LOCAL_PROVIDER_PATTERNS.some((re) => re.test(provider));
}

/** Compact ranked text table: model · think · quality · hunkCov · $ · latency. */
function formatBenchTable(results: BenchResult[], resultsPath: string | undefined): string {
	const lines = ['Story-review model benchmark (ranked by quality):', ''];
	const header = ['model', 'think', 'quality', 'hunkCov', '$', 'ms'];
	const rows = results.map((r) => [
		r.modelId,
		r.thinkingLevel,
		r.ok ? r.score.quality.toFixed(1) : 'ERR',
		r.ok && r.metrics.jsonValid ? `${(r.metrics.hunkCoverage * 100).toFixed(0)}%` : '-',
		r.metrics.costUsd.toFixed(4),
		String(r.metrics.latencyMs)
	]);
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
	const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
	lines.push(fmt(header), widths.map((w) => '-'.repeat(w)).join('  '));
	for (const row of rows) lines.push(fmt(row));
	for (const r of results) {
		if (!r.ok && r.error) lines.push(`[error] ${r.modelKey} @ ${r.thinkingLevel}: ${r.error}`);
	}
	if (resultsPath) lines.push('', `Full results: ${resultsPath}`);
	return lines.join('\n');
}

async function maybeAutorunPreReview(
	ctx: ExtensionCommandContext,
	sessionId: string,
	reviewModels: Model<any>[],
	diff: { mode: DiffMode; files: ReviewFileSummary[]; commits: ReviewCommit[] }
): Promise<void> {
	const settings = await readReviewUiSettings();
	const autorun = settings.autorun;
	if (!autorun?.enabled) return;

	const totalLines = diff.files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
	const isUncommitted = diff.mode === 'unstaged' || diff.mode === 'staged' || diff.mode === 'uncommitted';
	const shouldRun =
		autorun.unconditional ||
		(autorun.minLines !== undefined && totalLines >= autorun.minLines) ||
		(autorun.minFiles !== undefined && diff.files.length >= autorun.minFiles) ||
		(autorun.onUncommitted === true && isUncommitted) ||
		(autorun.onSingleCommit === true && diff.commits.length === 1);
	if (!shouldRun) return;

	const model = settings.modelKey ? reviewModels.find((candidate) => modelKey(candidate) === settings.modelKey) : ctx.model;
	const thinkingLevel = (settings.thinkingLevel as ReviewThinkingLevel | undefined) ?? 'off';
	const suggestComments = settings.suggestComments !== false;
	void runPreReview(sessionId, ctx, model, thinkingLevel, suggestComments);
}

function parseReviewArgs(args: string): { cwd?: string; diffTokens: string[] } {
	const tokens = splitArgs(args.trim());
	const diffTokens: string[] = [];
	let cwd: string | undefined;

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token === '--cwd') {
			const value = tokens[index + 1];
			if (!value) throw new Error('Missing value for --cwd');
			cwd = value;
			index += 1;
			continue;
		}
		if (token.startsWith('--cwd=')) {
			cwd = token.slice('--cwd='.length);
			if (!cwd) throw new Error('Missing value for --cwd');
			continue;
		}
		diffTokens.push(token);
	}

	return { cwd, diffTokens };
}

async function resolveReviewCwd(pi: ExtensionAPI, ctx: ExtensionCommandContext, explicitCwd: string | undefined): Promise<string> {
	if (explicitCwd) {
		const cwd = resolve(ctx.cwd, explicitCwd);
		const gitRoot = await gitTopLevel(pi, cwd);
		if (!gitRoot) throw new Error(`Not a git worktree: ${cwd}`);
		return gitRoot;
	}

	const activeCwd = activeCwdFromSession(ctx);
	if (activeCwd) {
		const cwd = resolve(ctx.cwd, activeCwd);
		const gitRoot = await gitTopLevel(pi, cwd);
		if (gitRoot) return gitRoot;
		ctx.ui.notify(`Ignoring invalid ${ACTIVE_CWD_ENTRY}: ${cwd}`, 'warning');
	}

	return ctx.cwd;
}

function activeCwdFromSession(ctx: ExtensionCommandContext): string | undefined {
	const entries = ctx.sessionManager.getEntries() as any[];
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== 'custom' || entry.customType !== ACTIVE_CWD_ENTRY) continue;
		const cwd = entry.data?.cwd;
		if (cwd === null) return undefined;
		return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : undefined;
	}
	return undefined;
}

async function gitTopLevel(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	try {
		const result = await pi.exec('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 10_000 });
		return result.code === 0 ? result.stdout.trim() || undefined : undefined;
	} catch {
		return undefined;
	}
}

async function hasUncommittedChangesInWorktree(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const tracked = await pi.exec('git', ['diff', '--quiet', 'HEAD', '--'], { cwd, timeout: 30_000 });
	if (tracked.code === 1) return true;
	const untracked = await pi.exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd, timeout: 30_000 });
	return untracked.code === 0 && untracked.stdout.trim().length > 0;
}

function modelKey(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function extractFeedbackTodos(feedback: string): FeedbackTodo[] {
	const items: string[] = [];
	let current: string | undefined;
	for (const line of feedback.split('\n')) {
		if (line.startsWith('- ')) {
			if (current) items.push(current);
			current = line.slice(2).trim();
		} else if (current && /^\s+\S/.test(line)) {
			current += ` ${line.trim()}`;
		}
	}
	if (current) items.push(current);
	return items.map((text) => ({ text: summarizeFeedbackTodo(text), status: 'open' }));
}

function summarizeFeedbackTodo(text: string): string {
	const summary = text
		.replace(/!\[[^\]]*\]\([^)]+\)/g, '')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
	const fallback = 'Attached image feedback';
	const singleLine = summary || fallback;
	return singleLine.length > 96 ? `${singleLine.slice(0, 95)}…` : singleLine;
}

async function summarizeFeedbackTodos(ctx: ExtensionCommandContext, todos: FeedbackTodo[], feedback: string): Promise<string[]> {
	if (!ctx.model || todos.length === 0) return todos.map((todo) => todo.text);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) return todos.map((todo) => todo.text);
	const userMessage: UserMessage = {
		role: 'user',
		content: [{ type: 'text', text: feedback }],
		timestamp: Date.now()
	};
	try {
		const response = await complete(
			ctx.model,
			{
				systemPrompt: `Summarize Story Review feedback items for a compact checklist widget. Return only a JSON array of ${todos.length} short labels in the same order. Each label must be one line, under 64 characters, describe the requested change, and omit image URLs, markdown syntax, file paths, and generic wording.`,
				messages: [userMessage]
			},
			{ apiKey: auth.apiKey, headers: auth.headers }
		);
		const text = response.content.filter((part): part is { type: 'text'; text: string } => part.type === 'text').map((part) => part.text).join('\n');
		return parseSummaryLabels(text, todos.length) ?? todos.map((todo) => todo.text);
	} catch {
		return todos.map((todo) => todo.text);
	}
}

function parseSummaryLabels(text: string, expectedCount: number): string[] | undefined {
	const json = /\[[\s\S]*\]/.exec(text)?.[0];
	if (!json) return undefined;
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!Array.isArray(parsed) || parsed.length !== expectedCount || !parsed.every((item) => typeof item === 'string')) return undefined;
		return parsed.map((item) => summarizeFeedbackTodo(item));
	} catch {
		return undefined;
	}
}

function renderFeedbackTodoWidget(ctx: ExtensionContext, todos: FeedbackTodo[]): void {
	if (!ctx.hasUI) return;
	if (todos.length === 0) {
		ctx.ui.setWidget('story-review-feedback', undefined);
		return;
	}
	const completed = todos.filter((todo) => todo.status !== 'open').length;
	const lines = [`Story Review feedback (${completed}/${todos.length})`];
	for (const [index, todo] of todos.entries()) {
		const marker = todo.status === 'done' ? '[x]' : todo.status === 'blocked' ? '[!]' : '[ ]';
		const text = todo.status === 'done' ? ctx.ui.theme.fg('muted', ctx.ui.theme.strikethrough(todo.text)) : todo.status === 'blocked' ? `${ctx.ui.theme.fg('warning', todo.text)}${todo.note ? ctx.ui.theme.fg('muted', ` — ${todo.note}`) : ''}` : todo.text;
		lines.push(`${marker} ${index + 1}. ${text}`);
	}
	ctx.ui.setWidget('story-review-feedback', lines, { placement: 'belowEditor' });
}

function deferEditorInsert(ctx: ExtensionCommandContext, feedback: string, returnFocusApp?: string): void {
	let attempts = 0;
	const insert = () => {
		attempts += 1;
		ctx.ui.setEditorText(feedback);
		if (ctx.ui.getEditorText() !== feedback) {
			ctx.ui.setEditorText('');
			ctx.ui.pasteToEditor(feedback);
		}
		if (ctx.ui.getEditorText() === feedback) {
			focusApp(returnFocusApp);
			ctx.ui.notify('Story review feedback inserted into input.', 'info');
			return;
		}
		if (attempts < 8) setTimeout(insert, 150);
		else ctx.ui.notify('Story review feedback is ready, but Pi did not accept editor insertion. Use Copy feedback in the review page.', 'warning');
	};
	setTimeout(insert, 250);
}

function getFrontmostAppName(): string | undefined {
	if (process.platform !== 'darwin') return undefined;
	try {
		const result = spawnSync('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'], { encoding: 'utf8' });
		return result.status === 0 ? result.stdout.trim() || undefined : undefined;
	} catch {
		return undefined;
	}
}

function focusApp(appName: string | undefined): void {
	if (process.platform !== 'darwin' || !appName) return;
	try {
		spawn('osascript', ['-e', `tell application ${JSON.stringify(appName)} to activate`], { detached: true, stdio: 'ignore' }).unref();
	} catch {
		// Best effort only.
	}
}

function openUrl(url: string): void {
	try {
		const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
		const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
		const child = spawn(command, args, { detached: true, stdio: 'ignore' });
		child.unref();
	} catch {
		// The notification still includes the URL for manual opening.
	}
}
