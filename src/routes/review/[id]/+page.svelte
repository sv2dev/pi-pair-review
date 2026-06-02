<script lang="ts">
	import { tick } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { renderReviewMarkdown } from '$lib/client/review-markdown';
	import { availableReviewLevelOptions, buildReviewFeedback, filterFilesForReviewLevel, modeForLevel, reviewModeOption, sortFilesForTree } from '$lib/client/review-ui';
	import DiffViewer from '$lib/components/DiffViewer.svelte';
	import FileTreeViewer from '$lib/components/FileTreeViewer.svelte';
	import MarkdownEditor from '$lib/components/MarkdownEditor.svelte';
	import { Check, ChevronDown, ChevronRight, Clipboard, Edit3, HelpCircle, LoaderCircle, MessageSquarePlus, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Play, Settings, Trash2, MoreVertical, BookOpenText } from '@lucide/svelte';
	import type { SelectedLineRange } from '@pierre/diffs';
	import type { ReviewAttentionLevel, ReviewDiffMode, ReviewDiffStyle, ReviewFinding, ReviewSessionSnapshot, ReviewUiSettings, UserReviewAnnotation } from '$lib/shared/review';

	type AnnotationDraft = { id?: string; scope: 'global' | 'file' | 'line'; file?: string; line?: number; side?: 'additions' | 'deletions'; endLine?: number; endSide?: 'additions' | 'deletions'; body: string };
	type MarkdownEditorApi = { insertText: (text: string) => void; focus: () => void };
	type DiffViewerApi = { scrollFile: (direction: 1 | -1) => void; scrollFileAfter: (file: string) => void; scrollComment: (direction: 1 | -1) => void; scrollHunk: (direction: 1 | -1) => void; editActiveComment: () => boolean; currentFile: () => string | undefined };
	type StoredReviewed = { version: 2; entries: string[] };

	let session = $state.raw<ReviewSessionSnapshot | undefined>(undefined);
	let error = $state<string | undefined>();
	let connectionWarning = $state<string | undefined>();
	let selectedFile = $state<string | undefined>();
	let diffStyle = $state<ReviewDiffStyle>('split');
	let wrap = $state(false);
	const reviewed = new SvelteSet<string>();
	let restoredSessionId = $state<string | undefined>();
	let leftOpen = $state(true);
	let rightOpen = $state(true);
	let annotationDraft = $state<AnnotationDraft | undefined>();
	let mdEditor = $state<MarkdownEditorApi | undefined>();
	let closingNotesTextarea = $state<HTMLTextAreaElement | undefined>();
	let diffViewer = $state<DiffViewerApi | undefined>();
	let agentModelKey = $state('');
	let agentThinkingLevel = $state('off');
	let suggestComments = $state(true);
	let autoReview = $state(false);
	let autoReviewArmed = $state(false);
	let autoStartedSessionId = $state<string | undefined>();
	let aiOpen = $state(false);
	let reviewModeOpen = $state(false);
	let modelDialog = $state(false);
	let shortcutsDialog = $state(false);
	let agentDefaultsSessionId = $state<string | undefined>();
	let agentDefaultsRestoringSessionId = $state<string | undefined>();
	let reviewLevelResetKey = $state('');
	let finished = $state(false);
	let copied = $state(false);
	let copyFailed = $state(false);
	let celebrateReviewComplete = $state(false);
	let completionDialog = $state(false);
	let closingNotes = $state('');
	let reviewLevel = $state<number>(1);
	let isolatedLevel = $state(false);
	let viewMenuOpen = $state(false);
	let diffSourceMode = $state<ReviewDiffMode>('uncommitted');
	let diffSourceBase = $state('origin/main');
	let branchRefs = $state.raw<string[]>([]);
	let diffSourceLoading = $state(false);
	let diffSourceError = $state<string | undefined>();
	let diffSourceSessionId = $state<string | undefined>();
	let summaryDialog = $state(false);
	let summaryOpenedForSession = $state<string | undefined>();
	let targetFindingId = $state<string | undefined>();
	let targetAnnotationId = $state<string | undefined>();
	let highlightedEntryId = $state<string | undefined>();
	let activeFile = $state<string | undefined>();
	let lastLineAnnotationTarget = $state<{ scope: 'line'; file: string; line: number; side: 'additions' | 'deletions'; endLine?: number; endSide?: 'additions' | 'deletions' } | undefined>();

	let reviewId = $derived(page.params.id);
	let files = $derived(session?.files ?? []);
	let findings = $derived(session?.preReview.findings ?? []);
	let hunkRanks = $derived(session?.preReview.hunks ?? []);
	let hasAgentReview = $derived(session?.preReview.status === 'done' && !!session.preReview.model);
	let reviewLevelOptions = $derived(availableReviewLevelOptions(hunkRanks));
	let currentReviewMode = $derived(reviewLevelOptions.find((option) => option.level === Number(reviewLevel)) ?? reviewModeOption(modeForLevel(reviewLevel), reviewLevel));
	let visibleFiles = $derived(sortFilesForTree(filterFilesForReviewLevel(files, hunkRanks, reviewLevel, isolatedLevel)));
	let userAnnotations = $derived(session?.userAnnotations ?? []);
	let reviewedFiles = $derived(new SvelteSet(files.filter((file) => isFileReviewed(file.path)).map((file) => file.path)));
	let reviewedFileCount = $derived(visibleFiles.filter((file) => reviewedFiles.has(file.path)).length);
	let reviewUnits = $derived(allReviewUnits());
	let reviewedReviewUnitCount = $derived(reviewUnits.filter((unit) => reviewed.has(reviewedKey(unit.file, unit.level))).length);
	let reviewProgress = $derived(reviewUnits.length ? Math.round((reviewedReviewUnitCount / reviewUnits.length) * 100) : 0);
	let allFilesReviewed = $derived(reviewUnits.length > 0 && reviewedReviewUnitCount >= reviewUnits.length);
	let feedbackText = $derived(buildReviewFeedback(findings, userAnnotations, closingNotes));
	let gridColumnsClass = $derived(leftOpen
		? rightOpen ? 'lg:grid-cols-[17rem_minmax(0,1fr)_19rem]' : 'lg:grid-cols-[17rem_minmax(0,1fr)]'
		: rightOpen ? 'lg:grid-cols-[minmax(0,1fr)_19rem]' : 'lg:grid-cols-[minmax(0,1fr)]');
	let selectedAgentModel = $derived(session?.agentReview.models.find((model) => model.key === agentModelKey));
	let reviewSettingsJson = $derived(JSON.stringify({ modelKey: agentModelKey, thinkingLevel: agentThinkingLevel, suggestComments, autoReview, isolatedLevel, diffStyle, wrap }));
	let reviewRanksKey = $derived(`${session?.id ?? ''}:${hunkRanks.map((rank) => `${rank.id}:${rank.file}:${rank.oldStart}:${rank.oldLines}:${rank.newStart}:${rank.newLines}:${rank.attentionLevel}`).join('|')}`);

	$effect(() => {
		if (hunkRanks.length > 0 && reviewRanksKey !== reviewLevelResetKey) {
			reviewLevelResetKey = reviewRanksKey;
			reviewLevel = lowestReviewLevel(hunkRanks);
			return;
		}
		if (hunkRanks.length > 0 && reviewLevelOptions.length > 0 && !reviewLevelOptions.some((option) => option.level === Number(reviewLevel))) reviewLevel = reviewLevelOptions[0]!.level;
	});

	$effect(() => {
		if (session && restoredSessionId !== session.id) restoreReviewed(session.id);
	});

	$effect(() => {
		if (session && diffSourceSessionId !== session.id) restoreDiffSource(session);
	});

	$effect(() => {
		if (session && agentDefaultsSessionId !== session.id && agentDefaultsRestoringSessionId !== session.id) void restoreAgentDefaults(session);
	});

	$effect(() => {
		if (selectedAgentModel && !selectedAgentModel.thinkingLevels.includes(agentThinkingLevel as never)) agentThinkingLevel = selectedAgentModel.thinkingLevels[0] ?? 'off';
	});

	$effect(() => {
		if (!agentDefaultsSessionId) return;
		const settingsJson = reviewSettingsJson;
		const timer = setTimeout(() => persistReviewSettings(settingsJson), 350);
		return () => clearTimeout(timer);
	});

	$effect(() => {
		if (session && autoReviewArmed && autoStartedSessionId !== session.id && session.preReview.status !== 'running' && agentModelKey) {
			autoStartedSessionId = session.id;
			autoReviewArmed = false;
			void runAgentReview();
		}
	});

	$effect(() => {
		if (hasAgentReview && session?.preReview.summary && summaryOpenedForSession !== session.id) {
			summaryOpenedForSession = session.id;
			summaryDialog = true;
		}
	});

	$effect(() => {
		if (completionDialog) void focusCompletionDialog();
	});

	$effect(() => {
		const id = reviewId;
		const abort = new AbortController();
		error = undefined;
		connectionWarning = undefined;
		selectedFile = undefined;
		void loadSnapshot(id, abort.signal);
		void loadBranchRefs(id, abort.signal);

		const events = new EventSource(`/api/reviews/${id}/events`);
		events.addEventListener('snapshot', (event) => {
			if (id !== reviewId) return;
			connectionWarning = undefined;
			session = JSON.parse((event as MessageEvent).data) as ReviewSessionSnapshot;
		});
		events.onerror = () => {
			if (id === reviewId) connectionWarning = 'Live connection lost. EventSource will retry automatically.';
		};

		return () => {
			abort.abort();
			events.close();
		};
	});

	async function loadSnapshot(id = reviewId, signal?: AbortSignal) {
		try {
			const response = await fetch(`/api/reviews/${id}`, { signal });
			if (!response.ok) throw new Error(await response.text());
			const nextSession = (await response.json()) as ReviewSessionSnapshot;
			if (id === reviewId && !signal?.aborted) session = nextSession;
		} catch (loadError) {
			if (signal?.aborted) return;
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
		reviewLevel = lowestReviewLevel(nextSession.preReview.hunks);
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

	async function loadBranchRefs(id = reviewId, signal?: AbortSignal) {
		try {
			const response = await fetch(`/api/reviews/${id}/refs`, { signal });
			if (!response.ok) return;
			if (id !== reviewId || signal?.aborted) return;
			branchRefs = ((await response.json()) as { refs: string[] }).refs;
			if (!diffSourceBase && branchRefs[0]) diffSourceBase = branchRefs[0];
		} catch {
			if (!signal?.aborted) branchRefs = [];
		}
	}

	function restoreReviewed(id: string) {
		restoredSessionId = id;
		try {
			const stored = localStorage.getItem(`pi-pair-review:${id}:reviewed`);
			reviewed.clear();
			const parsed = stored ? JSON.parse(stored) as StoredReviewed | string[] : undefined;
			const entries = Array.isArray(parsed) ? parsed : parsed?.version === 2 ? parsed.entries : [];
			for (const entry of entries) if (isReviewedKey(entry)) reviewed.add(entry);
		} catch {
			reviewed.clear();
		}
	}

	function toggleReviewed(file: string) {
		const wasComplete = allFilesReviewed;
		const levels = reviewedLevelsForFile(file);
		const isReviewed = levels.length > 0 && levels.every((level) => reviewed.has(reviewedKey(file, level)));
		for (const level of levels) {
			const key = reviewedKey(file, level);
			if (isReviewed) reviewed.delete(key);
			else reviewed.add(key);
		}
		if (!wasComplete && allReviewUnits().every((unit) => reviewed.has(reviewedKey(unit.file, unit.level)))) celebrateCompletion();
		persistReviewed();
		if (!isReviewed) advanceAfterReviewed(file);
	}

	async function advanceAfterReviewed(file: string) {
		await tick();
		if (!selectedFile) {
			diffViewer?.scrollFileAfter(file);
			return;
		}
		const currentIndex = visibleFiles.findIndex((item) => item.path === file || item.previousPath === file);
		const next = visibleFiles[currentIndex + 1];
		if (next) selectedFile = next.path;
	}

	function persistReviewed() {
		if (!session) return;
		localStorage.setItem(`pi-pair-review:${session.id}:reviewed`, JSON.stringify({ version: 2, entries: [...reviewed] } satisfies StoredReviewed));
	}

	function allReviewUnits() {
		if (hunkRanks.length === 0) return files.map((file) => ({ file: file.path, level: 1 as ReviewAttentionLevel }));
		const units: { file: string; level: ReviewAttentionLevel }[] = [];
		for (const rank of hunkRanks) {
			const file = canonicalFileForRank(rank.file);
			if (!file || units.some((unit) => unit.file === file && unit.level === rank.attentionLevel)) continue;
			units.push({ file, level: rank.attentionLevel });
		}
		return units;
	}

	function canonicalFileForRank(file: string) {
		return files.find((item) => item.path === file || item.previousPath === file)?.path;
	}

	function isFileReviewed(file: string) {
		const levels = reviewedLevelsForFile(file);
		return levels.length > 0 && levels.every((level) => reviewed.has(reviewedKey(file, level)));
	}

	function reviewedLevelsForFile(file: string) {
		if (hunkRanks.length === 0) return [1 as ReviewAttentionLevel];
		const previousPath = files.find((item) => item.path === file)?.previousPath;
		const levels: ReviewAttentionLevel[] = [];
		for (const rank of hunkRanks) {
			if (rank.file !== file && rank.file !== previousPath) continue;
			if (isolatedLevel ? rank.attentionLevel !== Number(reviewLevel) : rank.attentionLevel > Number(reviewLevel)) continue;
			if (!levels.includes(rank.attentionLevel)) levels.push(rank.attentionLevel);
		}
		return levels.sort((left, right) => left - right);
	}

	function reviewedKey(file: string, level: ReviewAttentionLevel) {
		return `${level}\t${file}`;
	}

	function isReviewedKey(value: unknown): value is string {
		return typeof value === 'string' && /^[1-5]\t/.test(value);
	}

	function lowestReviewLevel(ranks: { attentionLevel: ReviewAttentionLevel }[]) {
		return ranks.length > 0 ? Math.min(...ranks.map((rank) => rank.attentionLevel)) : 1;
	}

	function celebrateCompletion() {
		celebrateReviewComplete = true;
		completionDialog = true;
		setTimeout(() => (celebrateReviewComplete = false), 2200);
	}

	async function saveAnnotation() {
		if (!annotationDraft?.body.trim()) return;
		const draft = { ...annotationDraft, body: annotationDraft.body.trim() };
		const previousSession = session;
		annotationDraft = undefined;
		try {
			if (draft.id) {
				if (session) session = { ...session, userAnnotations: session.userAnnotations.map((item) => (item.id === draft.id ? { ...item, body: draft.body } : item)) };
				const annotation = await requestJson<UserReviewAnnotation>(`/api/reviews/${reviewId}/annotations/${draft.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: draft.body }) });
				if (session) session = { ...session, userAnnotations: session.userAnnotations.map((item) => (item.id === annotation.id ? annotation : item)) };
				return;
			}
			const optimistic: UserReviewAnnotation = { ...draft, id: `local-${crypto.randomUUID()}`, createdAt: new Date().toISOString() };
			if (session) session = { ...session, userAnnotations: [...session.userAnnotations, optimistic] };
			const annotation = await requestJson<UserReviewAnnotation>(`/api/reviews/${reviewId}/annotations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
			if (session) session = { ...session, userAnnotations: session.userAnnotations.map((item) => (item.id === optimistic.id ? annotation : item)) };
		} catch (saveError) {
			session = previousSession;
			annotationDraft = draft;
			connectionWarning = saveError instanceof Error ? saveError.message : String(saveError);
		}
	}

	async function removeFinding(finding: ReviewFinding) {
		const previousSession = session;
		if (session) session = { ...session, preReview: { ...session.preReview, findings: session.preReview.findings.filter((item) => item.id !== finding.id) } };
		try {
			await requestOk(`/api/reviews/${reviewId}/findings/${finding.id}`, { method: 'DELETE' });
		} catch (removeError) {
			session = previousSession;
			connectionWarning = removeError instanceof Error ? removeError.message : String(removeError);
		}
	}

	async function removeAnnotation(annotation: UserReviewAnnotation) {
		const previousSession = session;
		if (session) session = { ...session, userAnnotations: session.userAnnotations.filter((item) => item.id !== annotation.id) };
		try {
			await requestOk(`/api/reviews/${reviewId}/annotations/${annotation.id}`, { method: 'DELETE' });
		} catch (removeError) {
			session = previousSession;
			connectionWarning = removeError instanceof Error ? removeError.message : String(removeError);
		}
	}

	async function runAgentReview() {
		persistReviewSettings();
		modelDialog = false;
		if (!agentModelKey) return;
		const previousSession = session;
		if (session) session = { ...session, preReview: { ...session.preReview, status: 'running', error: undefined, findings: suggestComments ? session.preReview.findings : [] } };
		try {
			await requestOk(`/api/reviews/${reviewId}/agent-review`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ modelKey: agentModelKey, thinkingLevel: agentThinkingLevel, suggestComments })
			});
		} catch (reviewError) {
			session = previousSession;
			connectionWarning = reviewError instanceof Error ? reviewError.message : String(reviewError);
		}
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
			reviewLevel = lowestReviewLevel(session.preReview.hunks);
			reviewLevelResetKey = '';
			selectedFile = undefined;
			reviewed.clear();
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

	async function requestOk(input: RequestInfo | URL, init?: RequestInit) {
		const response = await fetch(input, init);
		if (!response.ok) throw new Error(await responseErrorMessage(response));
		return response;
	}

	async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
		const response = await requestOk(input, init);
		return (await response.json()) as T;
	}

	async function responseErrorMessage(response: Response) {
		const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
		return body?.error ?? (response.statusText || 'Request failed');
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
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
			event.preventDefault();
			void copyFeedback();
			return;
		}
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
		try {
			await requestOk(`/api/reviews/${reviewId}/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
			window.close();
			setTimeout(() => {
				document.body.replaceChildren(Object.assign(document.createElement('main'), { className: 'center', textContent: 'Feedback inserted. You can close this tab.' }));
			}, 150);
		} catch (finishError) {
			finished = false;
			connectionWarning = finishError instanceof Error ? finishError.message : String(finishError);
		}
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

	function startLineAnnotation(detail: { file: string; line: number; side: 'additions' | 'deletions'; endLine?: number; endSide?: 'additions' | 'deletions' }) {
		lastLineAnnotationTarget = { scope: 'line', ...detail };
		annotationDraft = { ...lastLineAnnotationTarget, body: '' };
	}

	function startLineRangeAnnotation(file: string, range: SelectedLineRange | null) {
		if (!range || (range.start === range.end && (range.side ?? 'additions') === (range.endSide ?? range.side ?? 'additions'))) return;
		startLineAnnotation({ file, line: range.start, side: range.side ?? 'additions', endLine: range.end, endSide: range.endSide ?? range.side ?? 'additions' });
	}

	function editAnnotation(annotation: UserReviewAnnotation) {
		annotationDraft = { id: annotation.id, scope: annotation.scope, file: annotation.file, line: annotation.line, side: annotation.side, endLine: annotation.endLine, endSide: annotation.endSide, body: annotation.body };
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

	function currentFileForAction() {
		return selectedFile ?? diffViewer?.currentFile() ?? activeFile;
	}

	function renderMarkdown(markdown: string, fallback = 'No summary available.') {
		return renderReviewMarkdown(markdown, reviewId ?? '', fallback);
	}

	async function focusCompletionDialog() {
		await tick();
		closingNotesTextarea?.focus();
	}

	function submitAnnotation(event: SubmitEvent) {
		event.preventDefault();
		void saveAnnotation();
	}

	function backdropClick(event: MouseEvent, close: () => void) {
		if (event.target === event.currentTarget) close();
	}
</script>

<svelte:window onkeydown={handleShortcut} />

{#if error}
	<main class="grid min-h-screen place-items-center p-4"><div class="border border-danger/50 bg-danger-soft px-2.5 py-2 text-danger">{error}</div></main>
{:else if !session}
	<main class="grid min-h-screen place-items-center p-4"><div class="border border-border bg-surface-2 px-2.5 py-2 text-muted">Loading review…</div></main>
{:else}
	<div class="grid min-h-screen grid-cols-1 grid-rows-[auto_1fr] {gridColumnsClass}">
		<header class="sticky top-0 z-40 col-span-full flex items-center justify-between gap-2 border-b border-border bg-bg/95 px-2 backdrop-blur-sm relative" style="min-height: var(--topbar-height)">
			<div class="absolute bottom-0 left-0 h-0.5 w-full overflow-hidden bg-surface-2"><div class="review-progress h-full bg-accent" class:review-progress-complete={celebrateReviewComplete} style={`width: ${reviewProgress}%`}></div></div>
			<div class="min-w-0">
				<h1 class="truncate text-[0.95rem] font-semibold">{session.title}</h1>
				<p class="truncate text-xs text-muted">{session.cwd} · {visibleFiles.length}/{files.length} files · {session.baseDescription}</p>
			</div>
			<div class="flex items-center gap-1">
				<button title="Copy feedback" onclick={copyFeedback}><Clipboard size={15} /><span class="hidden sm:inline">{copied ? 'Copied' : copyFailed ? 'Copy failed' : 'Copy feedback'}</span></button>
				<button class={allFilesReviewed ? 'border-accent bg-accent text-accent-fg hover:bg-accent hover:opacity-90' : ''} title="Insert feedback (W or Cmd/Ctrl+Enter)" onclick={() => finish()}><Check size={15} /><span class="hidden sm:inline">Insert feedback</span></button>
				<button title="Toggle left sidebar (B)" onclick={() => (leftOpen = !leftOpen)}>{#if leftOpen}<PanelLeftClose size={15} />{:else}<PanelLeftOpen size={15} />{/if}<span class="hidden sm:inline">{leftOpen ? 'Hide' : 'Show'} files</span></button>
				<button title="Toggle right sidebar (Shift+B)" onclick={() => (rightOpen = !rightOpen)}>{#if rightOpen}<PanelRightClose size={15} />{:else}<PanelRightOpen size={15} />{/if}<span class="hidden sm:inline">{rightOpen ? 'Hide' : 'Show'} annotations</span></button>
				<div class="relative">
					<button class="h-8 w-8 self-center p-0 leading-none" title="View options" aria-label="View options" onclick={() => (viewMenuOpen = !viewMenuOpen)}><MoreVertical size={18} /></button>
					{#if viewMenuOpen}
						<div class="absolute right-0 top-[calc(100%+0.4rem)] z-30 grid min-w-52 gap-[0.3125rem] border border-border-strong bg-surface p-1.5 shadow-[0_12px_32px_var(--shadow)]">
							<label class="flex items-center justify-between gap-1 text-sm text-muted">View <select bind:value={diffStyle}><option value="split">Split</option><option value="unified">Unified</option></select></label>
							<label class="flex items-center gap-1 text-sm text-muted"><input type="checkbox" bind:checked={wrap} /> Wrap lines</label>
							<button type="button" onclick={() => { shortcutsDialog = true; viewMenuOpen = false; }}><HelpCircle size={15} />Keyboard shortcuts</button>
						</div>
					{/if}
				</div>
			</div>
		</header>

		{#if leftOpen}
		<aside class="grid content-start gap-1 border-b border-border bg-bg p-[0.3125rem] lg:sticky lg:top-[var(--topbar-height)] lg:h-[calc(100vh-var(--topbar-height))] lg:overflow-auto lg:border-b-0 lg:border-r">
			{#if connectionWarning}<section class="border border-warning/40 bg-warning-soft p-[0.3125rem] text-sm text-warning">{connectionWarning}</section>{/if}
			<section class="grid min-w-0 gap-1 overflow-hidden border border-border bg-surface p-[0.3125rem]">
				<div class="flex items-center justify-between gap-1.5"><h2 class="text-[0.85rem] font-semibold">Diff source</h2><span class="bg-code px-[0.1875rem] py-[0.0625rem] text-[0.66rem] font-semibold uppercase text-muted">{session.diffMode ?? 'diff'}</span></div>
				<label class="grid gap-0.5 text-sm text-muted">Review
					<select bind:value={diffSourceMode} disabled={diffSourceLoading || session.preReview.status === 'running'} onchange={handleDiffModeChange}>
						<option value="unstaged">Unstaged changes</option>
						<option value="staged">Staged changes</option>
						<option value="uncommitted">Uncommitted changes</option>
						<option value="commit">Last commit</option>
						<option value="branch">Branch vs ref</option>
					</select>
				</label>
				{#if diffSourceMode === 'branch'}<label class="grid gap-0.5 text-sm text-muted">Base ref <select bind:value={diffSourceBase} disabled={diffSourceLoading || session.preReview.status === 'running'} onchange={handleBranchRefChange}>{#if diffSourceBase && !branchRefs.includes(diffSourceBase)}<option value={diffSourceBase}>{diffSourceBase}</option>{/if}{#each branchRefs as ref (ref)}<option value={ref}>{ref}</option>{/each}{#if branchRefs.length === 0 && !diffSourceBase}<option value="origin/main">origin/main</option>{/if}</select></label>{/if}
				{#if diffSourceLoading}<p class="text-sm text-muted">Loading source…</p>{/if}
				{#if diffSourceError}<p class="text-sm text-danger">{diffSourceError}</p>{/if}
			</section>
			<section class="grid min-w-0 gap-1 overflow-hidden border border-border bg-surface p-[0.3125rem]">
				<div class="flex items-center justify-between gap-1.5"><h2 class="text-[0.85rem] font-semibold">Files</h2><span class="bg-code px-[0.1875rem] py-[0.0625rem] text-[0.66rem] font-semibold uppercase text-muted">{reviewedFileCount}/{visibleFiles.length}</span></div>
				<FileTreeViewer files={visibleFiles} {selectedFile} {activeFile} reviewed={reviewedFiles} onSelect={(file) => (selectedFile = file)} />
			</section>
		</aside>
		{/if}

		<main class="min-w-0 max-w-full px-1.5 py-[0.3125rem]" style="scroll-padding-top: calc(var(--topbar-height) + 1rem)">
			<DiffViewer bind:this={diffViewer} {session} {findings} {hunkRanks} {reviewLevel} {isolatedLevel} reviewed={reviewedFiles} reviewedKeys={reviewed} {selectedFile} {targetFindingId} {targetAnnotationId} {diffStyle} {wrap} onActiveChange={(detail) => { activeFile = detail.file; }} onAnnotate={startLineAnnotation} onAnnotateRange={startLineRangeAnnotation} onFileComment={(file) => (annotationDraft = { scope: 'file', file, body: '' })} onToggleReviewed={toggleReviewed} onEditAnnotation={editAnnotation} onDeleteAnnotation={removeAnnotation} />
		</main>

		{#if rightOpen}
			<aside class="grid content-start gap-1 border-t border-border bg-bg p-[0.3125rem] lg:sticky lg:top-[var(--topbar-height)] lg:h-[calc(100vh-var(--topbar-height))] min-w-0 overflow-x-hidden lg:overflow-y-auto lg:border-t-0 lg:border-l">
				<section class="grid min-w-0 gap-1 overflow-hidden border border-border bg-surface p-[0.3125rem]">
					<div class="flex items-center justify-between gap-1.5">
						<button class="min-w-0 flex-1 justify-start border-0 bg-transparent p-0 hover:bg-transparent" onclick={() => (aiOpen = !aiOpen)}><h2 class="flex items-center gap-[0.1875rem] text-[0.85rem] font-semibold">{#if aiOpen}<ChevronDown size={15} />{:else}<ChevronRight size={15} />{/if}AI review</h2></button>
						{#if hasAgentReview || session.preReview.status === 'running'}
							<span class="bg-code px-[0.1875rem] py-[0.0625rem] text-[0.66rem] font-semibold uppercase text-muted">{hasAgentReview ? 'done' : 'running'}</span>
						{:else}
							<button class="px-1 py-[0.0625rem] text-xs" title="Run AI review" disabled={!agentModelKey} onclick={runAgentReview}><Play size={13} />Run</button>
						{/if}
					</div>
					{#if aiOpen}
						<div class="grid grid-cols-[minmax(0,1fr)_auto] gap-1">
							<button title="AI review settings" onclick={() => (modelDialog = true)}>{#if session.preReview.status === 'running'}<LoaderCircle class="animate-spin" size={15} />{:else}<Settings size={15} />{/if}Model: {selectedAgentModel?.name ?? 'none'}</button>
							{#if hasAgentReview && session.preReview.summary}<button class="w-9 px-0" title="Show summary (S)" aria-label="Show summary" onclick={() => (summaryDialog = true)}><BookOpenText size={15} /></button>{/if}
						</div>
						{#if !hasAgentReview}<p class="text-sm text-muted">{session.preReview.status === 'idle' ? 'Run agent review from model settings.' : session.preReview.status === 'running' ? 'Ranking hunks…' : 'Agent review failed.'}</p>{/if}
						{#if session.agentReview.models.length === 0}<p class="text-sm text-muted">No authenticated models available.</p>{/if}
						{#if session.preReview.error}<p class="text-sm text-muted">{session.preReview.error}</p>{/if}
					{/if}
				</section>
				{#if hunkRanks.length > 0}
					<section class="relative grid min-w-0 gap-1 overflow-hidden border border-border bg-surface p-1 {reviewModeOpen || reviewLevelOptions.length <= 1 ? '' : 'pb-4'}">
						<div class="flex items-center justify-between gap-1.5">
							<button class="min-w-0 flex-1 justify-start border-0 bg-transparent p-0 hover:bg-transparent" onclick={() => (reviewModeOpen = !reviewModeOpen)}><h2 class="flex items-center gap-[0.1875rem] text-[0.85rem] font-semibold">{#if reviewModeOpen}<ChevronDown size={15} />{:else}<ChevronRight size={15} />{/if}Review mode</h2><span class="truncate text-xs text-muted">{currentReviewMode.label}</span></button>
						</div>
						{#if !reviewModeOpen && reviewLevelOptions.length > 1}
							<div class="absolute inset-x-1 bottom-1.5 flex gap-0.5" title="Review mode (+/-)">
								{#each reviewLevelOptions as option (option.level)}
									<button class="h-1.5 min-w-0 flex-1 border-0 p-0 {(isolatedLevel ? option.level === Number(reviewLevel) : option.level <= Number(reviewLevel)) ? 'bg-accent hover:bg-accent' : 'bg-surface-2 hover:bg-surface-hover'}" aria-label={`Review level ${option.level}`} onclick={() => (reviewLevel = option.level)}></button>
								{/each}
							</div>
						{/if}
						{#if reviewModeOpen}
							{#if reviewLevelOptions.length <= 1}
								<p class="border border-border bg-surface-2 p-1 text-sm text-muted"><strong class="text-fg">{currentReviewMode.label}</strong> · {currentReviewMode.description}</p>
							{:else}
								<div class="grid gap-[0.1875rem]">
									{#each reviewLevelOptions as option (option.level)}
										<label class="flex cursor-pointer items-start gap-1 border p-1 text-sm hover:bg-surface-hover {(isolatedLevel ? option.level === Number(reviewLevel) : option.level <= Number(reviewLevel)) ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2'}">
											<input class="mt-[0.1875rem] size-3.5 flex-none" type="radio" name="review-level" value={option.level} bind:group={reviewLevel} />
											<span class="grid min-w-0 gap-[0.0625rem]"><span class="font-medium text-fg">{option.label} <span class="text-xs font-normal text-muted">({option.count})</span></span><span class="text-xs text-muted">{option.description}</span></span>
										</label>
									{/each}
								</div>
							{/if}
							<label class="flex items-center gap-1 text-sm text-muted" title="Toggle isolated review mode (I)"><input type="checkbox" bind:checked={isolatedLevel} /> Isolate selected mode</label>
						{/if}
					</section>
				{/if}
				<section class="grid min-w-0 gap-1 overflow-hidden border border-border bg-surface p-[0.3125rem]">
					<div class="flex items-center justify-between gap-1.5"><h2 class="text-[0.85rem] font-semibold">Agent annotations</h2><span class="bg-code px-[0.1875rem] py-[0.0625rem] text-[0.66rem] font-semibold uppercase text-muted">{findings.length}</span></div>
					{#if findings.length === 0}<p class="text-sm text-muted">No highlights yet.</p>{:else}<div class="grid gap-1">{#each findings as finding (finding.id)}<div class="grid gap-[0.1875rem] p-1 transition-colors {highlightedEntryId === finding.id ? 'bg-accent-soft ring-1 ring-accent' : 'bg-surface-2 hover:bg-surface-hover'}"><div class="flex items-center gap-[0.1875rem]"><button class="min-w-0 flex-1 justify-start border-0 bg-transparent p-0 text-left hover:bg-transparent" onclick={() => selectFinding(finding)}><span class="flex min-w-0 items-center gap-1"><span class="{severityClass(finding)} px-[0.1875rem] py-[0.0625rem] text-[0.66rem] font-semibold uppercase">L{finding.attentionLevel} · {finding.severity}</span><small class="min-w-0 truncate text-muted">{finding.file ?? 'Overall'}{finding.line ? `:${finding.line}` : ''}</small></span></button><button class="flex-none border-0 bg-transparent px-0.5 text-muted hover:bg-danger-soft hover:text-danger" title="Remove" aria-label="Remove finding" onclick={() => removeFinding(finding)}><Trash2 size={14} /></button></div><button class="block w-full justify-start border-0 bg-transparent p-0 text-left hover:bg-transparent" onclick={() => selectFinding(finding)}><div class="rendered-markdown text-sm">{@html renderMarkdown(finding.title)}</div></button></div>{/each}</div>{/if}
				</section>
				<section class="grid min-w-0 gap-1 overflow-hidden border border-border bg-surface p-[0.3125rem]">
					<div class="sticky top-0 z-10 -mx-2.5 -mt-2.5 grid gap-1 border-b border-border bg-surface p-[0.3125rem]">
						<div class="flex items-center justify-between gap-1.5"><h2 class="text-[0.85rem] font-semibold">User annotations</h2><span class="bg-code px-[0.1875rem] py-[0.0625rem] text-[0.66rem] font-semibold uppercase text-muted">{userAnnotations.length}</span></div>
						<button class="w-full justify-start" title="Comment overall (O)" onclick={() => (annotationDraft = { scope: 'global', body: '' })}><MessageSquarePlus size={15} />Comment overall</button>
					</div>
					{#if userAnnotations.length === 0}<p class="text-sm text-muted">Click line numbers, add file notes, or comment overall.</p>{:else}<div class="grid gap-1">{#each userAnnotations as annotation (annotation.id)}<div class="grid gap-[0.1875rem] p-1 transition-colors {highlightedEntryId === annotation.id ? 'bg-accent-soft ring-1 ring-accent' : 'bg-surface-2 hover:bg-surface-hover'}"><div class="flex items-center gap-[0.1875rem]"><button class="min-w-0 flex-1 justify-start border-0 bg-transparent p-0 text-left hover:bg-transparent" onclick={() => selectAnnotation(annotation)}><span class="flex min-w-0 items-center gap-1"><small class="min-w-0 truncate text-muted">{annotation.scope === 'global' ? 'Overall' : annotation.scope === 'file' ? annotation.file : `${annotation.file}:${annotation.line}`}</small></span></button><button class="flex-none border-0 bg-transparent px-0.5 text-muted hover:bg-surface-hover hover:text-fg" title="Edit" aria-label="Edit annotation" onclick={() => editAnnotation(annotation)}><Edit3 size={14} /></button><button class="flex-none border-0 bg-transparent px-0.5 text-muted hover:bg-danger-soft hover:text-danger" title="Remove" aria-label="Remove annotation" onclick={() => removeAnnotation(annotation)}><Trash2 size={14} /></button></div><button class="block w-full justify-start border-0 bg-transparent p-0 text-left hover:bg-transparent" onclick={() => selectAnnotation(annotation)}><div class="rendered-markdown text-sm">{@html renderMarkdown(annotation.body)}</div></button></div>{/each}</div>{/if}
				</section>
			</aside>
		{/if}
	</div>
{/if}

{#if modelDialog}
	<div role="presentation" class="modal-backdrop fixed inset-0 z-40 grid place-items-center p-2" onclick={(event) => backdropClick(event, () => (modelDialog = false))}>
		<div role="dialog" aria-modal="true" aria-labelledby="model-dialog-title" class="grid w-[min(34rem,calc(100vw-2rem))] gap-1.5 border border-border bg-surface p-2.5 shadow-[0_16px_48px_var(--shadow)]">
			<h2 id="model-dialog-title" class="text-[0.95rem] font-semibold">AI review model</h2>
			<label class="grid gap-[0.1875rem] text-sm text-muted">Model
				<select class="w-full" bind:value={agentModelKey} disabled={session?.preReview.status === 'running'}>
					{#each session?.agentReview.models ?? [] as model (model.key)}
						<option value={model.key}>{model.provider}/{model.name}</option>
					{/each}
				</select>
			</label>
			<label class="grid gap-[0.1875rem] text-sm text-muted">Thinking
				<select class="w-full" bind:value={agentThinkingLevel} disabled={session?.preReview.status === 'running'}>
					{#each selectedAgentModel?.thinkingLevels ?? ['off'] as level (level)}
						<option value={level}>{level}</option>
					{/each}
				</select>
			</label>
			<label class="flex items-center gap-1 text-sm"><input type="checkbox" bind:checked={suggestComments} /> Suggest comments</label>
			<label class="flex items-center gap-1 text-sm"><input type="checkbox" bind:checked={autoReview} /> Run automatically next time</label>
			<div class="flex justify-end gap-1 pt-0.5"><button title="Close dialog (Esc)" type="button" onclick={() => { persistReviewSettings(); modelDialog = false; }}>Close</button><button class="border-accent bg-accent text-accent-fg hover:bg-accent hover:opacity-90" title="Run AI review" type="button" disabled={!agentModelKey || session?.preReview.status === 'running'} onclick={runAgentReview}><Play size={15} />Run</button></div>
		</div>
	</div>
{/if}

{#if summaryDialog}
	<div role="presentation" class="modal-backdrop fixed inset-0 z-40 grid place-items-center p-2" onclick={(event) => backdropClick(event, () => (summaryDialog = false))}>
		<div role="dialog" aria-modal="true" aria-labelledby="summary-dialog-title" class="grid max-h-[min(70vh,42rem)] w-[min(40rem,calc(100vw-2rem))] gap-1.5 overflow-auto border border-border bg-surface p-2.5 shadow-[0_16px_48px_var(--shadow)]">
			<h2 id="summary-dialog-title" class="text-[0.95rem] font-semibold">Agent summary</h2>
			<div class="markdown-body text-sm">{@html renderMarkdown(session?.preReview.summary ?? '')}</div>
			<div class="flex justify-end gap-1 pt-0.5"><button type="button" onclick={() => (summaryDialog = false)}>Close</button></div>
		</div>
	</div>
{/if}

{#if completionDialog}
	<div role="presentation" class="modal-backdrop fixed inset-0 z-40 grid place-items-center p-2" onclick={(event) => backdropClick(event, () => (completionDialog = false))}>
		<div class="confetti-layer" aria-hidden="true">{#each Array.from({ length: 24 }, (_, index) => index) as index (index)}<i></i>{/each}</div>
		<div role="dialog" aria-modal="true" aria-labelledby="completion-dialog-title" class="relative z-10 grid w-[min(34rem,calc(100vw-2rem))] gap-1.5 border border-accent/50 bg-surface p-2.5 shadow-[0_16px_48px_var(--shadow)]">
			<h2 id="completion-dialog-title" class="text-[1rem] font-semibold">Review complete</h2>
			<p class="text-sm text-muted">All files in this review scope are marked reviewed. Add optional closing notes before inserting feedback.</p>
			<label class="grid gap-[0.1875rem] text-sm text-muted">Closing notes
				<textarea bind:this={closingNotesTextarea} bind:value={closingNotes} rows="5" placeholder="Optional notes to append below annotations…"></textarea>
			</label>
			<div class="flex justify-end gap-1 pt-0.5"><button type="button" onclick={() => (completionDialog = false)}>Keep reviewing</button><button class="border-accent bg-accent text-accent-fg hover:bg-accent hover:opacity-90" type="button" onclick={() => finish()}><Check size={15} />Insert feedback</button></div>
		</div>
	</div>
{/if}

{#if shortcutsDialog}
	<div role="presentation" class="modal-backdrop fixed inset-0 z-40 grid place-items-center p-2" onclick={(event) => backdropClick(event, () => (shortcutsDialog = false))}>
		<div role="dialog" aria-modal="true" aria-labelledby="shortcuts-dialog-title" class="grid w-[min(32rem,calc(100vw-2rem))] gap-1.5 border border-border bg-surface p-2.5 shadow-[0_16px_48px_var(--shadow)]">
			<h2 id="shortcuts-dialog-title" class="text-[0.95rem] font-semibold">Keyboard shortcuts</h2>
			<dl class="grid max-h-[60vh] gap-1 overflow-auto pr-0.5">
				<dt class="text-xs font-semibold uppercase text-muted">All files</dt>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">↓ / ↑</kbd><dd class="text-sm text-muted">Next / previous file</dd></div>
				<dt class="mt-3 border-t border-border pt-1.5 text-xs font-semibold uppercase text-muted">Diff view</dt>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">Shift+↓ / ↑</kbd><dd class="text-sm text-muted">Next / previous comment</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">Enter</kbd><dd class="text-sm text-muted">Edit highlighted user comment</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">V</kbd><dd class="text-sm text-muted">Toggle current file reviewed</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">F</kbd><dd class="text-sm text-muted">Add file comment</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">Opt+↓ / ↑</kbd><dd class="text-sm text-muted">Next / previous hunk</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">O</kbd><dd class="text-sm text-muted">Comment overall</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">S</kbd><dd class="text-sm text-muted">Show agent summary</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">I</kbd><dd class="text-sm text-muted">Toggle isolated review mode</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">+ / −</kbd><dd class="text-sm text-muted">Change review mode</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">B</kbd><dd class="text-sm text-muted">Toggle files sidebar</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">Shift+B</kbd><dd class="text-sm text-muted">Toggle annotations sidebar</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">W</kbd><dd class="text-sm text-muted">Insert feedback</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">Cmd/Ctrl+C</kbd><dd class="text-sm text-muted">Copy feedback</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">Cmd/Ctrl+Enter</kbd><dd class="text-sm text-muted">Insert feedback</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">?</kbd><dd class="text-sm text-muted">Show keyboard shortcuts</dd></div>
				<dt class="mt-3 border-t border-border pt-1.5 text-xs font-semibold uppercase text-muted">Editing annotation</dt>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">Ctrl+S</kbd><dd class="text-sm text-muted">Save annotation</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">Cmd+Enter</kbd><dd class="text-sm text-muted">Save annotation</dd></div>
				<dt class="mt-3 border-t border-border pt-1.5 text-xs font-semibold uppercase text-muted">Dialogs</dt>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">Esc</kbd><dd class="text-sm text-muted">Close dialog</dd></div>
			</dl>
			<div class="flex justify-end gap-1 pt-0.5"><button type="button" onclick={() => (shortcutsDialog = false)}>Close</button></div>
		</div>
	</div>
{/if}

{#if annotationDraft}
	<div role="presentation" class="modal-backdrop fixed inset-0 z-40 grid place-items-center p-2" onclick={(event) => backdropClick(event, () => (annotationDraft = undefined))}>
		<div role="dialog" aria-modal="true" aria-labelledby="annotation-dialog-title">
			<form class="grid w-[min(36rem,calc(100vw-2rem))] gap-1.5 border border-border bg-surface p-2.5 shadow-[0_16px_48px_var(--shadow)]" onsubmit={submitAnnotation}>
				<h2 id="annotation-dialog-title" class="text-[0.95rem] font-semibold">{annotationDraft.id ? 'Edit annotation' : 'Add annotation'}</h2>
				<p class="text-xs text-muted">{annotationDraft.scope === 'global' ? 'Overall review' : annotationDraft.scope === 'file' ? annotationDraft.file : `${annotationDraft.file}:${annotationDraft.line}${annotationDraft.endLine && annotationDraft.endLine !== annotationDraft.line ? `-${annotationDraft.endLine}` : ''} · ${annotationDraft.side}`}</p>
				<MarkdownEditor bind:this={mdEditor} bind:value={annotationDraft.body} onImagePaste={handleAnnotationImagePaste} />
				<div class="flex justify-end gap-1 pt-0.5"><button title="Close dialog (Esc)" type="button" onclick={() => (annotationDraft = undefined)}>Cancel</button><button class="border-accent bg-accent text-accent-fg hover:bg-accent hover:opacity-90" title="Save comment (Ctrl+S or Cmd+Enter)" type="submit">Save</button></div>
			</form>
		</div>
	</div>
{/if}
