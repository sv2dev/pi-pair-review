import { spawn } from 'node:child_process';
import type { ReviewCommit, ReviewFileSummary, ReviewHunk } from '../lib/shared/review.ts';

export type DiffMode = 'unstaged' | 'staged' | 'uncommitted' | 'commit' | 'branch';

export interface DiffCommand {
	command: string[];
	baseDescription: string;
	mode: DiffMode;
	base?: string;
}

export function buildDiffCommand(args: string, options: { hasUncommittedChanges?: boolean } = {}): DiffCommand {
	const tokens = splitArgs(args.trim());
	return buildDiffCommandFromTokens(tokens, options);
}

export function buildDiffCommandFromSelection(input: { mode: DiffMode; base?: string }): DiffCommand {
	if (input.mode === 'staged') return diffCommandForMode('staged');
	if (input.mode === 'unstaged') return diffCommandForMode('unstaged');
	if (input.mode === 'uncommitted') return diffCommandForMode('uncommitted');
	if (input.mode === 'commit') return diffCommandForMode('commit');
	return diffCommandForMode('branch', input.base);
}

export function buildDiffCommandFromTokens(tokens: string[], options: { hasUncommittedChanges?: boolean } = {}): DiffCommand {
	const readValue = (...names: string[]) => {
		for (const name of names) {
			const index = tokens.indexOf(name);
			if (index >= 0 && tokens[index + 1] && !tokens[index + 1]!.startsWith('-')) return tokens[index + 1];
			const prefixed = tokens.find((token) => token.startsWith(`${name}=`));
			if (prefixed) return prefixed.slice(name.length + 1);
		}
		return undefined;
	};

	if (tokens.includes('--staged') || tokens.includes('--cached') || tokens.includes('-s')) return diffCommandForMode('staged');
	if (tokens.includes('--unstaged') || tokens.includes('-u')) return diffCommandForMode('unstaged');
	if (tokens.includes('--uncommitted') || tokens.includes('--all') || tokens.includes('-c')) return diffCommandForMode('uncommitted');
	if (tokens.includes('--branch')) return diffCommandForMode('branch', readValue('--branch', '--base', '--target'));

	const base = tokens.find((token) => !token.startsWith('-'));
	if (base) return diffCommandForMode('branch', base);

	return options.hasUncommittedChanges ? diffCommandForMode('uncommitted') : diffCommandForMode('commit');
}

