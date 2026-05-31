import { completeSimple, type Model, type UserMessage } from '@earendil-works/pi-ai';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { ReviewAttentionLevel, ReviewFinding, ReviewHunkRank, ReviewMode, ReviewSeverity, ReviewThinkingLevel } from '../lib/shared/review.ts';
import { getReviewSession, markPreReviewDone, markPreReviewFailed, markPreReviewRunning } from './store.ts';
import { trimPatchForModel } from './diff.ts';

const HUNK_RANK_PROMPT = `You rank changed hunks for a progressive human review.
Return strict JSON only. No markdown.

JSON shape:
{
  "hunks": [
    { "file": "path/from/diff", "oldStart": 10, "newStart": 12, "attentionLevel": 1 | 2 | 3 | 4 | 5, "reason": "short reason" }
  ],
  "findings": [],
  "summary": "2-4 sentence high-level summary of what changed"
}

Rules:
- Rank every changed hunk in the supplied hunk list.
- attentionLevel: 1 = concise set of most important blocking/high-risk review targets only.
- attentionLevel: 2-5 = progressively less important details, polish, and context.
- Prefer correctness, security, data loss, migrations, auth, concurrency, API contracts, and missing tests.
- Return an empty findings array.`;

const REVIEW_PROMPT = `You are the quick first-pass reviewer for a paired code review session.
Return strict JSON only. No markdown.

JSON shape:
{
  "hunks": [
    { "file": "path/from/diff", "oldStart": 10, "newStart": 12, "attentionLevel": 1 | 2 | 3 | 4 | 5, "reason": "short reason" }
  ],
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "attentionLevel": 1 | 2 | 3 | 4 | 5,
      "title": "short label",
      "file": "path/from/diff",
      "line": 123,
      "side": "additions" | "deletions",
      "rationale": "why this deserves review",
      "recommendation": "specific thing to verify or change"
    }
  ],
  "summary": "2-4 sentence high-level summary of what changed"
}

Rules:
- Rank every changed hunk in the supplied hunk list.
- Do not list more than 20 findings.
- attentionLevel: 1 = concise set of the most important blocking/high-risk review targets only.
- attentionLevel: 2-5 = progressively less important details, polish, and context.
- Include only issues or high-risk areas visible from the diff.
- If there is no concern, return {"findings": []}.`;

export async function runPreReview(
	sessionId: string,
	ctx: ExtensionCommandContext,
	model: Model<any> | undefined = ctx.model,
	thinkingLevel: ReviewThinkingLevel = 'off',
	suggestComments = true
): Promise<void> {
	const session = getReviewSession(sessionId);
	if (!session) return;

	const fallback = buildHeuristicPreReview(session.patch);
	const fallbackFindings = fallback.findings;
	const fallbackHunks = fallback.hunks;

	if (!model) {
		markPreReviewFailed(sessionId, 'No model selected; showing heuristic highlights only.', fallbackFindings, fallbackHunks);
		return;
	}

	markPreReviewRunning(sessionId, `${model.provider}/${model.id}${thinkingLevel !== 'off' ? `:${thinkingLevel}` : ''}`);

	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			markPreReviewFailed(
				sessionId,
				auth.ok ? `No API key available for ${model.provider}.` : auth.error,
				fallbackFindings,
				fallbackHunks
			);
			return;
		}

		const patchHunks = parsePatchHunks(session.patch);
		const userMessage: UserMessage = {
			role: 'user',
			timestamp: Date.now(),
			content: [
				{
					type: 'text',
					text: `Review target: ${session.title}\nBase: ${session.baseDescription}\nRepository: ${session.cwd}\nSuggest comments: ${suggestComments ? 'yes' : 'no; rank hunks but return an empty findings array'}\n\nChanged files:\n${session.files
						.map((file) => `- ${file.path} (+${file.additions}/-${file.deletions}, ${file.changeType})`)
						.join('\n')}\n\nChanged hunks to rank:\n${patchHunks.map((hunk) => `- ${hunk.file} -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines}`).join('\n')}\n\nDiff:\n${trimPatchForModel(session.patch)}`
				}
			]
		};

		const response = await completeSimple(
			model,
			{ systemPrompt: suggestComments ? REVIEW_PROMPT : HUNK_RANK_PROMPT, messages: [userMessage] },
			{ apiKey: auth.apiKey, headers: auth.headers, reasoning: thinkingLevel === 'off' ? undefined : thinkingLevel }
		);

		const text = response.content
			.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
			.map((part) => part.text)
			.join('\n');

		const parsed = parsePreReview(text);
		const findings = parsed.findings.map((finding, index) => ({
			...finding,
			id: `agent-${index + 1}`,
			source: 'agent' as const
		}));

		const finalFindings = suggestComments ? (findings.length > 0 ? findings : fallbackFindings) : [];
		markPreReviewDone(sessionId, finalFindings, buildHunkRanks(session.patch, finalFindings, parsed.hunks), parsed.summary);
	} catch (error) {
		markPreReviewFailed(sessionId, error instanceof Error ? error.message : String(error), fallbackFindings, fallbackHunks);
	}
}

