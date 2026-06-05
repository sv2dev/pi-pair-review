import type { ReviewFinding, ReviewSessionSnapshot, UserReviewComment } from './review.js';

const REVIEW_FEEDBACK_PREAMBLE = `Please address **all** feedback items below. Treat each bullet/comment as an explicit requested change unless it is clearly phrased as optional. After completing or blocking each individual item, immediately mark that item done or blocked before starting the next one. Before finishing, verify every item has either been implemented or explicitly called out with a reason it could not be done.`;

export function buildReviewFeedback(findings: ReviewFinding[], comments: UserReviewComment[], closingNotes = ''): string {
	const lines = buildFeedbackLines(findings, comments);
	if (closingNotes.trim()) lines.push('', closingNotes.trim());
	return withReviewFeedbackPreamble(lines);
}

export function buildSessionFeedback(session: ReviewSessionSnapshot | undefined): string {
	if (!session) return '';
	return withReviewFeedbackPreamble(buildFeedbackLines(session.preReview.findings, session.userComments));
}

function buildFeedbackLines(findings: ReviewFinding[], comments: UserReviewComment[]): string[] {
	const lines: string[] = [];
	for (const finding of findings) lines.push(formatFeedbackLine(finding.file, finding.line, finding.title));
	for (const comment of comments) lines.push(formatFeedbackLine(comment.file, comment.line, comment.body, comment.endLine));
	return lines;
}

function withReviewFeedbackPreamble(lines: string[]): string {
	if (!lines.some((line) => line.trim())) return '';
	return [REVIEW_FEEDBACK_PREAMBLE, '', ...lines].join('\n');
}

function formatFeedbackLine(file: string | undefined, line: number | undefined, body: string, endLine?: number): string {
	const formatted = body.replace(/\n/g, '\n  ');
	const lineLabel = line ? endLine && endLine !== line ? `:${line}-${endLine}` : `:${line}` : '';
	return file ? `- [${file}${lineLabel}] ${formatted}` : `- ${formatted}`;
}
