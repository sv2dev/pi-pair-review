import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { addUserAnnotation, finishReview, getReviewFeedback, getReviewSession, isReviewFinished, removeReviewFinding, removeUserAnnotation, replaceReviewDiff, reviewListenerCount, startAgentReview, subscribeToReviewSession, updateUserAnnotation } from './store.ts';
import { buildDiffCommandFromSelection, summarizePatchFiles, type DiffMode } from './diff.ts';
import { buildHeuristicPreReview } from './pre-review.ts';
import { readReviewUiSettings, updateReviewUiSettings } from './settings.ts';
import type { ReviewSessionSnapshot } from '../lib/shared/review.ts';

type SvelteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
type WebHandler = { handler?: SvelteHandler; close?: () => Promise<void> | void; dev?: boolean };

export interface ReviewWebServer {
	origin: string;
	urlForReview(id: string): string;
	close(): Promise<void>;
}

let serverPromise: Promise<ReviewWebServer> | undefined;

export function ensureReviewWebServer(): Promise<ReviewWebServer> {
	serverPromise ??= startReviewWebServer();
	return serverPromise;
}

export async function closeReviewWebServer(): Promise<void> {
	if (!serverPromise) return;
	const server = await serverPromise;
	serverPromise = undefined;
	await server.close();
}

async function startReviewWebServer(): Promise<ReviewWebServer> {
	const webHandler = await loadWebHandler();

	const server = createServer((req, res) => {
		void handleRequest(req, res, webHandler.handler);
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});

	const address = server.address() as AddressInfo;
	const origin = `http://127.0.0.1:${address.port}`;

	return {
		origin,
		urlForReview: (id) => `${origin}/review/${id}`,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
			await webHandler.close?.();
		}
	};
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, svelteHandler: SvelteHandler | undefined): Promise<void> {
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

	if (url.pathname === '/api/settings') {
		handleSettingsRequest(req, res);
		return;
	}

	if (url.pathname === '/api/settings') {
		handleSettingsRequest(req, res);
		return;
	}

	if (url.pathname.startsWith('/api/reviews/')) {
		handleApiRequest(req, res, url);
		return;
	}

	if (!svelteHandler) {
		writeHtml(res, 503, renderMissingBuildPage());
		return;
	}

	await svelteHandler(req, res);
}

function handleSettingsRequest(req: IncomingMessage, res: ServerResponse): void {
	if (req.method === 'GET') {
		void readReviewUiSettings().then((settings) => writeJson(res, 200, settings)).catch((error) => writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) }));
		return;
	}
	if (req.method === 'PATCH') {
		void readJson(req).then((body) => updateReviewUiSettings(body as Parameters<typeof updateReviewUiSettings>[0])).then((settings) => writeJson(res, 200, settings)).catch((error) => writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) }));
		return;
	}
	writeJson(res, 405, { error: 'Method not allowed' });
}

