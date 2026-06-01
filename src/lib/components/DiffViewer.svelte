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

	const dispatch = createEventDispatcher<{ annotate: { file: string; line: number; side: 'additions' | 'deletions' }; toggleReviewed: string; fileComment: string; editAnnotation: UserReviewAnnotation; deleteAnnotation: UserReviewAnnotation; activeChange: { file?: string; commentId?: string } }>();

	let container: HTMLDivElement;
	let mounted = false;
	let renderError: string | undefined;
	let renderSequence = 0;
	let instances: FileDiffInstance<RenderAnnotation>[] = [];
	let modulePromise: Promise<typeof import('@pierre/diffs')> | undefined;
	let prefersDark = true;
	let activeFile: string | undefined;
	let activeCommentId: string | undefined;
	let scrollFrame: number | undefined;
	let containerWidth = 0;

	$: effectiveDiffStyle = diffStyle === 'split' && containerWidth > 0 && containerWidth < 820 ? 'unified' : diffStyle;
	$: diffAnnotationKey = session.userAnnotations.filter((annotation) => annotation.scope !== 'global').map((annotation) => `${annotation.id}:${annotation.body}`).join(',');
	$: renderKey = `${session.id}:${session.patch.length}:${findings.map((finding) => finding.id).join(',')}:${diffAnnotationKey}:${selectedFile ?? '*'}:${reviewLevel}:${isolatedLevel}:${[...reviewed].join(',')}:${hunkRanks.map((hunk) => `${hunk.id}:${hunk.attentionLevel}`).join(',')}:${effectiveDiffStyle}:${wrap}`;
	$: hunkFilterKey = `${reviewLevel}:${isolatedLevel}:${hunkRanks.map((hunk) => `${hunk.id}:${hunk.attentionLevel}`).join(',')}:${selectedFile ?? '*'}`;
	$: if (mounted && renderKey) void renderDiffs();
	$: if (mounted && hunkFilterKey) void applyHunkVisibility();
	$: if (mounted && targetFindingId) void scrollToFinding(targetFindingId);
	$: if (mounted && targetAnnotationId) void scrollToAnnotation(targetAnnotationId);

	onMount(() => {
		mounted = true;
		const resizeObserver = new ResizeObserver(([entry]) => {
			containerWidth = entry?.contentRect.width ?? 0;
		});
		if (container) resizeObserver.observe(container);
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		prefersDark = media.matches;
		const updateTheme = () => {
			prefersDark = media.matches;
			void renderDiffs();
		};
		media.addEventListener('change', updateTheme);
		void renderDiffs();
		window.addEventListener('scroll', onScroll, { passive: true });
		return () => {
			resizeObserver.disconnect();
			media.removeEventListener('change', updateTheme);
			window.removeEventListener('scroll', onScroll);
			if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
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
				section.className = 'rendered-file mb-2 scroll-mt-[5.5rem] rounded-xl border border-border bg-surface';
				section.dataset.file = file.name;
				container.append(section);

				const header = document.createElement('div');
				header.className = 'file-review-header sticky top-[var(--topbar-height)] z-20 rounded-xl flex items-center justify-between gap-3 border-b border-border bg-surface px-3 py-2';
				const title = document.createElement('button');
				title.type = 'button';
				title.className = 'file-collapse-toggle min-w-0 flex-1 overflow-hidden justify-start border-0 bg-transparent p-0 text-left text-sm font-medium hover:bg-transparent';
				setFileTitle(title, file.name, reviewed.has(file.name) && !selectedFile);
				const change = document.createElement('span');
				change.className = `file-change-chip flex-none rounded-full px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase ${fileChangeClass(file.type)}`;
				change.textContent = fileChangeLabel(file.type);
				const actions = document.createElement('div');
				actions.className = 'flex flex-none items-center gap-2';
				const comment = document.createElement('button');
				comment.type = 'button';
				comment.className = 'whitespace-nowrap text-xs';
				appendIconLabel(comment, 'message-square-plus', 'Comment file');
				const toggle = document.createElement('button');
				toggle.type = 'button';
				toggle.className = `file-reviewed-toggle whitespace-nowrap text-xs${reviewed.has(file.name) ? ' border-accent text-accent' : ''}`;
				appendIconLabel(toggle, 'check', 'reviewed');
				actions.append(comment, toggle);
				header.append(title, change, actions);
				section.append(header);

				const fileNotes = fileAnnotationsFor(file);
				if (fileNotes.length > 0) {
					const notes = document.createElement('div');
					notes.className = 'file-annotations grid gap-2 border-b border-border p-3';
					for (const annotation of fileNotes) notes.append(renderFileAnnotation(annotation));
					section.append(notes);
				}

				const diffHost = document.createElement('div');
				diffHost.className = 'file-diff-host';
				if (reviewed.has(file.name) && !selectedFile) diffHost.hidden = true;
				section.append(diffHost);
				title.addEventListener('click', () => {
					diffHost.hidden = !diffHost.hidden;
					setFileTitle(title, file.name, diffHost.hidden);
				});
				comment.addEventListener('click', () => dispatch('fileComment', file.name));
				toggle.addEventListener('click', () => dispatch('toggleReviewed', file.name));

				const instance = new FileDiff<RenderAnnotation>({
					disableFileHeader: true,
					diffStyle: effectiveDiffStyle,
					diffIndicators: 'bars',
					lineDiffType: 'word-alt',
					hunkSeparators: 'line-info-basic',
					overflow: wrap ? 'wrap' : 'scroll',
					stickyHeader: true,
					theme: { dark: 'pierre-dark', light: 'pierre-light' },
					themeType: prefersDark ? 'dark' : 'light',
					lineHoverHighlight: 'both',
					unsafeCSS: diffUnsafeCss(),
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
			markActiveElements();
			if (targetFindingId) void scrollToFinding(targetFindingId);
			updateActiveFromScroll();
		} catch (error) {
			renderError = error instanceof Error ? error.message : String(error);
		}
	}

	export function scrollFile(direction: 1 | -1) {
		const sections = visibleFileSections();
		const next = scrollToNextElement(sections, direction, 'start');
		if (next?.dataset.file) activateFile(next.dataset.file);
	}

	export function scrollComment(direction: 1 | -1) {
		scrollToNextElement(commentElements(), direction, 'center');
	}

	export function scrollHunk(direction: 1 | -1) {
		scrollToNextElement(hunkElements(), direction, 'start');
	}

	export function editActiveComment() {
		if (!activeCommentId) return false;
		const annotation = session.userAnnotations.find((candidate) => candidate.id === activeCommentId);
		if (!annotation) return false;
		dispatch('editAnnotation', annotation);
		return true;
	}

	export function currentFile() {
		return activeFile;
	}

	function scrollToNextElement(elements: HTMLElement[], direction: 1 | -1, block: ScrollLogicalPosition) {
		if (elements.length === 0) return undefined;
		const threshold = window.scrollY + (direction > 0 ? 96 : 0);
		const positions = elements.map((element) => ({ element, top: element.getBoundingClientRect().top + window.scrollY })).sort((left, right) => left.top - right.top);
		const next = direction > 0 ? positions.find((item) => item.top > threshold + 8) ?? positions[0] : [...positions].reverse().find((item) => item.top < threshold - 8) ?? positions.at(-1);
		next?.element.scrollIntoView({ block, behavior: 'smooth' });
		return next?.element;
	}

	function activateFile(file: string) {
		activeFile = file;
		markActiveElements();
		dispatch('activeChange', { file: activeFile, commentId: activeCommentId });
	}

	function visibleFileSections() {
		return [...container.querySelectorAll<HTMLElement>('.rendered-file')].filter((element) => !element.hidden);
	}

	function commentElements() {
		const light = [...container.querySelectorAll<HTMLElement>('[data-user-annotation-id], [data-finding-id]')];
		const shadow = diffHosts().flatMap((host) => [...(host.shadowRoot?.querySelectorAll<HTMLElement>('[data-user-annotation-id], [data-finding-id]') ?? [])]);
		return [...light, ...shadow].filter((element) => element.offsetParent !== null || !!element.getClientRects().length);
	}

	function hunkElements() {
		return diffHosts().flatMap((host) => [...(host.shadowRoot?.querySelectorAll<HTMLElement>('[data-separator]') ?? [])]);
	}

	function onScroll() {
		if (scrollFrame) return;
		scrollFrame = window.requestAnimationFrame(() => {
			scrollFrame = undefined;
			updateActiveFromScroll();
		});
	}

	function updateActiveFromScroll() {
		if (!container) return;
		const topbarHeight = topbarHeightPx();
		const fileAnchor = topbarHeight + 1;
		const visibleSections = visibleFileSections();
		const sectionPositions = visibleSections.map((element) => ({ element, rect: element.getBoundingClientRect() }));
		const currentSection = sectionPositions.find((item) => item.rect.top <= fileAnchor && item.rect.bottom > fileAnchor)
			?? [...sectionPositions].reverse().find((item) => item.rect.top <= fileAnchor)
			?? sectionPositions.find((item) => item.rect.top > fileAnchor);
		const nextFile = currentSection?.element.dataset.file;
		if (!nextFile) return;
		const comments = commentElements().map((element) => ({ element, top: element.getBoundingClientRect().top, id: element.dataset.userAnnotationId ?? element.dataset.findingId })).filter((item) => item.id && item.top <= topbarHeight + 140).sort((left, right) => right.top - left.top);
		const nextCommentId = comments[0]?.id;
		if (nextFile === activeFile && nextCommentId === activeCommentId) return;
		activeFile = nextFile;
		activeCommentId = nextCommentId;
		markActiveElements();
		dispatch('activeChange', { file: activeFile, commentId: activeCommentId });
	}

	function topbarHeightPx() {
		const value = getComputedStyle(document.documentElement).getPropertyValue('--topbar-height').trim();
		if (value.endsWith('rem')) return Number.parseFloat(value) * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
		if (value.endsWith('px')) return Number.parseFloat(value);
		return Number.parseFloat(value) || 0;
	}

	function markActiveElements() {
		for (const element of container.querySelectorAll<HTMLElement>('.review-active-file, .review-active-comment')) element.classList.remove('review-active-file', 'review-active-comment');
		for (const host of diffHosts()) for (const element of host.shadowRoot?.querySelectorAll<HTMLElement>('.review-active-comment') ?? []) element.classList.remove('review-active-comment');
		container.classList.toggle('review-has-active-file', !!activeFile);
		if (activeFile) container.querySelector<HTMLElement>(`[data-file="${CSS.escape(activeFile)}"]`)?.classList.add('review-active-file');
		if (activeCommentId) {
			container.querySelector<HTMLElement>(`[data-user-annotation-id="${CSS.escape(activeCommentId)}"], [data-finding-id="${CSS.escape(activeCommentId)}"]`)?.classList.add('review-active-comment');
			for (const host of diffHosts()) host.shadowRoot?.querySelector<HTMLElement>(`[data-user-annotation-id="${CSS.escape(activeCommentId)}"], [data-finding-id="${CSS.escape(activeCommentId)}"]`)?.classList.add('review-active-comment');
		}
	}

	function setFileTitle(button: HTMLButtonElement, file: string, collapsed: boolean) {
		const label = document.createElement('span');
		label.className = 'file-title-label min-w-0 truncate';
		label.textContent = file;
		button.replaceChildren(createLucideIcon(collapsed ? 'chevron-right' : 'chevron-down'), label);
	}

	function appendIconLabel(button: HTMLButtonElement, icon: LucideIconName, label: string) {
		const text = document.createElement('span');
		text.className = 'file-action-label';
		text.textContent = label;
		button.append(createLucideIcon(icon), text);
	}

	function fileChangeLabel(type: FileDiffMetadata['type']) {
		return type === 'new' ? 'added' : type === 'deleted' ? 'deleted' : type === 'rename-pure' || type === 'rename-changed' ? 'renamed' : 'modified';
	}

	function fileChangeClass(type: FileDiffMetadata['type']) {
		return type === 'deleted' ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent';
	}

	type LucideIconName = 'chevron-down' | 'chevron-right' | 'check' | 'x' | 'message-square-plus';

	function createLucideIcon(name: LucideIconName) {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('width', '14');
		svg.setAttribute('height', '14');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		svg.setAttribute('aria-hidden', 'true');
		const paths: Record<LucideIconName, string[]> = {
			'chevron-down': ['m6 9 6 6 6-6'],
			'chevron-right': ['m9 18 6-6-6-6'],
			check: ['M20 6 9 17l-5-5'],
			x: ['M18 6 6 18', 'M6 6l12 12'],
			'message-square-plus': ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z', 'M12 7v6', 'M9 10h6']
		};
		for (const d of paths[name]) {
			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.setAttribute('d', d);
			svg.append(path);
		}
		return svg;
	}

	function diffUnsafeCss() {
		return `
			[data-code] {
				padding-right: var(--diffs-gap-inline, var(--diffs-gap-fallback));
			}
			[data-diff-type=split][data-overflow=scroll] [data-additions] [data-code] {
				padding-right: var(--diffs-gap-inline, var(--diffs-gap-fallback));
			}
		`;
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
		element.className = 'file-annotation grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-lg border border-accent/35 bg-accent-soft p-2';
		element.dataset.userAnnotationId = annotation.id;
		const body = document.createElement('button');
		body.type = 'button';
		body.className = 'file-annotation-body annotation-md block w-full min-w-0 border-0 bg-transparent p-0 text-left text-sm hover:bg-transparent';
		body.innerHTML = renderMarkdown(annotation.body);
		body.addEventListener('click', () => dispatch('editAnnotation', annotation));
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'file-annotation-remove flex-none border-0 bg-transparent p-1 text-danger hover:bg-transparent';
		remove.title = 'Delete annotation';
		remove.append(createLucideIcon('x'));
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
		if (hunkRanks.length === 0) return;

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
				const start = effectiveDiffStyle === 'split' ? hunk.splitLineStart : hunk.unifiedLineStart;
				const count = effectiveDiffStyle === 'split' ? hunk.splitLineCount : hunk.unifiedLineCount;
				for (let index = start; index < start + count; index += 1) visible.add(index);
			}
			for (const element of shadowRoot.querySelectorAll<HTMLElement>('[data-line-index]')) {
				const indexes = (element.getAttribute('data-line-index') ?? '').split(',').map((value) => Number(value)).filter(Number.isFinite);
				if (indexes.length > 0 && indexes.every((index) => !visible.has(index))) element.style.display = 'none';
			}
		}
	}

	function filteredPatch() {
		if (hunkRanks.length === 0 && !selectedFile) return session.patch;
		const visible = new Set(
			hunkRanks
				.filter((rank) => isolatedLevel ? rank.attentionLevel === Number(reviewLevel) : rank.attentionLevel <= Number(reviewLevel))
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
				includeCurrentHunk = hunkRanks.length === 0 || visible.has(currentHunk);
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
		return marked.parse(renderableMarkdown(markdown), { async: false, gfm: true, breaks: true }) as string;
	}

	function renderableMarkdown(markdown: string) {
		return markdown.trim().replace(/^\s*(\/[^\s)]+\.(?:png|jpe?g|gif|webp))\s*$/gim, (_match, path: string) => `![pasted image](/api/reviews/${session.id}/attachments?path=${encodeURIComponent(path)})`);
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
	<div class="mb-4 rounded-lg border border-danger/50 bg-danger-soft p-4 text-danger">Could not render diff: {renderError}</div>
{/if}

<div class="mb-2 text-sm text-muted">Click a line number to add a review note.</div>
<div class="diff-container grid gap-2" bind:this={container}></div>
