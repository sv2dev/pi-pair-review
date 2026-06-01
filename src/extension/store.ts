import { randomUUID } from 'node:crypto';
import type { ReviewDiffMode, ReviewFileSummary, ReviewFinding, ReviewHunkRank, ReviewSessionCreateInput, ReviewSessionSnapshot, UserReviewAnnotation, ReviewThinkingLevel } from '../lib/shared/review.ts';

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
		userAnnotations: [],
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

export function replaceReviewDiff(id: string, input: { title: string; baseDescription: string; diffMode: ReviewDiffMode; diffBase?: string; patch: string; files: ReviewFileSummary[]; hunks: ReviewHunkRank[] }): boolean {
	let replaced = false;
	update(id, (snapshot) => {
		replaced = true;
		return {
			...snapshot,
			title: input.title,
			baseDescription: input.baseDescription,
			diffMode: input.diffMode,
			diffBase: input.diffBase,
			patch: input.patch,
			files: input.files,
			userAnnotations: [],
			preReview: {
				status: 'idle',
				findings: [],
				hunks: input.hunks
			}
		};
	});
	return replaced;
}

export function addUserAnnotation(id: string, input: Omit<UserReviewAnnotation, 'id' | 'createdAt'>): UserReviewAnnotation | undefined {
	const annotation: UserReviewAnnotation = {
		...input,
		id: randomUUID(),
		createdAt: new Date().toISOString()
	};
	update(id, (snapshot) => ({ ...snapshot, userAnnotations: [...snapshot.userAnnotations, annotation] }));
	return annotation;
}

export function updateUserAnnotation(id: string, annotationId: string, body: string): UserReviewAnnotation | undefined {
	let updated: UserReviewAnnotation | undefined;
	update(id, (snapshot) => {
		const userAnnotations = snapshot.userAnnotations.map((annotation) => {
			if (annotation.id !== annotationId) return annotation;
			updated = { ...annotation, body };
			return updated;
		});
		return { ...snapshot, userAnnotations };
	});
	return updated;
}

export function removeUserAnnotation(id: string, annotationId: string): boolean {
	let removed = false;
	update(id, (snapshot) => {
		const userAnnotations = snapshot.userAnnotations.filter((annotation) => annotation.id !== annotationId);
		removed = userAnnotations.length !== snapshot.userAnnotations.length;
		return { ...snapshot, userAnnotations };
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
	for (const annotation of session.userAnnotations) lines.push(formatFeedbackLine(annotation.file, annotation.line, annotation.body));
	return lines.join('\n');
}

function formatFeedbackLine(file: string | undefined, line: number | undefined, body: string): string {
	const formatted = body.replace(/\n/g, '\n  ');
	return file ? `- [${file}${line ? `:${line}` : ''}] ${formatted}` : `- ${formatted}`;
}

function emit(id: string): void {
	const snapshot = sessions.get(id);
	if (!snapshot) return;
	for (const listener of listeners.get(id) ?? []) {
		listener(snapshot);
	}
}
