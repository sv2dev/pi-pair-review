import { isReviewableImagePath } from '$lib/shared/images';
import type { ReviewAttentionLevel, ReviewFileSummary, ReviewFinding, ReviewHunkRank, ReviewMode, UserReviewComment } from '$lib/shared/review';

export interface ReviewModeOption {
	level: ReviewAttentionLevel;
	mode: ReviewMode;
	label: string;
	description: string;
	count?: number;
}

export function availableReviewLevelOptions(ranks: ReviewHunkRank[]): ReviewModeOption[] {
	const levels = ranks.length > 0 ? [...new Set(ranks.map((rank) => rank.attentionLevel))].sort((left, right) => left - right) : [1, 2, 3, 4, 5] as ReviewAttentionLevel[];
	return levels.map((level) => {
		const levelRanks = ranks.filter((rank) => rank.attentionLevel === level);
		return { ...reviewModeOption(levelRanks[0]?.mode ?? modeForLevel(level), level), count: levelRanks.length };
	});
}

export function modeForLevel(level: number): ReviewMode {
	return level === 1 ? 'deep-focus' : level === 2 ? 'careful' : level === 3 ? 'standard' : level === 4 ? 'glance' : 'background';
}

export function reviewModeOption(mode: ReviewMode, level = 1): ReviewModeOption {
	const data: Record<ReviewMode, { label: string; description: string }> = {
		'deep-focus': { label: 'Deep focus', description: 'Highest-risk correctness, security, data, and contract changes' },
		careful: { label: 'Careful', description: 'Important domain, API, or large implementation changes' },
		standard: { label: 'Standard', description: 'Normal implementation review' },
		glance: { label: 'Glance', description: 'Quick check for style-only or low-risk UI changes' },
		background: { label: 'Background', description: 'Generated, docs, fixtures, snapshots, and other low-signal changes' }
	};
	return { level: Number(level) as ReviewAttentionLevel, mode, ...data[mode] };
}

export function filterFilesForReviewLevel(files: ReviewFileSummary[], ranks: ReviewHunkRank[], level: number, isolatedLevel: boolean) {
	if (ranks.length === 0) return files;
	const visible = new Set(ranks.filter((rank) => isolatedLevel ? rank.attentionLevel === Number(level) : rank.attentionLevel <= Number(level)).map((rank) => rank.file));
	return files.filter((file) => visible.has(file.path) || (file.previousPath && visible.has(file.previousPath)) || isUnrankedImageFile(file, ranks));
}

function isUnrankedImageFile(file: ReviewFileSummary, ranks: ReviewHunkRank[]) {
	if (!isReviewableImagePath(file.path) && !isReviewableImagePath(file.previousPath)) return false;
	return !ranks.some((rank) => rank.file === file.path || rank.file === file.previousPath);
}

export function sortFilesForTree(files: ReviewFileSummary[]) {
	return [...files].sort((left, right) => compareTreeOrder(left.path, right.path));
}

export function compareTreeOrder(leftPath: string, rightPath: string) {
	const left = leftPath.split('/');
	const right = rightPath.split('/');
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const leftPart = left[index];
		const rightPart = right[index];
		if (leftPart === undefined) return 1;
		if (rightPart === undefined) return -1;
		if (leftPart === rightPart) continue;
		const leftIsDirectory = index < left.length - 1;
		const rightIsDirectory = index < right.length - 1;
		if (leftIsDirectory !== rightIsDirectory) return leftIsDirectory ? -1 : 1;
		return leftPart.localeCompare(rightPart);
	}
	return 0;
}

export function buildReviewFeedback(findings: ReviewFinding[], comments: UserReviewComment[], closingNotes: string) {
	const lines: string[] = [];
	for (const finding of findings) lines.push(formatFeedbackLine(finding.file, finding.line, finding.title));
	for (const comment of comments) lines.push(formatFeedbackLine(comment.file, comment.line, comment.body, comment.endLine));
	if (closingNotes.trim()) lines.push('', closingNotes.trim());
	return lines.join('\n');
}

function formatFeedbackLine(file: string | undefined, line: number | undefined, body: string, endLine?: number) {
	const formatted = body.replace(/\n/g, '\n  ');
	const lineLabel = line ? endLine && endLine !== line ? `:${line}-${endLine}` : `:${line}` : '';
	return file ? `- [${file}${lineLabel}] ${formatted}` : `- ${formatted}`;
}