function parsePreReview(text: string): { findings: Omit<ReviewFinding, 'id' | 'source'>[]; hunks: Partial<ReviewHunkRank>[]; summary?: string } {
	const json = extractJson(text);
	const parsed = JSON.parse(json) as { findings?: unknown; hunks?: unknown; summary?: unknown };
	return {
		findings: Array.isArray(parsed.findings) ? parsed.findings.flatMap((item) => normalizeFinding(item)) : [],
		hunks: Array.isArray(parsed.hunks) ? parsed.hunks.flatMap((item) => normalizeHunkRank(item)) : [],
		summary: asString(parsed.summary)
	};
}

function normalizeHunkRank(item: unknown): Partial<ReviewHunkRank>[] {
	if (!item || typeof item !== 'object') return [];
	const value = item as Record<string, unknown>;
	const file = asString(value.file);
	const oldStart = asNumber(value.oldStart);
	const newStart = asNumber(value.newStart);
	if (!file || oldStart === undefined || newStart === undefined) return [];
	return [
		{
			file,
			oldStart,
			newStart,
			attentionLevel: normalizeAttentionLevel(value.attentionLevel, 'low'),
			reason: asString(value.reason)
		}
	];
}

function normalizeFinding(item: unknown): Omit<ReviewFinding, 'id' | 'source'>[] {
	if (!item || typeof item !== 'object') return [];
	const value = item as Record<string, unknown>;
	const title = asString(value.title);
	const file = asString(value.file);
	const rationale = asString(value.rationale);
	if (!title || !rationale) return [];

	return [
		{
			severity: normalizeSeverity(value.severity),
			attentionLevel: normalizeAttentionLevel(value.attentionLevel, normalizeSeverity(value.severity)),
			title,
			file,
			line: asNumber(value.line),
			side: value.side === 'deletions' ? 'deletions' : 'additions',
			rationale,
			recommendation: asString(value.recommendation)
		}
	];
}

function extractJson(text: string): string {
	const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
	if (fenced?.[1]) return fenced[1];
	const first = text.indexOf('{');
	const last = text.lastIndexOf('}');
	if (first >= 0 && last > first) return text.slice(first, last + 1);
	return text;
}

export function buildHeuristicPreReview(patch: string): { findings: ReviewFinding[]; hunks: ReviewHunkRank[]; summary: string } {
	const findings = heuristicFindings(patch);
	const hunks = buildHunkRanks(patch, findings);
	return { findings, hunks, summary: summarizeHeuristicReview(hunks) };
}

function heuristicFindings(patch: string): ReviewFinding[] {
	const findings: ReviewFinding[] = [];
	let currentFile = '';
	let newLine = 0;
	let oldLine = 0;

	for (const line of patch.split('\n')) {
		const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
		if (header) {
			currentFile = header[2] ?? header[1] ?? '';
			continue;
		}

		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			continue;
		}

		if (!currentFile) continue;
		if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;

		if (line.startsWith('+')) {
			const content = line.slice(1);
			const finding = heuristicForAddedLine(currentFile, newLine, content, findings.length + 1);
			if (finding) findings.push(finding);
			newLine += 1;
			continue;
		}

		if (line.startsWith('-')) {
			oldLine += 1;
			continue;
		}

		oldLine += 1;
		newLine += 1;
	}

	return findings.slice(0, 20);
}

function buildHunkRanks(patch: string, findings: ReviewFinding[], modelRanks: Partial<ReviewHunkRank>[] = []): ReviewHunkRank[] {
	const hunks = parsePatchHunks(patch);
	const ranks: ReviewHunkRank[] = hunks.map(({ lines, ...hunk }) => ({ ...hunk, ...classifyHunk({ ...hunk, lines }) }));

	for (const modelRank of modelRanks) {
		const match = ranks.find((hunk) => hunk.file === modelRank.file && hunk.oldStart === modelRank.oldStart && hunk.newStart === modelRank.newStart);
		if (!match || !modelRank.attentionLevel) continue;
		match.attentionLevel = modelRank.attentionLevel;
		match.mode = reviewModeForLevel(modelRank.attentionLevel);
		match.reason = modelRank.reason ?? match.reason;
	}

	for (const finding of findings) {
		if (!finding.file) continue;
		const matching = ranks.filter((hunk) => {
			if (hunk.file !== finding.file) return false;
			if (!finding.line) return true;
			if (finding.side === 'deletions') return lineInRange(finding.line, hunk.oldStart, hunk.oldLines);
			return lineInRange(finding.line, hunk.newStart, hunk.newLines);
		});
		for (const hunk of matching) {
			if (finding.attentionLevel < hunk.attentionLevel) {
				hunk.attentionLevel = finding.attentionLevel;
				hunk.mode = reviewModeForLevel(finding.attentionLevel);
				hunk.reason = finding.title;
			}
		}
	}

	return normalizeHunkRankScale(ranks);
}

