<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	type ButtonSize = 'sm' | 'md' | 'icon-sm' | 'icon-md';

	let {
		children,
		size = 'md',
		class: className = '',
		...rest
	}: HTMLButtonAttributes & {
		children?: Snippet;
		size?: ButtonSize;
	} = $props();
</script>

<button class="ui-button ui-button-{size} {className}" {...rest}>
	{@render children?.()}
</button>

<style>
	.ui-button {
		min-width: 0;
	}

	.ui-button-sm {
		height: 1.5rem;
		padding-inline: 0.3rem;
		font-size: 0.75rem;
	}

	.ui-button-md {
		height: 1.75rem;
		padding-inline: 0.4rem;
	}

	.ui-button-icon-sm {
		width: 1.5rem;
		height: 1.5rem;
		padding: 0;
	}

	.ui-button-icon-md {
		width: 1.75rem;
		height: 1.75rem;
		padding: 0;
	}
</style>
