<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import DiffViewer from '$lib/components/DiffViewer.svelte';
	import type { ReviewFileSummary, ReviewFinding, ReviewSessionSnapshot } from '$lib/shared/review';

	let session: ReviewSessionSnapshot | undefined;
	let error: string | undefined;
	let connectionWarning: string | undefined;
	let selectedFile: string | undefined;
	let diffStyle: 'split' | 'unified' = 'split';
	let wrap = false;
	let reviewed = new Set<string>();
	let restoredSessionId: string | undefined;

	$: reviewId = $page.params.id;
	$: files = session?.files ?? [];
	$: findings = session?.preReview.findings ?? [];
	$: if (session && restoredSessionId !== session.id) restoreReviewed(session.id);

	onMount(() => {
		void loadSnapshot();
		const events = new EventSource(`/api/reviews/${reviewId}/events`);
		events.addEventListener('snapshot', (event) => {
			connectionWarning = undefined;
			session = JSON.parse((event as MessageEvent).data) as ReviewSessionSnapshot;
		});
		events.onerror = () => {
			connectionWarning = 'Live connection lost. EventSource will retry automatically.';
		};
		return () => events.close();
	});

	async function loadSnapshot() {
		try {
			const response = await fetch(`/api/reviews/${reviewId}`);
			if (!response.ok) throw new Error(await response.text());
			session = (await response.json()) as ReviewSessionSnapshot;
		} catch (loadError) {
			error = loadError instanceof Error ? loadError.message : String(loadError);
		}
	}

	function restoreReviewed(id: string) {
		restoredSessionId = id;
		try {
			const stored = localStorage.getItem(`pi-pair-review:${id}:reviewed`);
			reviewed = stored ? new Set(JSON.parse(stored) as string[]) : new Set();
		} catch {
			reviewed = new Set();
		}
	}

	function toggleReviewed(file: string) {
		const next = new Set(reviewed);
		if (next.has(file)) next.delete(file);
		else next.add(file);
		reviewed = next;
		if (session) localStorage.setItem(`pi-pair-review:${session.id}:reviewed`, JSON.stringify([...reviewed]));
	}

	function selectFinding(finding: ReviewFinding) {
		selectedFile = finding.file;
	}

	function findingsFor(file: ReviewFileSummary) {
		return findings.filter((finding) => finding.file === file.path || finding.file === file.previousPath);
	}

	function severityClass(finding: ReviewFinding) {
		return `severity-${finding.severity}`;
	}
</script>

