<script lang="ts">
	import { marked } from 'marked';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import DiffViewer from '$lib/components/DiffViewer.svelte';
	import FileTreeViewer from '$lib/components/FileTreeViewer.svelte';
	import MarkdownEditor from '$lib/components/MarkdownEditor.svelte';
	import { Check, Clipboard, Edit3, FileText, HelpCircle, MessageSquarePlus, PanelRightClose, PanelRightOpen, Play, Settings, Trash2, X, MoreVertical, BookOpenText } from '@lucide/svelte';
	import type { ReviewAttentionLevel, ReviewDiffMode, ReviewFileSummary, ReviewFinding, ReviewMode, ReviewSessionSnapshot, UserReviewAnnotation } from '$lib/shared/review';

	let session: ReviewSessionSnapshot | undefined;
	let error: string | undefined;
	let connectionWarning: string | undefined;
	let selectedFile: string | undefined;
	let diffStyle: 'split' | 'unified' = 'split';
	let wrap = false;
	let reviewed = new Set<string>();
	let restoredSessionId: string | undefined;
	let rightOpen = true;
	let annotationDraft: { id?: string; scope: 'global' | 'file' | 'line'; file?: string; line?: number; side?: 'additions' | 'deletions'; body: string } | undefined;
	let mdEditor: { insertText: (text: string) => void; focus: () => void } | undefined;
	let agentModelKey = '';
	let agentThinkingLevel = 'off';
	let suggestComments = true;
	let autoReview = false;
	let autoReviewArmed = false;
	let autoStartedSessionId: string | undefined;
	let aiOpen = true;
	let modelDialog = false;
	let shortcutsDialog = false;
	let agentDefaultsSessionId: string | undefined;
	let finished = false;
	let copied = false;
	let copyFailed = false;
	let reviewLevel = 1;
	let isolatedLevel = false;
	let viewMenuOpen = false;
	let diffSourceMode: ReviewDiffMode = 'uncommitted';
	let diffSourceBase = 'origin/main';
	let diffSourceLoading = false;
	let diffSourceError: string | undefined;
	let diffSourceSessionId: string | undefined;
	let summaryDialog = false;
	let summaryOpenedForSession: string | undefined;
	let targetFindingId: string | undefined;
	let targetAnnotationId: string | undefined;
	let highlightedEntryId: string | undefined;
	let lastLineAnnotationTarget: { scope: 'line'; file: string; line: number; side: 'additions' | 'deletions' } | undefined;

	$: reviewId = $page.params.id;
	$: files = session?.files ?? [];
	$: findings = session?.preReview.findings ?? [];
	$: hunkRanks = session?.preReview.hunks ?? [];
	$: reviewLevelOptions = availableReviewLevelOptions(hunkRanks);
	$: currentReviewMode = reviewLevelOptions.find((option) => option.level === Number(reviewLevel)) ?? reviewModeOption(modeForLevel(reviewLevel), reviewLevel);
	$: if (session?.preReview.status === 'done' && reviewLevelOptions.length > 0 && !reviewLevelOptions.some((option) => option.level === Number(reviewLevel))) reviewLevel = reviewLevelOptions[0]!.level;
	$: visibleFiles = sortFilesForTree(filterFilesForReviewLevel(files, hunkRanks, reviewLevel));
	$: userAnnotations = session?.userAnnotations ?? [];
	$: counts = annotationCounts(visibleFiles, findings, userAnnotations);
	$: feedbackText = buildFeedback();
	$: if (session && restoredSessionId !== session.id) restoreReviewed(session.id);
	$: if (session && diffSourceSessionId !== session.id) restoreDiffSource(session);
	$: if (session && agentDefaultsSessionId !== session.id) restoreAgentDefaults(session);
	$: selectedAgentModel = session?.agentReview.models.find((model) => model.key === agentModelKey);
	$: if (selectedAgentModel && !selectedAgentModel.thinkingLevels.includes(agentThinkingLevel as never)) agentThinkingLevel = selectedAgentModel.thinkingLevels[0] ?? 'off';
	$: if (agentDefaultsSessionId) persistReviewSettings();
	$: if (session && autoReviewArmed && autoStartedSessionId !== session.id && session.preReview.status !== 'running' && agentModelKey) {
		autoStartedSessionId = session.id;
		autoReviewArmed = false;
		void runAgentReview();
	}
	$: if (session?.preReview.status === 'done' && session.preReview.summary && summaryOpenedForSession !== session.id) {
		summaryOpenedForSession = session.id;
		summaryDialog = true;
	}

	onMount(() => {
		void loadSnapshot();
		const onKeyDown = (event: KeyboardEvent) => handleShortcut(event);
		window.addEventListener('keydown', onKeyDown);
		const events = new EventSource(`/api/reviews/${reviewId}/events`);
		events.addEventListener('snapshot', (event) => {
			connectionWarning = undefined;
			session = JSON.parse((event as MessageEvent).data) as ReviewSessionSnapshot;
		});
		events.onerror = () => {
			connectionWarning = 'Live connection lost. EventSource will retry automatically.';
		};
		return () => {
			events.close();
			window.removeEventListener('keydown', onKeyDown);
		};
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

	function restoreAgentDefaults(nextSession: ReviewSessionSnapshot) {
		agentDefaultsSessionId = nextSession.id;
		let stored: Partial<{ modelKey: string; thinkingLevel: string; suggestComments: boolean; autoReview: boolean; reviewLevel: number | string; isolatedLevel: boolean }> = {};
		try { stored = JSON.parse(localStorage.getItem('pi-pair-review:settings') ?? '{}') as typeof stored; } catch { stored = {}; }
		agentModelKey = stored.modelKey && nextSession.agentReview.models.some((model) => model.key === stored.modelKey) ? stored.modelKey : nextSession.agentReview.defaultModelKey ?? nextSession.agentReview.models[0]?.key ?? '';
		agentThinkingLevel = stored.thinkingLevel ?? nextSession.agentReview.defaultThinkingLevel;
		suggestComments = stored.suggestComments ?? true;
		autoReview = stored.autoReview ?? false;
		autoReviewArmed = autoReview;
		const storedReviewLevel = Number(stored.reviewLevel);
		reviewLevel = Number.isFinite(storedReviewLevel) && storedReviewLevel >= 1 && storedReviewLevel <= 5 ? storedReviewLevel : 1;
		isolatedLevel = stored.isolatedLevel ?? true;
	}

	function persistReviewSettings() {
		localStorage.setItem('pi-pair-review:settings', JSON.stringify({ modelKey: agentModelKey, thinkingLevel: agentThinkingLevel, suggestComments, autoReview, reviewLevel: Number(reviewLevel), isolatedLevel }));
	}

	function restoreDiffSource(nextSession: ReviewSessionSnapshot) {
		diffSourceSessionId = nextSession.id;
		diffSourceMode = nextSession.diffMode ?? 'uncommitted';
		diffSourceBase = nextSession.diffBase ?? 'origin/main';
		diffSourceError = undefined;
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

	async function saveAnnotation() {
		if (!annotationDraft?.body.trim()) return;
		const draft = { ...annotationDraft, body: annotationDraft.body.trim() };
		annotationDraft = undefined;
		if (draft.id) {
			if (session) session = { ...session, userAnnotations: session.userAnnotations.map((item) => (item.id === draft.id ? { ...item, body: draft.body } : item)) };
			await fetch(`/api/reviews/${reviewId}/annotations/${draft.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: draft.body }) });
			return;
		}
		const optimistic: UserReviewAnnotation = { ...draft, id: `local-${crypto.randomUUID()}`, createdAt: new Date().toISOString() };
		if (session) session = { ...session, userAnnotations: [...session.userAnnotations, optimistic] };
		await fetch(`/api/reviews/${reviewId}/annotations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
	}

	async function removeFinding(finding: ReviewFinding) {
		if (session) session = { ...session, preReview: { ...session.preReview, findings: session.preReview.findings.filter((item) => item.id !== finding.id) } };
		await fetch(`/api/reviews/${reviewId}/findings/${finding.id}`, { method: 'DELETE' });
	}

	async function removeAnnotation(annotation: UserReviewAnnotation) {
		if (session) session = { ...session, userAnnotations: session.userAnnotations.filter((item) => item.id !== annotation.id) };
		await fetch(`/api/reviews/${reviewId}/annotations/${annotation.id}`, { method: 'DELETE' });
	}

	async function runAgentReview() {
		persistReviewSettings();
		modelDialog = false;
		if (!agentModelKey) return;
		if (session) session = { ...session, preReview: { ...session.preReview, status: 'running', error: undefined, findings: suggestComments ? session.preReview.findings : [] } };
		await fetch(`/api/reviews/${reviewId}/agent-review`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ modelKey: agentModelKey, thinkingLevel: agentThinkingLevel, suggestComments })
		});
	}

	async function changeDiffSource() {
		if ((userAnnotations.length > 0 || findings.length > 0 || reviewed.size > 0) && !confirm('Change diff source? Existing annotations, highlights, and reviewed markers for this session will be cleared.')) return;
		diffSourceLoading = true;
		diffSourceError = undefined;
		try {
			const response = await fetch(`/api/reviews/${reviewId}/diff`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mode: diffSourceMode, base: diffSourceBase })
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
				throw new Error(body?.error ?? 'Failed to change diff source');
			}
			session = (await response.json()) as ReviewSessionSnapshot;
			selectedFile = undefined;
			reviewed = new Set();
			localStorage.removeItem(`pi-pair-review:${reviewId}:reviewed`);
		} catch (changeError) {
			diffSourceError = changeError instanceof Error ? changeError.message : String(changeError);
		} finally {
			diffSourceLoading = false;
		}
	}

	async function copyFeedback() {
		copyFailed = false;
		try {
			await writeClipboard(await fetchFeedbackText());
			copied = true;
			setTimeout(() => (copied = false), 1600);
		} catch {
			copyFailed = true;
			setTimeout(() => (copyFailed = false), 1600);
		}
	}

	async function fetchFeedbackText() {
		try {
			const response = await fetch(`/api/reviews/${reviewId}/feedback`);
			if (response.ok) return ((await response.json()) as { feedback: string }).feedback;
		} catch {
			// Fall back to the local snapshot below.
		}
		return feedbackText;
	}

	async function writeClipboard(text: string) {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return;
		}
		const textarea = document.createElement('textarea');
		textarea.value = text;
		textarea.style.position = 'fixed';
		textarea.style.left = '-9999px';
		document.body.append(textarea);
		textarea.focus();
		textarea.select();
		try {
			if (!document.execCommand('copy')) throw new Error('document.execCommand(copy) failed');
		} finally {
			textarea.remove();
		}
	}

	function handleShortcut(event: KeyboardEvent) {
		const target = event.target as HTMLElement | null;
		const inEditor = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT' || target?.tagName === 'SELECT';
		if (event.key === 'Escape' && (annotationDraft || modelDialog || summaryDialog || shortcutsDialog)) {
			event.preventDefault();
			annotationDraft = undefined;
			modelDialog = false;
			summaryDialog = false;
			shortcutsDialog = false;
			return;
		}
		if (annotationDraft && ((event.ctrlKey && event.key.toLowerCase() === 's') || (event.metaKey && event.key === 'Enter'))) {
			event.preventDefault();
			void saveAnnotation();
			return;
		}
		if (annotationDraft || modelDialog || summaryDialog || shortcutsDialog || inEditor) return;
		if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
			event.preventDefault();
			void finish();
			return;
		}
		if (event.ctrlKey && event.altKey && event.key.toLowerCase() === 'b') {
			event.preventDefault();
			rightOpen = !rightOpen;
			return;
		}
		if (event.key.toLowerCase() === 'o') {
			event.preventDefault();
			annotationDraft = { scope: 'global', body: '' };
			return;
		}
		if (event.key.toLowerCase() === 'm') {
			event.preventDefault();
			annotationDraft = lastLineAnnotationTarget ? { ...lastLineAnnotationTarget, body: '' } : { scope: 'global', body: '' };
			return;
		}
		if (event.key === '+' || event.key === '=' || event.key === 'ArrowRight') {
			event.preventDefault();
			stepReviewLevel(1);
			return;
		}
		if (event.key === '-' || event.key === 'ArrowLeft') {
			event.preventDefault();
			stepReviewLevel(-1);
			return;
		}
		if (event.key.toLowerCase() === 'i') {
			event.preventDefault();
			isolatedLevel = !isolatedLevel;
			return;
		}
		if (event.key.toLowerCase() === 's') {
			event.preventDefault();
			if (session?.preReview.summary) summaryDialog = true;
			return;
		}
		if (event.key === '?') {
			event.preventDefault();
			shortcutsDialog = true;
		}
	}

	async function finish(options?: { keepalive?: boolean }) {
		if (finished || !session) return;
		finished = true;
		const payload = JSON.stringify({ feedback: feedbackText });
		if (options?.keepalive && navigator.sendBeacon) {
			navigator.sendBeacon(`/api/reviews/${reviewId}/finish`, new Blob([payload], { type: 'application/json' }));
			return;
		}
		await fetch(`/api/reviews/${reviewId}/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
		window.close();
		setTimeout(() => {
			document.body.replaceChildren(Object.assign(document.createElement('main'), { className: 'center', innerHTML: '<div class="loading-card">Feedback inserted. You can close this tab.</div>' }));
		}, 150);
	}

	function selectFinding(finding: ReviewFinding) {
		if (selectedFile && finding.file) selectedFile = finding.file;
		targetAnnotationId = undefined;
		targetFindingId = finding.id;
		highlightEntry(finding.id);
	}

	function selectAnnotation(annotation: UserReviewAnnotation) {
		if (annotation.scope === 'global') {
			editAnnotation(annotation);
			return;
		}
		if (selectedFile && annotation.file) selectedFile = annotation.file;
		targetFindingId = undefined;
		targetAnnotationId = annotation.id;
		highlightEntry(annotation.id);
	}

	function startLineAnnotation(detail: { file: string; line: number; side: 'additions' | 'deletions' }) {
		lastLineAnnotationTarget = { scope: 'line', ...detail };
		annotationDraft = { ...lastLineAnnotationTarget, body: '' };
	}

	function editAnnotation(annotation: UserReviewAnnotation) {
		annotationDraft = { id: annotation.id, scope: annotation.scope, file: annotation.file, line: annotation.line, side: annotation.side, body: annotation.body };
	}

	async function handleAnnotationImagePaste(file: File) {
		if (!annotationDraft) return;
		const response = await fetch(`/api/reviews/${reviewId}/attachments?name=${encodeURIComponent(file.name || 'image.png')}`, {
			method: 'POST',
			headers: { 'content-type': file.type || 'application/octet-stream' },
			body: await file.arrayBuffer()
		});
		if (!response.ok) return;
		const { path } = (await response.json()) as { path: string };
		mdEditor?.insertText(path);
	}

	function highlightEntry(id: string) {
		highlightedEntryId = id;
		setTimeout(() => {
			if (highlightedEntryId === id) highlightedEntryId = undefined;
		}, 900);
	}

	function severityClass(finding: ReviewFinding) {
		return `severity-${finding.severity}`;
	}

	function stepReviewLevel(direction: 1 | -1) {
		const options = reviewLevelOptions.length > 0 ? reviewLevelOptions.map((option) => option.level) : [1, 2, 3, 4, 5];
		const index = Math.max(0, options.indexOf(Number(reviewLevel) as ReviewAttentionLevel));
		reviewLevel = options[Math.min(options.length - 1, Math.max(0, index + direction))] ?? reviewLevel;
	}

	function availableReviewLevelOptions(ranks: typeof hunkRanks) {
		const levels = ranks.length > 0 ? [...new Set(ranks.map((rank) => rank.attentionLevel))].sort((left, right) => left - right) : [1, 2, 3, 4, 5] as ReviewAttentionLevel[];
		return levels.map((level) => {
			const levelRanks = ranks.filter((rank) => rank.attentionLevel === level);
			return { ...reviewModeOption(levelRanks[0]?.mode ?? modeForLevel(level), level), count: levelRanks.length };
		});
	}

	function modeForLevel(level: number): ReviewMode {
		return level === 1 ? 'deep-focus' : level === 2 ? 'careful' : level === 3 ? 'standard' : level === 4 ? 'glance' : 'background';
	}

	function reviewModeOption(mode: ReviewMode, level = 1) {
		const data: Record<ReviewMode, { label: string; description: string }> = {
			'deep-focus': { label: 'Deep focus', description: 'Highest-risk correctness, security, data, and contract changes' },
			careful: { label: 'Careful', description: 'Important domain, API, or large implementation changes' },
			standard: { label: 'Standard', description: 'Normal implementation review' },
			glance: { label: 'Glance', description: 'Quick check for style-only or low-risk UI changes' },
			background: { label: 'Background', description: 'Generated, docs, fixtures, snapshots, and other low-signal changes' }
		};
		return { level: Number(level) as ReviewAttentionLevel, mode, ...data[mode] };
	}

	function filterFilesForReviewLevel(files: ReviewFileSummary[], ranks: typeof hunkRanks, level: number) {
		if (ranks.length === 0 || session?.preReview.status !== 'done') return files;
		const visible = new Set(ranks.filter((rank) => isolatedLevel ? rank.attentionLevel === Number(level) : rank.attentionLevel <= Number(level)).map((rank) => rank.file));
		return files.filter((file) => visible.has(file.path) || (file.previousPath && visible.has(file.previousPath)));
	}

	function sortFilesForTree(files: ReviewFileSummary[]) {
		return [...files].sort((left, right) => compareTreeOrder(left.path, right.path));
	}

	function compareTreeOrder(leftPath: string, rightPath: string) {
		const left = leftPath.split('/');
		const right = rightPath.split('/');
		const length = Math.max(left.length, right.length);
		for (let index = 0; index < length; index += 1) {
			const leftPart = left[index];
			const rightPart = right[index];
			if (leftPart === undefined) return 1;
			if (rightPart === undefined) return -1;
			if (leftPart === rightPart) continue;
			const leftIsDirectory = index < left.length - 1;
			const rightIsDirectory = index < right.length - 1;
			if (leftIsDirectory !== rightIsDirectory) return leftIsDirectory ? -1 : 1;
			return leftPart.localeCompare(rightPart);
		}
		return 0;
	}

	function annotationCounts(files: ReviewFileSummary[], agent: ReviewFinding[], user: UserReviewAnnotation[]) {
		const map = new Map<string, number>();
		for (const file of files) map.set(file.path, 0);
		for (const finding of agent) if (finding.file) map.set(finding.file, (map.get(finding.file) ?? 0) + 1);
		for (const annotation of user) if (annotation.file) map.set(annotation.file, (map.get(annotation.file) ?? 0) + 1);
		return map;
	}

	function buildFeedback() {
		if (!session) return '';
		const lines: string[] = [];
		for (const finding of findings) lines.push(formatFeedbackLine(finding.file, finding.line, finding.title));
		for (const annotation of userAnnotations) lines.push(formatFeedbackLine(annotation.file, annotation.line, annotation.body));
		return lines.join('\n');
	}

	function formatFeedbackLine(file: string | undefined, line: number | undefined, body: string) {
		const formatted = body.replace(/\n/g, '\n  ');
		return file ? `- [${file}${line ? `:${line}` : ''}] ${formatted}` : `- ${formatted}`;
	}

	function renderMarkdown(markdown: string) {
		return marked.parse(markdown.trim() || 'No summary available.', { async: false, gfm: true, breaks: true }) as string;
	}

	function backdropClick(event: MouseEvent, close: () => void) {
		if (event.target === event.currentTarget) close();
	}
</script>

{#if error}
	<main class="grid min-h-screen place-items-center p-8"><div class="rounded-xl border border-danger/50 bg-danger-soft px-5 py-4 text-danger">{error}</div></main>
{:else if !session}
	<main class="grid min-h-screen place-items-center p-8"><div class="rounded-xl border border-border bg-surface-2 px-5 py-4 text-muted">Loading review…</div></main>
{:else}
	<div class="grid min-h-screen grid-cols-1 grid-rows-[auto_1fr] {rightOpen ? 'lg:grid-cols-[17rem_minmax(0,1fr)_19rem]' : 'lg:grid-cols-[17rem_minmax(0,1fr)]'}">
		<header class="sticky top-0 z-20 col-span-full flex items-center justify-between gap-4 border-b border-border bg-bg/95 px-4 backdrop-blur-sm" style="min-height: var(--topbar-height)">
			<div class="min-w-0">
				<h1 class="truncate text-[0.95rem] font-semibold">{session.title}</h1>
				<p class="truncate text-xs text-muted">{session.cwd} · {visibleFiles.length}/{files.length} files · {session.baseDescription}</p>
			</div>
			<div class="flex items-center gap-2">
				<button title="Copy feedback" on:click={copyFeedback}><Clipboard size={15} />{copied ? 'Copied' : copyFailed ? 'Copy failed' : 'Copy feedback'}</button>
				<button class="border-accent bg-accent text-accent-fg hover:bg-accent hover:opacity-90" title="Insert feedback (S)" on:click={() => finish()}><Check size={15} />Insert feedback</button>
				<button title="Toggle right sidebar (Ctrl+Alt+B)" on:click={() => (rightOpen = !rightOpen)}>{#if rightOpen}<PanelRightClose size={15} />{:else}<PanelRightOpen size={15} />{/if}{rightOpen ? 'Hide' : 'Show'} annotations</button>
				<div class="relative">
					<button class="w-8 px-0" title="View options" on:click={() => (viewMenuOpen = !viewMenuOpen)}><MoreVertical size={17} /></button>
					{#if viewMenuOpen}
						<div class="absolute right-0 top-[calc(100%+0.4rem)] z-30 grid min-w-52 gap-2.5 rounded-lg border border-border-strong bg-surface p-3 shadow-[0_12px_32px_var(--shadow)]">
							<label class="flex items-center justify-between gap-2 text-sm text-muted">View <select bind:value={diffStyle}><option value="split">Split</option><option value="unified">Unified</option></select></label>
							<label class="flex items-center gap-2 text-sm text-muted"><input type="checkbox" bind:checked={wrap} /> Wrap lines</label>
							<button type="button" on:click={() => { shortcutsDialog = true; viewMenuOpen = false; }}><HelpCircle size={15} />Keyboard shortcuts</button>
						</div>
					{/if}
				</div>
			</div>
		</header>

		<aside class="grid content-start gap-2 border-b border-border bg-bg p-2.5 lg:sticky lg:top-[var(--topbar-height)] lg:h-[calc(100vh-var(--topbar-height))] lg:overflow-auto lg:border-b-0 lg:border-r">
			{#if connectionWarning}<section class="rounded-lg border border-warning/40 bg-warning-soft p-2.5 text-sm text-warning">{connectionWarning}</section>{/if}
			<section class="grid gap-2 rounded-lg border border-border bg-surface p-2.5">
				<div class="flex items-center justify-between gap-3"><h2 class="text-[0.85rem] font-semibold">Diff source</h2><span class="rounded-full bg-code px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase text-muted">{session.diffMode ?? 'diff'}</span></div>
				<label class="grid gap-1 text-sm text-muted">Review
					<select bind:value={diffSourceMode} disabled={diffSourceLoading || session.preReview.status === 'running'}>
						<option value="unstaged">Unstaged changes</option>
						<option value="staged">Staged changes</option>
						<option value="uncommitted">Uncommitted changes</option>
						<option value="commit">Last commit</option>
						<option value="branch">Branch vs ref</option>
					</select>
				</label>
				{#if diffSourceMode === 'branch'}<label class="grid gap-1 text-sm text-muted">Base ref <input bind:value={diffSourceBase} disabled={diffSourceLoading || session.preReview.status === 'running'} placeholder="origin/main" /></label>{/if}
				<button type="button" disabled={diffSourceLoading || session.preReview.status === 'running'} on:click={changeDiffSource}>{diffSourceLoading ? 'Loading…' : 'Use source'}</button>
				{#if diffSourceError}<p class="text-sm text-danger">{diffSourceError}</p>{/if}
			</section>
			<section class="grid gap-2 rounded-lg border border-border bg-surface p-2.5">
				<div class="flex items-center justify-between gap-3"><h2 class="text-[0.85rem] font-semibold">Files</h2><span class="rounded-full bg-code px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase text-muted">{reviewed.size}/{files.length}</span></div>
				<div class="flex flex-wrap justify-end gap-2">
					<button title="Comment overall (O)" on:click={() => (annotationDraft = { scope: 'global', body: '' })}><MessageSquarePlus size={15} />Comment overall</button>
					{#if selectedFile}<button on:click={() => (annotationDraft = { scope: 'file', file: selectedFile, body: '' })}><FileText size={15} />Comment file</button><button on:click={() => toggleReviewed(selectedFile!)}><Check size={15} />{reviewed.has(selectedFile) ? 'Mark not reviewed' : 'Mark reviewed'}</button>{/if}
				</div>
				<FileTreeViewer files={visibleFiles} {selectedFile} {reviewed} {counts} on:select={(event) => (selectedFile = event.detail)} on:toggleReviewed={(event) => toggleReviewed(event.detail)} />
			</section>
		</aside>

		<main class="min-w-0 px-3 py-3 lg:pr-0" style="scroll-padding-top: calc(var(--topbar-height) + 1rem)">
			<DiffViewer {session} {findings} {hunkRanks} {reviewLevel} {isolatedLevel} {reviewed} {selectedFile} {targetFindingId} {targetAnnotationId} {diffStyle} {wrap} on:annotate={(event) => startLineAnnotation(event.detail)} on:toggleReviewed={(event) => toggleReviewed(event.detail)} on:editAnnotation={(event) => editAnnotation(event.detail)} on:deleteAnnotation={(event) => removeAnnotation(event.detail)} />
		</main>

		{#if rightOpen}
			<aside class="grid content-start gap-2 border-t border-border bg-bg p-2.5 lg:sticky lg:top-[var(--topbar-height)] lg:h-[calc(100vh-var(--topbar-height))] lg:overflow-auto lg:border-t-0 lg:border-l">
				<section class="grid gap-2 rounded-lg border border-border bg-surface p-2.5">
					<button class="flex w-full items-center justify-between gap-3 border-0 bg-transparent p-0 hover:bg-transparent" on:click={() => (aiOpen = !aiOpen)}><h2 class="text-[0.85rem] font-semibold">AI review</h2><span class="rounded-full bg-code px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase text-muted">{aiOpen ? '▾' : '▸'} {session.preReview.status === 'done' ? '✓ done' : session.preReview.status}</span></button>
					{#if aiOpen}
						<div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
							<button title="AI review settings" on:click={() => (modelDialog = true)}>{#if session.preReview.status === 'running'}<span class="inline-block h-3.5 w-3.5 flex-none animate-spin rounded-full border-2 border-accent/25 border-t-accent"></span>{:else}<Settings size={15} />{/if}Model: {selectedAgentModel?.name ?? 'none'}</button>
							{#if session.preReview.status === 'done' && session.preReview.summary}<button class="w-9 px-0" title="Show summary (S)" on:click={() => (summaryDialog = true)}><BookOpenText size={15} /></button>{/if}
						</div>
						{#if session.preReview.status === 'done'}
							<div class="grid gap-2">
								<div class="flex items-center justify-between gap-3"><h2 class="text-[0.85rem] font-semibold">Review mode</h2><span class="rounded-full bg-code px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase text-muted">{currentReviewMode.label}</span></div>
								{#if reviewLevelOptions.length <= 1}
									<p class="rounded-lg border border-border bg-surface-2 p-2 text-sm text-muted"><strong class="text-fg">{currentReviewMode.label}</strong> · {currentReviewMode.description}</p>
								{:else}
									<div class="grid gap-1.5" title="Review mode (+/-)">
										{#each reviewLevelOptions as option}
											<label class="flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-sm hover:bg-surface-hover {(isolatedLevel ? option.level === Number(reviewLevel) : option.level <= Number(reviewLevel)) ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2'}">
												<input type="radio" name="review-level" value={option.level} bind:group={reviewLevel} />
												<span class="grid min-w-0 gap-0.5"><span class="font-medium text-fg">{option.label} <span class="text-xs font-normal text-muted">({option.count})</span></span><span class="text-xs text-muted">{option.description}</span></span>
											</label>
										{/each}
									</div>
								{/if}
								<label class="flex items-center gap-2 text-sm text-muted" title="Toggle isolated review mode (I)"><input type="checkbox" bind:checked={isolatedLevel} /> Isolate selected mode</label>
							</div>
						{:else}
							<p class="text-sm text-muted">{session.preReview.status === 'idle' ? 'Run agent review from model settings.' : 'Ranking hunks…'}</p>
						{/if}
						{#if session.agentReview.models.length === 0}<p class="text-sm text-muted">No authenticated models available.</p>{/if}
						{#if session.preReview.error}<p class="text-sm text-muted">{session.preReview.error}</p>{/if}
					{/if}
				</section>
				<section class="grid gap-2 rounded-lg border border-border bg-surface p-2.5">
					<div class="flex items-center justify-between gap-3"><h2 class="text-[0.85rem] font-semibold">Agent annotations</h2><span class="rounded-full bg-code px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase text-muted">{findings.length}</span></div>
					{#if findings.length === 0}<p class="text-sm text-muted">No highlights yet.</p>{:else}<div class="grid gap-2">{#each findings as finding}<div class="grid gap-1.5 rounded-lg p-2 transition-colors {highlightedEntryId === finding.id ? 'bg-accent-soft ring-1 ring-accent' : 'bg-surface-2 hover:bg-surface-hover'}"><div class="flex items-center gap-1.5"><button class="min-w-0 flex-1 border-0 bg-transparent p-0 text-left hover:bg-transparent" on:click={() => selectFinding(finding)}><span class="flex min-w-0 items-center gap-2"><span class="{severityClass(finding)} rounded-full px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase">L{finding.attentionLevel} · {finding.severity}</span><small class="min-w-0 truncate text-muted">{finding.file ?? 'Overall'}{finding.line ? `:${finding.line}` : ''}</small></span></button><button class="flex-none rounded-full border-0 bg-transparent px-1 text-muted hover:bg-danger-soft hover:text-danger" title="Remove" on:click={() => removeFinding(finding)}><Trash2 size={14} /></button></div><button class="block w-full border-0 bg-transparent p-0 text-left hover:bg-transparent" on:click={() => selectFinding(finding)}><div class="rendered-markdown text-sm">{@html renderMarkdown(finding.title)}</div></button></div>{/each}</div>{/if}
				</section>
				<section class="grid gap-2 rounded-lg border border-border bg-surface p-2.5">
					<div class="flex items-center justify-between gap-3"><h2 class="text-[0.85rem] font-semibold">User annotations</h2><span class="rounded-full bg-code px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase text-muted">{userAnnotations.length}</span></div>
					{#if userAnnotations.length === 0}<p class="text-sm text-muted">Click line numbers, add file notes, or comment overall.</p>{:else}<div class="grid gap-2">{#each userAnnotations as annotation}<div class="grid gap-1.5 rounded-lg p-2 transition-colors {highlightedEntryId === annotation.id ? 'bg-accent-soft ring-1 ring-accent' : 'bg-surface-2 hover:bg-surface-hover'}"><div class="flex items-center gap-1.5"><button class="min-w-0 flex-1 border-0 bg-transparent p-0 text-left hover:bg-transparent" on:click={() => selectAnnotation(annotation)}><span class="flex min-w-0 items-center gap-2"><small class="min-w-0 truncate text-muted">{annotation.scope === 'global' ? 'Overall' : annotation.scope === 'file' ? annotation.file : `${annotation.file}:${annotation.line}`}</small></span></button><button class="flex-none rounded-full border-0 bg-transparent px-1 text-muted hover:bg-surface-hover hover:text-fg" title="Edit" on:click={() => editAnnotation(annotation)}><Edit3 size={14} /></button><button class="flex-none rounded-full border-0 bg-transparent px-1 text-muted hover:bg-danger-soft hover:text-danger" title="Remove" on:click={() => removeAnnotation(annotation)}><Trash2 size={14} /></button></div><button class="block w-full border-0 bg-transparent p-0 text-left hover:bg-transparent" on:click={() => selectAnnotation(annotation)}><div class="rendered-markdown text-sm">{@html renderMarkdown(annotation.body)}</div></button></div>{/each}</div>{/if}
				</section>
			</aside>
		{/if}
	</div>
{/if}

{#if modelDialog}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4 backdrop-blur-sm" on:click={(event) => backdropClick(event, () => (modelDialog = false))}>
		<div class="grid w-[min(34rem,calc(100vw-2rem))] gap-3 rounded-xl border border-border bg-surface p-5 shadow-[0_16px_48px_var(--shadow)]">
			<h2 class="text-[0.95rem] font-semibold">AI review model</h2>
			<label class="grid gap-1.5 text-sm text-muted">Model
				<select class="w-full" bind:value={agentModelKey} disabled={session?.preReview.status === 'running'}>
					{#each session?.agentReview.models ?? [] as model}
						<option value={model.key}>{model.provider}/{model.name}</option>
					{/each}
				</select>
			</label>
			<label class="grid gap-1.5 text-sm text-muted">Thinking
				<select class="w-full" bind:value={agentThinkingLevel} disabled={session?.preReview.status === 'running'}>
					{#each selectedAgentModel?.thinkingLevels ?? ['off'] as level}
						<option value={level}>{level}</option>
					{/each}
				</select>
			</label>
			<label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={suggestComments} /> Suggest comments</label>
			<label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={autoReview} /> Run automatically next time</label>
			<div class="flex justify-end gap-2 pt-1"><button title="Close dialog (Esc)" type="button" on:click={() => { persistReviewSettings(); modelDialog = false; }}>Close</button><button class="border-accent bg-accent text-accent-fg hover:bg-accent hover:opacity-90" title="Run AI review" type="button" disabled={!agentModelKey || session?.preReview.status === 'running'} on:click={runAgentReview}><Play size={15} />Run</button></div>
		</div>
	</div>
{/if}

{#if summaryDialog}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4 backdrop-blur-sm" on:click={(event) => backdropClick(event, () => (summaryDialog = false))}>
		<div class="grid max-h-[min(70vh,42rem)] w-[min(40rem,calc(100vw-2rem))] gap-3 overflow-auto rounded-xl border border-border bg-surface p-5 shadow-[0_16px_48px_var(--shadow)]">
			<h2 class="text-[0.95rem] font-semibold">Agent summary</h2>
			<div class="markdown-body text-sm">{@html renderMarkdown(session?.preReview.summary ?? '')}</div>
			<div class="flex justify-end gap-2 pt-1"><button type="button" on:click={() => (summaryDialog = false)}>Close</button></div>
		</div>
	</div>
{/if}

{#if shortcutsDialog}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4 backdrop-blur-sm" on:click={(event) => backdropClick(event, () => (shortcutsDialog = false))}>
		<div class="grid w-[min(32rem,calc(100vw-2rem))] gap-3 rounded-xl border border-border bg-surface p-5 shadow-[0_16px_48px_var(--shadow)]">
			<h2 class="text-[0.95rem] font-semibold">Keyboard shortcuts</h2>
			<dl class="grid gap-2">
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><dt class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">?</dt><dd class="text-sm text-muted">Show keyboard shortcuts</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><dt class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">O</dt><dd class="text-sm text-muted">Comment overall</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><dt class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">M</dt><dd class="text-sm text-muted">Comment last line target</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><dt class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">S</dt><dd class="text-sm text-muted">Show summary</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><dt class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">I</dt><dd class="text-sm text-muted">Toggle isolated level</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><dt class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">+ / −</dt><dd class="text-sm text-muted">Change review depth</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><dt class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">Cmd/Ctrl+Enter</dt><dd class="text-sm text-muted">Insert feedback</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><dt class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">Esc</dt><dd class="text-sm text-muted">Close dialog</dd></div>
			</dl>
			<div class="flex justify-end gap-2 pt-1"><button type="button" on:click={() => (shortcutsDialog = false)}>Close</button></div>
		</div>
	</div>
{/if}

{#if annotationDraft}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4 backdrop-blur-sm" on:click={(event) => backdropClick(event, () => (annotationDraft = undefined))}>
		<form class="grid w-[min(36rem,calc(100vw-2rem))] gap-3 rounded-xl border border-border bg-surface p-5 shadow-[0_16px_48px_var(--shadow)]" on:submit|preventDefault={saveAnnotation}>
			<h2 class="text-[0.95rem] font-semibold">{annotationDraft.id ? 'Edit annotation' : 'Add annotation'}</h2>
			<p class="text-xs text-muted">{annotationDraft.scope === 'global' ? 'Overall review' : annotationDraft.scope === 'file' ? annotationDraft.file : `${annotationDraft.file}:${annotationDraft.line} · ${annotationDraft.side}`}</p>
			<MarkdownEditor bind:this={mdEditor} bind:value={annotationDraft.body} on:imagepaste={(event) => handleAnnotationImagePaste(event.detail)} />
			<div class="flex justify-end gap-2 pt-1"><button title="Close dialog (Esc)" type="button" on:click={() => (annotationDraft = undefined)}>Cancel</button><button class="border-accent bg-accent text-accent-fg hover:bg-accent hover:opacity-90" title="Save comment (Ctrl+S or Cmd+Enter)" type="submit">Save</button></div>
		</form>
	</div>
{/if}
