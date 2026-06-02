<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { renderReviewMarkdown } from '$lib/client/review-markdown';
	import { compareTreeOrder } from '$lib/client/review-ui';
	import { SvelteSet } from 'svelte/reactivity';
	import { Check, ChevronDown, ChevronRight, MessageSquarePlus, Trash2 } from '@lucide/svelte';
	import type { DiffLineAnnotation, FileContents, FileDiff as FileDiffInstance, FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
	import type { ReviewAttentionLevel, ReviewFinding, ReviewHunkRank, ReviewSessionSnapshot, UserReviewAnnotation } from '$lib/shared/review';

	type RenderAnnotation =
		| { kind: 'finding'; value: ReviewFinding }
		| { kind: 'user'; value: UserReviewAnnotation };
	type FileDiffContents = { oldFile: FileContents; newFile: FileContents };

	let {
		session,
		findings = [],
		hunkRanks = [],
		reviewLevel = 1,
		selectedFile,
		targetFindingId,
		targetAnnotationId,
		diffStyle = 'split',
		wrap = false,
		reviewed = new SvelteSet<string>(),
		reviewedKeys = new SvelteSet<string>(),
		isolatedLevel = false,
		onAnnotate,
		onAnnotateRange,
		onToggleReviewed,
		onFileComment,
		onEditAnnotation,
		onDeleteAnnotation,
		onActiveChange
	}: {
		session: ReviewSessionSnapshot;
		findings?: ReviewFinding[];
		hunkRanks?: ReviewHunkRank[];
		reviewLevel?: number;
		selectedFile?: string;
		targetFindingId?: string;
		targetAnnotationId?: string;
		diffStyle?: 'split' | 'unified';
		wrap?: boolean;
		reviewed?: Set<string>;
		reviewedKeys?: Set<string>;
		isolatedLevel?: boolean;
		onAnnotate?: (detail: { file: string; line: number; side: 'additions' | 'deletions' }) => void;
		onAnnotateRange?: (file: string, range: SelectedLineRange | null) => void;
		onToggleReviewed?: (file: string) => void;
		onFileComment?: (file: string) => void;
		onEditAnnotation?: (annotation: UserReviewAnnotation) => void;
		onDeleteAnnotation?: (annotation: UserReviewAnnotation) => void;
		onActiveChange?: (detail: { file?: string; commentId?: string }) => void;
	} = $props();

	let container: HTMLDivElement;
	let mounted = $state(false);
	let renderError = $state<string | undefined>();
	let renderSequence = 0;
	let renderedFiles = $state.raw<FileDiffMetadata[]>([]);
	let instances: FileDiffInstance<RenderAnnotation>[] = [];
	let modulePromise: Promise<typeof import('@pierre/diffs')> | undefined;
	const fileContentsCache = new Map<string, Promise<FileDiffContents | undefined>>();
	let prefersDark = $state(true);
	let activeFile = $state<string | undefined>();
	let activeCommentId = $state<string | undefined>();
	let scrollFrame: number | undefined;
	let quickScrollFrame: number | undefined;
	let containerWidth = $state(0);
	let lastFileScrollPadding = $state(0);
	const diffHostElements = new Map<string, HTMLDivElement>();
	const expandedFiles = new SvelteSet<string>();
	const collapsedFiles = new SvelteSet<string>();

	let effectiveDiffStyle = $derived(diffStyle === 'split' && containerWidth > 0 && containerWidth < 820 ? 'unified' : diffStyle);
	let diffAnnotationKey = $derived(session.userAnnotations.filter((annotation) => annotation.scope !== 'global').map((annotation) => `${annotation.id}:${annotation.scope}:${annotation.file ?? ''}:${annotation.line ?? ''}:${annotation.side ?? ''}:${annotation.body}`).join(','));
	let reviewedKeysKey = $derived([...reviewedKeys].sort().join(','));
	let renderKey = $derived(`${session.id}:${hashString(session.patch)}:${findings.map((finding) => `${finding.id}:${finding.file ?? ''}:${finding.line ?? ''}:${finding.side ?? ''}:${finding.title}:${finding.rationale}:${finding.recommendation ?? ''}`).join(',')}:${diffAnnotationKey}:${selectedFile ?? '*'}:${reviewLevel}:${isolatedLevel}:${hunkRanks.map((hunk) => `${hunk.id}:${hunk.file}:${hunk.oldStart}:${hunk.oldLines}:${hunk.newStart}:${hunk.newLines}:${hunk.attentionLevel}`).join(',')}:${effectiveDiffStyle}:${wrap}`);
	let hunkFilterKey = $derived(`${reviewLevel}:${isolatedLevel}:${reviewedKeysKey}:${hunkRanks.map((hunk) => `${hunk.id}:${hunk.attentionLevel}`).join(',')}:${selectedFile ?? '*'}`);

	$effect(() => {
		if (mounted && renderKey) void renderDiffs();
	});

	$effect(() => {
		if (mounted && hunkFilterKey) void applyHunkVisibility();
	});

	$effect(() => {
		if (mounted && targetFindingId) void scrollToFinding(targetFindingId);
	});

	$effect(() => {
		if (mounted && targetAnnotationId) void scrollToAnnotation(targetAnnotationId);
	});

	onMount(() => {
		mounted = true;
		const resizeObserver = new ResizeObserver(([entry]) => {
			containerWidth = entry?.contentRect.width ?? 0;
			void updateLastFileScrollPadding();
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
		return () => {
			resizeObserver.disconnect();
			media.removeEventListener('change', updateTheme);
			if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
			if (quickScrollFrame) window.cancelAnimationFrame(quickScrollFrame);
			cleanup();
		};
	});

	async function renderDiffs() {
		if (!container) return;
		const sequence = ++renderSequence;
		cleanup();
		renderError = undefined;

		try {
			const { FileDiff } = await (modulePromise ??= import('@pierre/diffs'));
			if (sequence !== renderSequence) return;

			const currentSession = session;
			const nextRenderedFiles = (await parseRenderedFiles(filteredPatch(), currentSession, hunkRanks.length === 0)).sort((left, right) => compareTreeOrder(left.name, right.name));
			if (sequence !== renderSequence) return;
			renderedFiles = nextRenderedFiles;
			await tick();
			if (sequence !== renderSequence) return;

			for (const file of renderedFiles) {
				const host = diffHostElements.get(file.name);
				if (!host) continue;
				host.replaceChildren();

				const instance = new FileDiff<RenderAnnotation>({
					disableFileHeader: true,
					diffStyle: effectiveDiffStyle,
					diffIndicators: 'bars',
					lineDiffType: 'word-alt',
					hunkSeparators: 'line-info',
					expansionLineCount: 25,
					overflow: wrap ? 'wrap' : 'scroll',
					stickyHeader: true,
					theme: { dark: 'pierre-dark', light: 'pierre-light' },
					themeType: prefersDark ? 'dark' : 'light',
					lineHoverHighlight: 'both',
					enableLineSelection: true,
					unsafeCSS: diffUnsafeCss(),
					onLineNumberClick: ({ lineNumber, annotationSide }) => {
						onAnnotate?.({ file: file.name, line: lineNumber, side: annotationSide });
					},
					onLineSelectionEnd: (range) => onAnnotateRange?.(file.name, range),
					renderAnnotation
				});

				instances.push(instance);
				instance.render({
					fileDiff: file,
					containerWrapper: host,
					lineAnnotations: annotationsFor(file)
				});
			}
			void applyHunkVisibility();
			void updateLastFileScrollPadding();
			markActiveElements();
			if (targetFindingId) void scrollToFinding(targetFindingId);
			updateActiveFromScroll();
		} catch (error) {
			renderError = error instanceof Error ? error.message : String(error);
		}
	}

	export function scrollFile(direction: 1 | -1) {
		const sections = visibleFileSections();
		if (sections.length === 0) return;
		const currentIndex = activeFile ? sections.findIndex((section) => section.dataset.file === activeFile) : -1;
		const nextIndex = currentIndex >= 0 ? Math.min(sections.length - 1, Math.max(0, currentIndex + direction)) : direction > 0 ? 0 : sections.length - 1;
		scrollToFileSection(sections[nextIndex]);
	}

	export function scrollFileAfter(file: string) {
		const sections = visibleFileSections();
		const index = sections.findIndex((section) => section.dataset.file === file);
		scrollToFileSection(index >= 0 ? sections[index + 1] : undefined);
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
		onEditAnnotation?.(annotation);
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
		onActiveChange?.({ file: activeFile, commentId: activeCommentId });
	}

	function visibleFileSections() {
		return [...container.querySelectorAll<HTMLElement>('.rendered-file')].filter((element) => !element.hidden);
	}

	function commentElements() {
		const light = [...container.querySelectorAll<HTMLElement>('[data-user-annotation-id], [data-finding-id]')];
		const shadow = shadowHosts().flatMap((host) => [...(host.shadowRoot?.querySelectorAll<HTMLElement>('[data-user-annotation-id], [data-finding-id]') ?? [])]);
		return [...light, ...shadow].filter((element) => element.offsetParent !== null || !!element.getClientRects().length);
	}

	function hunkElements() {
		return shadowHosts().flatMap((host) => [...(host.shadowRoot?.querySelectorAll<HTMLElement>('[data-separator]') ?? [])]);
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
		const switchLine = topbarHeight + 12;
		const sectionPositions = visibleFileSections().map((element) => ({ element, rect: element.getBoundingClientRect() }));
		const currentSection = sectionPositions.find((item) => item.rect.bottom > switchLine) ?? sectionPositions.at(-1);
		const nextFile = currentSection?.element.dataset.file;
		if (!nextFile) return;
		const comments = commentElements().map((element) => ({ element, top: element.getBoundingClientRect().top, id: element.dataset.userAnnotationId ?? element.dataset.findingId })).filter((item) => item.id && item.top <= topbarHeight + 140).sort((left, right) => right.top - left.top);
		const nextCommentId = comments[0]?.id;
		if (nextFile === activeFile && nextCommentId === activeCommentId) return;
		activeFile = nextFile;
		activeCommentId = nextCommentId;
		markActiveElements();
		onActiveChange?.({ file: activeFile, commentId: activeCommentId });
	}

	function scrollToFileSection(section: HTMLElement | undefined) {
		if (!section) return;
		scrollFileSectionIntoView(section);
		if (section.dataset.file) activateFile(section.dataset.file);
	}

	function scrollFileSectionIntoView(section: HTMLElement) {
		const top = section.getBoundingClientRect().top + window.scrollY - topbarHeightPx() - 4;
		quickScrollTo(Math.max(0, top));
	}

	function quickScrollTo(top: number) {
		if (quickScrollFrame) window.cancelAnimationFrame(quickScrollFrame);
		const start = window.scrollY;
		const distance = top - start;
		if (Math.abs(distance) < 16 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			window.scrollTo({ top, behavior: 'auto' });
			quickScrollFrame = undefined;
			return;
		}
		const startedAt = performance.now();
		const duration = 120;
		const step = (now: number) => {
			const progress = Math.min(1, (now - startedAt) / duration);
			const eased = 1 - Math.pow(1 - progress, 3);
			window.scrollTo({ top: start + distance * eased, behavior: 'auto' });
			quickScrollFrame = progress < 1 ? window.requestAnimationFrame(step) : undefined;
		};
		quickScrollFrame = window.requestAnimationFrame(step);
	}

	async function updateLastFileScrollPadding() {
		await tick();
		const last = visibleFileSections().at(-1);
		if (!last) {
			lastFileScrollPadding = 0;
			return;
		}
		const rowGap = Number.parseFloat(getComputedStyle(container).rowGap) || 0;
		lastFileScrollPadding = Math.max(0, window.innerHeight - topbarHeightPx() - 12 - last.offsetHeight - rowGap);
	}

	function topbarHeightPx() {
		const value = getComputedStyle(document.documentElement).getPropertyValue('--topbar-height').trim();
		if (value.endsWith('rem')) return Number.parseFloat(value) * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
		if (value.endsWith('px')) return Number.parseFloat(value);
		return Number.parseFloat(value) || 0;
	}

	function markActiveElements() {
		for (const host of shadowHosts()) for (const element of host.shadowRoot?.querySelectorAll<HTMLElement>('.review-active-comment') ?? []) element.classList.remove('review-active-comment');
		if (activeCommentId) for (const host of shadowHosts()) host.shadowRoot?.querySelector<HTMLElement>(`[data-user-annotation-id="${CSS.escape(activeCommentId)}"], [data-finding-id="${CSS.escape(activeCommentId)}"]`)?.classList.add('review-active-comment');
	}

	function isFileCollapsed(file: string) {
		return collapsedFiles.has(file) || (reviewed.has(file) && !selectedFile && !expandedFiles.has(file));
	}

	function toggleFileCollapsed(file: string) {
		if (isFileCollapsed(file)) {
			collapsedFiles.delete(file);
			expandedFiles.add(file);
		} else {
			expandedFiles.delete(file);
			collapsedFiles.add(file);
		}
		void updateLastFileScrollPadding();
	}

	function registerDiffHost(file: string) {
		return (node: HTMLDivElement) => {
			diffHostElements.set(file, node);
			return () => {
				diffHostElements.delete(file);
			};
		};
	}

	function fileChangeLabel(type: FileDiffMetadata['type']) {
		return type === 'new' ? 'added' : type === 'deleted' ? 'deleted' : type === 'rename-pure' || type === 'rename-changed' ? 'renamed' : 'modified';
	}

	function fileChangeClass(type: FileDiffMetadata['type']) {
		return type === 'deleted' ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent';
	}

	function diffUnsafeCss() {
		return `
			[data-code] {
				padding-right: var(--diffs-gap-inline, var(--diffs-gap-fallback));
			}
			[data-diff-type=split][data-overflow=scroll] [data-additions] [data-code] {
				padding-right: var(--diffs-gap-inline, var(--diffs-gap-fallback));
			}
			.review-reviewed-hunk:is([data-line-type=change-addition], [data-line-type=change-deletion]) {
				--mix-light: 96%;
				--mix-dark: 93%;
				--diffs-bg-addition-emphasis: rgb(from var(--diffs-addition-base) r g b / 0.06);
				--diffs-bg-deletion-emphasis: rgb(from var(--diffs-deletion-base) r g b / 0.07);
			}
			.review-reviewed-hunk[data-column-number]::before {
				opacity: 0.28;
			}
		`;
	}

	function reviewedKey(file: string, level: ReviewAttentionLevel) {
		return `${level}\t${file}`;
	}

	function cleanup() {
		for (const instance of instances) instance.cleanUp();
		instances = [];
		for (const host of diffHostElements.values()) host.replaceChildren();
	}

	function fileAnnotationsFor(file: FileDiffMetadata) {
		return session.userAnnotations.filter((annotation) => annotation.scope === 'file' && annotation.file && (annotation.file === file.name || annotation.file === file.prevName));
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
		const visibleFiles = renderedFiles;

		for (const host of shadowHosts()) {
			for (const element of host.shadowRoot?.querySelectorAll<HTMLElement>('[data-line-index], [data-line-annotation], [data-gutter-buffer], [data-separator]') ?? []) {
				element.style.removeProperty('display');
				element.classList.remove('review-reviewed-hunk');
			}
		}
		if (hunkRanks.length === 0) return;

		for (const file of visibleFiles) {
			const section = container.querySelector<HTMLElement>(`[data-file="${CSS.escape(file.name)}"]`);
			const shadowRoot = section ? diffHost(section)?.shadowRoot : undefined;
			if (!shadowRoot) continue;
			const fileRanks = hunkRanks.filter((rank) => rank.file === file.name || rank.file === file.prevName);
			if (fileRanks.length === 0) continue;
			const visible = new SvelteSet<number>();
			const reviewedVisibleIndexes = new SvelteSet<number>();
			for (const hunk of file.hunks) {
				const rank = hunkRankFor(file, hunk);
				const level = rank?.attentionLevel ?? 5;
				if (isolatedLevel ? level !== Number(reviewLevel) : level > Number(reviewLevel)) continue;
				const start = effectiveDiffStyle === 'split' ? hunk.splitLineStart : hunk.unifiedLineStart;
				const count = effectiveDiffStyle === 'split' ? hunk.splitLineCount : hunk.unifiedLineCount;
				for (let index = start; index < start + count; index += 1) {
					visible.add(index);
					if (rank && reviewedKeys.has(reviewedKey(file.name, rank.attentionLevel))) reviewedVisibleIndexes.add(index);
				}
			}
			for (const element of shadowRoot.querySelectorAll<HTMLElement>('[data-line-index]')) {
				element.classList.remove('review-reviewed-hunk');
				const indexes = (element.getAttribute('data-line-index') ?? '').split(',').map((value) => Number(value)).filter(Number.isFinite);
				const isExpandedContext = element.getAttribute('data-line-type') === 'context-expanded';
				if (!isExpandedContext && indexes.length > 0 && indexes.every((index) => !visible.has(index))) {
					element.style.display = 'none';
					continue;
				}
				if (indexes.some((index) => reviewedVisibleIndexes.has(index))) element.classList.add('review-reviewed-hunk');
			}
		}
		void updateLastFileScrollPadding();
	}

	async function parseRenderedFiles(patch: string, currentSession: ReviewSessionSnapshot, hydrateFullFileContext: boolean): Promise<FileDiffMetadata[]> {
		const { parsePatchFiles, processFile } = await (modulePromise ??= import('@pierre/diffs'));
		const chunks = patchFileChunks(patch);
		const files: FileDiffMetadata[] = [];

		for (const [index, chunk] of chunks.entries()) {
			const parsed = parsePatchFiles(chunk, `${currentSession.id}-${index}`, true).flatMap((item) => item.files);
			for (const file of parsed) {
				const contents = hydrateFullFileContext ? await contentsFor(file, currentSession) : undefined;
				if (!contents) {
					files.push(file);
					continue;
				}
				try {
					const processed = processFile(chunk, { cacheKey: file.cacheKey, oldFile: contents.oldFile, newFile: contents.newFile, throwOnError: true });
					files.push(processed && hasBalancedTrailingContext(processed) ? processed : file);
				} catch {
					files.push(file);
				}
			}
		}
		return files;
	}

	function hasBalancedTrailingContext(file: FileDiffMetadata) {
		if (file.isPartial || file.hunks.length === 0) return true;
		const lastHunk = file.hunks.at(-1)!;
		const additionRemaining = file.additionLines.length - (lastHunk.additionLineIndex + lastHunk.additionCount);
		const deletionRemaining = file.deletionLines.length - (lastHunk.deletionLineIndex + lastHunk.deletionCount);
		return additionRemaining >= 0 && deletionRemaining >= 0 && additionRemaining === deletionRemaining;
	}

	function patchFileChunks(patch: string) {
		const chunks: string[] = [];
		let current: string[] = [];
		for (const line of patch.split('\n')) {
			if (line.startsWith('diff --git ') && current.length > 0) {
				chunks.push(current.join('\n'));
				current = [];
			}
			if (line.startsWith('diff --git ') || current.length > 0) current.push(line);
		}
		if (current.length > 0) chunks.push(current.join('\n'));
		return chunks;
	}

	function contentsFor(file: FileDiffMetadata, currentSession: ReviewSessionSnapshot) {
		const patchHash = hashString(currentSession.patch);
		const key = `${currentSession.id}:${patchHash}:${file.prevName ?? ''}:${file.name}`;
		let promise = fileContentsCache.get(key);
		if (!promise) {
			const params = new URLSearchParams({ file: file.name });
			if (file.prevName) params.set('previous', file.prevName);
			promise = fetch(`/api/reviews/${currentSession.id}/contents?${params}`)
				.then(async (response) => response.ok ? await response.json() as FileDiffContents : undefined)
				.catch(() => undefined);
			fileContentsCache.set(key, promise);
		}
		return promise;
	}

	function filteredPatch() {
		if (hunkRanks.length === 0 && !selectedFile) return session.patch;
		const visible = new SvelteSet(
			hunkRanks
				.filter((rank) => isolatedLevel ? rank.attentionLevel === Number(reviewLevel) : rank.attentionLevel <= Number(reviewLevel))
				.filter((rank) => !selectedFile || rank.file === selectedFile)
				.map((rank) => hunkKey(rank.file, rank.oldStart, rank.oldLines, rank.newStart, rank.newLines))
		);
		const selected = selectedFile ? new SvelteSet([selectedFile]) : undefined;
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

	function shadowHosts() {
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
		return renderReviewMarkdown(markdown, session.id);
	}

	function hashString(value: string) {
		let hash = 5381;
		for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
		return hash >>> 0;
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

<svelte:window onscroll={onScroll} onresize={() => void updateLastFileScrollPadding()} />

{#if renderError}
	<div class="mb-4 border border-danger/50 bg-danger-soft p-2 text-danger">Could not render diff: {renderError}</div>
{/if}

<div class="diff-container grid gap-1" style:padding-bottom={`${lastFileScrollPadding}px`} bind:this={container}>
	{#each renderedFiles as file (file.name)}
		{@const collapsed = isFileCollapsed(file.name)}
		{@const fileNotes = fileAnnotationsFor(file)}
		<section class="rendered-file mb-2 scroll-mt-[5.5rem] border border-border bg-surface" class:review-active-file={activeFile === file.name} data-file={file.name}>
			<div class="file-review-header sticky top-[var(--topbar-height)] z-20 flex items-center justify-between gap-1.5 border-b border-border bg-surface px-1.5 py-1">
				<button type="button" class="file-collapse-toggle min-w-0 flex-1 overflow-hidden justify-start border-0 bg-transparent p-0 text-left text-sm font-medium hover:bg-transparent" onclick={() => toggleFileCollapsed(file.name)}>
					{#if collapsed}<ChevronRight size={14} />{:else}<ChevronDown size={14} />{/if}
					<span class="file-title-label min-w-0 truncate">{file.name}</span>
				</button>
				<span class="file-change-chip flex-none px-[0.1875rem] py-[0.0625rem] text-[0.66rem] font-semibold uppercase {fileChangeClass(file.type)}">{fileChangeLabel(file.type)}</span>
				<div class="flex flex-none items-center gap-1">
					<button type="button" class="whitespace-nowrap text-xs" onclick={() => onFileComment?.(file.name)}><MessageSquarePlus size={14} /><span class="file-action-label">Comment file</span></button>
					<button type="button" class="file-reviewed-toggle whitespace-nowrap text-xs{reviewed.has(file.name) ? ' border-accent text-accent' : ''}" onclick={() => onToggleReviewed?.(file.name)}><Check size={14} /><span class="file-action-label">reviewed</span></button>
				</div>
			</div>

			{#if fileNotes.length > 0}
				<div class="file-annotations grid gap-1 border-b border-border p-1.5">
					{#each fileNotes as annotation (annotation.id)}
						<aside class="file-annotation grid grid-cols-[minmax(0,1fr)_auto] items-start gap-1 border border-accent/35 bg-accent-soft p-1" class:review-active-comment={activeCommentId === annotation.id} data-user-annotation-id={annotation.id}>
							<button type="button" class="file-annotation-body annotation-md block w-full min-w-0 border-0 bg-transparent p-0 text-left text-sm hover:bg-transparent" onclick={() => onEditAnnotation?.(annotation)}>{@html renderMarkdown(annotation.body)}</button>
							<button type="button" class="file-annotation-remove flex-none border-0 bg-transparent p-0.5 text-danger hover:bg-transparent" title="Delete annotation" aria-label="Delete annotation" onclick={() => onDeleteAnnotation?.(annotation)}><Trash2 size={14} /></button>
						</aside>
					{/each}
				</div>
			{/if}

			<div class="file-diff-host" hidden={collapsed} {@attach registerDiffHost(file.name)}></div>
		</section>
	{/each}
</div>
