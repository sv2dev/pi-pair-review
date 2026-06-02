import { getSupportedThinkingLevels, type Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { buildDiffCommandFromTokens, splitArgs, summarizePatchFiles } from './diff.ts';
import { createReviewSession, markHeuristicPreReview } from './store.ts';
import { closeReviewWebServer, ensureReviewWebServer } from './server.ts';
import { buildHeuristicPreReview, runPreReview } from './pre-review.ts';

const ACTIVE_CWD_ENTRY = 'pi-active-cwd';

export default function pairReviewExtension(pi: ExtensionAPI) {
	pi.registerCommand('pair-review', {
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

			const hasUncommittedChanges = await hasTrackedUncommittedChanges(pi, reviewCwd);
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

			const returnFocusApp = getFrontmostAppName();
			const session = createReviewSession({
				cwd: reviewCwd,
				envPwd: process.env.PWD,
				title: `Review ${diffCommand.baseDescription}`,
				baseDescription: diffCommand.baseDescription,
				diffMode: diffCommand.mode,
				diffBase: diffCommand.base,
				patch,
				files: summarizePatchFiles(patch),
				agentReview: {
					models: reviewModels.map((model) => ({
						key: modelKey(model),
						provider: model.provider,
						id: model.id,
						name: model.name,
						thinkingLevels: getSupportedThinkingLevels(model)
					})),
					defaultModelKey: ctx.model ? modelKey(ctx.model) : reviewModels[0] ? modelKey(reviewModels[0]) : undefined,
					defaultThinkingLevel: 'off'
				},
				onFeedback: (feedback) => {
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

			const heuristicReview = buildHeuristicPreReview(patch);
			markHeuristicPreReview(session.id, heuristicReview.hunks);

			const url = server.urlForReview(session.id);
			openUrl(url);
			ctx.ui.notify(`Pair review opened: ${url}${reviewCwd !== ctx.cwd ? ` (${reviewCwd})` : ''}`, 'info');
		}
	});

	pi.on('session_shutdown', async () => {
		await closeReviewWebServer();
	});
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

async function hasTrackedUncommittedChanges(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const result = await pi.exec('git', ['diff', '--quiet', 'HEAD', '--'], { cwd, timeout: 30_000 });
	return result.code === 1;
}

function modelKey(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
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
			ctx.ui.notify('Pair review feedback inserted into input.', 'info');
			return;
		}
		if (attempts < 8) setTimeout(insert, 150);
		else ctx.ui.notify('Pair review feedback is ready, but Pi did not accept editor insertion. Use Copy feedback in the review page.', 'warning');
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
