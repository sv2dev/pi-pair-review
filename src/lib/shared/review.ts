export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ReviewSide = 'additions' | 'deletions';
export type PreReviewStatus = 'idle' | 'running' | 'done' | 'failed';
export type ReviewThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type ReviewAttentionLevel = 1 | 2 | 3 | 4 | 5;
export type ReviewMode = 'deep-focus' | 'careful' | 'standard' | 'glance' | 'background';
export type ReviewDiffMode = 'unstaged' | 'staged' | 'uncommitted' | 'commit' | 'branch';
export type UserReviewAnnotationScope = 'global' | 'file' | 'line';

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
	attentionLevel: ReviewAttentionLevel;
	title: string;
	file?: string;
	line?: number;
	side?: ReviewSide;
	rationale: string;
	recommendation?: string;
	source: 'agent' | 'heuristic';
}

export interface ReviewHunkRank {
	id: string;
	file: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	attentionLevel: ReviewAttentionLevel;
	mode?: ReviewMode;
	reason?: string;
	signals?: string[];
}

export interface UserReviewAnnotation {
	id: string;
	scope: UserReviewAnnotationScope;
	file?: string;
	line?: number;
	side?: ReviewSide;
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
	createdAt: string;
	title: string;
	baseDescription: string;
	diffMode?: ReviewDiffMode;
	diffBase?: string;
	patch: string;
	files: ReviewFileSummary[];
	userAnnotations: UserReviewAnnotation[];
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
		summary?: string;
		findings: ReviewFinding[];
		hunks: ReviewHunkRank[];
	};
}

export interface ReviewSessionCreateInput {
	cwd: string;
	title: string;
	baseDescription: string;
	diffMode?: ReviewDiffMode;
	diffBase?: string;
	patch: string;
	files: ReviewFileSummary[];
	agentReview: ReviewSessionSnapshot['agentReview'];
	onFeedback?: (feedback: string) => void;
	onAgentReview?: (input: { modelKey: string; thinkingLevel: ReviewThinkingLevel; suggestComments: boolean }) => void;
}