function handleApiRequest(req: IncomingMessage, res: ServerResponse, url: URL): void {
	const [, , , id, tail, itemId] = url.pathname.split('/');
	if (!id) {
		writeJson(res, 404, { error: 'Missing review id' });
		return;
	}

	if (req.method === 'GET' && !tail) {
		const snapshot = getReviewSession(id);
		if (!snapshot) {
			writeJson(res, 404, { error: 'Review not found' });
			return;
		}
		writeJson(res, 200, snapshot);
		return;
	}

	if (req.method === 'GET' && tail === 'events') {
		handleEvents(id, res);
		return;
	}

	if (req.method === 'GET' && tail === 'feedback') {
		const feedback = getReviewFeedback(id);
		writeJson(res, feedback === undefined ? 404 : 200, feedback === undefined ? { error: 'Review not found' } : { feedback });
		return;
	}

	if (req.method === 'GET' && tail === 'contents') {
		void (async () => {
			const session = getReviewSession(id);
			if (!session) {
				writeJson(res, 404, { error: 'Review not found' });
				return;
			}
			const file = url.searchParams.get('file')?.trim();
			const previous = url.searchParams.get('previous')?.trim() || file;
			if (!file || file.includes('\0') || previous?.includes('\0')) {
				writeJson(res, 400, { error: 'Invalid file path' });
				return;
			}
			const contents = await readDiffFileContents(session, file, previous ?? file);
			writeJson(res, 200, contents);
		})().catch((error) => writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) }));
		return;
	}

	if (req.method === 'GET' && tail === 'refs') {
		void (async () => {
			const session = getReviewSession(id);
			if (!session) {
				writeJson(res, 404, { error: 'Review not found' });
				return;
			}
			const refs = await execCommand('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], session.cwd, 10_000);
			if (refs.code !== 0) {
				writeJson(res, 400, { error: refs.stderr || 'Failed to read git refs' });
				return;
			}
			const values = [...new Set(refs.stdout.split('\n').map((item) => item.trim()).filter((item) => item && !item.endsWith('/HEAD')))].sort((left, right) => left.localeCompare(right));
			writeJson(res, 200, { refs: values });
		})().catch((error) => writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) }));
		return;
	}

	if (req.method === 'POST' && tail === 'diff') {
		void readJson(req).then(async (body) => {
			const session = getReviewSession(id);
			if (!session) {
				writeJson(res, 404, { error: 'Review not found' });
				return;
			}
			const value = body as Record<string, unknown>;
			const mode = normalizeDiffMode(typeof value.mode === 'string' ? value.mode : '');
			const base = typeof value.base === 'string' ? value.base.trim() : undefined;
			if (!mode) {
				writeJson(res, 400, { error: 'Invalid diff mode' });
				return;
			}
			const diffCommand = buildDiffCommandFromSelection({ mode, base });
			const diff = await execCommand(diffCommand.command[0]!, diffCommand.command.slice(1), session.cwd, 30_000);
			if (diff.code !== 0) {
				writeJson(res, 400, { error: diff.stderr || 'Failed to read git diff' });
				return;
			}
			const patch = diff.stdout.trimEnd();
			if (!patch.trim()) {
				writeJson(res, 400, { error: `No ${diffCommand.baseDescription} found` });
				return;
			}
			const heuristicReview = buildHeuristicPreReview(patch);
			replaceReviewDiff(id, {
				title: `Review ${diffCommand.baseDescription}`,
				baseDescription: diffCommand.baseDescription,
				diffMode: diffCommand.mode,
				diffBase: diffCommand.base,
				patch,
				files: summarizePatchFiles(patch),
				hunks: heuristicReview.hunks
			});
			writeJson(res, 200, getReviewSession(id) ?? { ok: true });
		}).catch((error) => writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) }));
		return;
	}

	if (req.method === 'GET' && tail === 'attachments') {
		void (async () => {
			const path = url.searchParams.get('path') ?? '';
			const normalized = normalize(path);
			const tempRoot = normalize(tmpdir());
			if (!(normalized === tempRoot || normalized.startsWith(`${tempRoot}${sep}`)) || !existsSync(normalized)) {
				writeJson(res, 404, { error: 'Attachment not found' });
				return;
			}
			const extension = extname(normalized).toLowerCase();
			const contentType = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.gif' ? 'image/gif' : extension === '.webp' ? 'image/webp' : 'image/png';
			res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' });
			res.end(await readFile(normalized));
		})().catch((error) => writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) }));
		return;
	}

	if (req.method === 'POST' && tail === 'attachments') {
		void readBuffer(req).then(async (buffer) => {
			const name = url.searchParams.get('name') ?? 'image.png';
			const extension = sanitizeExtension(extname(name)) || '.png';
			const path = join(tmpdir(), `pi-pair-review-${randomUUID()}${extension}`);
			await writeFile(path, buffer);
			writeJson(res, 200, { path });
		}).catch((error) => writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) }));
		return;
	}

	if (req.method === 'PATCH' && tail === 'annotations' && itemId) {
		void readJson(req).then((body) => {
			const annotationBody = typeof (body as Record<string, unknown>).body === 'string' ? (body as Record<string, string>).body.trim() : '';
			if (!annotationBody) {
				writeJson(res, 400, { error: 'Missing annotation body' });
				return;
			}
			const annotation = updateUserAnnotation(id, itemId, annotationBody);
			writeJson(res, annotation ? 200 : 404, annotation ?? { error: 'Review not found' });
		}).catch((error) => writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) }));
		return;
	}

	if (req.method === 'DELETE' && tail === 'annotations' && itemId) {
		writeJson(res, removeUserAnnotation(id, itemId) ? 200 : 404, { ok: true });
		return;
	}

	if (req.method === 'DELETE' && tail === 'findings' && itemId) {
		writeJson(res, removeReviewFinding(id, itemId) ? 200 : 404, { ok: true });
		return;
	}

	if (req.method === 'POST' && tail === 'annotations') {
		void readJson(req).then((body) => {
			const value = body as Record<string, unknown>;
			const scope = value.scope === 'global' || value.scope === 'file' || value.scope === 'line' ? value.scope : 'line';
			const file = typeof value.file === 'string' && value.file.trim() ? value.file.trim() : undefined;
			const line = typeof value.line === 'number' && Number.isFinite(value.line) ? value.line : undefined;
			const side = value.side === 'deletions' ? 'deletions' : value.side === 'additions' ? 'additions' : undefined;
			const endLine = typeof value.endLine === 'number' && Number.isFinite(value.endLine) ? value.endLine : undefined;
			const endSide = value.endSide === 'deletions' ? 'deletions' : value.endSide === 'additions' ? 'additions' : undefined;
			const annotationBody = typeof value.body === 'string' ? value.body.trim() : '';
			if (!annotationBody || (scope !== 'global' && !file) || (scope === 'line' && (!line || !side))) {
				writeJson(res, 400, { error: 'Missing annotation fields' });
				return;
			}
			const annotation = addUserAnnotation(id, { scope, file, line, side, endLine, endSide, body: annotationBody });
			writeJson(res, annotation ? 200 : 404, annotation ?? { error: 'Review not found' });
		}).catch((error) => writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) }));
		return;
	}

	if (req.method === 'POST' && tail === 'finish') {
		void readJson(req).then((body) => {
			const feedback = typeof (body as Record<string, unknown>).feedback === 'string' ? (body as Record<string, string>).feedback : '';
			writeJson(res, finishReview(id, feedback) ? 200 : 404, { ok: true });
		}).catch((error) => writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) }));
		return;
	}

	if (req.method === 'POST' && tail === 'agent-review') {
		void readJson(req).then((body) => {
			const value = body as Record<string, unknown>;
			const modelKey = typeof value.modelKey === 'string' ? value.modelKey : '';
			const thinkingLevel = typeof value.thinkingLevel === 'string' ? value.thinkingLevel : 'off';
			const suggestComments = value.suggestComments !== false;
			if (!modelKey) {
				writeJson(res, 400, { error: 'Missing modelKey' });
				return;
			}
			writeJson(res, startAgentReview(id, { modelKey, thinkingLevel: normalizeThinkingLevel(thinkingLevel), suggestComments }) ? 200 : 404, { ok: true });
		}).catch((error) => writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) }));
		return;
	}

	writeJson(res, 404, { error: 'Not found' });
}