function normalizeHunkRankScale(ranks: ReviewHunkRank[]): ReviewHunkRank[] {
	const levels = [...new Set(ranks.map((rank) => rank.attentionLevel))].sort((left, right) => left - right);
	const normalized = new Map(levels.map((level, index) => [level, (index + 1) as ReviewAttentionLevel]));
	return ranks.map((rank) => ({ ...rank, attentionLevel: normalized.get(rank.attentionLevel) ?? rank.attentionLevel }));
}

function parsePatchHunks(patch: string): Array<Omit<ReviewHunkRank, 'attentionLevel' | 'mode' | 'reason' | 'signals'> & { lines: string[] }> {
	const hunks: Array<Omit<ReviewHunkRank, 'attentionLevel' | 'mode' | 'reason' | 'signals'> & { lines: string[] }> = [];
	let currentFile = '';
	let index = 0;
	let currentHunk: (typeof hunks)[number] | undefined;

	for (const line of patch.split('\n')) {
		const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
		if (header) {
			currentFile = header[2] ?? header[1] ?? '';
			currentHunk = undefined;
			continue;
		}

		const rename = /^rename to (.+)$/.exec(line);
		if (rename) currentFile = rename[1] ?? currentFile;

		const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (hunk && currentFile) {
			const oldStart = Number(hunk[1]);
			const oldLines = hunk[2] === undefined ? 1 : Number(hunk[2]);
			const newStart = Number(hunk[3]);
			const newLines = hunk[4] === undefined ? 1 : Number(hunk[4]);
			currentHunk = { id: `hunk-${++index}`, file: currentFile, oldStart, oldLines, newStart, newLines, lines: [] };
			hunks.push(currentHunk);
			continue;
		}

		if (currentHunk && !line.startsWith('diff --git ')) currentHunk.lines.push(line);
	}

	return hunks;
}

function lineInRange(line: number, start: number, length: number): boolean {
	return length === 0 ? line === start : line >= start && line < start + length;
}

function classifyHunk(hunk: Omit<ReviewHunkRank, 'attentionLevel' | 'mode' | 'reason' | 'signals'> & { lines: string[] }): Pick<ReviewHunkRank, 'attentionLevel' | 'mode' | 'reason' | 'signals'> {
	const path = hunk.file.toLowerCase();
	const churn = hunk.oldLines + hunk.newLines;
	const changed = hunk.lines.filter((line) => (line.startsWith('+') && !line.startsWith('+++ ')) || (line.startsWith('-') && !line.startsWith('--- '))).map((line) => line.slice(1).trim());
	const signals: string[] = [];
	let level: ReviewAttentionLevel = 4;
	let reason = 'Small implementation change';

	if (isGeneratedPath(path)) {
		signals.push('generated');
		level = 5;
		reason = 'Generated or low-signal file';
	} else if (/auth|security|permission|policy|acl|rbac|payment|billing|credential|token|secret|session|crypto/.test(path)) {
		signals.push('security-sensitive');
		level = 1;
		reason = 'Security, auth, credential, or payment-sensitive path';
	} else if (/migration|schema|prisma|drizzle|typeorm|sequelize|database|\bsql\b|\.sql$/.test(path)) {
		signals.push('data-model');
		level = 1;
		reason = 'Database schema or migration change';
	} else if (/domain|model|entity|aggregate|contract|api|route|endpoint|validation|serializer|schema/.test(path)) {
		signals.push('contract-or-domain');
		level = 2;
		reason = 'Domain model, API contract, or validation change';
	} else if (isStyleOnly(path, hunk.lines, changed)) {
		signals.push('style-only');
		level = 4;
		reason = 'Style or markup-class-only change';
	} else if (/test|spec|fixture|snapshot|readme|docs?\//.test(path)) {
		signals.push('test-or-docs');
		level = 5;
		reason = 'Tests, fixtures, snapshots, or documentation';
	} else if (churn > 80) {
		signals.push('large-change');
		level = 2;
		reason = 'Large hunk worth careful review';
	} else if (churn > 30) {
		signals.push('medium-change');
		level = 3;
		reason = 'Medium-sized hunk';
	}

	return { attentionLevel: level, mode: reviewModeForLevel(level), reason, signals };
}

