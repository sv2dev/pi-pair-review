export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ReviewSide = 'additions' | 'deletions';
export type PreReviewStatus = 'idle' | 'running' | 'done' | 'failed';
export type ReviewThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type ReviewDiffMode = 'unstaged' | 'staged' | 'uncommitted' | 'commit' | 'branch';
export type ReviewDiffStyle = 'split' | 'unified';
export type UserReviewCommentScope = 'global' | 'file' | 'line';
export type ReviewStrategy = 'flat' | 'smart' | 'commits';
export type ReviewSortOrder = 'tree' | 'causality';

/**
 * Curated recommended agent-review models, ordered by preference. Matched against
 * a model `id` by case-insensitive substring (provider prefixes vary).
 */
export const RECOMMENDED_REVIEW_MODEL_IDS = ['gpt-5.4-mini', 'gpt-5.5', 'haiku-4.5'] as const;

/**
 * Picks the first available model id matching the recommended list, in preference order.
 * Returns undefined when none match.
 */
export function pickRecommendedModelId(modelIds: readonly string[]): string | undefined {
	const lowered = modelIds.map((id) => ({ id, lower: id.toLowerCase() }));
	for (const recommended of RECOMMENDED_REVIEW_MODEL_IDS) {
		const match = lowered.find((candidate) => candidate.lower.includes(recommended.toLowerCase()));
		if (match) return match.id;
	}
	return undefined;
}

export interface ReviewHunk {
	id: string;
	file: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
}

export interface ReviewCommit {
	sha: string;
	subject: string;
	body?: string;
	order: number;
	hunkIds: string[];
}

export interface ReviewChunk {
	id: string;
	partId: string;
	file: string;
	hunkIds: string[];
	cue?: string;
}

export interface ReviewPart {
	id: string;
	kind: 'flat' | 'patch' | 'commit';
	title: string;
	brief?: string;
	order: number;
	commitSha?: string;
}

export interface ReviewSmartPartition {
	parts: ReviewPart[];
	chunks: ReviewChunk[];
}

export interface ReviewUiSettings {
	modelKey?: string;
	thinkingLevel?: ReviewThinkingLevel;
	suggestComments?: boolean;
	strategy?: ReviewStrategy;
	sortOrder?: ReviewSortOrder;
	cueEnabled?: boolean;
	autorun?: {
		enabled: boolean;
		unconditional: boolean;
		minLines?: number;
		minFiles?: number;
		onUncommitted?: boolean;
		onSingleCommit?: boolean;
	};
	isolatedPart?: boolean;
	autoAdvance?: boolean;
	diffStyle?: ReviewDiffStyle;
	wrap?: boolean;
}

export interface ReviewFileSummary {
	path: string;
	previousPath?: string;
	additions: number;
	deletions: number;
	changeType: 'added' | 'deleted' | 'renamed' | 'modified';
}

export interface ReviewFinding {
	id: string;
	severity: ReviewSeverity;
	title: string;
	file?: string;
	line?: number;
	side?: ReviewSide;
	rationale: string;
	recommendation?: string;
	source: 'agent' | 'heuristic';
}

export interface UserReviewComment {
	id: string;
	scope: UserReviewCommentScope;
	file?: string;
	line?: number;
	side?: ReviewSide;
	endLine?: number;
	endSide?: ReviewSide;
	body: string;
	createdAt: string;
}

export interface ReviewAgentModelOption {
	key: string;
	provider: string;
	id: string;
	name: string;
	thinkingLevels: ReviewThinkingLevel[];
}

export interface ReviewSessionSnapshot {
	id: string;
	cwd: string;
	envPwd?: string;
	createdAt: string;
	title: string;
	baseDescription: string;
	diffMode?: ReviewDiffMode;
	diffBase?: string;
	patch: string;
	files: ReviewFileSummary[];
	hunks: ReviewHunk[];
	commits?: ReviewCommit[];
	userComments: UserReviewComment[];
	agentReview: {
		models: ReviewAgentModelOption[];
		defaultModelKey?: string;
		defaultThinkingLevel: ReviewThinkingLevel;
	};
	preReview: {
		status: PreReviewStatus;
		model?: string;
		startedAt?: string;
		finishedAt?: string;
		error?: string;
		overview?: string;
		assessment?: string;
		findings: ReviewFinding[];
		smart?: ReviewSmartPartition;
		causalityOrder?: string[];
	};
}

export interface ReviewSessionCreateInput {
	cwd: string;
	envPwd?: string;
	title: string;
	baseDescription: string;
	diffMode?: ReviewDiffMode;
	diffBase?: string;
	patch: string;
	files: ReviewFileSummary[];
	commits?: ReviewCommit[];
	agentReview: ReviewSessionSnapshot['agentReview'];
	onFeedback?: (feedback: string) => void;
	onAgentReview?: (input: { modelKey: string; thinkingLevel: ReviewThinkingLevel; suggestComments: boolean }) => void;
}
