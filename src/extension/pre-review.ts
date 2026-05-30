import { complete, type UserMessage } from '@earendil-works/pi-ai';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { ReviewFinding, ReviewSeverity } from '../lib/shared/review.ts';
import { getReviewSession, markPreReviewDone, markPreReviewFailed, markPreReviewRunning } from './store.ts';
import { trimPatchForModel } from './diff.ts';

const SYSTEM_PROMPT = `You are the quick first-pass reviewer for a paired code review session.
The human reviewer has already started reading the diff, so prioritize the handful of changes worth their immediate attention.
Return strict JSON only. No markdown.

JSON shape:
{
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "title": "short label",
      "file": "path/from/diff",
      "line": 123,
      "side": "additions" | "deletions",
      "rationale": "why this deserves review",
      "recommendation": "specific thing to verify or change"
    }
  ]
}

Rules:
- Prefer correctness, security, data loss, migrations, auth, concurrency, API contracts, and missing tests.
- Do not list more than 8 findings.
- Include only issues or high-risk areas visible from the diff.
- If there is no concern, return {"findings": []}.`;

export async function runPreReview(sessionId: string, ctx: ExtensionCommandContext): Promise<void> {
	const session = getReviewSession(sessionId);
	if (!session) return;

	const model = ctx.model;
	const fallbackFindings = heuristicFindings(session.patch);

	if (!model) {
		markPreReviewFailed(sessionId, 'No model selected; showing heuristic highlights only.', fallbackFindings);
		return;
	}

	markPreReviewRunning(sessionId, `${model.provider}/${model.id}`);

	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			markPreReviewFailed(
				sessionId,
				auth.ok ? `No API key available for ${model.provider}.` : auth.error,
				fallbackFindings
			);
			return;
		}

		const userMessage: UserMessage = {
			role: 'user',
			timestamp: Date.now(),
			content: [
				{
					type: 'text',
					text: `Review target: ${session.title}\nBase: ${session.baseDescription}\nRepository: ${session.cwd}\n\nChanged files:\n${session.files
						.map((file) => `- ${file.path} (+${file.additions}/-${file.deletions}, ${file.changeType})`)
						.join('\n')}\n\nDiff:\n${trimPatchForModel(session.patch)}`
				}
			]
		};

		const response = await complete(
			model,
			{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
			{ apiKey: auth.apiKey, headers: auth.headers }
		);

		const text = response.content
			.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
			.map((part) => part.text)
			.join('\n');

		const findings = parseFindings(text).map((finding, index) => ({
			...finding,
			id: `agent-${index + 1}`,
			source: 'agent' as const
		}));

		markPreReviewDone(sessionId, findings.length > 0 ? findings : fallbackFindings);
	} catch (error) {
		markPreReviewFailed(sessionId, error instanceof Error ? error.message : String(error), fallbackFindings);
	}
}

function parseFindings(text: string): Omit<ReviewFinding, 'id' | 'source'>[] {
	const json = extractJson(text);
	const parsed = JSON.parse(json) as { findings?: unknown };
	if (!Array.isArray(parsed.findings)) return [];
	return parsed.findings.flatMap((item) => normalizeFinding(item));
}

function normalizeFinding(item: unknown): Omit<ReviewFinding, 'id' | 'source'>[] {
	if (!item || typeof item !== 'object') return [];
	const value = item as Record<string, unknown>;
	const title = asString(value.title);
	const file = asString(value.file);
	const rationale = asString(value.rationale);
	if (!title || !file || !rationale) return [];

	return [
		{
			severity: normalizeSeverity(value.severity),
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

	return findings.slice(0, 8);
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

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
