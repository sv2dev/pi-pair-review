<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import { FileTree, type GitStatusEntry } from '@pierre/trees';
	import type { ReviewFileSummary } from '$lib/shared/review';

	export let files: ReviewFileSummary[] = [];
	export let selectedFile: string | undefined;
	export let activeFile: string | undefined;
	export let reviewed = new Set<string>();
	export let counts = new Map<string, number>();

	const dispatch = createEventDispatcher<{ select: string | undefined; toggleReviewed: string }>();
	let host: HTMLDivElement | undefined;
	let tree: FileTree | undefined;
	let mounted = false;

	$: paths = files.map((file) => file.path);
	$: treeKey = `${paths.join('\n')}|${selectedFile ?? ''}|${[...reviewed].sort().join('\n')}|${[...counts.entries()].map(([path, count]) => `${path}:${count}`).join('\n')}`;
	$: if (mounted && treeKey) renderTree();
	$: if (mounted) markActiveRow(!selectedFile ? activeFile : undefined);

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
			renderRowDecoration: ({ item }) => {
				const path = item.path;
				const parts = [];
				const count = counts.get(path) ?? 0;
				if (count) parts.push(String(count));
				if (reviewed.has(path)) parts.push('✓');
				return parts.length ? { text: parts.join(' ') } : null;
			},
			onSelectionChange: (selected) => dispatch('select', selected[0])
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

	function gitStatus(changeType: ReviewFileSummary['changeType']): GitStatusEntry['status'] {
		return changeType === 'added' ? 'added' : changeType === 'deleted' ? 'deleted' : changeType === 'renamed' ? 'renamed' : 'modified';
	}
</script>

<button
	class="mb-1 w-full justify-start rounded-md border-0 px-3 py-1.5 text-left text-sm hover:bg-surface-hover {!selectedFile ? 'bg-surface-hover font-medium' : 'bg-surface-2'}"
	on:click={() => dispatch('select', undefined)}>All files</button>
<div class="h-[calc(100vh-14rem)] min-h-72" bind:this={host}></div>
