import { isReviewableImagePath } from './images.js';
import type { ReviewFinding, ReviewSessionSnapshot, UserReviewComment } from './review.js';

const REVIEW_FEEDBACK_PREAMBLE = `Please address **all** feedback items below. Treat each bullet/comment as an explicit requested change unless it is clearly phrased as optional. After completing or blocking each individual item, immediately mark that item done or blocked before starting the next one. Before finishing, verify every item has either been implemented or explicitly called out with a reason it could not be done.`;

export function buildReviewFeedback(findings: ReviewFinding[], comments: UserReviewComment[], closingNotes = '', reviewId?: string): string {
	const lines = buildFeedbackLines(findings, comments, reviewId);
	if (closingNotes.trim()) lines.push('', normalizeImageReferences(closingNotes.trim(), [], reviewId));
	return withReviewFeedbackPreamble(lines);
}

export function buildSessionFeedback(session: ReviewSessionSnapshot | undefined): string {
	if (!session) return '';
	return withReviewFeedbackPreamble(buildFeedbackLines(session.preReview.findings, session.userComments, session.id));
}

function buildFeedbackLines(findings: ReviewFinding[], comments: UserReviewComment[], reviewId?: string): string[] {
	const lines: string[] = [];
	for (const finding of findings) lines.push(formatFeedbackLine(finding.file, finding.line, finding.title, undefined, undefined, reviewId));
	for (const comment of comments) lines.push(formatFeedbackLine(comment.file, comment.line, comment.body, comment.endLine, comment.attachments, reviewId));
	return lines;
}

function withReviewFeedbackPreamble(lines: string[]): string {
	if (!lines.some((line) => line.trim())) return '';
	return [REVIEW_FEEDBACK_PREAMBLE, '', ...lines].join('\n');
}

function formatFeedbackLine(file: string | undefined, line: number | undefined, body: string, endLine?: number, attachments: UserReviewComment['attachments'] = [], reviewId?: string): string {
	const formatted = normalizeImageReferences(body, attachments, reviewId).replace(/\n/g, '\n  ');
	const lineLabel = line ? endLine && endLine !== line ? `:${line}-${endLine}` : `:${line}` : '';
	return file ? `- [${file}${lineLabel}] ${formatted}` : `- ${formatted}`;
}

function normalizeImageReferences(body: string, attachments: UserReviewComment['attachments'] = [], reviewId?: string): string {
	return body
		.replace(/!\[Image\s*(\d+)\](?!\()/gim, (match, id: string) => {
			const src = attachments[Number(id) - 1]?.src;
			return src ? imageMarkdown(feedbackImagePath(src, reviewId)) : match;
		})
		.replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/gim, (match, alt: string, src: string) => {
			const normalized = feedbackImagePath(src, reviewId);
			if (normalized === src && alt !== 'Image' && !/^Image\s*\d*$/i.test(alt)) return match;
			return imageMarkdown(normalized);
		})
		.replace(/(^|\s)(\/[^\n\r\s)]+\.(?:png|jpe?g|gif|webp))/gim, (_match, prefix: string, path: string) => `${prefix}${imageMarkdown(path)}`);
}

function imageMarkdown(path: string) {
	return `![${path}](${path})`;
}

function feedbackImagePath(src: string, reviewId?: string) {
	const attachmentPath = attachmentUrlPath(src, reviewId);
	if (attachmentPath) return attachmentPath;
	return src;
}

function attachmentUrlPath(src: string, reviewId?: string): string | undefined {
	try {
		const url = new URL(src, 'http://story-review.local');
		const expectedPath = reviewId ? `/api/reviews/${reviewId}/attachments` : undefined;
		if (expectedPath ? url.pathname !== expectedPath : !/^\/api\/reviews\/[^/]+\/attachments$/.test(url.pathname)) return undefined;
		const path = url.searchParams.get('path') ?? undefined;
		return isReviewableImagePath(path) ? path : undefined;
	} catch {
		return undefined;
	}
}
