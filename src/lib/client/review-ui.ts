import type { ReviewChunk, ReviewFileSummary, ReviewPart, ReviewSessionSnapshot, ReviewSortOrder, ReviewStrategy } from '$lib/shared/review';

export interface ReviewPartition {
	parts: ReviewPart[];
	chunks: ReviewChunk[];
}

export function buildPartition(strategy: ReviewStrategy, snapshot: ReviewSessionSnapshot): ReviewPartition {
	if (strategy === 'smart') {
		const smart = snapshot.preReview.smart;
		return smart ? removeEmptyParts({ parts: [...smart.parts], chunks: [...smart.chunks] }) : { parts: [], chunks: [] };
	}
	if (strategy === 'commits') {
		const commits = snapshot.commits ?? [];
		const parts: ReviewPart[] = commits.map((commit) => ({
			id: `part-commit-${commit.sha}`,
			kind: 'commit',
			title: commit.subject,
			brief: commit.body,
			order: commit.order,
			commitSha: commit.sha
		}));
		const chunks: ReviewChunk[] = commits.flatMap((commit, index) => chunksFromHunkIds(commit.hunkIds, snapshot, parts[index]!.id));
		return removeEmptyParts({ parts, chunks });
	}
	const part: ReviewPart = { id: 'part-flat', kind: 'flat', title: 'All changes', order: 0 };
	const chunks = chunksFromHunkIds(snapshot.hunks.map((hunk) => hunk.id), snapshot, part.id);
	return { parts: [part], chunks };
}

function removeEmptyParts(partition: ReviewPartition): ReviewPartition {
	const partIdsWithChunks = new Set(partition.chunks.map((chunk) => chunk.partId));
	return { parts: partition.parts.filter((part) => partIdsWithChunks.has(part.id)), chunks: partition.chunks };
}

function chunksFromHunkIds(hunkIds: string[], snapshot: ReviewSessionSnapshot, partId: string): ReviewChunk[] {
	const byFile = new Map<string, string[]>();
	const fileForHunk = new Map(snapshot.hunks.map((hunk) => [hunk.id, hunk.file] as const));
	for (const hunkId of hunkIds) {
		const file = fileForHunk.get(hunkId);
		if (!file) continue;
		const existing = byFile.get(file);
		if (existing) existing.push(hunkId);
		else byFile.set(file, [hunkId]);
	}
	return [...byFile.entries()].map(([file, ids]) => ({ id: `${partId}:${file}`, partId, file, hunkIds: ids }));
}

export function orderChunks(chunks: ReviewChunk[], sort: ReviewSortOrder, causalityOrder?: string[]): ReviewChunk[] {
	if (sort === 'causality' && causalityOrder && causalityOrder.length > 0) {
		const rankFor = (chunk: ReviewChunk) => {
			let rank = Number.POSITIVE_INFINITY;
			for (const hunkId of chunk.hunkIds) {
				const index = causalityOrder.indexOf(hunkId);
				if (index >= 0 && index < rank) rank = index;
			}
			return rank;
		};
		return [...chunks].sort((left, right) => {
			const leftRank = rankFor(left);
			const rightRank = rankFor(right);
			if (leftRank !== rightRank) return leftRank - rightRank;
			return compareTreeOrder(left.file, right.file);
		});
	}
	return [...chunks].sort((left, right) => compareTreeOrder(left.file, right.file));
}

export function chunksForPart(chunks: ReviewChunk[], partId: string): ReviewChunk[] {
	return chunks.filter((chunk) => chunk.partId === partId);
}

export function partsInOrder(parts: ReviewPart[]): ReviewPart[] {
	return [...parts].sort((left, right) => left.order - right.order);
}

export function availableStrategies(snapshot: ReviewSessionSnapshot): ReviewStrategy[] {
	const strategies: ReviewStrategy[] = ['flat'];
	if (snapshot.preReview.smart) strategies.push('smart');
	if (snapshot.commits?.length) strategies.push('commits');
	return strategies;
}

export function causalityAvailable(snapshot: ReviewSessionSnapshot): boolean {
	return !!snapshot.preReview.causalityOrder?.length;
}

export function sortFilesForTree(files: ReviewFileSummary[]) {
	return [...files].sort((left, right) => compareTreeOrder(left.path, right.path));
}

export function compareTreeOrder(leftPath: string, rightPath: string) {
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

