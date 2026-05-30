import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { getReviewSession, subscribeToReviewSession } from './store.ts';

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
	const [, , , id, tail] = url.pathname.split('/');
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

	writeJson(res, 404, { error: 'Not found' });
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
	res.on('close', unsubscribe);
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
