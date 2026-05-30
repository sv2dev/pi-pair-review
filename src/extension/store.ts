import { randomUUID } from 'node:crypto';
import type { ReviewFinding, ReviewSessionCreateInput, ReviewSessionSnapshot } from '../lib/shared/review.ts';

type Listener = (snapshot: ReviewSessionSnapshot) => void;

const sessions = new Map<string, ReviewSessionSnapshot>();
const listeners = new Map<string, Set<Listener>>();

export function createReviewSession(input: ReviewSessionCreateInput): ReviewSessionSnapshot {
	const id = randomUUID();
	const snapshot: ReviewSessionSnapshot = {
		...input,
		id,
		createdAt: new Date().toISOString(),
		preReview: {
			status: 'idle',
			findings: []
		}
	};
	sessions.set(id, snapshot);
	emit(id);
	return snapshot;
}

export function getReviewSession(id: string): ReviewSessionSnapshot | undefined {
	return sessions.get(id);
}

export function subscribeToReviewSession(id: string, listener: Listener): () => void {
	let set = listeners.get(id);
	if (!set) {
		set = new Set();
		listeners.set(id, set);
	}
	set.add(listener);
	const snapshot = sessions.get(id);
	if (snapshot) listener(snapshot);
	return () => {
		set?.delete(listener);
		if (set?.size === 0) listeners.delete(id);
	};
}

export function markPreReviewRunning(id: string, model?: string): void {
	update(id, (snapshot) => ({
		...snapshot,
		preReview: {
			...snapshot.preReview,
			status: 'running',
			model,
			startedAt: new Date().toISOString(),
			error: undefined
		}
	}));
}

export function markPreReviewDone(id: string, findings: ReviewFinding[]): void {
	update(id, (snapshot) => ({
		...snapshot,
		preReview: {
			...snapshot.preReview,
			status: 'done',
			finishedAt: new Date().toISOString(),
			findings
		}
	}));
}

export function markPreReviewFailed(id: string, error: string, findings: ReviewFinding[]): void {
	update(id, (snapshot) => ({
		...snapshot,
		preReview: {
			...snapshot.preReview,
			status: 'failed',
			finishedAt: new Date().toISOString(),
			error,
			findings
		}
	}));
}

function update(id: string, fn: (snapshot: ReviewSessionSnapshot) => ReviewSessionSnapshot): void {
	const current = sessions.get(id);
	if (!current) return;
	sessions.set(id, fn(current));
	emit(id);
}

function emit(id: string): void {
	const snapshot = sessions.get(id);
	if (!snapshot) return;
	for (const listener of listeners.get(id) ?? []) {
		listener(snapshot);
	}
}
