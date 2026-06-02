import type { ReviewFileSummary } from '../lib/shared/review.ts';

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
	if (mode === 'unstaged') return { command: common, baseDescription: 'unstaged changes', mode };
	if (mode === 'uncommitted') return { command: [...common, 'HEAD'], baseDescription: 'uncommitted changes', mode };
	if (mode === 'commit') return { command: [...common, 'HEAD^..HEAD'], baseDescription: 'last commit', mode };
	const branchBase = base?.trim() || 'origin/main';
	return { command: [...common, `${branchBase}...HEAD`], baseDescription: `${branchBase}...HEAD`, mode, base: branchBase };
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
