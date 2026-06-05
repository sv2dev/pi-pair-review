<script lang="ts">
	import { Check } from '@lucide/svelte';

	let {
		progress = 0,
		size = 20,
		iconSize = 15,
		showCheck = true,
		class: className = '',
		title
	}: {
		progress?: number;
		size?: number;
		iconSize?: number;
		showCheck?: boolean;
		class?: string;
		title?: string;
	} = $props();

	let progressValue = $derived(Math.max(0, Math.min(100, Number(progress) || 0)));
	let progressOffset = $derived(100 - progressValue);
	let progressOpacity = $derived(progressValue > 0 ? 1 : 0);
</script>

<span class="circular-check-progress {className}" style:--circular-check-size={`${size}px`} style:--circular-check-progress-offset={progressOffset} style:--circular-check-progress-opacity={progressOpacity} {title}>
	{#if showCheck}<Check size={iconSize} />{/if}
	<svg class="circular-check-progress-circle" viewBox="0 0 24 24" aria-hidden="true">
		<circle class="circular-check-progress-background" cx="12" cy="12" r="10" />
		<circle class="circular-check-progress-path" pathLength="100" cx="12" cy="12" r="10" />
	</svg>
</span>

<style>
	.circular-check-progress {
		position: relative;
		display: inline-grid;
		place-items: center;
		width: var(--circular-check-size, 20px);
		height: var(--circular-check-size, 20px);
		flex: none;
		color: inherit;
	}

	.circular-check-progress > :global(svg:not(.circular-check-progress-circle)) {
		transform: translateY(1px);
	}

	.circular-check-progress-circle {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		overflow: visible;
		pointer-events: none;
		transform: rotate(-90deg);
	}

	.circular-check-progress-background,
	.circular-check-progress-path {
		fill: none;
		stroke: var(--circular-check-progress-color, var(--review));
		stroke-width: 2;
	}

	.circular-check-progress-background {
		opacity: var(--circular-check-progress-background-opacity, 0.18);
	}

	.circular-check-progress-path {
		stroke-linecap: round;
		stroke-dasharray: 100;
		stroke-dashoffset: var(--circular-check-progress-offset, 100);
		opacity: var(--circular-check-progress-opacity, 0);
		transition:
			stroke-dashoffset 0.35s ease,
			opacity 0.12s ease;
	}
</style>
