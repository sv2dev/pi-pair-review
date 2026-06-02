<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { FileTree, type GitStatusEntry } from '@pierre/trees';
	import type { ReviewFileSummary } from '$lib/shared/review';

	let {
		files = [],
		selectedFile,
		activeFile,
		reviewed = new SvelteSet<string>(),
		onSelect
	}: {
		files?: ReviewFileSummary[];
		selectedFile?: string;
		activeFile?: string;
		reviewed?: Set<string>;
		onSelect?: (file: string | undefined) => void;
	} = $props();
	let host = $state<HTMLDivElement | undefined>();
	let tree: FileTree | undefined;
	let mounted = $state(false);

	let paths = $derived(files.map((file) => file.path));
	let treeKey = $derived(`${paths.join('\n')}|${selectedFile ?? ''}|${[...reviewed].sort().join('\n')}`);

	$effect(() => {
		if (mounted && treeKey) renderTree();
	});

	$effect(() => {
		if (mounted) markActiveRow(!selectedFile ? activeFile : undefined);
	});

	onMount(() => {
		mounted = true;
		renderTree();
		return () => tree?.cleanUp();
	});

	function renderTree() {
		if (!host) return;
		tree?.cleanUp();
		host.replaceChildren();
		tree = new FileTree({
			paths,
			flattenEmptyDirectories: true,
			initialExpansion: 'open',
			initialSelectedPaths: selectedFile ? [selectedFile] : [],
			icons: 'standard',
			gitStatus: files.map((file): GitStatusEntry => ({ path: file.path, status: gitStatus(file.changeType) })),
			unsafeCSS: treeThemeCss(),
			renderRowDecoration: ({ item }) => {
				const path = item.path;
				return reviewed.has(path) ? { text: 'reviewed' } : null;
			},
			onSelectionChange: (selected) => onSelect?.(selected[0])
		});
		tree.render({ containerWrapper: host });
		markActiveRow(!selectedFile ? activeFile : undefined);
	}

	function markActiveRow(path: string | undefined) {
		if (!host) return;
		for (const element of host.querySelectorAll<HTMLElement>('.tree-active-row')) element.classList.remove('tree-active-row');
		if (!path) return;
		const row = host.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"], [data-tree-path="${CSS.escape(path)}"]`);
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
			[data-item-selected] { background: var(--accent-soft) !important; color: var(--fg) !important; }
		`;
	}

	function gitStatus(changeType: ReviewFileSummary['changeType']): GitStatusEntry['status'] {
		return changeType === 'added' ? 'added' : changeType === 'deleted' ? 'deleted' : changeType === 'renamed' ? 'renamed' : 'modified';
	}
</script>

<button
	class="mb-1 w-full justify-start border-0 px-1.5 py-[0.1875rem] text-left text-sm hover:bg-surface-hover {!selectedFile ? 'bg-surface-hover font-medium' : 'bg-surface-2'}"
	onclick={() => onSelect?.(undefined)}>All files</button>
<div class="max-h-72 min-h-48 overflow-auto lg:h-[calc(100vh-14rem)] lg:max-h-none lg:min-h-72" bind:this={host}></div>
