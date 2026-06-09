import { randomUUID } from 'node:crypto';
import { buildSessionFeedback } from '../lib/shared/feedback.ts';
import type { ReviewCommit, ReviewDiffMode, ReviewFileSummary, ReviewFinding, ReviewHunk, ReviewSessionCreateInput, ReviewSessionSnapshot, ReviewSmartPartition, UserReviewComment, ReviewThinkingLevel } from '../lib/shared/review.ts';
import { parseReviewHunks } from './diff.ts';

type Listener = (snapshot: ReviewSessionSnapshot) => void;
type FeedbackHandler = (feedback: string) => void;
type AgentReviewHandler = (input: { modelKey: string; thinkingLevel: ReviewThinkingLevel; suggestComments: boolean }) => void;

const sessions = new Map<string, ReviewSessionSnapshot>();
const listeners = new Map<string, Set<Listener>>();
const feedbackHandlers = new Map<string, FeedbackHandler>();
const agentReviewHandlers = new Map<string, AgentReviewHandler>();

export function createReviewSession(input: ReviewSessionCreateInput): ReviewSessionSnapshot {
	const id = randomUUID();
	const { onFeedback, onAgentReview, commits, ...snapshotInput } = input;
	const snapshot: ReviewSessionSnapshot = {
		...snapshotInput,
		id,
		createdAt: new Date().toISOString(),
		hunks: parseReviewHunks(input.patch),
		commits: commits ?? [],
		userComments: [],
		preReview: {
			status: 'idle',
			findings: []
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

export function markPreReviewDone(id: string, payload: { overview?: string; assessment?: string; comments: ReviewFinding[]; smart?: ReviewSmartPartition; causalityOrder?: string[] }): void {
	update(id, (snapshot) => ({
		...snapshot,
		preReview: {
			...snapshot.preReview,
			status: 'done',
			finishedAt: new Date().toISOString(),
			overview: payload.overview,
			assessment: payload.assessment,
			findings: payload.comments,
			smart: payload.smart,
			causalityOrder: payload.causalityOrder
		}
	}));
}

export function markPreReviewFailed(id: string, error: string, findings: ReviewFinding[] = []): void {
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

export function replaceReviewDiff(id: string, input: { cwd?: string; title: string; baseDescription: string; diffMode: ReviewDiffMode; diffBase?: string; patch: string; files: ReviewFileSummary[]; commits?: ReviewCommit[] }): boolean {
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
			hunks: parseReviewHunks(input.patch),
			commits: input.commits ?? [],
			userComments: [],
			preReview: {
				status: 'idle',
				findings: []
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

export function updateUserComment(id: string, commentId: string, input: { body: string; attachments?: UserReviewComment['attachments'] }): UserReviewComment | undefined {
	let updated: UserReviewComment | undefined;
	update(id, (snapshot) => {
		const userComments = snapshot.userComments.map((comment) => {
			if (comment.id !== commentId) return comment;
			updated = { ...comment, body: input.body, attachments: input.attachments };
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
	handler(feedback?.trim() ? feedback : buildSessionFeedback(sessions.get(id)));
	feedbackHandlers.delete(id);
	agentReviewHandlers.delete(id);
	return true;
}

export function getReviewFeedback(id: string): string | undefined {
	const session = sessions.get(id);
	return session ? buildSessionFeedback(session) : undefined;
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

function emit(id: string): void {
	const snapshot = sessions.get(id);
	if (!snapshot) return;
	for (const listener of listeners.get(id) ?? []) {
		listener(snapshot);
	}
}