{#if error}
	<main class="center">
		<div class="error-card">{error}</div>
	</main>
{:else if !session}
	<main class="center">
		<div class="loading-card">Loading review…</div>
	</main>
{:else}
	<div class="review-shell">
		<header class="topbar">
			<div>
				<p class="eyebrow">Guided review</p>
				<h1>{session.title}</h1>
				<p class="meta">{session.cwd} · {files.length} files · {session.baseDescription}</p>
			</div>
			<div class="controls">
				<label>
					View
					<select bind:value={diffStyle}>
						<option value="split">Split</option>
						<option value="unified">Unified</option>
					</select>
				</label>
				<label class="toggle">
					<input type="checkbox" bind:checked={wrap} />
					Wrap
				</label>
			</div>
		</header>

		<aside class="sidebar">
			{#if connectionWarning}
				<section class="panel warning">{connectionWarning}</section>
			{/if}
			<section class="panel">
				<div class="panel-heading">
					<h2>Agent pre-review</h2>
					<span class:running={session.preReview.status === 'running'}>{session.preReview.status}</span>
				</div>
				{#if session.preReview.error}
					<p class="note">{session.preReview.error}</p>
				{/if}
				{#if session.preReview.status === 'running'}
					<p class="note">Quick pass running in the background{session.preReview.model ? ` on ${session.preReview.model}` : ''}…</p>
				{/if}
				{#if findings.length === 0}
					<p class="empty">No highlights yet.</p>
				{:else}
					<div class="finding-list">
						{#each findings as finding}
							<button class="finding" on:click={() => selectFinding(finding)}>
								<span class={severityClass(finding)}>{finding.severity}</span>
								<strong>{finding.title}</strong>
								<small>{finding.file}{finding.line ? `:${finding.line}` : ''}</small>
							</button>
						{/each}
					</div>
				{/if}
			</section>

			<section class="panel">
				<div class="panel-heading">
					<h2>Files</h2>
					<span>{reviewed.size}/{files.length}</span>
				</div>
				<button class:selected={!selectedFile} class="file-row all" on:click={() => (selectedFile = undefined)}>
					<span>All files</span>
				</button>
				{#each files as file}
					<div class:selected={selectedFile === file.path} class="file-row">
						<button on:click={() => (selectedFile = file.path)}>
							<span>{file.path}</span>
							<small>+{file.additions} / -{file.deletions} · {file.changeType}</small>
						</button>
						<button class="reviewed" aria-label="Toggle reviewed" on:click={() => toggleReviewed(file.path)}>
							{reviewed.has(file.path) ? '✓' : '○'}
						</button>
						{#if findingsFor(file).length}
							<span class="badge">{findingsFor(file).length}</span>
						{/if}
					</div>
				{/each}
			</section>
		</aside>

		<main class="diff-pane">
			<DiffViewer {session} {selectedFile} {diffStyle} {wrap} />
		</main>
	</div>
{/if}

<style>
	.review-shell {
		display: grid;
		grid-template-columns: 22rem minmax(0, 1fr);
		grid-template-rows: auto 1fr;
		min-height: 100vh;
	}

	.topbar {
		position: sticky;
		top: 0;
		z-index: 5;
		display: flex;
		grid-column: 1 / -1;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid #293142;
		background: rgba(13, 15, 20, 0.9);
		backdrop-filter: blur(18px);
	}

	h1,
	h2,
	p {
		margin: 0;
	}

	h1 {
		font-size: 1.3rem;
	}

	h2 {
		font-size: 0.95rem;
	}

	.meta,
	.note,
	.empty,
	small {
		color: #9aa6c1;
	}

	.controls {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.controls label {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		color: #b5bfd4;
		font-size: 0.85rem;
	}

	select {
		border: 1px solid #333c4f;
		border-radius: 0.5rem;
		background: #151923;
		color: #e7eaf0;
		padding: 0.35rem 0.5rem;
	}

	.sidebar {
		position: sticky;
		top: 4.45rem;
		height: calc(100vh - 4.45rem);
		overflow: auto;
		display: grid;
		align-content: start;
		gap: 1rem;
		padding: 1rem;
		border-right: 1px solid #293142;
		background: rgba(16, 20, 29, 0.72);
	}

	.panel {
		display: grid;
		gap: 0.75rem;
		padding: 0.9rem;
		border: 1px solid #293142;
		border-radius: 1rem;
		background: rgba(17, 21, 29, 0.86);
	}

	.panel-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.panel-heading span,
	.badge,
	.finding span {
		border-radius: 999px;
		padding: 0.15rem 0.45rem;
		background: #242a35;
		color: #aeb8d0;
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.panel-heading .running {
		background: rgba(139, 211, 255, 0.16);
		color: #8bd3ff;
	}

	.finding-list,
	.file-row {
		display: grid;
		gap: 0.5rem;
	}

	.finding,
	.file-row,
	.file-row button,
	.file-row.all {
		width: 100%;
		border: 0;
		color: inherit;
		text-align: left;
	}

	.finding,
	.file-row {
		border-radius: 0.75rem;
		background: #151923;
	}

	.finding {
		display: grid;
		gap: 0.35rem;
		padding: 0.75rem;
		cursor: pointer;
	}

	.file-row {
		position: relative;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.35rem;
		padding: 0.35rem;
	}

	.file-row button {
		background: transparent;
		cursor: pointer;
	}

	.file-row button:first-child {
		display: grid;
		gap: 0.2rem;
		min-width: 0;
	}

	.file-row span,
	.file-row small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-row.selected,
	.file-row.all.selected,
	.finding:hover,
	.file-row:hover {
		background: #202637;
	}

	.file-row.all {
		padding: 0.7rem;
		cursor: pointer;
	}

	.reviewed {
		width: 1.8rem;
		height: 1.8rem;
		border-radius: 999px;
		color: #8bd3ff !important;
		text-align: center !important;
	}

	.badge {
		position: absolute;
		right: 2.5rem;
		top: 0.3rem;
		background: rgba(255, 159, 67, 0.14);
		color: #ffb86b;
	}

	.severity-critical {
		background: rgba(255, 107, 122, 0.16) !important;
		color: #ff6b7a !important;
	}

	.severity-high {
		background: rgba(255, 159, 67, 0.16) !important;
		color: #ffad5f !important;
	}

	.severity-medium {
		background: rgba(255, 209, 102, 0.16) !important;
		color: #ffd166 !important;
	}

	.severity-low {
		background: rgba(139, 211, 255, 0.16) !important;
		color: #8bd3ff !important;
	}

	.diff-pane {
		min-width: 0;
		padding: 1rem;
	}

	.center {
		display: grid;
		min-height: 100vh;
		place-items: center;
		padding: 2rem;
	}

	.error-card,
	.loading-card {
		padding: 1rem 1.25rem;
		border: 1px solid #293142;
		border-radius: 1rem;
		background: #151923;
	}

	.error-card {
		border-color: rgba(255, 107, 122, 0.45);
		color: #ffd7dc;
	}

	.warning {
		border-color: rgba(255, 209, 102, 0.35);
		color: #ffe0a3;
	}

	@media (max-width: 980px) {
		.review-shell {
			grid-template-columns: 1fr;
		}

		.sidebar {
			position: static;
			height: auto;
			border-right: 0;
			border-bottom: 1px solid #293142;
		}
	}
</style>
