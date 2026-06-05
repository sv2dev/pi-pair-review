<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { FileTree, type GitStatusEntry } from '@pierre/trees';
	import CircularCheckProgress from './CircularCheckProgress.svelte';
	import { compareTreeOrder } from '$lib/client/review-ui';
	import type { ReviewChunk, ReviewFileSummary } from '$lib/shared/review';

	type ReviewProgressUnits = { reviewed: number; total: number };

	let {
		files = [],
		chunks = [],
		selectedFile,
		activeFile,
		reviewed = new SvelteSet<string>(),
		progress = new Map<string, number>(),
		progressUnits = new Map<string, ReviewProgressUnits>(),
		onSelect,
		onToggleReviewed,
		onSetReviewed
	}: {
		files?: ReviewFileSummary[];
		chunks?: ReviewChunk[];
		selectedFile?: string;
		activeFile?: string;
		reviewed?: Set<string>;
		progress?: ReadonlyMap<string, number>;
		progressUnits?: ReadonlyMap<string, ReviewProgressUnits>;
		onSelect?: (file: string | undefined) => void;
		onToggleReviewed?: (file: string) => void;
		onSetReviewed?: (files: string[], reviewed: boolean) => void;
	} = $props();

	let host = $state<HTMLDivElement | undefined>();
	let tree: FileTree | undefined;
	let mounted = $state(false);
	let reviewControlsObserver: MutationObserver | undefined;
	let reviewControlsFrame: number | undefined;
	let renderingReviewControls = false;

	let chunkCountByFile = $derived(countChunksByFile(chunks));
	let paths = $derived([...files].sort((left, right) => compareTreeOrder(left.path, right.path)).map((file) => file.path));
	let rootProgressUnits = $derived(progressUnitsForFiles(files.map((file) => file.path)));
	let rootProgress = $derived(rootProgressUnits.total ? Math.round((rootProgressUnits.reviewed / rootProgressUnits.total) * 100) : 0);
	let rootReviewed = $derived(rootProgressUnits.total > 0 && rootProgressUnits.reviewed >= rootProgressUnits.total);
	let treeKey = $derived(`${paths.join('\n')}|${files.map((file) => `${file.path}:${file.changeType}`).join('\n')}|${selectedFile ?? ''}`);
	let reviewControlsKey = $derived(`${[...reviewed].sort().join('\n')}|${[...progress.entries()].map(([path, value]) => `${path}:${value}`).sort().join('\n')}|${[...progressUnits.entries()].map(([path, value]) => `${path}:${value.reviewed}/${value.total}`).sort().join('\n')}|${[...chunkCountByFile.entries()].map(([file, count]) => `${file}:${count}`).join('\n')}`);

	$effect(() => {
		if (mounted && treeKey) renderTree();
	});

	$effect(() => {
		if (mounted && reviewControlsKey) scheduleRenderReviewControls();
	});

	$effect(() => {
		if (mounted) markActiveRow(selectedFile ?? activeFile);
	});

	onMount(() => {
		mounted = true;
		renderTree();
		return () => {
			cleanupReviewControls();
			tree?.cleanUp();
		};
	});

	function renderTree() {
		if (!host) return;
		cleanupReviewControls();
		tree?.cleanUp();
		host.replaceChildren();
		tree = new FileTree({
			paths,
			flattenEmptyDirectories: true,
			initialExpansion: 'open',
			initialSelectedPaths: selectedFile ? [selectedFile] : [],
			density: 'compact',
			icons: 'complete',
			gitStatus: files.map((file): GitStatusEntry => ({ path: file.path, status: gitStatus(file.changeType) })),
			unsafeCSS: treeThemeCss(),
			onSelectionChange: (selected) => onSelect?.(selected[0])
		});
		tree.render({ containerWrapper: host });
		observeTreeRows();
		renderReviewControls();
		markActiveRow(selectedFile ?? activeFile);
	}

	function cleanupReviewControls() {
		if (reviewControlsFrame !== undefined) {
			window.cancelAnimationFrame(reviewControlsFrame);
			reviewControlsFrame = undefined;
		}
		reviewControlsObserver?.disconnect();
		reviewControlsObserver = undefined;
	}

	function observeTreeRows() {
		reviewControlsObserver?.disconnect();
		const root = tree?.getFileTreeContainer()?.shadowRoot;
		if (!root) return;
		reviewControlsObserver = new MutationObserver(() => {
			if (renderingReviewControls) return;
			scheduleRenderReviewControls();
		});
		reviewControlsObserver.observe(root, { childList: true, subtree: true });
	}

	function scheduleRenderReviewControls() {
		if (reviewControlsFrame !== undefined) return;
		reviewControlsFrame = window.requestAnimationFrame(() => {
			reviewControlsFrame = undefined;
			renderReviewControls();
		});
	}

	function renderReviewControls() {
		const root = tree?.getFileTreeContainer()?.shadowRoot;
		if (!root) return;
		renderingReviewControls = true;
		try {
			for (const row of root.querySelectorAll<HTMLElement>('[data-type="item"]')) {
				const path = row.dataset.itemPath;
				const type = row.dataset.itemType;
				if (!path || (type !== 'file' && type !== 'folder')) continue;
				const targetFiles = type === 'file' ? [path] : descendantFiles(path);
				if (targetFiles.length === 0) continue;
				const units = progressUnitsForFiles(targetFiles);
				const isReviewed = units.total > 0 && units.reviewed >= units.total;
				row.classList.toggle('tree-reviewed-row', isReviewed);
			}
		} finally {
			queueMicrotask(() => {
				renderingReviewControls = false;
			});
		}
	}


	function descendantFiles(directory: string) {
		const prefix = directory.endsWith('/') ? directory : `${directory}/`;
		return files.filter((file) => file.path.startsWith(prefix)).map((file) => file.path);
	}

	function countChunksByFile(chunks: ReviewChunk[]) {
		const byFile = new Map<string, number>();
		for (const chunk of chunks) byFile.set(chunk.file, (byFile.get(chunk.file) ?? 0) + 1);
		return byFile;
	}

	function progressUnitsForFiles(filePaths: string[]) {
		return filePaths.reduce((total, path) => {
			const units = progressUnits.get(path);
			return units ? { reviewed: total.reviewed + units.reviewed, total: total.total + units.total } : total;
		}, { reviewed: 0, total: 0 });
	}

	function markActiveRow(path: string | undefined) {
		const root = tree?.getFileTreeContainer()?.shadowRoot;
		if (!root) return;
		for (const element of root.querySelectorAll<HTMLElement>('.tree-active-row')) element.classList.remove('tree-active-row');
		if (!path) return;
		const row = root.querySelector<HTMLElement>(`[data-type="item"][data-item-path="${CSS.escape(path)}"]`);
		row?.classList.add('tree-active-row');
	}

	function treeThemeCss() {
		return `
			:host, [data-file-tree-id] {
				--trees-padding-inline-override: 0px;
				--trees-item-margin-x-override: 0px;
				--trees-scrollbar-gutter-override: 0px;
				--trees-theme-list-active-selection-bg: var(--accent-soft);
				--trees-theme-list-active-selection-fg: var(--fg);
				--trees-theme-list-hover-bg: var(--surface-hover);
				--trees-theme-focus-ring: var(--accent);
				--trees-theme-git-added-fg: var(--fg);
				--trees-theme-git-modified-fg: var(--fg);
				--trees-theme-git-deleted-fg: var(--fg);
			}
			[data-item-git-status], [data-item-contains-git-change="true"] [data-item-section="git"] { color: var(--fg) !important; }
			.tree-reviewed-row, .tree-reviewed-row [data-item-section], .tree-reviewed-row [data-item-git-status], .tree-reviewed-row[data-item-contains-git-change="true"] [data-item-section="git"] { color: var(--review) !important; }
			[data-item-selected], .tree-active-row { background: var(--review-soft) !important; color: var(--fg) !important; }
		`;
	}

	function gitStatus(changeType: ReviewFileSummary['changeType']): GitStatusEntry['status'] {
		return changeType === 'added' ? 'added' : changeType === 'deleted' ? 'deleted' : changeType === 'renamed' ? 'renamed' : 'modified';
	}
</script>

<div class="mb-1 grid grid-cols-[auto_minmax(0,1fr)] items-center bg-surface-2 {!selectedFile ? 'bg-surface-hover font-medium' : ''}">
	<button
		class="grid h-7 w-7 place-items-center border-0 bg-transparent p-0 text-review hover:bg-surface-hover"
		title={`${rootProgress}% reviewed`}
		aria-label={`All files ${rootProgress}% reviewed`}
		onclick={(event) => {
			event.stopPropagation();
			onSetReviewed?.(paths, !rootReviewed);
		}}
	>
		<CircularCheckProgress progress={rootProgress} size={16} iconSize={12} />
	</button>
	<button
		class="w-full justify-start border-0 bg-transparent px-1.5 py-[0.1875rem] text-left text-sm hover:bg-surface-hover"
		onclick={() => onSelect?.(undefined)}>All files</button>
</div>
<div class="max-h-72 min-h-48 overflow-auto lg:h-[calc(100vh-14rem)] lg:max-h-none lg:min-h-72" bind:this={host}></div>
