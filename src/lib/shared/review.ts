export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ReviewSide = 'additions' | 'deletions';
export type PreReviewStatus = 'idle' | 'running' | 'done' | 'failed';

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
	file: string;
	line?: number;
	side?: ReviewSide;
	rationale: string;
	recommendation?: string;
	source: 'agent' | 'heuristic';
}

export interface ReviewSessionSnapshot {
	id: string;
	cwd: string;
	createdAt: string;
	title: string;
	baseDescription: string;
	patch: string;
	files: ReviewFileSummary[];
	preReview: {
		status: PreReviewStatus;
		model?: string;
		startedAt?: string;
		finishedAt?: string;
		error?: string;
		findings: ReviewFinding[];
	};
}

export interface ReviewSessionCreateInput {
	cwd: string;
	title: string;
	baseDescription: string;
	patch: string;
	files: ReviewFileSummary[];
}
