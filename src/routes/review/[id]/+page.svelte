<script lang="ts">
	import { marked } from 'marked';
	import { onMount, tick } from 'svelte';
	import { page } from '$app/stores';
	import DiffViewer from '$lib/components/DiffViewer.svelte';
	import FileTreeViewer from '$lib/components/FileTreeViewer.svelte';
	import MarkdownEditor from '$lib/components/MarkdownEditor.svelte';
	import { Check, ChevronDown, ChevronRight, Clipboard, Edit3, HelpCircle, MessageSquarePlus, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Play, Settings, Trash2, MoreVertical, BookOpenText } from '@lucide/svelte';
	import type { ReviewAttentionLevel, ReviewDiffMode, ReviewDiffStyle, ReviewFileSummary, ReviewFinding, ReviewMode, ReviewSessionSnapshot, ReviewUiSettings, UserReviewAnnotation } from '$lib/shared/review';

	let session: ReviewSessionSnapshot | undefined;
	let error: string | undefined;
	let connectionWarning: string | undefined;
	let selectedFile: string | undefined;
	let diffStyle: ReviewDiffStyle = 'split';
	let wrap = false;
	let reviewed = new Set<string>();
	let restoredSessionId: string | undefined;
	let leftOpen = true;
	let rightOpen = true;
	let annotationDraft: { id?: string; scope: 'global' | 'file' | 'line'; file?: string; line?: number; side?: 'additions' | 'deletions'; body: string } | undefined;
	let mdEditor: { insertText: (text: string) => void; focus: () => void } | undefined;
	let closingNotesTextarea: HTMLTextAreaElement | undefined;
	let diffViewer: { scrollFile: (direction: 1 | -1) => void; scrollComment: (direction: 1 | -1) => void; scrollHunk: (direction: 1 | -1) => void; editActiveComment: () => boolean; currentFile: () => string | undefined } | undefined;
	let agentModelKey = '';
	let agentThinkingLevel = 'off';
	let suggestComments = true;
	let autoReview = false;
	let autoReviewArmed = false;
	let autoStartedSessionId: string | undefined;
	let aiOpen = false;
	let reviewModeOpen = false;
	let modelDialog = false;
	let shortcutsDialog = false;
	let agentDefaultsSessionId: string | undefined;
	let agentDefaultsRestoringSessionId: string | undefined;
	let finished = false;
	let copied = false;
	let copyFailed = false;
	let celebrateReviewComplete = false;
	let completionDialog = false;
	let closingNotes = '';
	let reviewLevel = 1;
	let isolatedLevel = false;
	let viewMenuOpen = false;
	let diffSourceMode: ReviewDiffMode = 'uncommitted';
	let diffSourceBase = 'origin/main';
	let branchRefs: string[] = [];
	let diffSourceLoading = false;
	let diffSourceError: string | undefined;
	let diffSourceSessionId: string | undefined;
	let summaryDialog = false;
	let summaryOpenedForSession: string | undefined;
	let targetFindingId: string | undefined;
	let targetAnnotationId: string | undefined;
	let highlightedEntryId: string | undefined;
	let activeFile: string | undefined;
	let activeCommentId: string | undefined;
	let lastLineAnnotationTarget: { scope: 'line'; file: string; line: number; side: 'additions' | 'deletions' } | undefined;

	$: reviewId = $page.params.id;
	$: files = session?.files ?? [];
	$: findings = session?.preReview.findings ?? [];
	$: hunkRanks = session?.preReview.hunks ?? [];
	$: hasAgentReview = session?.preReview.status === 'done' && !!session.preReview.model;
	$: reviewLevelOptions = availableReviewLevelOptions(hunkRanks);
	$: currentReviewMode = reviewLevelOptions.find((option) => option.level === Number(reviewLevel)) ?? reviewModeOption(modeForLevel(reviewLevel), reviewLevel);
	$: if (hunkRanks.length > 0 && reviewLevelOptions.length > 0 && !reviewLevelOptions.some((option) => option.level === Number(reviewLevel))) reviewLevel = reviewLevelOptions[0]!.level;
	$: visibleFiles = sortFilesForTree(filterFilesForReviewLevel(files, hunkRanks, reviewLevel));
	$: userAnnotations = session?.userAnnotations ?? [];
	$: reviewedFileCount = files.filter((file) => reviewed.has(file.path)).length;
	$: reviewProgress = files.length ? Math.round((reviewedFileCount / files.length) * 100) : 0;
	$: allFilesReviewed = files.length > 0 && reviewedFileCount >= files.length;
	$: feedbackText = buildFeedback();
	$: gridColumnsClass = leftOpen
		? rightOpen ? 'lg:grid-cols-[17rem_minmax(0,1fr)_19rem]' : 'lg:grid-cols-[17rem_minmax(0,1fr)]'
		: rightOpen ? 'lg:grid-cols-[minmax(0,1fr)_19rem]' : 'lg:grid-cols-[minmax(0,1fr)]';
	$: if (session && restoredSessionId !== session.id) restoreReviewed(session.id);
	$: if (session && diffSourceSessionId !== session.id) restoreDiffSource(session);
	$: if (session && agentDefaultsSessionId !== session.id && agentDefaultsRestoringSessionId !== session.id) void restoreAgentDefaults(session);
	$: selectedAgentModel = session?.agentReview.models.find((model) => model.key === agentModelKey);
	$: if (selectedAgentModel && !selectedAgentModel.thinkingLevels.includes(agentThinkingLevel as never)) agentThinkingLevel = selectedAgentModel.thinkingLevels[0] ?? 'off';
	$: reviewSettingsJson = JSON.stringify({ modelKey: agentModelKey, thinkingLevel: agentThinkingLevel, suggestComments, autoReview, reviewLevel: Number(reviewLevel), isolatedLevel, diffStyle, wrap });
	$: if (agentDefaultsSessionId) persistReviewSettings(reviewSettingsJson);
	$: if (session && autoReviewArmed && autoStartedSessionId !== session.id && session.preReview.status !== 'running' && agentModelKey) {
		autoStartedSessionId = session.id;
		autoReviewArmed = false;
		void runAgentReview();
	}
	$: if (hasAgentReview && session?.preReview.summary && summaryOpenedForSession !== session.id) {
		summaryOpenedForSession = session.id;
	}
	$: if (completionDialog) void focusCompletionDialog();

	onMount(() => {
		void loadSnapshot();
		void loadBranchRefs();
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

	async function restoreAgentDefaults(nextSession: ReviewSessionSnapshot) {
		agentDefaultsRestoringSessionId = nextSession.id;
		const stored = await loadReviewSettings();
		agentModelKey = stored.modelKey && nextSession.agentReview.models.some((model) => model.key === stored.modelKey) ? stored.modelKey : nextSession.agentReview.defaultModelKey ?? nextSession.agentReview.models[0]?.key ?? '';
		agentThinkingLevel = stored.thinkingLevel ?? nextSession.agentReview.defaultThinkingLevel;
		suggestComments = stored.suggestComments ?? true;
		autoReview = stored.autoReview ?? false;
		autoReviewArmed = autoReview;
		reviewLevel = stored.reviewLevel ?? 2;
		isolatedLevel = stored.isolatedLevel ?? true;
		diffStyle = stored.diffStyle ?? 'split';
		wrap = stored.wrap ?? false;
		agentDefaultsSessionId = nextSession.id;
	}

	async function loadReviewSettings(): Promise<ReviewUiSettings> {
		try {
			const response = await fetch('/api/settings');
			return response.ok ? ((await response.json()) as ReviewUiSettings) : {};
		} catch {
			return {};
		}
	}

	function persistReviewSettings(settingsJson = reviewSettingsJson) {
		void fetch('/api/settings', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: settingsJson
		});
	}

	function restoreDiffSource(nextSession: ReviewSessionSnapshot) {
		diffSourceSessionId = nextSession.id;
		diffSourceMode = nextSession.diffMode ?? 'uncommitted';
		diffSourceBase = nextSession.diffBase ?? branchRefs[0] ?? 'origin/main';
		diffSourceError = undefined;
	}

	async function loadBranchRefs() {
		try {
			const response = await fetch(`/api/reviews/${reviewId}/refs`);
			if (!response.ok) return;
			branchRefs = ((await response.json()) as { refs: string[] }).refs;
			if (!diffSourceBase && branchRefs[0]) diffSourceBase = branchRefs[0];
		} catch {
			branchRefs = [];
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
		const wasComplete = allFilesReviewed;
		const next = new Set(reviewed);
		if (next.has(file)) next.delete(file);
		else next.add(file);
		reviewed = next;
		if (!wasComplete && files.length > 0 && files.every((item) => next.has(item.path))) celebrateCompletion();
		if (session) localStorage.setItem(`pi-pair-review:${session.id}:reviewed`, JSON.stringify([...reviewed]));
	}

	function celebrateCompletion() {
		celebrateReviewComplete = true;
		completionDialog = true;
		setTimeout(() => (celebrateReviewComplete = false), 2200);
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

	function handleDiffModeChange(event: Event) {
		diffSourceMode = (event.currentTarget as HTMLSelectElement).value as ReviewDiffMode;
		if (diffSourceMode === 'branch' && (!diffSourceBase || diffSourceBase === session?.diffBase)) diffSourceBase = session?.diffBase ?? branchRefs[0] ?? 'origin/main';
		void changeDiffSource();
	}

	function handleBranchRefChange(event: Event) {
		diffSourceBase = (event.currentTarget as HTMLSelectElement).value;
		void changeDiffSource();
	}

	async function changeDiffSource() {
		if (!session || diffSourceLoading || session.preReview.status === 'running') return;
		if (diffSourceMode === session.diffMode && (diffSourceMode !== 'branch' || diffSourceBase === session.diffBase)) return;
		if ((userAnnotations.length > 0 || findings.length > 0 || reviewed.size > 0) && !confirm('Change diff source? Existing annotations, highlights, and reviewed markers for this session will be cleared.')) {
			restoreDiffSource(session);
			return;
		}
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
		if (event.key === 'Escape' && (annotationDraft || modelDialog || summaryDialog || shortcutsDialog || completionDialog)) {
			event.preventDefault();
			annotationDraft = undefined;
			modelDialog = false;
			summaryDialog = false;
			shortcutsDialog = false;
			completionDialog = false;
			return;
		}
		if (completionDialog && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {
			event.preventDefault();
			void finish();
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
		if (event.key === 'W') {
			event.preventDefault();
			void finish();
			return;
		}
		if (event.key === 'ArrowDown' && event.altKey) {
			event.preventDefault();
			diffViewer?.scrollHunk(1);
			return;
		}
		if (event.key === 'ArrowUp' && event.altKey) {
			event.preventDefault();
			diffViewer?.scrollHunk(-1);
			return;
		}
		if (event.key === 'ArrowDown' && event.shiftKey) {
			event.preventDefault();
			diffViewer?.scrollComment(1);
			return;
		}
		if (event.key === 'ArrowUp' && event.shiftKey) {
			event.preventDefault();
			diffViewer?.scrollComment(-1);
			return;
		}
		if (!selectedFile && event.key === 'ArrowDown') {
			event.preventDefault();
			diffViewer?.scrollFile(1);
			return;
		}
		if (!selectedFile && event.key === 'ArrowUp') {
			event.preventDefault();
			diffViewer?.scrollFile(-1);
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			diffViewer?.editActiveComment();
			return;
		}
		if (event.key.toLowerCase() === 'v') {
			event.preventDefault();
			const file = currentFileForAction();
			if (file) toggleReviewed(file);
			return;
		}
		if (event.key.toLowerCase() === 'f') {
			event.preventDefault();
			const file = currentFileForAction();
			if (file) annotationDraft = { scope: 'file', file, body: '' };
			return;
		}
		if (event.key === 'B') {
			event.preventDefault();
			rightOpen = !rightOpen;
			return;
		}
		if (event.key.toLowerCase() === 'b') {
			event.preventDefault();
			leftOpen = !leftOpen;
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
			if (hasAgentReview && session?.preReview.summary) summaryDialog = true;
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
		mdEditor?.insertText(`![pasted image](/api/reviews/${reviewId}/attachments?path=${encodeURIComponent(path)})`);
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

	function currentFileForAction() {
		return selectedFile ?? diffViewer?.currentFile() ?? activeFile;
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
		if (ranks.length === 0) return files;
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


	function buildFeedback() {
		if (!session) return '';
		const lines: string[] = [];
		for (const finding of findings) lines.push(formatFeedbackLine(finding.file, finding.line, finding.title));
		for (const annotation of userAnnotations) lines.push(formatFeedbackLine(annotation.file, annotation.line, annotation.body));
		if (closingNotes.trim()) lines.push('', closingNotes.trim());
		return lines.join('\n');
	}

	function formatFeedbackLine(file: string | undefined, line: number | undefined, body: string) {
		const formatted = body.replace(/\n/g, '\n  ');
		return file ? `- [${file}${line ? `:${line}` : ''}] ${formatted}` : `- ${formatted}`;
	}

	function renderMarkdown(markdown: string) {
		return marked.parse(renderableMarkdown(markdown) || 'No summary available.', { async: false, gfm: true, breaks: true }) as string;
	}

	function renderableMarkdown(markdown: string) {
		return markdown.trim().replace(/^\s*(\/[^\s)]+\.(?:png|jpe?g|gif|webp))\s*$/gim, (_match, path: string) => `![pasted image](/api/reviews/${reviewId}/attachments?path=${encodeURIComponent(path)})`);
	}

	async function focusCompletionDialog() {
		await tick();
		closingNotesTextarea?.focus();
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
	<div class="grid min-h-screen grid-cols-1 grid-rows-[auto_1fr] {gridColumnsClass}">
		<header class="sticky top-0 z-40 col-span-full flex items-center justify-between gap-4 border-b border-border bg-bg/95 px-4 backdrop-blur-sm relative" style="min-height: var(--topbar-height)">
			<div class="absolute bottom-0 left-0 h-0.5 w-full overflow-hidden bg-surface-2"><div class="review-progress h-full bg-accent" class:review-progress-complete={celebrateReviewComplete} style={`width: ${reviewProgress}%`}></div></div>
			<div class="min-w-0">
				<h1 class="truncate text-[0.95rem] font-semibold">{session.title}</h1>
				<p class="truncate text-xs text-muted">{session.cwd} · {visibleFiles.length}/{files.length} files · {session.baseDescription}</p>
			</div>
			<div class="flex items-center gap-2">
				<button title="Copy feedback" on:click={copyFeedback}><Clipboard size={15} /><span class="hidden sm:inline">{copied ? 'Copied' : copyFailed ? 'Copy failed' : 'Copy feedback'}</span></button>
				<button class={allFilesReviewed ? 'border-accent bg-accent text-accent-fg hover:bg-accent hover:opacity-90' : ''} title="Insert feedback (W or Cmd/Ctrl+Enter)" on:click={() => finish()}><Check size={15} /><span class="hidden sm:inline">Insert feedback</span></button>
				<button title="Toggle left sidebar (B)" on:click={() => (leftOpen = !leftOpen)}>{#if leftOpen}<PanelLeftClose size={15} />{:else}<PanelLeftOpen size={15} />{/if}<span class="hidden sm:inline">{leftOpen ? 'Hide' : 'Show'} files</span></button>
				<button title="Toggle right sidebar (Shift+B)" on:click={() => (rightOpen = !rightOpen)}>{#if rightOpen}<PanelRightClose size={15} />{:else}<PanelRightOpen size={15} />{/if}<span class="hidden sm:inline">{rightOpen ? 'Hide' : 'Show'} annotations</span></button>
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

		{#if leftOpen}
		<aside class="grid content-start gap-2 border-b border-border bg-bg p-2.5 lg:sticky lg:top-[var(--topbar-height)] lg:h-[calc(100vh-var(--topbar-height))] lg:overflow-auto lg:border-b-0 lg:border-r">
			{#if connectionWarning}<section class="rounded-lg border border-warning/40 bg-warning-soft p-2.5 text-sm text-warning">{connectionWarning}</section>{/if}
			<section class="grid min-w-0 gap-2 overflow-hidden rounded-lg border border-border bg-surface p-2.5">
				<div class="flex items-center justify-between gap-3"><h2 class="text-[0.85rem] font-semibold">Diff source</h2><span class="rounded-full bg-code px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase text-muted">{session.diffMode ?? 'diff'}</span></div>
				<label class="grid gap-1 text-sm text-muted">Review
					<select bind:value={diffSourceMode} disabled={diffSourceLoading || session.preReview.status === 'running'} on:change={handleDiffModeChange}>
						<option value="unstaged">Unstaged changes</option>
						<option value="staged">Staged changes</option>
						<option value="uncommitted">Uncommitted changes</option>
						<option value="commit">Last commit</option>
						<option value="branch">Branch vs ref</option>
					</select>
				</label>
				{#if diffSourceMode === 'branch'}<label class="grid gap-1 text-sm text-muted">Base ref <select bind:value={diffSourceBase} disabled={diffSourceLoading || session.preReview.status === 'running'} on:change={handleBranchRefChange}>{#if diffSourceBase && !branchRefs.includes(diffSourceBase)}<option value={diffSourceBase}>{diffSourceBase}</option>{/if}{#each branchRefs as ref}<option value={ref}>{ref}</option>{/each}{#if branchRefs.length === 0 && !diffSourceBase}<option value="origin/main">origin/main</option>{/if}</select></label>{/if}
				{#if diffSourceLoading}<p class="text-sm text-muted">Loading source…</p>{/if}
				{#if diffSourceError}<p class="text-sm text-danger">{diffSourceError}</p>{/if}
			</section>
			<section class="grid min-w-0 gap-2 overflow-hidden rounded-lg border border-border bg-surface p-2.5">
				<div class="flex items-center justify-between gap-3"><h2 class="text-[0.85rem] font-semibold">Files</h2><span class="rounded-full bg-code px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase text-muted">{reviewedFileCount}/{files.length}</span></div>
				<FileTreeViewer files={visibleFiles} {selectedFile} {activeFile} {reviewed} on:select={(event) => (selectedFile = event.detail)} on:toggleReviewed={(event) => toggleReviewed(event.detail)} />
			</section>
		</aside>
		{/if}

		<main class="min-w-0 max-w-full px-3 py-3" style="scroll-padding-top: calc(var(--topbar-height) + 1rem)">
			<DiffViewer bind:this={diffViewer} {session} {findings} {hunkRanks} {reviewLevel} {isolatedLevel} {reviewed} {selectedFile} {targetFindingId} {targetAnnotationId} {diffStyle} {wrap} on:activeChange={(event) => { activeFile = event.detail.file; activeCommentId = event.detail.commentId; }} on:annotate={(event) => startLineAnnotation(event.detail)} on:fileComment={(event) => (annotationDraft = { scope: 'file', file: event.detail, body: '' })} on:toggleReviewed={(event) => toggleReviewed(event.detail)} on:editAnnotation={(event) => editAnnotation(event.detail)} on:deleteAnnotation={(event) => removeAnnotation(event.detail)} />
		</main>

		{#if rightOpen}
			<aside class="grid content-start gap-2 border-t border-border bg-bg p-2.5 lg:sticky lg:top-[var(--topbar-height)] lg:h-[calc(100vh-var(--topbar-height))] min-w-0 overflow-x-hidden lg:overflow-y-auto lg:border-t-0 lg:border-l">
				<section class="grid min-w-0 gap-2 overflow-hidden rounded-lg border border-border bg-surface p-2.5">
					<button class="flex w-full items-center justify-between gap-3 border-0 bg-transparent p-0 hover:bg-transparent" on:click={() => (aiOpen = !aiOpen)}><h2 class="flex items-center gap-1.5 text-[0.85rem] font-semibold">{#if aiOpen}<ChevronDown size={15} />{:else}<ChevronRight size={15} />{/if}AI review</h2><span class="rounded-full bg-code px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase text-muted">{hasAgentReview ? 'done' : session.preReview.status === 'running' ? 'running' : session.preReview.status === 'failed' ? 'failed' : 'not run'}</span></button>
					{#if aiOpen}
						<div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
							<button title="AI review settings" on:click={() => (modelDialog = true)}>{#if session.preReview.status === 'running'}<span class="inline-block h-3.5 w-3.5 flex-none animate-spin rounded-full border-2 border-accent/25 border-t-accent"></span>{:else}<Settings size={15} />{/if}Model: {selectedAgentModel?.name ?? 'none'}</button>
							{#if hasAgentReview && session.preReview.summary}<button class="w-9 px-0" title="Show summary (S)" on:click={() => (summaryDialog = true)}><BookOpenText size={15} /></button>{/if}
						</div>
						{#if !hasAgentReview}<p class="text-sm text-muted">{session.preReview.status === 'idle' ? 'Run agent review from model settings.' : session.preReview.status === 'running' ? 'Ranking hunks…' : 'Agent review failed.'}</p>{/if}
						{#if session.agentReview.models.length === 0}<p class="text-sm text-muted">No authenticated models available.</p>{/if}
						{#if session.preReview.error}<p class="text-sm text-muted">{session.preReview.error}</p>{/if}
					{/if}
				</section>
				{#if hunkRanks.length > 0}
					<section class="relative grid min-w-0 gap-2 overflow-hidden rounded-lg border border-border bg-surface p-2.5 {reviewModeOpen || reviewLevelOptions.length <= 1 ? '' : 'pb-5'}">
						<div class="flex items-center justify-between gap-3">
							<button class="min-w-0 flex-1 justify-start border-0 bg-transparent p-0 hover:bg-transparent" on:click={() => (reviewModeOpen = !reviewModeOpen)}><h2 class="flex items-center gap-1.5 text-[0.85rem] font-semibold">{#if reviewModeOpen}<ChevronDown size={15} />{:else}<ChevronRight size={15} />{/if}Review mode</h2><span class="truncate text-xs text-muted">{currentReviewMode.label}</span></button>
						</div>
						{#if !reviewModeOpen && reviewLevelOptions.length > 1}
							<div class="absolute inset-x-2.5 bottom-2 flex gap-1" title="Review mode (+/-)">
								{#each reviewLevelOptions as option}
									<button class="h-1.5 min-w-0 flex-1 rounded-full border-0 p-0 {(isolatedLevel ? option.level === Number(reviewLevel) : option.level <= Number(reviewLevel)) ? 'bg-accent hover:bg-accent' : 'bg-surface-2 hover:bg-surface-hover'}" aria-label={`Review level ${option.level}`} on:click={() => (reviewLevel = option.level)}></button>
								{/each}
							</div>
						{/if}
						{#if reviewModeOpen}
							{#if reviewLevelOptions.length <= 1}
								<p class="rounded-lg border border-border bg-surface-2 p-2 text-sm text-muted"><strong class="text-fg">{currentReviewMode.label}</strong> · {currentReviewMode.description}</p>
							{:else}
								<div class="grid gap-1.5">
									{#each reviewLevelOptions as option}
										<label class="flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-sm hover:bg-surface-hover {(isolatedLevel ? option.level === Number(reviewLevel) : option.level <= Number(reviewLevel)) ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2'}">
											<input type="radio" name="review-level" value={option.level} bind:group={reviewLevel} />
											<span class="grid min-w-0 gap-0.5"><span class="font-medium text-fg">{option.label} <span class="text-xs font-normal text-muted">({option.count})</span></span><span class="text-xs text-muted">{option.description}</span></span>
										</label>
									{/each}
								</div>
							{/if}
							<label class="flex items-center gap-2 text-sm text-muted" title="Toggle isolated review mode (I)"><input type="checkbox" bind:checked={isolatedLevel} /> Isolate selected mode</label>
						{/if}
					</section>
				{/if}
				<section class="grid min-w-0 gap-2 overflow-hidden rounded-lg border border-border bg-surface p-2.5">
					<div class="flex items-center justify-between gap-3"><h2 class="text-[0.85rem] font-semibold">Agent annotations</h2><span class="rounded-full bg-code px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase text-muted">{findings.length}</span></div>
					{#if findings.length === 0}<p class="text-sm text-muted">No highlights yet.</p>{:else}<div class="grid gap-2">{#each findings as finding}<div class="grid gap-1.5 rounded-lg p-2 transition-colors {highlightedEntryId === finding.id ? 'bg-accent-soft ring-1 ring-accent' : 'bg-surface-2 hover:bg-surface-hover'}"><div class="flex items-center gap-1.5"><button class="min-w-0 flex-1 justify-start border-0 bg-transparent p-0 text-left hover:bg-transparent" on:click={() => selectFinding(finding)}><span class="flex min-w-0 items-center gap-2"><span class="{severityClass(finding)} rounded-full px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase">L{finding.attentionLevel} · {finding.severity}</span><small class="min-w-0 truncate text-muted">{finding.file ?? 'Overall'}{finding.line ? `:${finding.line}` : ''}</small></span></button><button class="flex-none rounded-full border-0 bg-transparent px-1 text-muted hover:bg-danger-soft hover:text-danger" title="Remove" on:click={() => removeFinding(finding)}><Trash2 size={14} /></button></div><button class="block w-full justify-start border-0 bg-transparent p-0 text-left hover:bg-transparent" on:click={() => selectFinding(finding)}><div class="rendered-markdown text-sm">{@html renderMarkdown(finding.title)}</div></button></div>{/each}</div>{/if}
				</section>
				<section class="grid min-w-0 gap-2 overflow-hidden rounded-lg border border-border bg-surface p-2.5">
					<div class="sticky top-0 z-10 -mx-2.5 -mt-2.5 grid gap-2 border-b border-border bg-surface p-2.5">
						<div class="flex items-center justify-between gap-3"><h2 class="text-[0.85rem] font-semibold">User annotations</h2><span class="rounded-full bg-code px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase text-muted">{userAnnotations.length}</span></div>
						<button class="w-full justify-start" title="Comment overall (O)" on:click={() => (annotationDraft = { scope: 'global', body: '' })}><MessageSquarePlus size={15} />Comment overall</button>
					</div>
					{#if userAnnotations.length === 0}<p class="text-sm text-muted">Click line numbers, add file notes, or comment overall.</p>{:else}<div class="grid gap-2">{#each userAnnotations as annotation}<div class="grid gap-1.5 rounded-lg p-2 transition-colors {highlightedEntryId === annotation.id ? 'bg-accent-soft ring-1 ring-accent' : 'bg-surface-2 hover:bg-surface-hover'}"><div class="flex items-center gap-1.5"><button class="min-w-0 flex-1 justify-start border-0 bg-transparent p-0 text-left hover:bg-transparent" on:click={() => selectAnnotation(annotation)}><span class="flex min-w-0 items-center gap-2"><small class="min-w-0 truncate text-muted">{annotation.scope === 'global' ? 'Overall' : annotation.scope === 'file' ? annotation.file : `${annotation.file}:${annotation.line}`}</small></span></button><button class="flex-none rounded-full border-0 bg-transparent px-1 text-muted hover:bg-surface-hover hover:text-fg" title="Edit" on:click={() => editAnnotation(annotation)}><Edit3 size={14} /></button><button class="flex-none rounded-full border-0 bg-transparent px-1 text-muted hover:bg-danger-soft hover:text-danger" title="Remove" on:click={() => removeAnnotation(annotation)}><Trash2 size={14} /></button></div><button class="block w-full justify-start border-0 bg-transparent p-0 text-left hover:bg-transparent" on:click={() => selectAnnotation(annotation)}><div class="rendered-markdown text-sm">{@html renderMarkdown(annotation.body)}</div></button></div>{/each}</div>{/if}
				</section>
			</aside>
		{/if}
	</div>
{/if}

{#if modelDialog}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal-backdrop fixed inset-0 z-40 grid place-items-center p-4" on:click={(event) => backdropClick(event, () => (modelDialog = false))}>
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
	<div class="modal-backdrop fixed inset-0 z-40 grid place-items-center p-4" on:click={(event) => backdropClick(event, () => (summaryDialog = false))}>
		<div class="grid max-h-[min(70vh,42rem)] w-[min(40rem,calc(100vw-2rem))] gap-3 overflow-auto rounded-xl border border-border bg-surface p-5 shadow-[0_16px_48px_var(--shadow)]">
			<h2 class="text-[0.95rem] font-semibold">Agent summary</h2>
			<div class="markdown-body text-sm">{@html renderMarkdown(session?.preReview.summary ?? '')}</div>
			<div class="flex justify-end gap-2 pt-1"><button type="button" on:click={() => (summaryDialog = false)}>Close</button></div>
		</div>
	</div>
{/if}

{#if completionDialog}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal-backdrop fixed inset-0 z-40 grid place-items-center p-4" on:click={(event) => backdropClick(event, () => (completionDialog = false))}>
		<div class="confetti-layer" aria-hidden="true">{#each Array(24) as _}<i></i>{/each}</div>
		<div class="relative z-10 grid w-[min(34rem,calc(100vw-2rem))] gap-3 rounded-xl border border-accent/50 bg-surface p-5 shadow-[0_16px_48px_var(--shadow)]">
			<h2 class="text-[1rem] font-semibold">Review complete</h2>
			<p class="text-sm text-muted">All files are marked reviewed. Add optional closing notes before inserting feedback.</p>
			<label class="grid gap-1.5 text-sm text-muted">Closing notes
				<textarea bind:this={closingNotesTextarea} bind:value={closingNotes} rows="5" placeholder="Optional notes to append below annotations…"></textarea>
			</label>
			<div class="flex justify-end gap-2 pt-1"><button type="button" on:click={() => (completionDialog = false)}>Keep reviewing</button><button class="border-accent bg-accent text-accent-fg hover:bg-accent hover:opacity-90" type="button" on:click={() => finish()}><Check size={15} />Insert feedback</button></div>
		</div>
	</div>
{/if}

{#if shortcutsDialog}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal-backdrop fixed inset-0 z-40 grid place-items-center p-4" on:click={(event) => backdropClick(event, () => (shortcutsDialog = false))}>
		<div class="grid w-[min(32rem,calc(100vw-2rem))] gap-3 rounded-xl border border-border bg-surface p-5 shadow-[0_16px_48px_var(--shadow)]">
			<h2 class="text-[0.95rem] font-semibold">Keyboard shortcuts</h2>
			<dl class="grid max-h-[60vh] gap-2 overflow-auto pr-1">
				<dt class="text-xs font-semibold uppercase text-muted">All files</dt>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><kbd class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">↓ / ↑</kbd><dd class="text-sm text-muted">Next / previous file</dd></div>
				<dt class="mt-3 border-t border-border pt-3 text-xs font-semibold uppercase text-muted">Diff view</dt>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><kbd class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">Shift+↓ / ↑</kbd><dd class="text-sm text-muted">Next / previous comment</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><kbd class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">Enter</kbd><dd class="text-sm text-muted">Edit highlighted user comment</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><kbd class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">V</kbd><dd class="text-sm text-muted">Toggle current file reviewed</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><kbd class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">F</kbd><dd class="text-sm text-muted">Add file comment</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><kbd class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">Opt+↓ / ↑</kbd><dd class="text-sm text-muted">Next / previous hunk</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><kbd class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">O</kbd><dd class="text-sm text-muted">Comment overall</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><kbd class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">S</kbd><dd class="text-sm text-muted">Show agent summary</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><kbd class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">I</kbd><dd class="text-sm text-muted">Toggle isolated review mode</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><kbd class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">+ / −</kbd><dd class="text-sm text-muted">Change review mode</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><kbd class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">B</kbd><dd class="text-sm text-muted">Toggle files sidebar</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><kbd class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">Shift+B</kbd><dd class="text-sm text-muted">Toggle annotations sidebar</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><kbd class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">W</kbd><dd class="text-sm text-muted">Insert feedback</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><kbd class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">Cmd/Ctrl+Enter</kbd><dd class="text-sm text-muted">Insert feedback</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><kbd class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">?</kbd><dd class="text-sm text-muted">Show keyboard shortcuts</dd></div>
				<dt class="mt-3 border-t border-border pt-3 text-xs font-semibold uppercase text-muted">Editing annotation</dt>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><kbd class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">Ctrl+S</kbd><dd class="text-sm text-muted">Save annotation</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><kbd class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">Cmd+Enter</kbd><dd class="text-sm text-muted">Save annotation</dd></div>
				<dt class="mt-3 border-t border-border pt-3 text-xs font-semibold uppercase text-muted">Dialogs</dt>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3"><kbd class="justify-self-start rounded-md border border-border-strong bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">Esc</kbd><dd class="text-sm text-muted">Close dialog</dd></div>
			</dl>
			<div class="flex justify-end gap-2 pt-1"><button type="button" on:click={() => (shortcutsDialog = false)}>Close</button></div>
		</div>
	</div>
{/if}

{#if annotationDraft}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal-backdrop fixed inset-0 z-40 grid place-items-center p-4" on:click={(event) => backdropClick(event, () => (annotationDraft = undefined))}>
		<form class="grid w-[min(36rem,calc(100vw-2rem))] gap-3 rounded-xl border border-border bg-surface p-5 shadow-[0_16px_48px_var(--shadow)]" on:submit|preventDefault={saveAnnotation}>
			<h2 class="text-[0.95rem] font-semibold">{annotationDraft.id ? 'Edit annotation' : 'Add annotation'}</h2>
			<p class="text-xs text-muted">{annotationDraft.scope === 'global' ? 'Overall review' : annotationDraft.scope === 'file' ? annotationDraft.file : `${annotationDraft.file}:${annotationDraft.line} · ${annotationDraft.side}`}</p>
			<MarkdownEditor bind:this={mdEditor} bind:value={annotationDraft.body} on:imagepaste={(event) => handleAnnotationImagePaste(event.detail)} />
			<div class="flex justify-end gap-2 pt-1"><button title="Close dialog (Esc)" type="button" on:click={() => (annotationDraft = undefined)}>Cancel</button><button class="border-accent bg-accent text-accent-fg hover:bg-accent hover:opacity-90" title="Save comment (Ctrl+S or Cmd+Enter)" type="submit">Save</button></div>
		</form>
	</div>
{/if}
