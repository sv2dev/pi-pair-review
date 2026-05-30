import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { spawn } from 'node:child_process';
import { buildDiffCommand, summarizePatchFiles } from './diff.ts';
import { createReviewSession } from './store.ts';
import { closeReviewWebServer, ensureReviewWebServer } from './server.ts';
import { runPreReview } from './pre-review.ts';

export default function pairReviewExtension(pi: ExtensionAPI) {
	pi.registerCommand('pair-review', {
		description: 'Open a guided web code review for the current git diff',
		getArgumentCompletions: (prefix) => {
			const options = ['--staged', '--cached'];
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
			const session = createReviewSession({
				cwd: ctx.cwd,
				title: `Review ${diffCommand.baseDescription}`,
				baseDescription: diffCommand.baseDescription,
				patch,
				files: summarizePatchFiles(patch)
			});

			const url = server.urlForReview(session.id);
			openUrl(url);
			ctx.ui.notify(`Pair review opened: ${url}`, 'info');

			void runPreReview(session.id, ctx);
		}
	});

	pi.on('session_shutdown', async () => {
		await closeReviewWebServer();
	});
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
