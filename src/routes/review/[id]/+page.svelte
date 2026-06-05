<script lang="ts">
	import { tick } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { renderReviewMarkdown } from '$lib/client/review-markdown';
	import { availableStrategies, buildPartition, causalityAvailable, orderChunks, partsInOrder, sortFilesForTree } from '$lib/client/review-ui';
	import { buildReviewFeedback } from '$lib/shared/feedback';
	import { isReviewableImagePath } from '$lib/shared/images';
	import Button from '$lib/components/Button.svelte';
	import CircularCheckProgress from '$lib/components/CircularCheckProgress.svelte';
	import DiffViewer from '$lib/components/DiffViewer.svelte';
	import FileTreeViewer from '$lib/components/FileTreeViewer.svelte';
	import MarkdownEditor from '$lib/components/MarkdownEditor.svelte';
	import { Check, ChevronDown, ChevronLeft, ChevronRight, Clipboard, Edit3, HelpCircle, LoaderCircle, MessageSquarePlus, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Play, Settings, Trash2, BookOpenText, SquareSplitHorizontal, TextWrap } from '@lucide/svelte';
	import type { SelectedLineRange } from '@pierre/diffs';
	import type { ReviewChunk, ReviewDiffMode, ReviewDiffStyle, ReviewFinding, ReviewSessionSnapshot, ReviewSortOrder, ReviewStrategy, ReviewUiSettings, UserReviewComment } from '$lib/shared/review';

	type CommentDraft = { id?: string; scope: 'global' | 'file' | 'line'; file?: string; line?: number; side?: 'additions' | 'deletions'; endLine?: number; endSide?: 'additions' | 'deletions'; body: string };
	type MarkdownEditorApi = { insertText: (text: string) => void; focus: () => void };
	type DiffViewerApi = { scrollFile: (direction: 1 | -1) => void; scrollFileAfter: (file: string) => void; scrollComment: (direction: 1 | -1) => void; scrollHunk: (direction: 1 | -1) => void; editActiveComment: () => boolean; currentFile: () => string | undefined };
	type StoredReviewed = { version: 3; entries: string[] };
	type ReviewWorktreeOption = { path: string; branch?: string; head?: string; current: boolean };

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
	let commentDraft = $state<CommentDraft | undefined>();
	let mdEditor = $state<MarkdownEditorApi | undefined>();
	let closingNotesTextarea = $state<HTMLTextAreaElement | undefined>();
	let diffViewer = $state<DiffViewerApi | undefined>();
	let agentModelKey = $state('');
	let agentThinkingLevel = $state('off');
	let suggestComments = $state(true);
	let autorunEnabled = $state(false);
	let autorunSettings = $state<NonNullable<ReviewUiSettings['autorun']> | undefined>(undefined);
	let autoReviewArmed = $state(false);
	let autoStartedSessionId = $state<string | undefined>();
	let aiOpen = $state(false);
	let reviewModeOpen = $state(false);
	let agentCommentsOpen = $state(false);
	let userCommentsOpen = $state(false);
	let commentOpenSessionId = $state<string | undefined>();
	let lastFindingCount = $state(0);
	let lastUserCommentCount = $state(0);
	let modelDialog = $state(false);
	let shortcutsDialog = $state(false);
	let agentDefaultsSessionId = $state<string | undefined>();
	let agentDefaultsRestoringSessionId = $state<string | undefined>();
	let strategyDefaultsKey = $state('');
	let finished = $state(false);
	let copied = $state(false);
	let copyFailed = $state(false);
	let celebrateReviewComplete = $state(false);
	let completionDialog = $state(false);
	let closingNotes = $state('');
	let strategy = $state<ReviewStrategy>('flat');
	let sortOrder = $state<ReviewSortOrder>('tree');
	let cueEnabled = $state(true);
	let isolatedPart = $state(false);
	let autoAdvance = $state(false);
	let currentPartIndex = $state(0);
	let animatePartTransition = $state(false);
	let partTransitionDirection = $state<1 | -1>(1);
	let partTransitionTimer: ReturnType<typeof setTimeout> | undefined;
	let smartAutoSwitched = $state<string | undefined>();
	let diffSourceMode = $state<ReviewDiffMode>('uncommitted');
	let diffSourceBase = $state('origin/main');
	let branchRefs = $state.raw<string[]>([]);
	let worktrees = $state.raw<ReviewWorktreeOption[]>([]);
	let worktreeCwd = $state('');
	let diffSourceLoading = $state(false);
	let diffSourceError = $state<string | undefined>();
	let diffSourceSessionId = $state<string | undefined>();
	let overviewDialog = $state(false);
	let overviewOpenedForSession = $state<string | undefined>();
	let targetFindingId = $state<string | undefined>();
	let targetCommentId = $state<string | undefined>();
	let highlightedEntryId = $state<string | undefined>();
	let activeFile = $state<string | undefined>();
	let lastLineCommentTarget = $state<{ scope: 'line'; file: string; line: number; side: 'additions' | 'deletions'; endLine?: number; endSide?: 'additions' | 'deletions' } | undefined>();

	const confettiPieces = Array.from({ length: 64 }, (_, index) => {
		const angle = -150 + (300 / 63) * index;
		const distance = 34 + ((index * 17) % 38);
		const radians = angle * Math.PI / 180;
		return {
			index,
			style: `--x: ${Math.cos(radians) * distance}; --y: ${Math.sin(radians) * distance}; --r: ${180 + index * 47}deg; --delay: ${(index % 14) * 0.016}s; --s: ${0.72 + (index % 6) * 0.11};`
		};
	});

	let reviewId = $derived(page.params.id);
	let files = $derived(session?.files ?? []);
	let findings = $derived(session?.preReview.findings ?? []);
	let hunks = $derived(session?.hunks ?? []);
	let hasAgentReview = $derived(session?.preReview.status === 'done' && !!session.preReview.model);
	let strategies = $derived(session ? availableStrategies(session) : (['flat'] as ReviewStrategy[]));
	let canCausality = $derived(session ? causalityAvailable(session) : false);
	let partition = $derived(session ? buildPartition(strategy, session) : { parts: [], chunks: [] });
	let orderedParts = $derived(partsInOrder(partition.parts));
	let multiPart = $derived(orderedParts.length > 1);
	let safePartIndex = $derived(orderedParts.length > 0 ? Math.min(currentPartIndex, orderedParts.length - 1) : 0);
	let currentPart = $derived(orderedParts[safePartIndex]);
	let currentPartKey = $derived(`${strategy}:${currentPart?.id ?? safePartIndex}`);
	let nextPart = $derived(orderedParts[safePartIndex + 1]);
	let hasNextPart = $derived(nextPart !== undefined);
	let currentPartComplete = $derived(isCurrentPartComplete());
	let singlePartInView = $derived(orderedParts.length <= 1 || isolatedPart || safePartIndex === 0);
	let visibleParts = $derived(isolatedPart && currentPart ? [currentPart] : orderedParts.slice(0, safePartIndex + 1));
	let visiblePartIds = $derived(new SvelteSet(visibleParts.map((part) => part.id)));
	let visibleChunks = $derived(orderChunks(partition.chunks.filter((chunk) => visiblePartIds.has(chunk.partId)), sortOrder, session?.preReview.causalityOrder));
	let visibleHunkIds = $derived(new SvelteSet(visibleChunks.flatMap((chunk) => chunk.hunkIds)));
	let visibleFileSet = $derived(new SvelteSet(visibleChunks.map((chunk) => chunk.file)));
	let visibleFiles = $derived(sortFilesForTree(files.filter((file) => visibleFileSet.has(file.path) || (file.previousPath && visibleFileSet.has(file.previousPath)))));
	let userComments = $derived(session?.userComments ?? []);
	let reviewedFiles = $derived(new SvelteSet(visibleFiles.filter((file) => isFileReviewed(file.path)).map((file) => file.path)));
	let reviewedFileCount = $derived(visibleFiles.filter((file) => reviewedFiles.has(file.path)).length);
	let reviewProgress = $derived(hunks.length ? Math.round(([...reviewed].filter((id) => hunks.some((hunk) => hunk.id === id)).length / hunks.length) * 100) : 0);
	let reviewScopeComplete = $derived(hunks.length > 0 && hunks.every((hunk) => reviewed.has(hunk.id)));
	let fileReviewUnits = $derived(fileReviewUnitMap());
	let fileReviewProgress = $derived(new Map([...fileReviewUnits].map(([file, units]) => [file, units.total ? Math.round((units.reviewed / units.total) * 100) : 0] as const)));
	let feedbackText = $derived(buildReviewFeedback(findings, userComments, closingNotes));
	let gridColumnsClass = $derived(leftOpen
		? rightOpen ? 'lg:grid-cols-[17rem_minmax(0,1fr)_19rem]' : 'lg:grid-cols-[17rem_minmax(0,1fr)]'
		: rightOpen ? 'lg:grid-cols-[minmax(0,1fr)_19rem]' : 'lg:grid-cols-[minmax(0,1fr)]');
	let selectedAgentModel = $derived(session?.agentReview.models.find((model) => model.key === agentModelKey));
	let selectedWorktree = $derived(worktrees.find((worktree) => worktree.path === worktreeCwd));
	let preferredBranchBase = $derived(selectPreferredBranchBase(branchRefs, selectedWorktree?.branch));
	let reviewSettingsJson = $derived(JSON.stringify({ modelKey: agentModelKey, thinkingLevel: agentThinkingLevel, suggestComments, strategy, sortOrder, cueEnabled, autorun: { ...(autorunSettings ?? { enabled: false, unconditional: false }), enabled: autorunEnabled }, isolatedPart, autoAdvance, diffStyle, wrap }));

	$effect(() => {
		if (orderedParts.length > 0 && currentPartIndex > orderedParts.length - 1) {
			resetPartTransition();
			currentPartIndex = orderedParts.length - 1;
		}
	});

	$effect(() => {
		if (!strategies.includes(strategy)) strategy = 'flat';
		if (sortOrder === 'causality' && !canCausality) sortOrder = 'tree';
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
		if (hasAgentReview && session?.preReview.overview && overviewOpenedForSession !== session.id) {
			overviewOpenedForSession = session.id;
			overviewDialog = true;
		}
	});

	$effect(() => {
		if (hasAgentReview && session && session.preReview.smart && smartAutoSwitched !== session.id) {
			smartAutoSwitched = session.id;
			strategy = 'smart';
			resetPartTransition();
			currentPartIndex = 0;
			if (causalityAvailable(session)) sortOrder = 'causality';
		}
	});

	$effect(() => {
		if (completionDialog) void focusCompletionDialog();
	});

	$effect(() => {
		const id = session?.id;
		if (id !== commentOpenSessionId) {
			commentOpenSessionId = id;
			lastFindingCount = findings.length;
			lastUserCommentCount = userComments.length;
			agentCommentsOpen = false;
			userCommentsOpen = false;
			return;
		}
		if (lastFindingCount === 0 && findings.length > 0) agentCommentsOpen = true;
		if (lastUserCommentCount === 0 && userComments.length > 0) userCommentsOpen = true;
		lastFindingCount = findings.length;
		lastUserCommentCount = userComments.length;
	});

	$effect(() => {
		const id = reviewId;
		const abort = new AbortController();
		error = undefined;
		connectionWarning = undefined;
		selectedFile = undefined;
		void loadSnapshot(id, abort.signal);
		void loadBranchRefs(id, abort.signal);
		void loadWorktrees(id, abort.signal);

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
		autorunSettings = stored.autorun;
		autorunEnabled = stored.autorun?.enabled ?? false;
		autoReviewArmed = autorunEnabled;
		const available = availableStrategies(nextSession);
		const defaultStrategy: ReviewStrategy = nextSession.commits?.length ? 'commits' : 'flat';
		strategy = stored.strategy && available.includes(stored.strategy) ? stored.strategy : defaultStrategy;
		sortOrder = stored.sortOrder && (stored.sortOrder === 'tree' || causalityAvailable(nextSession)) ? stored.sortOrder : 'tree';
		cueEnabled = stored.cueEnabled ?? true;
		isolatedPart = stored.isolatedPart ?? false;
		autoAdvance = stored.autoAdvance ?? false;
		resetPartTransition();
		currentPartIndex = 0;
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
		worktreeCwd = nextSession.cwd;
		diffSourceMode = nextSession.diffMode ?? 'uncommitted';
		diffSourceBase = nextSession.diffBase ?? preferredBranchBase;
		diffSourceError = undefined;
	}

	async function loadBranchRefs(id = reviewId, signal?: AbortSignal) {
		try {
			const response = await fetch(`/api/reviews/${id}/refs`, { signal });
			if (!response.ok) return;
			if (id !== reviewId || signal?.aborted) return;
			branchRefs = ((await response.json()) as { refs: string[] }).refs;
			if (!diffSourceBase || (diffSourceBase === 'origin/main' && !branchRefs.includes(diffSourceBase))) diffSourceBase = selectPreferredBranchBase(branchRefs, selectedWorktree?.branch);
		} catch {
			if (!signal?.aborted) branchRefs = [];
		}
	}

	async function loadWorktrees(id = reviewId, signal?: AbortSignal) {
		try {
			const response = await fetch(`/api/reviews/${id}/worktrees`, { signal });
			if (!response.ok) return;
			if (id !== reviewId || signal?.aborted) return;
			worktrees = ((await response.json()) as { worktrees: ReviewWorktreeOption[] }).worktrees;
			if (!worktreeCwd) worktreeCwd = session?.cwd ?? worktrees.find((item) => item.current)?.path ?? worktrees[0]?.path ?? '';
		} catch {
			if (!signal?.aborted) worktrees = [];
		}
	}

	function restoreReviewed(id: string) {
		restoredSessionId = id;
		try {
			const stored = localStorage.getItem(`story-review:${id}:reviewed`);
			reviewed.clear();
			const parsed = stored ? JSON.parse(stored) as StoredReviewed | { version?: number; entries?: unknown } : undefined;
			const entries = parsed && typeof parsed === 'object' && parsed.version === 3 && Array.isArray(parsed.entries) ? parsed.entries : [];
			for (const entry of entries) if (typeof entry === 'string') reviewed.add(entry);
		} catch {
			reviewed.clear();
		}
	}

	function toggleReviewed(file: string) {
		const activeBeforeToggle = currentFileForAction();
		const hunkIds = hunkIdsForFile(file);
		const isReviewed = hunkIds.length > 0 && hunkIds.every((id) => reviewed.has(id));
		const advancedPart = setHunksReviewed(hunkIds, !isReviewed);
		if (!advancedPart && !isReviewed && file === activeBeforeToggle) advanceAfterReviewed(file);
	}

	function setFilesReviewed(targetFiles: string[], nextReviewed: boolean) {
		setHunksReviewed(targetFiles.flatMap((file) => hunkIdsForFile(file)), nextReviewed);
	}

	function setHunksReviewed(hunkIds: string[], nextReviewed: boolean) {
		const wasComplete = reviewScopeComplete;
		const wasCurrentPartComplete = isCurrentPartComplete();
		let advancedPart = false;
		for (const id of hunkIds) {
			if (nextReviewed) reviewed.add(id);
			else reviewed.delete(id);
		}
		const isComplete = hunks.length > 0 && hunks.every((hunk) => reviewed.has(hunk.id));
		if (!wasComplete && isComplete) celebrateCompletion();
		else if (autoAdvance && hasNextPart && !wasCurrentPartComplete && isCurrentPartComplete()) {
			stepPart(1);
			advancedPart = true;
		}
		persistReviewed();
		return advancedPart;
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
		localStorage.setItem(`story-review:${session.id}:reviewed`, JSON.stringify({ version: 3, entries: [...reviewed] } satisfies StoredReviewed));
	}

	function hunkIdsForFile(file: string) {
		const summary = files.find((item) => item.path === file || item.previousPath === file);
		const matches = (candidate: string) => candidate === file || (summary && (candidate === summary.path || candidate === summary.previousPath));
		const ids = visibleChunks.filter((chunk) => matches(chunk.file)).flatMap((chunk) => chunk.hunkIds);
		return [...new Set(ids)];
	}

	function hunkIdsForPart(partId: string | undefined) {
		if (!partId) return [];
		return [...new Set(partition.chunks.filter((chunk) => chunk.partId === partId).flatMap((chunk) => chunk.hunkIds))];
	}

	function isCurrentPartComplete() {
		const ids = hunkIdsForPart(currentPart?.id);
		return ids.length > 0 && ids.every((id) => reviewed.has(id));
	}

	function isFileReviewed(file: string) {
		const hunkIds = hunkIdsForFile(file);
		return hunkIds.length > 0 && hunkIds.every((id) => reviewed.has(id));
	}

	function fileReviewUnitMap() {
		return new Map(visibleFiles.map((file) => {
			const hunkIds = hunkIdsForFile(file.path);
			const done = hunkIds.filter((id) => reviewed.has(id)).length;
			return [file.path, { reviewed: done, total: hunkIds.length }] as const;
		}));
	}

	function repositoryLabel(cwd: string) {
		const parts = cwd.split(/[\\/]/).filter(Boolean);
		const worktreeIndex = parts.lastIndexOf('.worktrees');
		if (worktreeIndex > 0) return `${parts[worktreeIndex - 1]} · ${parts[worktreeIndex + 1] ?? 'worktree'}`;
		return parts.at(-1) ?? cwd;
	}

	function worktreeLabel(worktree: ReviewWorktreeOption) {
		const name = worktree.path.split(/[\\/]/).pop() || worktree.path;
		return worktree.branch ? `${name} · ${worktree.branch}` : name;
	}

	function selectPreferredBranchBase(refs: string[], currentBranch?: string) {
		const preferredRefs = currentBranch === 'master'
			? ['origin/master', 'upstream/master', 'master', 'origin/main', 'upstream/main', 'main']
			: ['origin/main', 'upstream/main', 'main', 'origin/master', 'upstream/master', 'master'];
		return preferredRefs.find((ref) => refs.includes(ref)) ?? refs.find((ref) => ref !== currentBranch) ?? refs[0] ?? 'origin/main';
	}

	function celebrateCompletion() {
		celebrateReviewComplete = true;
		completionDialog = true;
		setTimeout(() => (celebrateReviewComplete = false), 2200);
	}

	function stepPart(direction: 1 | -1) {
		if (orderedParts.length <= 1) return;
		const next = Math.min(orderedParts.length - 1, Math.max(0, safePartIndex + direction));
		if (next === safePartIndex) return;
		startPartTransition(direction);
		currentPartIndex = next;
		selectedFile = undefined;
	}

	function startPartTransition(direction: 1 | -1) {
		partTransitionDirection = direction;
		animatePartTransition = true;
		if (partTransitionTimer !== undefined) clearTimeout(partTransitionTimer);
		partTransitionTimer = setTimeout(() => {
			animatePartTransition = false;
			partTransitionTimer = undefined;
		}, 220);
	}

	function resetPartTransition() {
		animatePartTransition = false;
		if (partTransitionTimer === undefined) return;
		clearTimeout(partTransitionTimer);
		partTransitionTimer = undefined;
	}

	async function saveComment() {
		if (!commentDraft?.body.trim()) return;
		const draft = { ...commentDraft, body: commentDraft.body.trim() };
		const previousSession = session;
		commentDraft = undefined;
		try {
			if (draft.id) {
				if (session) session = { ...session, userComments: session.userComments.map((item) => (item.id === draft.id ? { ...item, body: draft.body } : item)) };
				const comment = await requestJson<UserReviewComment>(`/api/reviews/${reviewId}/comments/${draft.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: draft.body }) });
				if (session) session = { ...session, userComments: session.userComments.map((item) => (item.id === comment.id ? comment : item)) };
				return;
			}
			const optimistic: UserReviewComment = { ...draft, id: `local-${crypto.randomUUID()}`, createdAt: new Date().toISOString() };
			if (session) session = { ...session, userComments: [...session.userComments, optimistic] };
			const comment = await requestJson<UserReviewComment>(`/api/reviews/${reviewId}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
			if (session) session = { ...session, userComments: session.userComments.map((item) => (item.id === optimistic.id ? comment : item)) };
		} catch (saveError) {
			session = previousSession;
			commentDraft = draft;
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

	async function removeComment(comment: UserReviewComment) {
		const previousSession = session;
		if (session) session = { ...session, userComments: session.userComments.filter((item) => item.id !== comment.id) };
		try {
			await requestOk(`/api/reviews/${reviewId}/comments/${comment.id}`, { method: 'DELETE' });
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
		if (diffSourceMode === 'branch' && (!diffSourceBase || diffSourceBase === selectedWorktree?.branch || diffSourceBase === session?.diffBase)) diffSourceBase = session?.diffBase && session.diffBase !== selectedWorktree?.branch ? session.diffBase : preferredBranchBase;
		void changeDiffSource();
	}

	function handleBranchRefChange(event: Event) {
		diffSourceBase = (event.currentTarget as HTMLSelectElement).value;
		void changeDiffSource();
	}

	function handleWorktreeChange(event: Event) {
		const previousBranch = selectedWorktree?.branch;
		worktreeCwd = (event.currentTarget as HTMLSelectElement).value;
		if (diffSourceMode === 'branch' && (!diffSourceBase || diffSourceBase === previousBranch || diffSourceBase === selectedWorktree?.branch)) diffSourceBase = preferredBranchBase;
		void changeDiffSource(worktreeCwd);
	}

	async function changeDiffSource(nextCwd = session?.cwd ?? '') {
		if (!session || diffSourceLoading || session.preReview.status === 'running') return;
		if (nextCwd === session.cwd && diffSourceMode === session.diffMode && (diffSourceMode !== 'branch' || diffSourceBase === session.diffBase)) return;
		if ((userComments.length > 0 || findings.length > 0 || reviewed.size > 0) && !confirm('Change diff source? Existing comments, agent comments, and reviewed markers for this session will be cleared.')) {
			restoreDiffSource(session);
			return;
		}
		diffSourceLoading = true;
		diffSourceError = undefined;
		try {
			const response = await fetch(`/api/reviews/${reviewId}/diff`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mode: diffSourceMode, base: diffSourceBase, cwd: nextCwd })
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
				throw new Error(body?.error ?? 'Failed to change diff source');
			}
			session = (await response.json()) as ReviewSessionSnapshot;
			worktreeCwd = session.cwd;
			void loadBranchRefs(reviewId);
			void loadWorktrees(reviewId);
			const defaultStrategy: ReviewStrategy = session.commits?.length ? 'commits' : 'flat';
			strategy = availableStrategies(session).includes(defaultStrategy) ? defaultStrategy : 'flat';
			sortOrder = 'tree';
			resetPartTransition();
			currentPartIndex = 0;
			smartAutoSwitched = undefined;
			selectedFile = undefined;
			reviewed.clear();
			localStorage.removeItem(`story-review:${reviewId}:reviewed`);
		} catch (changeError) {
			diffSourceError = changeError instanceof Error ? changeError.message : String(changeError);
			worktreeCwd = session.cwd;
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
		const inputType = target instanceof HTMLInputElement ? target.type : undefined;
		const inEditor = target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT' || (target?.tagName === 'INPUT' && inputType !== 'checkbox' && inputType !== 'radio');
		if (event.key === 'Escape' && (commentDraft || modelDialog || overviewDialog || shortcutsDialog || completionDialog)) {
			event.preventDefault();
			commentDraft = undefined;
			modelDialog = false;
			overviewDialog = false;
			shortcutsDialog = false;
			completionDialog = false;
			return;
		}
		if (completionDialog && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {
			event.preventDefault();
			void finish();
			return;
		}
		if (commentDraft && ((event.ctrlKey && event.key.toLowerCase() === 's') || (event.metaKey && event.key === 'Enter'))) {
			event.preventDefault();
			void saveComment();
			return;
		}
		if (commentDraft || modelDialog || overviewDialog || shortcutsDialog || inEditor) return;
		if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'a') {
			event.preventDefault();
			autoAdvance = !autoAdvance;
			return;
		}
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
		if (event.key === ' ' || event.key.toLowerCase() === 'v') {
			const file = currentFileForAction();
			if (!file) return;
			event.preventDefault();
			toggleReviewed(file);
			return;
		}
		if (event.key.toLowerCase() === 'f') {
			event.preventDefault();
			const file = currentFileForAction();
			if (file) commentDraft = { scope: 'file', file, body: '' };
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
			commentDraft = { scope: 'global', body: '' };
			return;
		}
		if (event.key.toLowerCase() === 'm') {
			event.preventDefault();
			commentDraft = lastLineCommentTarget ? { ...lastLineCommentTarget, body: '' } : { scope: 'global', body: '' };
			return;
		}
		if (event.key === '+' || event.key === '=' || event.key === 'ArrowRight') {
			event.preventDefault();
			stepPart(1);
			return;
		}
		if (event.key === '-' || event.key === 'ArrowLeft') {
			event.preventDefault();
			stepPart(-1);
			return;
		}
		if (event.key.toLowerCase() === 'i') {
			event.preventDefault();
			isolatedPart = !isolatedPart;
			return;
		}
		if (event.key.toLowerCase() === 's') {
			event.preventDefault();
			if (hasAgentReview && session?.preReview.overview) overviewDialog = true;
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
		targetCommentId = undefined;
		targetFindingId = finding.id;
		highlightEntry(finding.id);
	}

	function selectComment(comment: UserReviewComment) {
		if (comment.scope === 'global') {
			editComment(comment);
			return;
		}
		if (selectedFile && comment.file) selectedFile = comment.file;
		targetFindingId = undefined;
		targetCommentId = comment.id;
		highlightEntry(comment.id);
	}

	function startLineComment(detail: { file: string; line: number; side: 'additions' | 'deletions'; endLine?: number; endSide?: 'additions' | 'deletions' }) {
		lastLineCommentTarget = { scope: 'line', ...detail };
		commentDraft = { ...lastLineCommentTarget, body: '' };
	}

	function startLineRangeComment(file: string, range: SelectedLineRange | null) {
		if (!range || (range.start === range.end && (range.side ?? 'additions') === (range.endSide ?? range.side ?? 'additions'))) return;
		startLineComment({ file, line: range.start, side: range.side ?? 'additions', endLine: range.end, endSide: range.endSide ?? range.side ?? 'additions' });
	}

	function editComment(comment: UserReviewComment) {
		commentDraft = { id: comment.id, scope: comment.scope, file: comment.file, line: comment.line, side: comment.side, endLine: comment.endLine, endSide: comment.endSide, body: comment.body };
	}

	async function handleCommentImagePaste(file: File) {
		if (!commentDraft) return;
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

	function currentFileForAction() {
		return selectedFile ?? diffViewer?.currentFile() ?? activeFile;
	}

	function renderMarkdown(markdown: string, fallback = 'No description available.') {
		return renderReviewMarkdown(markdown, reviewId ?? '', fallback);
	}

	async function focusCompletionDialog() {
		await tick();
		closingNotesTextarea?.focus();
	}

	function submitComment(event: SubmitEvent) {
		event.preventDefault();
		void saveComment();
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
		<header class="sticky top-0 z-40 col-span-full grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-1.5 border-b border-border bg-bg/95 px-2 backdrop-blur-sm" style="min-height: var(--topbar-height)">
			<Button size="icon-md" title="Toggle files sidebar (B)" aria-label="Toggle files sidebar" onclick={() => (leftOpen = !leftOpen)}>{#if leftOpen}<PanelLeftClose size={15} />{:else}<PanelLeftOpen size={15} />{/if}</Button>
			<h1 class="min-w-0 truncate text-[0.95rem] font-semibold" title={session.cwd}>{repositoryLabel(session.cwd)}</h1>
			<div class="flex min-w-0 items-center justify-end gap-1">
				<div class="hidden items-center gap-0.5 md:flex" role="group" aria-label="Diff view options">
					<Button size="md" class={diffStyle === 'split' ? 'view-toggle-active' : 'view-toggle-inactive'} title="Toggle split view" aria-label="Toggle split view" aria-pressed={diffStyle === 'split'} onclick={() => (diffStyle = diffStyle === 'split' ? 'unified' : 'split')}><SquareSplitHorizontal size={15} /><span class="hidden xl:inline">Split</span></Button>
					<Button size="md" class={wrap ? 'view-toggle-active' : 'view-toggle-inactive'} title="Toggle line wrapping" aria-label="Toggle line wrapping" aria-pressed={wrap} onclick={() => (wrap = !wrap)}><TextWrap size={15} /><span class="hidden xl:inline">Wrap</span></Button>
				</div>
				<Button size="md" title="Copy feedback" onclick={copyFeedback}><Clipboard size={15} /><span class="hidden sm:inline">{copied ? 'Copied' : copyFailed ? 'Copy failed' : 'Copy feedback'}</span></Button>
				<Button size="md" class="feedback-progress {reviewScopeComplete ? 'review-complete' : ''} {celebrateReviewComplete ? 'review-progress-complete' : ''}" title={`Insert feedback (${reviewProgress}% reviewed, W or Cmd/Ctrl+Enter)`} onclick={() => finish()}><CircularCheckProgress progress={reviewProgress} size={18} iconSize={13} /><span class="hidden sm:inline">Insert feedback</span></Button>
			</div>
			<Button size="icon-md" title="Toggle comments sidebar (Shift+B)" aria-label="Toggle comments sidebar" onclick={() => (rightOpen = !rightOpen)}>{#if rightOpen}<PanelRightClose size={15} />{:else}<PanelRightOpen size={15} />{/if}</Button>
		</header>

		{#if leftOpen}
		<aside class="grid min-w-0 content-start gap-0 overflow-x-hidden border-b border-border bg-bg p-0 lg:sticky lg:top-[var(--topbar-height)] lg:h-[calc(100vh-var(--topbar-height))] lg:overflow-y-auto lg:border-b-0 lg:border-r">
			{#if connectionWarning}<section class="border border-warning/40 bg-warning-soft p-[0.3125rem] text-sm text-warning">{connectionWarning}</section>{/if}
			<section class="grid min-w-0 gap-1 overflow-hidden border border-border bg-surface p-[0.3125rem]">
				<div class="flex items-center justify-between gap-1.5"><h2 class="text-[0.85rem] font-semibold">Diff source</h2><span class="bg-code px-[0.1875rem] py-[0.0625rem] text-[0.66rem] font-semibold uppercase text-muted">{session.diffMode ?? 'diff'}</span></div>
				<label class="grid min-w-0 gap-0.5 text-sm text-muted">Worktree
					<select class="w-full min-w-0" bind:value={worktreeCwd} disabled={diffSourceLoading || session.preReview.status === 'running'} onchange={handleWorktreeChange}>
						{#if worktreeCwd && !worktrees.some((worktree) => worktree.path === worktreeCwd)}<option value={worktreeCwd}>{worktreeCwd}</option>{/if}
						{#each worktrees as worktree (worktree.path)}<option value={worktree.path}>{worktreeLabel(worktree)}{worktree.current ? ' (current)' : ''}</option>{/each}
					</select>
				</label>
				<label class="grid min-w-0 gap-0.5 text-sm text-muted">Review
					<select class="w-full min-w-0" bind:value={diffSourceMode} disabled={diffSourceLoading || session.preReview.status === 'running'} onchange={handleDiffModeChange}>
						<option value="unstaged">Unstaged changes</option>
						<option value="staged">Staged changes</option>
						<option value="uncommitted">Uncommitted changes</option>
						<option value="commit">Last commit</option>
						<option value="branch">Branch vs ref</option>
					</select>
				</label>
				{#if diffSourceMode === 'branch'}<label class="grid min-w-0 gap-0.5 text-sm text-muted">Base ref <select class="w-full min-w-0" bind:value={diffSourceBase} disabled={diffSourceLoading || session.preReview.status === 'running'} onchange={handleBranchRefChange}>{#if diffSourceBase && !branchRefs.includes(diffSourceBase)}<option value={diffSourceBase}>{diffSourceBase}</option>{/if}{#each branchRefs as ref (ref)}<option value={ref}>{ref}</option>{/each}{#if branchRefs.length === 0 && !diffSourceBase}<option value="origin/main">origin/main</option>{/if}</select></label>{/if}
				{#if diffSourceLoading}<p class="text-sm text-muted">Loading source…</p>{/if}
				{#if diffSourceError}<p class="text-sm text-danger">{diffSourceError}</p>{/if}
			</section>
			<section class="grid min-w-0 gap-1 overflow-hidden border border-border bg-surface p-[0.3125rem]">
				<div class="flex items-center justify-between gap-1.5"><h2 class="text-[0.85rem] font-semibold">Files</h2><span class="bg-code px-[0.1875rem] py-[0.0625rem] text-[0.66rem] font-semibold uppercase text-muted">{reviewedFileCount}/{visibleFiles.length}</span></div>
				<FileTreeViewer files={visibleFiles} chunks={visibleChunks} {selectedFile} {activeFile} reviewed={reviewedFiles} progress={fileReviewProgress} progressUnits={fileReviewUnits} onSelect={(file) => (selectedFile = file)} onToggleReviewed={toggleReviewed} onSetReviewed={setFilesReviewed} />
			</section>
		</aside>
		{/if}

		<main class="min-w-0 max-w-full p-0" style="scroll-padding-top: calc(var(--topbar-height) + 1rem)">
			{#key currentPartKey}
				<div class="part-review-content {animatePartTransition ? 'part-slide-in' : ''}" style={`--part-slide-x: ${partTransitionDirection * 2.5}rem;`} onanimationend={resetPartTransition}>
					{#if currentPart?.brief?.trim()}
						<section class="grid min-w-0 gap-0.5 border border-border bg-surface p-[0.3125rem]">
							<span class="text-[0.66rem] font-semibold uppercase text-muted">{currentPart.title}</span>
							<div class="rendered-markdown text-sm">{@html renderMarkdown(currentPart.brief)}</div>
						</section>
					{/if}
					{#snippet diffFooter()}
						{#if hasNextPart}
							<section class="grid justify-items-center gap-1 px-2 py-2 text-sm text-muted">
								{#if !autoAdvance}
									<button class="border-accent px-2 py-1.5 text-fg disabled:border-border disabled:text-muted" title={`Continue to next part: ${nextPart?.title ?? ''}`} disabled={!currentPartComplete} onclick={() => stepPart(1)}><ChevronRight size={15} />Continue to next part<span class="hidden max-w-[28rem] truncate sm:inline">: {nextPart?.title}</span></button>
								{/if}
								<label class="flex items-center gap-1" title="Toggle Auto-advance (Ctrl+Shift+A)"><input type="checkbox" bind:checked={autoAdvance} /> Auto-advance</label>
							</section>
						{/if}
					{/snippet}
					<DiffViewer bind:this={diffViewer} {session} {findings} {hunks} chunks={visibleChunks} {visibleHunkIds} reviewedHunks={reviewed} {cueEnabled} {singlePartInView} reviewed={reviewedFiles} progress={fileReviewProgress} {selectedFile} {targetFindingId} {targetCommentId} {diffStyle} {wrap} footer={diffFooter} onActiveChange={(detail) => { activeFile = detail.file; }} onComment={startLineComment} onCommentRange={startLineRangeComment} onFileComment={(file) => (commentDraft = { scope: 'file', file, body: '' })} onToggleReviewed={toggleReviewed} onEditComment={editComment} onDeleteComment={removeComment} />
				</div>
			{/key}
		</main>

		{#if rightOpen}
			<aside class="flex min-w-0 flex-col gap-0 overflow-x-hidden border-t border-border bg-bg p-0 lg:sticky lg:top-[var(--topbar-height)] lg:h-[calc(100vh-var(--topbar-height))] lg:overflow-y-auto lg:border-t-0 lg:border-l">
				<section class="grid min-w-0 gap-1 overflow-hidden border border-border bg-surface p-[0.3125rem]">
					<div class="flex items-center justify-between gap-1.5">
						<button class="min-w-0 flex-1 justify-start border-0 bg-transparent p-0 hover:bg-transparent" onclick={() => (aiOpen = !aiOpen)}><h2 class="flex items-center gap-[0.1875rem] text-[0.85rem] font-semibold">{#if aiOpen}<ChevronDown size={15} />{:else}<ChevronRight size={15} />{/if}AI review</h2></button>
						{#if hasAgentReview || session.preReview.status === 'running'}
							<span class="inline-flex items-center gap-[0.1875rem] bg-code px-[0.1875rem] py-[0.0625rem] text-[0.66rem] font-semibold uppercase text-muted">{#if session.preReview.status === 'running'}<LoaderCircle class="animate-spin" size={11} />{/if}{hasAgentReview ? 'done' : 'running'}</span>
						{:else}
							<button class="px-1 py-[0.0625rem] text-xs" title="Run AI review" disabled={!agentModelKey} onclick={runAgentReview}><Play size={13} />Run</button>
						{/if}
					</div>
					{#if aiOpen}
						<div class="grid grid-cols-[minmax(0,1fr)_auto] gap-1">
							<button title="AI review settings" onclick={() => (modelDialog = true)}><Settings size={15} />Model: {selectedAgentModel?.name ?? 'none'}</button>
							{#if hasAgentReview && session.preReview.overview}<button class="w-9 px-0" title="Show Overview (S)" aria-label="Show Overview" onclick={() => (overviewDialog = true)}><BookOpenText size={15} /></button>{/if}
						</div>
						{#if !hasAgentReview}<p class="text-sm text-muted">{session.preReview.status === 'idle' ? 'Run agent review from model settings.' : session.preReview.status === 'running' ? 'Reviewing changes…' : 'Agent review failed.'}</p>{/if}
						{#if hasAgentReview && session.preReview.assessment}<div class="rendered-markdown border border-border bg-surface-2 p-1 text-sm text-muted">{@html renderMarkdown(session.preReview.assessment)}</div>{/if}
						{#if session.agentReview.models.length === 0}<p class="text-sm text-muted">No authenticated models available.</p>{/if}
						{#if session.preReview.error}<p class="text-sm text-muted">{session.preReview.error}</p>{/if}
					{/if}
				</section>
				<section class="grid min-w-0 gap-1 overflow-hidden border border-border bg-surface p-[0.3125rem]">
					<div class="flex items-center justify-between gap-1.5">
						<button class="min-w-0 flex-1 justify-start border-0 bg-transparent p-0 hover:bg-transparent" onclick={() => (reviewModeOpen = !reviewModeOpen)}><h2 class="flex items-center gap-[0.1875rem] text-[0.85rem] font-semibold">{#if reviewModeOpen}<ChevronDown size={15} />{:else}<ChevronRight size={15} />{/if}Review strategy</h2></button>
					</div>
					{#if multiPart}
						<div class="flex items-center gap-1">
							<button class="h-7 w-7 flex-none p-0" title="Previous part (−/←)" aria-label="Previous part" disabled={safePartIndex === 0} onclick={() => stepPart(-1)}><ChevronLeft size={15} /></button>
							<div class="grid min-w-0 flex-1 gap-[0.0625rem] text-center">
								<span class="truncate text-sm font-medium" title={currentPart?.title}>{currentPart?.title ?? ''}</span>
								<span class="text-[0.66rem] uppercase text-muted">Part {safePartIndex + 1} of {orderedParts.length}</span>
							</div>
							<button class="h-7 w-7 flex-none p-0" title="Next part (+/→)" aria-label="Next part" disabled={safePartIndex >= orderedParts.length - 1} onclick={() => stepPart(1)}><ChevronRight size={15} /></button>
						</div>
					{/if}
					{#if reviewModeOpen}
						<label class="grid gap-0.5 text-sm text-muted">Strategy
							<select class="w-full" bind:value={strategy} onchange={() => { resetPartTransition(); currentPartIndex = 0; selectedFile = undefined; }}>
								{#if strategies.includes('flat')}<option value="flat">Flat</option>{/if}
								{#if strategies.includes('smart')}<option value="smart">Smart</option>{/if}
								{#if strategies.includes('commits')}<option value="commits">Commits</option>{/if}
							</select>
						</label>
						<label class="grid gap-0.5 text-sm text-muted">Sort order
							<select class="w-full" bind:value={sortOrder}>
								<option value="tree">Tree</option>
								{#if canCausality}<option value="causality">Causality</option>{/if}
							</select>
						</label>
						{#if multiPart}<label class="flex items-center gap-1 text-sm text-muted" title="Isolate current part (I)"><input type="checkbox" bind:checked={isolatedPart} /> Isolate current part</label>{/if}
						<label class="flex items-center gap-1 text-sm text-muted" title="Show Cue notes"><input type="checkbox" bind:checked={cueEnabled} disabled={!canCausality && !session.preReview.smart} /> Show Cue notes</label>
					{/if}
				</section>
				<section class="grid min-w-0 gap-1 overflow-hidden border border-border bg-surface p-[0.3125rem]">
					<div class="flex items-center justify-between gap-1.5">
						<button class="min-w-0 flex-1 justify-start border-0 bg-transparent p-0 hover:bg-transparent" onclick={() => (agentCommentsOpen = !agentCommentsOpen)}><h2 class="flex items-center gap-[0.1875rem] text-[0.85rem] font-semibold">{#if agentCommentsOpen}<ChevronDown size={15} />{:else}<ChevronRight size={15} />{/if}Agent comments</h2></button>
						<span class="bg-code px-[0.1875rem] py-[0.0625rem] text-[0.66rem] font-semibold uppercase text-muted">{findings.length}</span>
					</div>
					{#if agentCommentsOpen}
						{#if findings.length === 0}<p class="text-sm text-muted">No agent comments yet.</p>{:else}<div class="grid gap-1">{#each findings as finding (finding.id)}<div class="grid gap-[0.1875rem] p-1 transition-colors {highlightedEntryId === finding.id ? 'bg-accent-soft ring-1 ring-accent' : 'bg-surface-2 hover:bg-surface-hover'}"><div class="flex items-center gap-[0.1875rem]"><button class="min-w-0 flex-1 justify-start border-0 bg-transparent p-0 text-left hover:bg-transparent" onclick={() => selectFinding(finding)}><span class="flex min-w-0 items-center gap-1"><span class="{severityClass(finding)} px-[0.1875rem] py-[0.0625rem] text-[0.66rem] font-semibold uppercase">{finding.severity}</span><small class="min-w-0 truncate text-muted">{finding.file ?? 'Overall'}{finding.line ? `:${finding.line}` : ''}</small></span></button><button class="flex-none border-0 bg-transparent px-0.5 text-muted hover:bg-danger-soft hover:text-danger" title="Remove" aria-label="Remove finding" onclick={() => removeFinding(finding)}><Trash2 size={14} /></button></div><button class="block w-full justify-start border-0 bg-transparent p-0 text-left hover:bg-transparent" onclick={() => selectFinding(finding)}><div class="rendered-markdown text-sm">{@html renderMarkdown(finding.title)}</div></button></div>{/each}</div>{/if}
					{/if}
				</section>
				<section class="grid min-w-0 gap-1 overflow-hidden border border-border bg-surface p-[0.3125rem]">
					<div class="flex items-center justify-between gap-1.5">
						<button class="min-w-0 flex-1 justify-start border-0 bg-transparent p-0 hover:bg-transparent" onclick={() => (userCommentsOpen = !userCommentsOpen)}><h2 class="flex items-center gap-[0.1875rem] text-[0.85rem] font-semibold">{#if userCommentsOpen}<ChevronDown size={15} />{:else}<ChevronRight size={15} />{/if}User comments</h2></button>
						<div class="flex flex-none items-center gap-1"><button class="px-1 py-[0.0625rem] text-xs" title="Comment overall (O)" onclick={() => (commentDraft = { scope: 'global', body: '' })}><MessageSquarePlus size={13} />comment</button><span class="bg-code px-[0.1875rem] py-[0.0625rem] text-[0.66rem] font-semibold uppercase text-muted">{userComments.length}</span></div>
					</div>
					{#if userCommentsOpen}
						{#if userComments.length === 0}<p class="text-sm text-muted">Click line numbers, add file comments, or comment overall.</p>{:else}<div class="grid gap-1">{#each userComments as comment (comment.id)}<div class="grid gap-[0.1875rem] p-1 transition-colors {highlightedEntryId === comment.id ? 'bg-accent-soft ring-1 ring-accent' : 'bg-surface-2 hover:bg-surface-hover'}"><div class="flex items-center gap-[0.1875rem]"><button class="min-w-0 flex-1 justify-start border-0 bg-transparent p-0 text-left hover:bg-transparent" onclick={() => selectComment(comment)}><span class="flex min-w-0 items-center gap-1"><small class="min-w-0 truncate text-muted">{comment.scope === 'global' ? 'Overall' : comment.scope === 'file' ? comment.file : `${comment.file}:${comment.line}`}</small></span></button><button class="flex-none border-0 bg-transparent px-0.5 text-muted hover:bg-surface-hover hover:text-fg" title="Edit" aria-label="Edit comment" onclick={() => editComment(comment)}><Edit3 size={14} /></button><button class="flex-none border-0 bg-transparent px-0.5 text-muted hover:bg-danger-soft hover:text-danger" title="Remove" aria-label="Remove comment" onclick={() => removeComment(comment)}><Trash2 size={14} /></button></div><button class="block w-full justify-start border-0 bg-transparent p-0 text-left hover:bg-transparent" onclick={() => selectComment(comment)}><div class="rendered-markdown text-sm">{@html renderMarkdown(comment.body)}</div></button></div>{/each}</div>{/if}
					{/if}
				</section>
				<div class="mt-auto flex justify-end p-[0.3125rem]"><Button size="icon-md" class="text-muted hover:text-fg" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onclick={() => (shortcutsDialog = true)}><HelpCircle size={15} /></Button></div>
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
			<label class="flex items-center gap-1 text-sm"><input type="checkbox" bind:checked={autorunEnabled} /> Autorun</label>
			<div class="flex justify-end gap-1 pt-0.5"><button title="Close dialog (Esc)" type="button" onclick={() => { persistReviewSettings(); modelDialog = false; }}>Close</button><button class="border-accent bg-accent text-accent-fg hover:bg-accent hover:opacity-90" title="Run AI review" type="button" disabled={!agentModelKey || session?.preReview.status === 'running'} onclick={runAgentReview}><Play size={15} />Run</button></div>
		</div>
	</div>
{/if}

{#if overviewDialog}
	<div role="presentation" class="modal-backdrop fixed inset-0 z-40 grid place-items-center p-2" onclick={(event) => backdropClick(event, () => (overviewDialog = false))}>
		<div role="dialog" aria-modal="true" aria-labelledby="overview-dialog-title" class="grid max-h-[min(70vh,42rem)] w-[min(40rem,calc(100vw-2rem))] gap-1.5 overflow-auto border border-border bg-surface p-2.5 shadow-[0_16px_48px_var(--shadow)]">
			<h2 id="overview-dialog-title" class="text-[0.95rem] font-semibold">Overview</h2>
			<div class="markdown-body text-sm">{@html renderMarkdown(session?.preReview.overview ?? '')}</div>
			<div class="flex justify-end gap-1 pt-0.5"><button type="button" onclick={() => (overviewDialog = false)}>Close</button></div>
		</div>
	</div>
{/if}

{#if completionDialog}
	<div role="presentation" class="modal-backdrop fixed inset-0 z-40 grid place-items-center p-2" onclick={(event) => backdropClick(event, () => (completionDialog = false))}>
		<div class="confetti-layer" aria-hidden="true">{#each confettiPieces as piece (piece.index)}<i style={piece.style}></i>{/each}</div>
		<div role="dialog" aria-modal="true" aria-labelledby="completion-dialog-title" class="relative z-10 grid w-[min(34rem,calc(100vw-2rem))] gap-1.5 border border-accent/50 bg-surface p-2.5 shadow-[0_16px_48px_var(--shadow)]">
			<h2 id="completion-dialog-title" class="text-[1rem] font-semibold">Review complete</h2>
			<p class="text-sm text-muted">Everything in this review scope is marked reviewed. Add optional closing notes before inserting feedback.</p>
			<label class="grid gap-[0.1875rem] text-sm text-muted">Closing notes
				<textarea bind:this={closingNotesTextarea} bind:value={closingNotes} rows="5" placeholder="Optional notes to append below comments…"></textarea>
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
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">Space / V</kbd><dd class="text-sm text-muted">Toggle current file reviewed</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">F</kbd><dd class="text-sm text-muted">Add file comment</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">Opt+↓ / ↑</kbd><dd class="text-sm text-muted">Next / previous hunk</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">O</kbd><dd class="text-sm text-muted">Comment overall</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">S</kbd><dd class="text-sm text-muted">Show Overview</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">I</kbd><dd class="text-sm text-muted">Isolate current part</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">+ / −</kbd><dd class="text-sm text-muted">Next / previous part</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">Ctrl+Shift+A</kbd><dd class="text-sm text-muted">Toggle Auto-advance</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">B</kbd><dd class="text-sm text-muted">Toggle files sidebar</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">Shift+B</kbd><dd class="text-sm text-muted">Toggle comments sidebar</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">W</kbd><dd class="text-sm text-muted">Insert feedback</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">Cmd/Ctrl+C</kbd><dd class="text-sm text-muted">Copy feedback</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">Cmd/Ctrl+Enter</kbd><dd class="text-sm text-muted">Insert feedback</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">?</kbd><dd class="text-sm text-muted">Show keyboard shortcuts</dd></div>
				<dt class="mt-3 border-t border-border pt-1.5 text-xs font-semibold uppercase text-muted">Editing comment</dt>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">Ctrl+S</kbd><dd class="text-sm text-muted">Save comment</dd></div>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">Cmd+Enter</kbd><dd class="text-sm text-muted">Save comment</dd></div>
				<dt class="mt-3 border-t border-border pt-1.5 text-xs font-semibold uppercase text-muted">Dialogs</dt>
				<div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-1.5"><kbd class="justify-self-start border border-border-strong bg-code px-[0.1875rem] py-[0.0625rem] font-mono text-xs font-semibold">Esc</kbd><dd class="text-sm text-muted">Close dialog</dd></div>
			</dl>
			<div class="flex justify-end gap-1 pt-0.5"><button type="button" onclick={() => (shortcutsDialog = false)}>Close</button></div>
		</div>
	</div>
{/if}

{#if commentDraft}
	<div role="presentation" class="modal-backdrop fixed inset-0 z-40 grid place-items-center p-2" onclick={(event) => backdropClick(event, () => (commentDraft = undefined))}>
		<div role="dialog" aria-modal="true" aria-labelledby="comment-dialog-title">
			<form class="grid w-[min(36rem,calc(100vw-2rem))] gap-1.5 border border-border bg-surface p-2.5 shadow-[0_16px_48px_var(--shadow)]" onsubmit={submitComment}>
				<h2 id="comment-dialog-title" class="text-[0.95rem] font-semibold">{commentDraft.id ? 'Edit comment' : 'Add comment'}</h2>
				<p class="text-xs text-muted">{commentDraft.scope === 'global' ? 'Overall review' : commentDraft.scope === 'file' ? commentDraft.file : `${commentDraft.file}:${commentDraft.line}${commentDraft.endLine && commentDraft.endLine !== commentDraft.line ? `-${commentDraft.endLine}` : ''} · ${commentDraft.side}`}</p>
				<MarkdownEditor bind:this={mdEditor} bind:value={commentDraft.body} onImagePaste={handleCommentImagePaste} />
				<div class="flex justify-end gap-1 pt-0.5"><button title="Close dialog (Esc)" type="button" onclick={() => (commentDraft = undefined)}>Cancel</button><button class="border-accent bg-accent text-accent-fg hover:bg-accent hover:opacity-90" title="Save comment (Ctrl+S or Cmd+Enter)" type="submit">Save</button></div>
			</form>
		</div>
	</div>
{/if}

<style>
	.part-review-content {
		min-width: 0;
	}

	.part-slide-in {
		animation: part-slide-fade-in 180ms ease-out;
	}

	@keyframes part-slide-fade-in {
		from {
			opacity: 0;
			transform: translateX(var(--part-slide-x));
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.part-slide-in {
			animation: none;
		}
	}
</style>
