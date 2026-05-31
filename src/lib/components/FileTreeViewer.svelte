<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import { FileTree, type GitStatusEntry } from '@pierre/trees';
	import type { ReviewFileSummary } from '$lib/shared/review';

	export let files: ReviewFileSummary[] = [];
	export let selectedFile: string | undefined;
	export let reviewed = new Set<string>();
	export let counts = new Map<string, number>();

	const dispatch = createEventDispatcher<{ select: string | undefined; toggleReviewed: string }>();
	let host: HTMLDivElement;
	let tree: FileTree | undefined;
	let mounted = false;

	$: paths = files.map((file) => file.path);
	$: treeKey = `${paths.join('\n')}|${selectedFile ?? ''}|${[...reviewed].sort().join('\n')}|${[...counts.entries()].map(([path, count]) => `${path}:${count}`).join('\n')}`;
	$: if (mounted && treeKey) renderTree();

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
	}

	function gitStatus(changeType: ReviewFileSummary['changeType']): GitStatusEntry['status'] {
		return changeType === 'added' ? 'added' : changeType === 'deleted' ? 'deleted' : changeType === 'renamed' ? 'renamed' : 'modified';
	}
</script>

<button
	class="mb-2 w-full rounded-md border-0 px-3 py-2 text-left text-sm hover:bg-surface-hover {!selectedFile ? 'bg-surface-hover font-medium' : 'bg-surface-2'}"
	on:click={() => dispatch('select', undefined)}>All files</button>
<div class="h-[calc(100vh-14rem)] min-h-72" bind:this={host}></div>