function isGeneratedPath(path: string): boolean {
	return /(^|\/)(dist|build|coverage|\.svelte-kit|\.next|\.nuxt|generated|\.generated)(\/|$)/.test(path) || /(?:^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|.*\.log|.*\.min\.(js|css)|.*\.snap)$/.test(path);
}

function isStyleOnly(path: string, hunkLines: string[], changed: string[]): boolean {
	if (/\.(css|scss|sass|less|pcss|postcss)$/.test(path)) return true;
	if (!/\.(svelte|vue|jsx|tsx|html)$/.test(path) || changed.length === 0) return false;
	if (hunkLines.some((line) => /<\/?script\b/i.test(line))) return false;
	return changed.every((line) =>
		line === '' ||
		/^class(Name)?=/.test(line) ||
		/^style=/.test(line) ||
		/^<\/?(div|span|section|main|header|footer|aside|button|a|p|ul|ol|li|label|input|form|nav)\b[^>{]*(class|style)=/.test(line) ||
		/^[}\])]*$/.test(line)
	);
}

function reviewModeForLevel(level: ReviewAttentionLevel): ReviewMode {
	return level === 1 ? 'deep-focus' : level === 2 ? 'careful' : level === 3 ? 'standard' : level === 4 ? 'glance' : 'background';
}

function summarizeHeuristicReview(hunks: ReviewHunkRank[]): string {
	if (hunks.length === 0) return 'No changed hunks detected.';
	const counts = new Map<string, number>();
	for (const hunk of hunks) for (const signal of hunk.signals ?? []) counts.set(signal, (counts.get(signal) ?? 0) + 1);
	const highlights = [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 3).map(([signal, count]) => `${count} ${signal}`);
	return `Deterministic review routing classified ${hunks.length} changed hunks${highlights.length ? ` (${highlights.join(', ')})` : ''}. Use the named review modes to focus on the eligible levels for this change.`;
}

function heuristicForAddedLine(file: string, line: number, content: string, index: number): ReviewFinding | undefined {
	const checks: Array<{ pattern: RegExp; severity: ReviewSeverity; title: string; rationale: string; recommendation: string }> = [
		{
			pattern: /\b(eval|new Function)\s*\(/,
			severity: 'critical',
			title: 'Dynamic code execution added',
			rationale: 'Dynamic code execution is usually security-sensitive and can turn data into executable code.',
			recommendation: 'Verify the input is trusted or replace this with a safer explicit implementation.'
		},
		{
			pattern: /dangerouslySetInnerHTML|innerHTML\s*=/,
			severity: 'high',
			title: 'Raw HTML injection path changed',
			rationale: 'Rendering raw HTML can introduce XSS if any part of the value is user-controlled.',
			recommendation: 'Check sanitization and prefer structured rendering when possible.'
		},
		{
			pattern: /\bTODO\b|\bFIXME\b|throw new Error\(['\"]TODO/i,
			severity: 'medium',
			title: 'Unfinished implementation marker added',
			rationale: 'The diff adds a marker that often indicates incomplete behavior.',
			recommendation: 'Confirm this is intentionally deferred and covered by a follow-up task.'
		},
		{
			pattern: /\bconsole\.log\s*\(/,
			severity: 'low',
			title: 'Debug logging added',
			rationale: 'Debug logging can leak noisy or sensitive runtime information.',
			recommendation: 'Remove it or use the project logger with appropriate level and redaction.'
		},
		{
			pattern: /\bpassword\b|\bsecret\b|\btoken\b|api[_-]?key/i,
			severity: 'high',
			title: 'Credential-related code changed',
			rationale: 'Credential handling changes are high-risk and deserve explicit review.',
			recommendation: 'Verify values are never logged, persisted insecurely, or exposed to clients.'
		}
	];

	const hit = checks.find((check) => check.pattern.test(content));
	if (!hit) return undefined;
	return {
		id: `heuristic-${index}`,
		severity: hit.severity,
		attentionLevel: severityAttentionLevel(hit.severity),
		title: hit.title,
		file,
		line,
		side: 'additions',
		rationale: hit.rationale,
		recommendation: hit.recommendation,
		source: 'heuristic'
	};
}

function normalizeSeverity(value: unknown): ReviewSeverity {
	return value === 'critical' || value === 'high' || value === 'medium' || value === 'low' ? value : 'medium';
}

function normalizeAttentionLevel(value: unknown, severity: ReviewSeverity) {
	return typeof value === 'number' && value >= 1 && value <= 5 ? (Math.round(value) as ReviewAttentionLevel) : severityAttentionLevel(severity);
}

function severityAttentionLevel(severity: ReviewSeverity) {
	return (severity === 'critical' ? 1 : severity === 'high' ? 2 : severity === 'medium' ? 3 : 4) as ReviewAttentionLevel;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
