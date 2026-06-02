<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { FileTree, type GitStatusEntry } from '@pierre/trees';
	import CircularCheckProgress from './CircularCheckProgress.svelte';
	import type { ReviewFileSummary } from '$lib/shared/review';

	type ReviewProgressUnits = { reviewed: number; total: number };

	let {
		files = [],
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

	let paths = $derived(files.map((file) => file.path));
	let rootProgressUnits = $derived(progressUnitsFor(paths));
	let rootProgress = $derived(rootProgressUnits.total ? Math.round((rootProgressUnits.reviewed / rootProgressUnits.total) * 100) : 0);
	let rootReviewed = $derived(rootProgressUnits.total > 0 && rootProgressUnits.reviewed >= rootProgressUnits.total);
	let treeKey = $derived(`${paths.join('\n')}|${files.map((file) => `${file.path}:${file.changeType}`).join('\n')}|${selectedFile ?? ''}`);
	let reviewControlsKey = $derived(`${[...reviewed].sort().join('\n')}|${[...progress.entries()].map(([path, value]) => `${path}:${value}`).sort().join('\n')}|${[...progressUnits.entries()].map(([path, value]) => `${path}:${value.reviewed}/${value.total}`).sort().join('\n')}`);

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
			icons: 'standard',
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
				const icon = row.querySelector<HTMLElement>('[data-item-section="icon"]');
				if (!icon) continue;
				const units = progressUnitsFor(targetFiles);
				const value = units.total ? Math.round((units.reviewed / units.total) * 100) : type === 'file' ? progress.get(path) ?? 0 : 0;
				const isReviewed = units.total > 0 && units.reviewed >= units.total;
				const marker = ensureReviewMarker(icon);
				const wasReviewed = marker.classList.contains('reviewed');
				marker.classList.toggle('reviewed', isReviewed);
				marker.classList.remove('review-marker-animate');
				if (!wasReviewed && isReviewed) {
					void marker.offsetWidth;
					marker.classList.add('review-marker-animate');
				}
				marker.title = `${value}% reviewed`;
				marker.setAttribute('aria-label', `${path} ${value}% reviewed`);
				marker.style.setProperty('--tree-review-progress-offset', String(100 - value));
				marker.style.setProperty('--tree-review-progress-opacity', value > 0 ? '1' : '0');
				marker.onclick = (event) => {
					event.preventDefault();
					event.stopPropagation();
					if (type === 'file') onToggleReviewed?.(path);
					else onSetReviewed?.(targetFiles, !isReviewed);
				};
			}
		} finally {
			queueMicrotask(() => {
				renderingReviewControls = false;
			});
		}
	}

	function ensureReviewMarker(icon: HTMLElement) {
		const existing = icon.querySelector<HTMLButtonElement>('.tree-reviewed-toggle');
		if (existing) return existing;
		const marker = document.createElement('button');
		marker.type = 'button';
		marker.className = 'tree-reviewed-toggle';
		marker.onmousedown = (event) => {
			event.preventDefault();
			event.stopPropagation();
		};
		marker.innerHTML = `<svg class="tree-review-marker" viewBox="0 0 24 24" aria-hidden="true"><circle class="tree-review-marker-ring" pathLength="100" cx="12" cy="12" r="10.75"></circle><path class="tree-review-marker-check" pathLength="100" d="M18.5 7.25 10 16.25 5.5 12"></path></svg>`;
		icon.replaceChildren(marker);
		return marker;
	}

	function descendantFiles(directory: string) {
		const prefix = directory.endsWith('/') ? directory : `${directory}/`;
		return files.filter((file) => file.path.startsWith(prefix)).map((file) => file.path);
	}

	function progressUnitsFor(paths: string[]) {
		return paths.reduce((total, path) => {
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
				--trees-theme-git-added-fg: var(--accent);
				--trees-theme-git-modified-fg: var(--accent);
				--trees-theme-git-deleted-fg: var(--danger);
			}
			[data-item-git-status], [data-item-contains-git-change="true"] [data-item-section="git"] { color: var(--accent) !important; }
			[data-item-git-status="deleted"] { color: var(--danger) !important; }
			[data-item-selected], .tree-active-row { background: var(--accent-soft) !important; color: var(--fg) !important; }
			.tree-reviewed-toggle {
				display: inline-grid;
				place-items: center;
				width: 1rem;
				height: 1rem;
				min-width: 1rem;
				min-height: 1rem;
				margin: 0;
				padding: 0;
				border: 0;
				background: transparent;
				color: var(--muted);
				cursor: pointer;
				line-height: 0;
			}
			.tree-reviewed-toggle.reviewed,
			.tree-reviewed-toggle:hover {
				color: var(--accent);
			}
			.tree-review-marker {
				display: block;
				width: 1rem;
				height: 1rem;
				overflow: visible;
			}
			.tree-review-marker-ring {
				fill: none;
				stroke: var(--accent);
				stroke-width: 2;
				stroke-linecap: round;
				stroke-dasharray: 100;
				stroke-dashoffset: var(--tree-review-progress-offset, 100);
				opacity: var(--tree-review-progress-opacity, 0);
				transform: rotate(-90deg);
				transform-origin: center;
				transition:
					stroke-dashoffset 0.35s ease,
					opacity 0.12s ease;
			}
			.tree-review-marker-check {
				fill: none;
				stroke: currentColor;
				stroke-width: 2.25;
				stroke-linecap: round;
				stroke-linejoin: round;
				stroke-dasharray: 100;
				stroke-dashoffset: 0;
				transition: stroke 0.15s ease;
			}
			.tree-reviewed-toggle.review-marker-animate .tree-review-marker-ring {
				animation: tree-review-ring-draw 0.35s ease-out;
			}
			.tree-reviewed-toggle.review-marker-animate .tree-review-marker-check {
				animation: tree-review-check-draw 0.35s ease-out;
			}
			@keyframes tree-review-ring-draw {
				0% { stroke-dashoffset: 100; opacity: 0; }
				100% { stroke-dashoffset: var(--tree-review-progress-offset, 0); opacity: var(--tree-review-progress-opacity, 1); }
			}
			@keyframes tree-review-check-draw {
				0% { stroke-dashoffset: 100; opacity: 0.35; }
				100% { stroke-dashoffset: 0; opacity: 1; }
			}
		`;
	}

	function gitStatus(changeType: ReviewFileSummary['changeType']): GitStatusEntry['status'] {
		return changeType === 'added' ? 'added' : changeType === 'deleted' ? 'deleted' : changeType === 'renamed' ? 'renamed' : 'modified';
	}
</script>

<div class="mb-1 grid grid-cols-[auto_minmax(0,1fr)] items-center bg-surface-2 {!selectedFile ? 'bg-surface-hover font-medium' : ''}">
	<button
		class="grid h-7 w-7 place-items-center border-0 bg-transparent p-0 hover:bg-surface-hover"
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
