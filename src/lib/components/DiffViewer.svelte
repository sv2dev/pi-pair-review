<script lang="ts">
	import { marked } from 'marked';
	import { onMount, createEventDispatcher, tick } from 'svelte';
	import type { DiffLineAnnotation, FileDiff as FileDiffInstance, FileDiffMetadata } from '@pierre/diffs';
	import type { ReviewFinding, ReviewHunkRank, ReviewSessionSnapshot, UserReviewAnnotation } from '$lib/shared/review';

	type RenderAnnotation =
		| { kind: 'finding'; value: ReviewFinding }
		| { kind: 'user'; value: UserReviewAnnotation };

	export let session: ReviewSessionSnapshot;
	export let findings: ReviewFinding[] = [];
	export let hunkRanks: ReviewHunkRank[] = [];
	export let reviewLevel = 1;
	export let selectedFile: string | undefined = undefined;
	export let targetFindingId: string | undefined = undefined;
	export let targetAnnotationId: string | undefined = undefined;
	export let diffStyle: 'split' | 'unified' = 'split';
	export let wrap = false;
	export let reviewed = new Set<string>();
	export let isolatedLevel = false;

	const dispatch = createEventDispatcher<{ annotate: { file: string; line: number; side: 'additions' | 'deletions' }; toggleReviewed: string; editAnnotation: UserReviewAnnotation; deleteAnnotation: UserReviewAnnotation }>();

	let container: HTMLDivElement;
	let mounted = false;
	let renderError: string | undefined;
	let renderSequence = 0;
	let instances: FileDiffInstance<RenderAnnotation>[] = [];
	let modulePromise: Promise<typeof import('@pierre/diffs')> | undefined;
	let prefersDark = true;

	$: renderKey = `${session.id}:${session.patch.length}:${findings.map((finding) => finding.id).join(',')}:${session.userAnnotations.map((annotation) => annotation.id).join(',')}:${selectedFile ?? '*'}:${reviewLevel}:${isolatedLevel}:${[...reviewed].join(',')}:${hunkRanks.map((hunk) => `${hunk.id}:${hunk.attentionLevel}`).join(',')}:${diffStyle}:${wrap}`;
	$: hunkFilterKey = `${reviewLevel}:${isolatedLevel}:${hunkRanks.map((hunk) => `${hunk.id}:${hunk.attentionLevel}`).join(',')}:${selectedFile ?? '*'}`;
	$: if (mounted && renderKey) void renderDiffs();
	$: if (mounted && hunkFilterKey) void applyHunkVisibility();
	$: if (mounted && targetFindingId) void scrollToFinding(targetFindingId);
	$: if (mounted && targetAnnotationId) void scrollToAnnotation(targetAnnotationId);

	onMount(() => {
		mounted = true;
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		prefersDark = media.matches;
		const updateTheme = () => {
			prefersDark = media.matches;
			void renderDiffs();
		};
		media.addEventListener('change', updateTheme);
		void renderDiffs();
		return () => {
			media.removeEventListener('change', updateTheme);
			cleanup();
		};
	});

	async function renderDiffs() {
		if (!container) return;
		const sequence = ++renderSequence;
		cleanup();
		renderError = undefined;

		try {
			const { FileDiff, parsePatchFiles } = await (modulePromise ??= import('@pierre/diffs'));
			if (sequence !== renderSequence) return;

			const patch = filteredPatch();
			const parsed = parsePatchFiles(patch, session.id, true);
			const visibleFiles = parsed.flatMap((patch) => patch.files).sort((left, right) => compareTreeOrder(left.name, right.name));

			container.replaceChildren();
			for (const file of visibleFiles) {
				const section = document.createElement('section');
				section.className = 'rendered-file';
				section.dataset.file = file.name;
				container.append(section);

				const header = document.createElement('div');
				header.className = 'file-review-header';
				const title = document.createElement('button');
				title.type = 'button';
				title.className = 'file-collapse-toggle';
				title.textContent = `${reviewed.has(file.name) && !selectedFile ? '▸' : '▾'} ${file.name}`;
				const toggle = document.createElement('button');
				toggle.type = 'button';
				toggle.className = `file-reviewed-toggle${reviewed.has(file.name) ? ' reviewed' : ''}`;
				toggle.textContent = reviewed.has(file.name) ? 'Reviewed' : 'Mark reviewed';
				header.append(title, toggle);
				section.append(header);

				const fileNotes = fileAnnotationsFor(file);
				if (fileNotes.length > 0) {
					const notes = document.createElement('div');
					notes.className = 'file-annotations';
					for (const annotation of fileNotes) notes.append(renderFileAnnotation(annotation));
					section.append(notes);
				}

				const diffHost = document.createElement('div');
				diffHost.className = 'file-diff-host';
				if (reviewed.has(file.name) && !selectedFile) diffHost.hidden = true;
				section.append(diffHost);
				title.addEventListener('click', () => {
					diffHost.hidden = !diffHost.hidden;
					title.textContent = `${diffHost.hidden ? '▸' : '▾'} ${file.name}`;
				});
				toggle.addEventListener('click', () => dispatch('toggleReviewed', file.name));

				const instance = new FileDiff<RenderAnnotation>({
					diffStyle,
					diffIndicators: 'bars',
					lineDiffType: 'word-alt',
					hunkSeparators: 'line-info-basic',
					overflow: wrap ? 'wrap' : 'scroll',
					stickyHeader: true,
					theme: { dark: 'pierre-dark', light: 'pierre-light' },
					themeType: prefersDark ? 'dark' : 'light',
					lineHoverHighlight: 'both',
					onLineNumberClick: ({ lineNumber, annotationSide }) => {
						dispatch('annotate', { file: file.name, line: lineNumber, side: annotationSide });
					},
					renderAnnotation
				});

				instances.push(instance);
				instance.render({
					fileDiff: file,
					containerWrapper: diffHost,
					lineAnnotations: annotationsFor(file)
				});
			}
			void applyHunkVisibility();
			if (targetFindingId) void scrollToFinding(targetFindingId);
		} catch (error) {
			renderError = error instanceof Error ? error.message : String(error);
		}
	}

	function cleanup() {
		for (const instance of instances) instance.cleanUp();
		instances = [];
		container?.replaceChildren();
	}

	function compareTreeOrder(leftPath: string, rightPath: string) {
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

	function fileAnnotationsFor(file: FileDiffMetadata) {
		return session.userAnnotations.filter((annotation) => annotation.scope === 'file' && annotation.file && (annotation.file === file.name || annotation.file === file.prevName));
	}

	function renderFileAnnotation(annotation: UserReviewAnnotation) {
		const element = document.createElement('aside');
		element.className = 'file-annotation';
		element.dataset.userAnnotationId = annotation.id;
		const body = document.createElement('button');
		body.type = 'button';
		body.className = 'file-annotation-body';
		body.innerHTML = renderMarkdown(annotation.body);
		body.addEventListener('click', () => dispatch('editAnnotation', annotation));
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'file-annotation-remove';
		remove.title = 'Delete annotation';
		remove.textContent = '×';
		remove.addEventListener('click', () => dispatch('deleteAnnotation', annotation));
		element.append(body, remove);
		return element;
	}

	function annotationsFor(file: FileDiffMetadata): DiffLineAnnotation<RenderAnnotation>[] {
		const agent = findings
			.filter((finding) => finding.file && finding.line && (finding.file === file.name || finding.file === file.prevName))
			.map((finding) => ({ lineNumber: finding.line!, side: finding.side ?? 'additions', metadata: { kind: 'finding' as const, value: finding } }));
		const user = session.userAnnotations
			.filter((annotation) => annotation.scope === 'line' && annotation.file && annotation.line && annotation.side && (annotation.file === file.name || annotation.file === file.prevName))
			.map((annotation) => ({ lineNumber: annotation.line!, side: annotation.side!, metadata: { kind: 'user' as const, value: annotation } }));
		return [...agent, ...user];
	}

	async function applyHunkVisibility() {
		if (!container) return;
		await tick();
		const { parsePatchFiles } = await (modulePromise ??= import('@pierre/diffs'));
		const parsed = parsePatchFiles(filteredPatch(), session.id, true);
		const visibleFiles = parsed.flatMap((patch) => patch.files).sort((left, right) => compareTreeOrder(left.name, right.name));

		for (const host of diffHosts()) {
			for (const element of host.shadowRoot?.querySelectorAll<HTMLElement>('[data-line-index], [data-line-annotation], [data-gutter-buffer], [data-separator]') ?? []) element.style.removeProperty('display');
		}
		if (hunkRanks.length === 0 || session.preReview.status !== 'done') return;

		for (const file of visibleFiles) {
			const section = container.querySelector<HTMLElement>(`[data-file="${CSS.escape(file.name)}"]`);
			const shadowRoot = section ? diffHost(section)?.shadowRoot : undefined;
			if (!shadowRoot) continue;
			const fileRanks = hunkRanks.filter((rank) => rank.file === file.name || rank.file === file.prevName);
			if (fileRanks.length === 0) continue;
			const visible = new Set<number>();
			for (const hunk of file.hunks) {
				const level = hunkRankFor(file, hunk)?.attentionLevel ?? 5;
				if (isolatedLevel ? level !== Number(reviewLevel) : level > Number(reviewLevel)) continue;
				const start = diffStyle === 'split' ? hunk.splitLineStart : hunk.unifiedLineStart;
				const count = diffStyle === 'split' ? hunk.splitLineCount : hunk.unifiedLineCount;
				for (let index = start; index < start + count; index += 1) visible.add(index);
			}
			for (const element of shadowRoot.querySelectorAll<HTMLElement>('[data-line-index]')) {
				const indexes = (element.getAttribute('data-line-index') ?? '').split(',').map((value) => Number(value)).filter(Number.isFinite);
				if (indexes.length > 0 && indexes.every((index) => !visible.has(index))) element.style.display = 'none';
			}
		}
	}

	function filteredPatch() {
		if ((hunkRanks.length === 0 || session.preReview.status !== 'done') && !selectedFile) return session.patch;
		const visible = new Set(
			hunkRanks
				.filter((rank) => session.preReview.status !== 'done' || (isolatedLevel ? rank.attentionLevel === Number(reviewLevel) : rank.attentionLevel <= Number(reviewLevel)))
				.filter((rank) => !selectedFile || rank.file === selectedFile)
				.map((rank) => hunkKey(rank.file, rank.oldStart, rank.oldLines, rank.newStart, rank.newLines))
		);
		const selected = selectedFile ? new Set([selectedFile]) : undefined;
		const output: string[] = [];
		let header: string[] = [];
		let body: string[] = [];
		let currentFile = '';
		let currentHunk: string | undefined;
		let includeCurrentFile = false;
		let includeCurrentHunk = false;
		let oldStart = 0;
		let oldLines = 0;
		let newStart = 0;
		let newLines = 0;

		const flushHunk = () => {
			if (!includeCurrentFile || !currentHunk || !includeCurrentHunk) return;
			if (header.length > 0) {
				output.push(...header);
				header = [];
			}
			output.push(...body);
		};

		for (const line of session.patch.split('\n')) {
			const fileHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
			if (fileHeader) {
				flushHunk();
				currentFile = fileHeader[2] ?? fileHeader[1] ?? '';
				includeCurrentFile = !selected || selected.has(currentFile) || selected.has(fileHeader[1] ?? '');
				header = [line];
				body = [];
				currentHunk = undefined;
				continue;
			}

			const rename = /^rename to (.+)$/.exec(line);
			if (rename) {
				currentFile = rename[1] ?? currentFile;
				if (selected?.has(currentFile)) includeCurrentFile = true;
			}

			const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
			if (hunk) {
				flushHunk();
				oldStart = Number(hunk[1]);
				oldLines = Number(hunk[2] ?? '1');
				newStart = Number(hunk[3]);
				newLines = Number(hunk[4] ?? '1');
				currentHunk = hunkKey(currentFile, oldStart, oldLines, newStart, newLines);
				includeCurrentHunk = hunkRanks.length === 0 || session.preReview.status !== 'done' || visible.has(currentHunk);
				body = [line];
				continue;
			}

			if (!currentHunk) header.push(line);
			else body.push(line);
		}
		flushHunk();
		return output.join('\n');
	}

	function hunkKey(file: string, oldStart: number, oldLines: number, newStart: number, newLines: number) {
		return `${file}:${oldStart}:${oldLines}:${newStart}:${newLines}`;
	}

	function diffHosts() {
		return [...container.querySelectorAll<HTMLElement>('.file-diff-host')].flatMap((section) => {
			const host = diffHost(section);
			return host ? [host] : [];
		});
	}

	function diffHost(section: HTMLElement): HTMLElement | undefined {
		return [...section.children].find((child): child is HTMLElement => child instanceof HTMLElement && !!child.shadowRoot);
	}

	function hunkRankFor(file: FileDiffMetadata, hunk: FileDiffMetadata['hunks'][number]): ReviewHunkRank | undefined {
		return hunkRanks.find(
			(rank) =>
				(rank.file === file.name || rank.file === file.prevName) &&
				rank.oldStart === hunk.deletionStart &&
				rank.oldLines === hunk.deletionCount &&
				rank.newStart === hunk.additionStart &&
				rank.newLines === hunk.additionCount
		);
	}

	async function scrollToFinding(id: string) {
		await tick();
		const finding = findings.find((candidate) => candidate.id === id);
		if (finding?.file && finding.line) {
			const section = container.querySelector<HTMLElement>(`[data-file="${CSS.escape(finding.file)}"]`);
			const lineType = finding.side === 'deletions' ? 'change-deletion' : 'change-addition';
			const line = section ? diffHost(section)?.shadowRoot?.querySelector(`[data-line="${finding.line}"][data-line-type="${lineType}"]`) : undefined;
			if (line) {
				line.scrollIntoView({ block: 'center', behavior: 'smooth' });
				flashElement(line as HTMLElement);
				return;
			}
		}
		const element = container?.querySelector(`[data-finding-id="${CSS.escape(id)}"]`);
		if (element) {
			element.scrollIntoView({ block: 'center', behavior: 'smooth' });
			flashElement(element as HTMLElement);
		}
	}

	async function scrollToAnnotation(id: string) {
		await tick();
		const annotation = session.userAnnotations.find((candidate) => candidate.id === id);
		if (annotation?.scope === 'global') return;
		if (annotation?.scope === 'file' && annotation.file) {
			const section = container.querySelector<HTMLElement>(`[data-file="${CSS.escape(annotation.file)}"]`);
			section?.scrollIntoView({ block: 'start', behavior: 'smooth' });
			if (section) flashElement(section);
			return;
		}
		const element = container.querySelector(`[data-user-annotation-id="${CSS.escape(id)}"]`);
		if (element) {
			element.scrollIntoView({ block: 'center', behavior: 'smooth' });
			flashElement(element as HTMLElement);
			return;
		}
		if (!annotation?.file || !annotation.line) return;
		const section = container.querySelector<HTMLElement>(`[data-file="${CSS.escape(annotation.file)}"]`);
		const line = section ? diffHost(section)?.shadowRoot?.querySelector(`[data-line="${annotation.line}"]`) : undefined;
		if (line) {
			line.scrollIntoView({ block: 'center', behavior: 'smooth' });
			flashElement(line as HTMLElement);
		}
	}

	function flashElement(element: HTMLElement) {
		const previous = element.style.boxShadow;
		element.classList.add('review-scroll-flash');
		element.style.boxShadow = `${previous ? `${previous}, ` : ''}inset 0 0 0 2px rgba(139, 211, 255, 0.95)`;
		setTimeout(() => {
			element.classList.remove('review-scroll-flash');
			element.style.boxShadow = previous;
		}, 900);
	}

	function renderAnnotation(annotation: DiffLineAnnotation<RenderAnnotation>): HTMLElement | undefined {
		const metadata = annotation.metadata;
		if (!metadata) return undefined;

		const element = document.createElement('aside');
		element.className = `inline-annotation ${metadata.kind}`;
		if (metadata.kind === 'finding') element.dataset.findingId = metadata.value.id;
		else element.dataset.userAnnotationId = metadata.value.id;

		const title = document.createElement('strong');
		const body = document.createElement('div');
		if (metadata.kind === 'finding') {
			const finding = metadata.value;
			title.textContent = `${finding.severity.toUpperCase()} · ${finding.title}`;
			title.style.color = severityColor(finding.severity);
			body.innerHTML = renderMarkdown(finding.rationale);
			element.append(title, body);
			if (finding.recommendation) {
				const recommendation = document.createElement('div');
				recommendation.innerHTML = renderMarkdown(finding.recommendation);
				recommendation.className = 'recommendation';
				element.append(recommendation);
			}
		} else {
			title.textContent = 'USER NOTE';
			body.innerHTML = renderMarkdown(metadata.value.body);
			element.append(title, body);
		}

		return element;
	}

	function renderMarkdown(markdown: string) {
		return marked.parse(markdown.trim(), { async: false, gfm: true, breaks: true }) as string;
	}

	function severityColor(severity: ReviewFinding['severity']) {
		return severity === 'critical'
			? 'var(--danger)'
			: severity === 'high'
				? '#ff9f43'
				: severity === 'medium'
					? 'var(--warning)'
					: 'var(--accent)';
	}
</script>

{#if renderError}
	<div class="render-error">Could not render diff: {renderError}</div>
{/if}

<div class="hint">Click a line number to add a review note.</div>
<div class="diff-container" bind:this={container}></div>

<style>
	.diff-container {
		display: grid;
		gap: 1rem;
	}

	.hint {
		margin-bottom: 0.75rem;
		color: var(--muted);
		font-size: 0.85rem;
	}

	:global(.rendered-file) {
		scroll-margin-top: 5.5rem;
		border: 1px solid var(--border);
		border-radius: 1rem;
		background: var(--panel-solid);
		overflow: clip;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.24);
	}

	:global(.file-review-header) {
		position: sticky;
		top: 4.25rem;
		z-index: 4;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.55rem 0.75rem;
		border-bottom: 1px solid var(--border);
		background: color-mix(in srgb, var(--panel-solid) 96%, transparent);
	}

	:global(.file-collapse-toggle), :global(.file-reviewed-toggle) {
		border: 1px solid var(--border-strong);
		border-radius: 0.5rem;
		background: var(--panel-soft);
		color: var(--text);
		padding: 0.3rem 0.5rem;
	}

	:global(.file-collapse-toggle) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	:global(.file-reviewed-toggle.reviewed) { color: var(--accent); border-color: rgba(139, 211, 255, 0.45); }

	:global(.file-annotations) {
		display: grid;
		gap: 0.5rem;
		padding: 0.75rem;
		border-bottom: 1px solid var(--border);
	}

	:global(.file-annotation) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: start;
		gap: 0.5rem;
		border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
		border-radius: 0.75rem;
		background: var(--accent-soft);
		padding: 0.5rem;
	}

	:global(.file-annotation-body), :global(.file-annotation-remove) {
		border: 0;
		background: transparent;
		color: var(--text);
		text-align: left;
		justify-content: flex-start;
		align-items: flex-start;
	}

	:global(.file-annotation-body) { display: block; width: 100%; white-space: normal; overflow-wrap: anywhere; }
	:global(.file-annotation-body p), :global(.inline-annotation p), :global(.inline-annotation ul), :global(.inline-annotation ol), :global(.file-annotation-body ul), :global(.file-annotation-body ol) { margin: 0; }
	:global(.file-annotation-body ul), :global(.file-annotation-body ol), :global(.inline-annotation ul), :global(.inline-annotation ol) { padding-left: 1.35rem; }
	:global(.file-annotation-body code), :global(.inline-annotation code) { border-radius: 0.3rem; background: var(--bg); padding: 0.1rem 0.25rem; }
	:global(.file-annotation-remove) { color: var(--danger); font-size: 1.2rem; line-height: 1; }

	:global(.inline-annotation) {
		margin: 6px 0 8px;
		padding: 10px 12px;
		border-radius: 10px;
		border: 1px solid var(--border);
		background: color-mix(in srgb, var(--panel-solid) 92%, transparent);
		color: var(--text);
		font: 13px/1.45 ui-sans-serif, system-ui, sans-serif;
		text-align: left;
		justify-items: start;
	}

	:global(.inline-annotation.user) {
		border-color: color-mix(in srgb, var(--accent) 35%, transparent);
		background: var(--accent-soft);
	}

	:global(.inline-annotation strong) {
		display: block;
		margin-bottom: 4px;
	}

	:global(.inline-annotation .recommendation) {
		margin-top: 4px;
		color: var(--muted);
	}

	:global(.review-scroll-flash) {
		animation: review-scroll-flash 0.9s ease-out;
	}

	@keyframes review-scroll-flash {
		0%, 40% { outline: 2px solid rgba(139, 211, 255, 0.95); outline-offset: -2px; }
		100% { outline: 0 solid transparent; }
	}

	.render-error {
		margin-bottom: 1rem;
		padding: 1rem;
		border: 1px solid rgba(255, 107, 122, 0.45);
		border-radius: 0.75rem;
		background: var(--danger-soft);
		color: var(--danger);
	}
</style>