function normalizeThinkingLevel(value: string) {
	return value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' ? value : 'off';
}

async function readDiffFileContents(session: ReviewSessionSnapshot, file: string, previous: string): Promise<{ oldFile: { name: string; contents: string }; newFile: { name: string; contents: string } }> {
	const mode = session.diffMode ?? 'uncommitted';
	const oldName = previous || file;
	const newName = file;
	let oldContents = '';
	let newContents = '';

	if (mode === 'unstaged') {
		oldContents = await readGitObject(session.cwd, `:${oldName}`) ?? '';
		newContents = await readWorktreeFile(session.cwd, newName) ?? '';
	} else if (mode === 'staged') {
		oldContents = await readGitObject(session.cwd, `HEAD:${oldName}`) ?? '';
		newContents = await readGitObject(session.cwd, `:${newName}`) ?? '';
	} else if (mode === 'commit') {
		oldContents = await readGitObject(session.cwd, `HEAD^:${oldName}`) ?? '';
		newContents = await readGitObject(session.cwd, `HEAD:${newName}`) ?? '';
	} else if (mode === 'branch') {
		const base = session.diffBase?.trim() || 'origin/main';
		const mergeBase = await readMergeBase(session.cwd, base);
		oldContents = mergeBase ? await readGitObject(session.cwd, `${mergeBase}:${oldName}`) ?? '' : '';
		newContents = await readGitObject(session.cwd, `HEAD:${newName}`) ?? '';
	} else {
		oldContents = await readGitObject(session.cwd, `HEAD:${oldName}`) ?? '';
		newContents = await readWorktreeFile(session.cwd, newName) ?? '';
	}

	return {
		oldFile: { name: oldName, contents: oldContents },
		newFile: { name: newName, contents: newContents }
	};
}

