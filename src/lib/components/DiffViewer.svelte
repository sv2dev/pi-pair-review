<script lang="ts">
	import { onMount } from 'svelte';
	import type { DiffLineAnnotation, FileDiff as FileDiffInstance, FileDiffMetadata } from '@pierre/diffs';
	import type { ReviewFinding, ReviewSessionSnapshot } from '$lib/shared/review';

	export let session: ReviewSessionSnapshot;
	export let selectedFile: string | undefined = undefined;
	export let diffStyle: 'split' | 'unified' = 'split';
	export let wrap = false;

	let container: HTMLDivElement;
	let mounted = false;
	let renderError: string | undefined;
	let renderSequence = 0;
	let instances: FileDiffInstance<ReviewFinding>[] = [];
	let modulePromise: Promise<typeof import('@pierre/diffs')> | undefined;

	$: renderKey = `${session.id}:${session.patch.length}:${session.preReview.findings.map((finding) => finding.id).join(',')}:${selectedFile ?? '*'}:${diffStyle}:${wrap}`;
	$: if (mounted && renderKey) void renderDiffs();

	onMount(() => {
		mounted = true;
		void renderDiffs();
		return cleanup;
	});

	async function renderDiffs() {
		if (!container) return;
		const sequence = ++renderSequence;
		cleanup();
		renderError = undefined;

		try {
			const { FileDiff, parsePatchFiles } = await (modulePromise ??= import('@pierre/diffs'));
			if (sequence !== renderSequence) return;

			const parsed = parsePatchFiles(session.patch, session.id, true);
			const files = parsed.flatMap((patch) => patch.files);
			const visibleFiles = selectedFile
				? files.filter((file) => file.name === selectedFile || file.prevName === selectedFile)
				: files;

			container.replaceChildren();
			for (const file of visibleFiles) {
				const section = document.createElement('section');
				section.className = 'rendered-file';
				section.dataset.file = file.name;
				container.append(section);

				const instance = new FileDiff<ReviewFinding>({
					diffStyle,
					diffIndicators: 'bars',
					lineDiffType: 'word-alt',
					hunkSeparators: 'line-info-basic',
					overflow: wrap ? 'wrap' : 'scroll',
					stickyHeader: true,
					theme: { dark: 'pierre-dark', light: 'pierre-light' },
					themeType: 'dark',
					renderAnnotation: renderFindingAnnotation
				});

				instances.push(instance);
				instance.render({
					fileDiff: file,
					containerWrapper: section,
					lineAnnotations: annotationsFor(file)
				});
			}
		} catch (error) {
			renderError = error instanceof Error ? error.message : String(error);
		}
	}

	function cleanup() {
		for (const instance of instances) instance.cleanUp();
		instances = [];
		container?.replaceChildren();
	}

	function annotationsFor(file: FileDiffMetadata): DiffLineAnnotation<ReviewFinding>[] {
		return session.preReview.findings
			.filter((finding) => finding.line && (finding.file === file.name || finding.file === file.prevName))
			.map((finding) => ({
				lineNumber: finding.line!,
				side: finding.side ?? 'additions',
				metadata: finding
			}));
	}

	function renderFindingAnnotation(annotation: DiffLineAnnotation<ReviewFinding>): HTMLElement | undefined {
		const finding = annotation.metadata;
		if (!finding) return undefined;

		const element = document.createElement('aside');
		element.style.cssText = [
			'margin: 6px 0 8px',
			'padding: 10px 12px',
			'border-radius: 10px',
			'border: 1px solid rgba(255,255,255,0.12)',
			'background: rgba(14, 18, 27, 0.92)',
			'color: #e7eaf0',
			'font: 13px/1.45 ui-sans-serif, system-ui, sans-serif'
		].join(';');

		const title = document.createElement('strong');
		title.textContent = `${finding.severity.toUpperCase()} · ${finding.title}`;
		title.style.color = severityColor(finding.severity);
		title.style.display = 'block';
		title.style.marginBottom = '4px';

		const rationale = document.createElement('div');
		rationale.textContent = finding.rationale;

		element.append(title, rationale);
		if (finding.recommendation) {
			const recommendation = document.createElement('div');
			recommendation.textContent = finding.recommendation;
			recommendation.style.marginTop = '4px';
			recommendation.style.color = '#aeb8d0';
			element.append(recommendation);
		}

		return element;
	}

	function severityColor(severity: ReviewFinding['severity']) {
		return severity === 'critical'
			? '#ff6b7a'
			: severity === 'high'
				? '#ff9f43'
				: severity === 'medium'
					? '#ffd166'
					: '#8bd3ff';
	}
</script>

{#if renderError}
	<div class="render-error">Could not render diff: {renderError}</div>
{/if}

<div class="diff-container" bind:this={container}></div>

<style>
	.diff-container {
		display: grid;
		gap: 1rem;
	}

	:global(.rendered-file) {
		border: 1px solid #293142;
		border-radius: 1rem;
		background: #11151d;
		overflow: clip;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.24);
	}

	.render-error {
		margin-bottom: 1rem;
		padding: 1rem;
		border: 1px solid rgba(255, 107, 122, 0.45);
		border-radius: 0.75rem;
		background: rgba(255, 107, 122, 0.12);
		color: #ffd7dc;
	}
</style>
