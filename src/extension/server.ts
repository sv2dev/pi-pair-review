import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { addUserAnnotation, finishReview, getReviewFeedback, getReviewSession, isReviewFinished, removeReviewFinding, removeUserAnnotation, reviewListenerCount, startAgentReview, subscribeToReviewSession, updateUserAnnotation } from './store.ts';

type SvelteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

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
	const svelteHandler = await loadSvelteHandler();

	const server = createServer((req, res) => {
		void handleRequest(req, res, svelteHandler);
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(51987, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});

	const address = server.address() as AddressInfo;
	const origin = `http://127.0.0.1:${address.port}`;

	return {
		origin,
		urlForReview: (id) => `${origin}/review/${id}`,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			})
	};
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, svelteHandler: SvelteHandler | undefined): Promise<void> {
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

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
			const annotationBody = typeof value.body === 'string' ? value.body.trim() : '';
			if (!annotationBody || (scope !== 'global' && !file) || (scope === 'line' && (!line || !side))) {
				writeJson(res, 400, { error: 'Missing annotation fields' });
				return;
			}
			const annotation = addUserAnnotation(id, { scope, file, line, side, body: annotationBody });
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
		}, 750);
	});
}

async function loadSvelteHandler(): Promise<SvelteHandler | undefined> {
	const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
	const handlerPath = `${root}/build/handler.js`;
	if (!existsSync(handlerPath)) return undefined;
	const mod = (await import(pathToFileURL(handlerPath).href)) as { handler?: SvelteHandler };
	return mod.handler;
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
		main { max-width: 760px; margin: 12vh auto; padding: 32px; background: #171a21; border: 1px solid #2a2f3a; border-radius: 18px; }
		code { background: #242a35; border-radius: 6px; padding: 2px 6px; }
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