async function readMergeBase(cwd: string, base: string): Promise<string | undefined> {
	const result = await execCommand('git', ['merge-base', base, 'HEAD'], cwd, 10_000);
	return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

async function readGitObject(cwd: string, spec: string): Promise<string | undefined> {
	const result = await execCommand('git', ['show', spec], cwd, 10_000);
	return result.code === 0 ? result.stdout : undefined;
}

async function readWorktreeFile(cwd: string, file: string): Promise<string | undefined> {
	const root = resolve(cwd);
	const target = resolve(root, file);
	if (!(target === root || target.startsWith(`${root}${sep}`))) return undefined;
	try {
		return await readFile(target, 'utf8');
	} catch {
		return undefined;
	}
}

function normalizeDiffMode(value: string): DiffMode | undefined {
	return value === 'unstaged' || value === 'staged' || value === 'uncommitted' || value === 'commit' || value === 'branch' ? value : undefined;
}

async function execCommand(command: string, args: string[], cwd: string, timeout: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));
		child.on('error', (error) => {
			clearTimeout(timer);
			resolve({ code: 1, stdout, stderr: error.message });
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const text = (await readBuffer(req)).toString('utf8');
	return text ? JSON.parse(text) : {};
}

async function readBuffer(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks);
}

function sanitizeExtension(extension: string): string {
	return /^\.[a-z0-9]{1,8}$/i.test(extension) ? extension : '';
}

function handleEvents(id: string, res: ServerResponse): void {
	const snapshot = getReviewSession(id);
	if (!snapshot) {
		writeJson(res, 404, { error: 'Review not found' });
		return;
	}

	res.writeHead(200, {
		'content-type': 'text/event-stream',
		'cache-control': 'no-cache, no-transform',
		connection: 'keep-alive'
	});

	const send = (event: string, data: unknown) => {
		res.write(`event: ${event}\n`);
		res.write(`data: ${JSON.stringify(data)}\n\n`);
	};

	send('snapshot', snapshot);
	const unsubscribe = subscribeToReviewSession(id, (next) => send('snapshot', next));
	res.on('close', () => {
		unsubscribe();
		setTimeout(() => {
			if (!isReviewFinished(id) && reviewListenerCount(id) === 0) finishReview(id);
		}, 400);
	});
}

async function loadWebHandler(): Promise<WebHandler> {
	const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
	if (process.env.PI_PAIR_REVIEW_DEV === '1') {
		try {
			const { createServer: createViteServer } = await import('vite');
			const vite = await createViteServer({
				root,
				server: { middlewareMode: true },
				appType: 'custom'
			});
			return {
				dev: true,
				handler: (req, res) => vite.middlewares(req, res, () => writeHtml(res, 404, 'Not found')),
				close: () => vite.close()
			};
		} catch {
			// Fall back to the built SvelteKit handler below.
		}
	}

	const handlerPath = `${root}/build/handler.js`;
	if (!existsSync(handlerPath)) return {};
	const mod = (await import(pathToFileURL(handlerPath).href)) as { handler?: SvelteHandler };
	return { handler: mod.handler };
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(value));
}

function writeHtml(res: ServerResponse, status: number, html: string): void {
	res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
	res.end(html);
}

function renderMissingBuildPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Pi Pair Review</title>
	<style>
		body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: #0f1115; color: #e7eaf0; }
		main { max-width: 760px; margin: 12vh auto; padding: 16px; background: #171a21; border: 1px solid #2a2f3a; }
		code { background: #242a35; padding: 1px 3px; }
	</style>
</head>
<body>
	<main>
		<h1>Pi Pair Review webapp is not built</h1>
		<p>Run <code>npm run build</code> in the extension package, then start <code>/pair-review</code> again.</p>
	</main>
</body>
</html>`;
}
