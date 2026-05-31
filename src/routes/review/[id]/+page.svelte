<script lang="ts">
	import { marked } from 'marked';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import DiffViewer from '$lib/components/DiffViewer.svelte';
	import FileTreeViewer from '$lib/components/FileTreeViewer.svelte';
	import { Check, Clipboard, Edit3, FileText, HelpCircle, MessageSquarePlus, PanelRightClose, PanelRightOpen, Play, Settings, Trash2, X, MoreVertical, BookOpenText } from '@lucide/svelte';
	import type { ReviewFileSummary, ReviewFinding, ReviewSessionSnapshot, UserReviewAnnotation } from '$lib/shared/review';

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
	let annotationTextarea: HTMLTextAreaElement | undefined;
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
	$: visibleFiles = sortFilesForTree(filterFilesForReviewLevel(files, hunkRanks, reviewLevel));
	$: userAnnotations = session?.userAnnotations ?? [];
	$: counts = annotationCounts(visibleFiles, findings, userAnnotations);
	$: feedbackText = buildFeedback();
	$: if (session && restoredSessionId !== session.id) restoreReviewed(session.id);
	$: if (session && agentDefaultsSessionId !== session.id) restoreAgentDefaults(session);
	$: selectedAgentModel = session?.agentReview.models.find((model) => model.key === agentModelKey);
	$: if (selectedAgentModel && !selectedAgentModel.thinkingLevels.includes(agentThinkingLevel as never)) agentThinkingLevel = selectedAgentModel.thinkingLevels[0] ?? 'off';
	$: if (annotationDraft && annotationTextarea) setTimeout(() => annotationTextarea?.focus());
	$: if (agentDefaultsSessionId) persistReviewSettings();
	$: if (session && autoReviewArmed && autoStartedSessionId !== session.id && session.preReview.status === 'idle' && agentModelKey) {
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
		const onPageHide = () => void finish({ keepalive: true });
		window.addEventListener('pagehide', onPageHide);
		return () => {
			events.close();
			window.removeEventListener('pagehide', onPageHide);
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
		isolatedLevel = stored.isolatedLevel ?? false;
	}

	function persistReviewSettings() {
		localStorage.setItem('pi-pair-review:settings', JSON.stringify({ modelKey: agentModelKey, thinkingLevel: agentThinkingLevel, suggestComments, autoReview, reviewLevel: Number(reviewLevel), isolatedLevel }));
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
			reviewLevel = Math.min(5, Number(reviewLevel) + 1);
			return;
		}
		if (event.key === '-' || event.key === 'ArrowLeft') {
			event.preventDefault();
			reviewLevel = Math.max(1, Number(reviewLevel) - 1);
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

	async function handleAnnotationPaste(event: ClipboardEvent) {
		const file = [...(event.clipboardData?.files ?? [])].find((item) => item.type.startsWith('image/'));
		if (!file || !annotationDraft) return;
		event.preventDefault();
		const response = await fetch(`/api/reviews/${reviewId}/attachments?name=${encodeURIComponent(file.name || 'image.png')}`, {
			method: 'POST',
			headers: { 'content-type': file.type || 'application/octet-stream' },
			body: await file.arrayBuffer()
		});
		if (!response.ok) return;
		const { path } = (await response.json()) as { path: string };
		insertIntoAnnotationDraft(path);
	}

	function insertIntoAnnotationDraft(text: string) {
		if (!annotationDraft) return;
		const textarea = annotationTextarea;
		const start = textarea?.selectionStart ?? annotationDraft.body.length;
		const end = textarea?.selectionEnd ?? start;
		annotationDraft = { ...annotationDraft, body: `${annotationDraft.body.slice(0, start)}${text}${annotationDraft.body.slice(end)}` };
		setTimeout(() => textarea?.setSelectionRange(start + text.length, start + text.length));
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
		return lines.length > 0 ? lines.join('\n') : '- No feedback entries.';
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
	<main class="center"><div class="error-card">{error}</div></main>
{:else if !session}
	<main class="center"><div class="loading-card">Loading review…</div></main>
{:else}
	<div class:right-collapsed={!rightOpen} class="review-shell">
		<header class="topbar">
			<div>
				<h1>{session.title}</h1>
				<p class="meta">{session.cwd} · {visibleFiles.length}/{files.length} files · {session.baseDescription}</p>
			</div>
			<div class="controls">
				<button title="Copy feedback" on:click={copyFeedback}><Clipboard size={16} />{copied ? 'Copied' : copyFailed ? 'Copy failed' : 'Copy feedback'}</button>
				<button title="Insert feedback (S)" on:click={() => finish()}><Check size={16} />Insert feedback</button>
				<button title="Toggle right sidebar (Ctrl+Alt+B)" on:click={() => (rightOpen = !rightOpen)}>{#if rightOpen}<PanelRightClose size={16} />{:else}<PanelRightOpen size={16} />{/if}{rightOpen ? 'Hide' : 'Show'} annotations</button>
				<div class="view-menu">
					<button class="icon-button" title="View options" on:click={() => (viewMenuOpen = !viewMenuOpen)}><MoreVertical size={18} /></button>
					{#if viewMenuOpen}
						<div class="view-popover">
							<label>View <select bind:value={diffStyle}><option value="split">Split</option><option value="unified">Unified</option></select></label>
							<label class="toggle"><input type="checkbox" bind:checked={wrap} /> Wrap lines</label>
							<button type="button" on:click={() => { shortcutsDialog = true; viewMenuOpen = false; }}><HelpCircle size={16} />Keyboard shortcuts</button>
						</div>
					{/if}
				</div>
			</div>
		</header>

		<aside class="sidebar left">
			{#if connectionWarning}<section class="panel warning">{connectionWarning}</section>{/if}
			<section class="panel">
				<div class="panel-heading"><h2>Files</h2><span>{reviewed.size}/{files.length}</span></div>
				<div class="file-actions">
					<button title="Comment overall (O)" on:click={() => (annotationDraft = { scope: 'global', body: '' })}><MessageSquarePlus size={16} />Comment overall</button>
					{#if selectedFile}<button on:click={() => (annotationDraft = { scope: 'file', file: selectedFile, body: '' })}><FileText size={16} />Comment file</button><button on:click={() => toggleReviewed(selectedFile!)}><Check size={16} />{reviewed.has(selectedFile) ? 'Mark not reviewed' : 'Mark reviewed'}</button>{/if}
				</div>
				<FileTreeViewer files={visibleFiles} {selectedFile} {reviewed} {counts} on:select={(event) => (selectedFile = event.detail)} on:toggleReviewed={(event) => toggleReviewed(event.detail)} />
			</section>
		</aside>

		<main class="diff-pane">
			<DiffViewer {session} {findings} {hunkRanks} {reviewLevel} {isolatedLevel} {reviewed} {selectedFile} {targetFindingId} {targetAnnotationId} {diffStyle} {wrap} on:annotate={(event) => startLineAnnotation(event.detail)} on:toggleReviewed={(event) => toggleReviewed(event.detail)} on:editAnnotation={(event) => editAnnotation(event.detail)} on:deleteAnnotation={(event) => removeAnnotation(event.detail)} />
		</main>

		{#if rightOpen}
			<aside class="sidebar right">
				<section class="panel">
					<button class="panel-toggle" on:click={() => (aiOpen = !aiOpen)}><h2>AI review</h2><span>{aiOpen ? '▾' : '▸'} {session.preReview.status === 'done' ? '✓ done' : session.preReview.status}</span></button>
					{#if aiOpen}
						<div class="agent-controls">
							<button title="AI review settings" on:click={() => (modelDialog = true)}>{#if session.preReview.status === 'running'}<span class="spinner"></span>{:else}<Settings size={16} />{/if}Model: {selectedAgentModel?.name ?? 'none'}</button>
							{#if session.preReview.status === 'done' && session.preReview.summary}<button title="Show summary (S)" on:click={() => (summaryDialog = true)}><BookOpenText size={16} /></button>{/if}
						</div>
						{#if session.preReview.status === 'done'}
							<div class="panel-heading"><h2>Review depth</h2><span>Level {reviewLevel}/5</span></div>
							<input title="Review depth (+/-)" type="range" min="1" max="5" step="1" bind:value={reviewLevel} />
							<label class="toggle" title="Toggle isolated review level (I)"><input type="checkbox" bind:checked={isolatedLevel} /> Isolated level</label>
						{:else}
							<p class="note">{session.preReview.status === 'idle' ? 'Run agent review from model settings.' : 'Ranking hunks…'}</p>
						{/if}
						{#if session.agentReview.models.length === 0}<p class="note">No authenticated models available.</p>{/if}
						{#if session.preReview.error}<p class="note">{session.preReview.error}</p>{/if}
					{/if}
				</section>
				<section class="panel">
					<div class="panel-heading"><h2>Agent annotations</h2><span>{findings.length}</span></div>
					{#if findings.length === 0}<p class="empty">No highlights yet.</p>{:else}<div class="finding-list">{#each findings as finding}<div class:flash={highlightedEntryId === finding.id} class="finding"><div class="card-top"><button class="finding-main" on:click={() => selectFinding(finding)}><span class="card-meta"><span class={severityClass(finding)}>L{finding.attentionLevel} · {finding.severity}</span><small>{finding.file ?? 'Overall'}{finding.line ? `:${finding.line}` : ''}</small></span></button><button class="remove" title="Remove" on:click={() => removeFinding(finding)}><Trash2 size={15} /></button></div><button class="finding-body" on:click={() => selectFinding(finding)}><div class="rendered-markdown">{@html renderMarkdown(finding.title)}</div></button></div>{/each}</div>{/if}
				</section>
				<section class="panel">
					<div class="panel-heading"><h2>User annotations</h2><span>{userAnnotations.length}</span></div>
					{#if userAnnotations.length === 0}<p class="empty">Click line numbers, add file notes, or comment overall.</p>{:else}<div class="finding-list">{#each userAnnotations as annotation}<div class:flash={highlightedEntryId === annotation.id} class="finding"><div class="card-top"><button class="finding-main" on:click={() => selectAnnotation(annotation)}><span class="card-meta"><small>{annotation.scope === 'global' ? 'Overall' : annotation.scope === 'file' ? annotation.file : `${annotation.file}:${annotation.line}`}</small></span></button><button class="remove" title="Edit" on:click={() => editAnnotation(annotation)}><Edit3 size={15} /></button><button class="remove" title="Remove" on:click={() => removeAnnotation(annotation)}><Trash2 size={15} /></button></div><button class="finding-body" on:click={() => selectAnnotation(annotation)}><div class="rendered-markdown">{@html renderMarkdown(annotation.body)}</div></button></div>{/each}</div>{/if}
				</section>
			</aside>
		{/if}
	</div>
{/if}

{#if modelDialog}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal-backdrop" on:click={(event) => backdropClick(event, () => (modelDialog = false))}>
		<div class="annotation-modal">
			<h2>AI review model</h2>
			<label>Model
				<select bind:value={agentModelKey} disabled={session?.preReview.status === 'running'}>
					{#each session?.agentReview.models ?? [] as model}
						<option value={model.key}>{model.provider}/{model.name}</option>
					{/each}
				</select>
			</label>
			<label>Thinking
				<select bind:value={agentThinkingLevel} disabled={session?.preReview.status === 'running'}>
					{#each selectedAgentModel?.thinkingLevels ?? ['off'] as level}
						<option value={level}>{level}</option>
					{/each}
				</select>
			</label>
			<label class="toggle"><input type="checkbox" bind:checked={suggestComments} /> Suggest comments</label>
			<label class="toggle"><input type="checkbox" bind:checked={autoReview} /> Run automatically next time</label>
			<div class="modal-actions"><button title="Close dialog (Esc)" type="button" on:click={() => { persistReviewSettings(); modelDialog = false; }}>Close</button><button title="Run AI review" type="button" disabled={!agentModelKey || session?.preReview.status === 'running'} on:click={runAgentReview}><Play size={16} />Run</button></div>
		</div>
	</div>
{/if}

{#if summaryDialog}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal-backdrop" on:click={(event) => backdropClick(event, () => (summaryDialog = false))}>
		<div class="annotation-modal summary-modal">
			<h2>Agent summary</h2>
			<div class="markdown-body">{@html renderMarkdown(session?.preReview.summary ?? '')}</div>
			<div class="modal-actions"><button type="button" on:click={() => (summaryDialog = false)}>Close</button></div>
		</div>
	</div>
{/if}

{#if shortcutsDialog}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal-backdrop" on:click={(event) => backdropClick(event, () => (shortcutsDialog = false))}>
		<div class="annotation-modal shortcuts-modal">
			<h2>Keyboard shortcuts</h2>
			<dl class="shortcuts-list">
				<div><dt>?</dt><dd>Show keyboard shortcuts</dd></div>
				<div><dt>O</dt><dd>Comment overall</dd></div>
				<div><dt>M</dt><dd>Comment last line target</dd></div>
				<div><dt>S</dt><dd>Show summary</dd></div>
				<div><dt>I</dt><dd>Toggle isolated level</dd></div>
				<div><dt>+ / −</dt><dd>Change review depth</dd></div>
				<div><dt>Cmd/Ctrl+Enter</dt><dd>Insert feedback</dd></div>
				<div><dt>Esc</dt><dd>Close dialog</dd></div>
			</dl>
			<div class="modal-actions"><button type="button" on:click={() => (shortcutsDialog = false)}>Close</button></div>
		</div>
	</div>
{/if}

{#if annotationDraft}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal-backdrop" on:click={(event) => backdropClick(event, () => (annotationDraft = undefined))}>
		<form class="annotation-modal" on:submit|preventDefault={saveAnnotation}>
			<h2>{annotationDraft.id ? 'Edit annotation' : 'Add annotation'}</h2>
			<p class="meta">{annotationDraft.scope === 'global' ? 'Overall review' : annotationDraft.scope === 'file' ? annotationDraft.file : `${annotationDraft.file}:${annotationDraft.line} · ${annotationDraft.side}`}</p>
			<textarea title="Paste images to insert a temp file path. Save with Ctrl+S or Cmd+Enter; close with Esc" bind:this={annotationTextarea} bind:value={annotationDraft.body} on:paste={handleAnnotationPaste}></textarea>
			<div class="modal-actions"><button title="Close dialog (Esc)" type="button" on:click={() => (annotationDraft = undefined)}>Cancel</button><button title="Save comment (Ctrl+S or Cmd+Enter)" type="submit">Save</button></div>
		</form>
	</div>
{/if}

<style>
	.review-shell { --topbar-height: 4.25rem; display: grid; grid-template-columns: 22rem minmax(0, 1fr) 24rem; grid-template-rows: auto 1fr; min-height: 100vh; }
	.review-shell.right-collapsed { grid-template-columns: 22rem minmax(0, 1fr); }
	.topbar { position: sticky; top: 0; z-index: 5; display: flex; grid-column: 1 / -1; align-items: center; justify-content: space-between; gap: 1rem; min-height: var(--topbar-height); padding: 0.55rem 1.25rem; border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--bg) 94%, transparent); backdrop-filter: blur(18px); }
	h1, h2, p { margin: 0; } h1 { font-size: 1.15rem; } h2 { font-size: 0.95rem; }
	.meta, .note, .empty, small { color: var(--muted); }
	.controls { display: flex; align-items: center; gap: 0.75rem; }
	.controls label { display: flex; align-items: center; gap: 0.4rem; color: var(--muted); font-size: 0.85rem; }
	.view-menu { position: relative; }
	.icon-button { width: 2rem; padding: 0.35rem; }
	.view-popover { position: absolute; right: 0; top: calc(100% + 0.4rem); z-index: 20; display: grid; gap: 0.65rem; min-width: 13rem; padding: 0.75rem; border: 1px solid var(--border-strong); border-radius: 0.75rem; background: var(--panel-solid); box-shadow: 0 12px 32px rgba(0,0,0,0.35); }
	button, select { border: 1px solid var(--border-strong); border-radius: 0.5rem; background: var(--panel-soft); color: var(--text); padding: 0.35rem 0.5rem; line-height: 1.3; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 0.35rem; }
.icon { display: inline-flex; align-items: center; justify-content: center; width: 1em; height: 1em; line-height: 1; flex: none; position: relative; top: 0.04em; font-size: 0.9em; }
.spinner { display: inline-block; width: 0.85rem; height: 0.85rem; border: 2px solid rgba(139,211,255,.25); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; flex: none; }
@keyframes spin { to { transform: rotate(360deg); } }
	.sidebar { position: sticky; top: var(--topbar-height); height: calc(100vh - var(--topbar-height)); overflow: auto; display: grid; align-content: start; gap: 1rem; padding: 1rem; background: var(--panel); }
	.sidebar.left { border-right: 1px solid var(--border); } .sidebar.right { border-left: 1px solid var(--border); }
	.panel { display: grid; gap: 0.75rem; padding: 0.9rem; border: 1px solid var(--border); border-radius: 1rem; background: var(--panel); }
	.panel-heading, .panel-toggle { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
	.panel-toggle { width: 100%; border: 0; background: transparent; padding: 0; text-align: left; }
	.panel-heading span, .finding span:not(.card-meta) { border-radius: 999px; padding: 0.15rem 0.45rem; background: var(--code-bg); color: var(--muted); font-size: 0.72rem; font-weight: 700; text-transform: uppercase; }
	.agent-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.5rem; }
	.file-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.5rem; }
	.depth-scale { display: flex; justify-content: space-between; color: var(--muted); font-size: 0.75rem; }
	.finding-list { display: grid; gap: 0.5rem; }
	.finding { display: grid; gap: 0.35rem; width: 100%; border-radius: 0.75rem; background: var(--panel-soft); padding: 0.35rem; transition: background 0.2s, box-shadow 0.2s; }
	.finding:hover { background: var(--panel-hover); }
	.finding.flash { background: rgba(139, 211, 255, 0.18); box-shadow: 0 0 0 1px rgba(139, 211, 255, 0.55); }
	.card-top { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 0.35rem; }
	.finding-main, .finding-body { min-width: 0; border: 0; background: transparent; color: inherit; padding: 0; text-align: left; cursor: pointer; }
	.finding-body { display: block; width: 100%; justify-content: flex-start; align-items: flex-start; }
	.card-meta { display: flex; align-items: center; justify-content: flex-start; gap: 0.5rem; min-width: 0; text-align: left; }
	.card-meta small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.remove { align-self: start; border: 0; border-radius: 999px; background: transparent; color: var(--muted); padding: 0 0.35rem; font-size: 1rem; line-height: 1.2; min-width: 1.5rem; }
	.remove:hover { background: rgba(255, 107, 122, 0.14); color: var(--danger); }
	.severity-critical { background: var(--danger-soft) !important; color: var(--danger) !important; } .severity-high { background: var(--warning-soft) !important; color: var(--warning) !important; } .severity-medium { background: var(--warning-soft) !important; color: var(--warning) !important; } .severity-low { background: var(--accent-soft) !important; color: var(--accent) !important; }
	.diff-pane { min-width: 0; padding: 1.25rem 0 1rem 1rem; scroll-padding-top: calc(var(--topbar-height) + 1rem); }
	.center { display: grid; min-height: 100vh; place-items: center; padding: 2rem; }
	.error-card, .loading-card { padding: 1rem 1.25rem; border: 1px solid var(--border); border-radius: 1rem; background: var(--panel-soft); }
	.error-card { border-color: rgba(255, 107, 122, 0.45); color: #ffd7dc; } .warning { border-color: rgba(255, 209, 102, 0.35); color: #ffe0a3; }
	.modal-backdrop { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; background: rgba(0,0,0,0.35); }
	.annotation-modal { display: grid; gap: 0.75rem; width: min(36rem, calc(100vw - 2rem)); padding: 1rem; border: 1px solid var(--border); border-radius: 1rem; background: var(--panel-solid); }
	.summary-modal { max-height: min(70vh, 42rem); overflow: auto; }
	.markdown-body, .rendered-markdown { display: grid; justify-items: start; gap: 0.7rem; width: 100%; line-height: 1.55; color: var(--text); text-align: left; }
	.markdown-body :global(p), .rendered-markdown :global(p), .markdown-body :global(h1), .markdown-body :global(h2), .markdown-body :global(h3), .rendered-markdown :global(h1), .rendered-markdown :global(h2), .rendered-markdown :global(h3) { margin: 0; }
	.markdown-body :global(ul), .markdown-body :global(ol), .rendered-markdown :global(ul), .rendered-markdown :global(ol) { margin: 0; padding-left: 1.35rem; }
	.markdown-body :global(code), .rendered-markdown :global(code) { border-radius: 0.3rem; background: var(--bg); padding: 0.1rem 0.25rem; }
	.shortcuts-list { display: grid; gap: 0.5rem; margin: 0; }
	.shortcuts-list div { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: 1rem; align-items: center; }
	.shortcuts-list dt { justify-self: start; border-radius: 0.35rem; background: var(--code-bg); padding: 0.15rem 0.4rem; font-weight: 700; }
	.shortcuts-list dd { margin: 0; color: var(--muted); }
	textarea { min-height: 10rem; border: 1px solid var(--border-strong); border-radius: 0.75rem; background: var(--bg); color: var(--text); padding: 0.75rem; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; tab-size: 2; }
	.modal-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
	@media (max-width: 1180px) { .review-shell, .review-shell.right-collapsed { grid-template-columns: 1fr; } .sidebar { position: static; height: auto; border: 0 !important; border-bottom: 1px solid var(--border) !important; } }
</style>
