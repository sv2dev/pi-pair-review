import { randomUUID } from 'node:crypto';
import type { ReviewDiffMode, ReviewFileSummary, ReviewFinding, ReviewHunkRank, ReviewSessionCreateInput, ReviewSessionSnapshot, UserReviewComment, ReviewThinkingLevel } from '../lib/shared/review.ts';

type Listener = (snapshot: ReviewSessionSnapshot) => void;
type FeedbackHandler = (feedback: string) => void;
type AgentReviewHandler = (input: { modelKey: string; thinkingLevel: ReviewThinkingLevel; suggestComments: boolean }) => void;

const sessions = new Map<string, ReviewSessionSnapshot>();
const listeners = new Map<string, Set<Listener>>();
const feedbackHandlers = new Map<string, FeedbackHandler>();
const agentReviewHandlers = new Map<string, AgentReviewHandler>();

export function createReviewSession(input: ReviewSessionCreateInput): ReviewSessionSnapshot {
	const id = randomUUID();
	const { onFeedback, onAgentReview, ...snapshotInput } = input;
	const snapshot: ReviewSessionSnapshot = {
		...snapshotInput,
		id,
		createdAt: new Date().toISOString(),
		userComments: [],
		preReview: {
			status: 'idle',
			findings: [],
			hunks: []
		}
	};
	sessions.set(id, snapshot);
	if (onFeedback) feedbackHandlers.set(id, onFeedback);
	if (onAgentReview) agentReviewHandlers.set(id, onAgentReview);
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

export function markHeuristicPreReview(id: string, hunks: ReviewHunkRank[]): void {
	update(id, (snapshot) => ({
		...snapshot,
		preReview: {
			...snapshot.preReview,
			status: 'idle',
			summary: undefined,
			findings: [],
			hunks
		}
	}));
}

export function markPreReviewDone(id: string, findings: ReviewFinding[], hunks: ReviewHunkRank[], summary?: string): void {
	update(id, (snapshot) => ({
		...snapshot,
		preReview: {
			...snapshot.preReview,
			status: 'done',
			finishedAt: new Date().toISOString(),
			summary,
			findings,
			hunks
		}
	}));
}

export function markPreReviewFailed(id: string, error: string, findings: ReviewFinding[], hunks: ReviewHunkRank[]): void {
	update(id, (snapshot) => ({
		...snapshot,
		preReview: {
			...snapshot.preReview,
			status: 'failed',
			finishedAt: new Date().toISOString(),
			error,
			findings,
			hunks
		}
	}));
}

export function replaceReviewDiff(id: string, input: { cwd?: string; title: string; baseDescription: string; diffMode: ReviewDiffMode; diffBase?: string; patch: string; files: ReviewFileSummary[]; hunks: ReviewHunkRank[] }): boolean {
	let replaced = false;
	update(id, (snapshot) => {
		replaced = true;
		return {
			...snapshot,
			cwd: input.cwd ?? snapshot.cwd,
			title: input.title,
			baseDescription: input.baseDescription,
			diffMode: input.diffMode,
			diffBase: input.diffBase,
			patch: input.patch,
			files: input.files,
			userComments: [],
			preReview: {
				status: 'idle',
				findings: [],
				hunks: input.hunks
			}
		};
	});
	return replaced;
}

export function addUserComment(id: string, input: Omit<UserReviewComment, 'id' | 'createdAt'>): UserReviewComment | undefined {
	const comment: UserReviewComment = {
		...input,
		id: randomUUID(),
		createdAt: new Date().toISOString()
	};
	update(id, (snapshot) => ({ ...snapshot, userComments: [...snapshot.userComments, comment] }));
	return comment;
}

export function updateUserComment(id: string, commentId: string, body: string): UserReviewComment | undefined {
	let updated: UserReviewComment | undefined;
	update(id, (snapshot) => {
		const userComments = snapshot.userComments.map((comment) => {
			if (comment.id !== commentId) return comment;
			updated = { ...comment, body };
			return updated;
		});
		return { ...snapshot, userComments };
	});
	return updated;
}

export function removeUserComment(id: string, commentId: string): boolean {
	let removed = false;
	update(id, (snapshot) => {
		const userComments = snapshot.userComments.filter((comment) => comment.id !== commentId);
		removed = userComments.length !== snapshot.userComments.length;
		return { ...snapshot, userComments };
	});
	return removed;
}

export function removeReviewFinding(id: string, findingId: string): boolean {
	let removed = false;
	update(id, (snapshot) => {
		const findings = snapshot.preReview.findings.filter((finding) => finding.id !== findingId);
		removed = findings.length !== snapshot.preReview.findings.length;
		return { ...snapshot, preReview: { ...snapshot.preReview, findings } };
	});
	return removed;
}

export function finishReview(id: string, feedback?: string): boolean {
	const handler = feedbackHandlers.get(id);
	if (!handler) return false;
	handler(feedback?.trim() ? feedback : buildFeedback(sessions.get(id)));
	feedbackHandlers.delete(id);
	agentReviewHandlers.delete(id);
	return true;
}

export function getReviewFeedback(id: string): string | undefined {
	const session = sessions.get(id);
	return session ? buildFeedback(session) : undefined;
}

export function isReviewFinished(id: string): boolean {
	return !feedbackHandlers.has(id);
}

export function reviewListenerCount(id: string): number {
	return listeners.get(id)?.size ?? 0;
}

export function startAgentReview(id: string, input: { modelKey: string; thinkingLevel: ReviewThinkingLevel; suggestComments: boolean }): boolean {
	const handler = agentReviewHandlers.get(id);
	if (!handler) return false;
	handler(input);
	return true;
}

function update(id: string, fn: (snapshot: ReviewSessionSnapshot) => ReviewSessionSnapshot): void {
	const current = sessions.get(id);
	if (!current) return;
	sessions.set(id, fn(current));
	emit(id);
}

function buildFeedback(session: ReviewSessionSnapshot | undefined): string {
	if (!session) return '';
	const lines: string[] = [];
	for (const finding of session.preReview.findings) lines.push(formatFeedbackLine(finding.file, finding.line, finding.title));
	for (const comment of session.userComments) lines.push(formatFeedbackLine(comment.file, comment.line, comment.body, comment.endLine));
	return lines.join('\n');
}

function formatFeedbackLine(file: string | undefined, line: number | undefined, body: string, endLine?: number): string {
	const formatted = body.replace(/\n/g, '\n  ');
	const lineLabel = line ? endLine && endLine !== line ? `:${line}-${endLine}` : `:${line}` : '';
	return file ? `- [${file}${lineLabel}] ${formatted}` : `- ${formatted}`;
}

function emit(id: string): void {
	const snapshot = sessions.get(id);
	if (!snapshot) return;
	for (const listener of listeners.get(id) ?? []) {
		listener(snapshot);
	}
}