function diffCommandForMode(mode: DiffMode, base?: string): DiffCommand {
	const common = ['git', 'diff', '--no-ext-diff', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/'];
	if (mode === 'staged') return { command: [...common, '--cached'], baseDescription: 'staged changes', mode };
	if (mode === 'unstaged') return { command: withUntrackedDiff(common), baseDescription: 'unstaged changes', mode };
	if (mode === 'uncommitted') return { command: withUntrackedDiff([...common, 'HEAD']), baseDescription: 'uncommitted changes', mode };
	if (mode === 'commit') return { command: [...common, 'HEAD^..HEAD'], baseDescription: 'last commit', mode };
	const branchBase = base?.trim() || 'origin/main';
	return { command: [...common, `${branchBase}...HEAD`], baseDescription: `${branchBase}...HEAD`, mode, base: branchBase };
}

function withUntrackedDiff(trackedDiffCommand: string[]): string[] {
	const quotedTrackedDiffCommand = trackedDiffCommand.map(shellQuote).join(' ');
	return [
		'bash',
		'-c',
		`${quotedTrackedDiffCommand}\n` +
			`status=$?\n` +
			`if [ "$status" -gt 1 ]; then exit "$status"; fi\n` +
			`while IFS= read -r -d '' path; do\n` +
			`  git diff --no-ext-diff --no-index -- /dev/null "$path"\n` +
			`  status=$?\n` +
			`  if [ "$status" -gt 1 ]; then exit "$status"; fi\n` +
			`done < <(git ls-files --others --exclude-standard -z)`
	];
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function summarizePatchFiles(patch: string): ReviewFileSummary[] {
	const summaries = new Map<string, ReviewFileSummary>();
	let current: ReviewFileSummary | undefined;

	for (const line of patch.split('\n')) {
		const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
		if (header) {
			const path = header[2] ?? header[1] ?? 'unknown';
			current = {
				path,
				previousPath: header[1] !== path ? header[1] : undefined,
				additions: 0,
				deletions: 0,
				changeType: header[1] !== path ? 'renamed' : 'modified'
			};
			summaries.set(path, current);
			continue;
		}

		if (!current) continue;
		if (line.startsWith('new file mode ')) current.changeType = 'added';
		if (line.startsWith('deleted file mode ')) current.changeType = 'deleted';
		if (line.startsWith('rename from ')) current.previousPath = line.slice('rename from '.length);
		if (line.startsWith('rename to ')) {
			current.path = line.slice('rename to '.length);
			current.changeType = 'renamed';
		}
		if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
		if (line.startsWith('+')) current.additions += 1;
		if (line.startsWith('-')) current.deletions += 1;
	}

	return Array.from(summaries.values());
}

export function trimPatchForModel(patch: string, maxChars = 80_000): string {
	if (patch.length <= maxChars) return patch;
	const head = patch.slice(0, Math.floor(maxChars * 0.7));
	const tail = patch.slice(-Math.floor(maxChars * 0.25));
	return `${head}\n\n[... diff truncated for pre-review: ${patch.length - head.length - tail.length} characters omitted ...]\n\n${tail}`;
}

export function splitArgs(input: string): string[] {
	if (!input) return [];
	const matches = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
	return matches.map((token) => token.replace(/^["']|["']$/g, ''));
}

export function parseReviewHunks(patch: string): ReviewHunk[] {
	const hunks: ReviewHunk[] = [];
	let currentFile = '';

	for (const line of patch.split('\n')) {
		const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
		if (header) {
			currentFile = header[2] ?? header[1] ?? '';
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
			hunks.push({
				id: `${currentFile}:${oldStart}:${newStart}`,
				file: currentFile,
				oldStart,
				oldLines,
				newStart,
				newLines
			});
		}
	}

	return hunks;
}

export async function enumerateCommits(cwd: string, mode: DiffMode, base?: string): Promise<ReviewCommit[]> {
	if (mode !== 'commit' && mode !== 'branch') return [];

	const fieldSeparator = String.fromCharCode(0);
	const recordSeparator = String.fromCharCode(30);
	const range = mode === 'commit' ? 'HEAD^..HEAD' : `${base?.trim() || 'origin/main'}...HEAD`;
	const log = await execGit(['log', `--format=%H%x00%s%x00%b%x1e`, '--reverse', range], cwd);
	if (log.code !== 0) return [];

	const entries = log.stdout.split(recordSeparator).map((entry) => entry.replace(/^\n/, '')).filter((entry) => entry.trim().length > 0);

	const commits: ReviewCommit[] = [];
	for (const entry of entries) {
		const [sha = '', subject = '', body = ''] = entry.split(fieldSeparator);
		const trimmedSha = sha.trim();
		if (!trimmedSha) continue;
		commits.push({
			sha: trimmedSha,
			subject: subject.trim(),
			body: body.trim() || undefined,
			order: commits.length,
			hunkIds: []
		});
	}

	return commits;
}

// Attributes each canonical hunk (from the aggregate patch) to the most-recent commit whose own
// new-side hunk ranges overlap it. Walks newest-first so the latest touching commit wins; a hunk is
// assigned to exactly one commit. Falls back to coarse file-level attribution when a commit's own
// diff cannot be produced (e.g. a root commit without a parent).
export async function attributeCommitHunks(cwd: string, commits: ReviewCommit[], hunks: ReviewHunk[]): Promise<void> {
	if (commits.length === 0 || hunks.length === 0) return;

	const assigned = new Set<string>();
	for (let index = commits.length - 1; index >= 0; index -= 1) {
		const commit = commits[index]!;
		const diff = await execGit(['diff', '--no-ext-diff', '--find-renames', `${commit.sha}^!`], cwd);
		const commitHunks = parseReviewHunks(diff.stdout);

		if (diff.code !== 0 && commitHunks.length === 0) {
			// NOTE: file-level fallback — diff of the commit against its parent was unavailable.
			const touched = new Set(parseReviewHunks(diff.stdout).map((hunk) => hunk.file));
			for (const hunk of hunks) {
				if (assigned.has(hunk.id) || !touched.has(hunk.file)) continue;
				assigned.add(hunk.id);
				commit.hunkIds.push(hunk.id);
			}
			continue;
		}

		for (const hunk of hunks) {
			if (assigned.has(hunk.id)) continue;
			const overlaps = commitHunks.some((candidate) => candidate.file === hunk.file && rangesOverlap(candidate.newStart, candidate.newLines, hunk.newStart, hunk.newLines));
			if (!overlaps) continue;
			assigned.add(hunk.id);
			commit.hunkIds.push(hunk.id);
		}
	}

	for (const commit of commits) commit.hunkIds.sort();
}

function rangesOverlap(startA: number, lengthA: number, startB: number, lengthB: number): boolean {
	const endA = startA + Math.max(lengthA, 1);
	const endB = startB + Math.max(lengthB, 1);
	return startA < endB && startB < endA;
}

async function execGit(args: string[], cwd: string, timeout = 30_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));
		child.on('error', (error) => {
			clearTimeout(timer);
			resolve({ code: 1, stdout, stderr: error.message });
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}
