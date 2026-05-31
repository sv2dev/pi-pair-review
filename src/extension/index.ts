import { getSupportedThinkingLevels, type Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { spawn, spawnSync } from 'node:child_process';
import { buildDiffCommand, summarizePatchFiles } from './diff.ts';
import { createReviewSession, markPreReviewDone } from './store.ts';
import { closeReviewWebServer, ensureReviewWebServer } from './server.ts';
import { buildHeuristicPreReview, runPreReview } from './pre-review.ts';

export default function pairReviewExtension(pi: ExtensionAPI) {
	pi.registerCommand('pair-review', {
		description: 'Open a guided web code review for the current git diff',
		getArgumentCompletions: (prefix) => {
			const options = ['--unstaged', '--staged', '--cached', '--uncommitted', '--branch', '--base', '--target'];
			const matches = options.filter((option) => option.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const diffCommand = buildDiffCommand(args);
			const diff = await pi.exec(diffCommand.command[0]!, diffCommand.command.slice(1), { cwd: ctx.cwd, timeout: 30_000 });

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
				cwd: ctx.cwd,
				title: `Review ${diffCommand.baseDescription}`,
				baseDescription: diffCommand.baseDescription,
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
			markPreReviewDone(session.id, heuristicReview.findings, heuristicReview.hunks, heuristicReview.summary);

			const url = server.urlForReview(session.id);
			openUrl(url);
			ctx.ui.notify(`Pair review opened: ${url}`, 'info');
		}
	});

	pi.on('session_shutdown', async () => {
		await closeReviewWebServer();
	});
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
