import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export interface ReviewAutorunSettings {
	enabled: boolean;
	unconditional: boolean;
	minLines?: number;
	minFiles?: number;
	onUncommitted?: boolean;
	onSingleCommit?: boolean;
}

export type ReviewUiSettings = Partial<{
	modelKey: string;
	thinkingLevel: string;
	suggestComments: boolean;
	strategy: 'flat' | 'smart' | 'commits';
	sortOrder: 'tree' | 'causality';
	cueEnabled: boolean;
	autorun: ReviewAutorunSettings;
	isolatedPart: boolean;
	autoAdvance: boolean;
	diffStyle: 'split' | 'unified';
	wrap: boolean;
}>;

const settingsPath = join(getAgentDir(), 'extensions', 'story-review', 'settings.json');
let writeQueue: Promise<void> = Promise.resolve();

export async function readReviewUiSettings(): Promise<ReviewUiSettings> {
	try {
		const parsed = JSON.parse(await readFile(settingsPath, 'utf8')) as ReviewUiSettings;
		return sanitizeSettings(parsed);
	} catch {
		return {};
	}
}

export async function updateReviewUiSettings(patch: ReviewUiSettings): Promise<ReviewUiSettings> {
	const next = sanitizeSettings({ ...(await readReviewUiSettings()), ...patch });
	writeQueue = writeQueue.then(async () => {
		await mkdir(dirname(settingsPath), { recursive: true });
		const tmp = `${settingsPath}.${randomUUID()}.tmp`;
		await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
		await rename(tmp, settingsPath);
	});
	await writeQueue;
	return next;
}

function sanitizeSettings(value: ReviewUiSettings): ReviewUiSettings {
	const next: ReviewUiSettings = {};
	if (typeof value.modelKey === 'string') next.modelKey = value.modelKey;
	if (typeof value.thinkingLevel === 'string') next.thinkingLevel = value.thinkingLevel;
	if (typeof value.suggestComments === 'boolean') next.suggestComments = value.suggestComments;
	if (value.strategy === 'flat' || value.strategy === 'smart' || value.strategy === 'commits') next.strategy = value.strategy;
	if (value.sortOrder === 'tree' || value.sortOrder === 'causality') next.sortOrder = value.sortOrder;
	if (typeof value.cueEnabled === 'boolean') next.cueEnabled = value.cueEnabled;
	const autorun = sanitizeAutorun(value.autorun);
	if (autorun) next.autorun = autorun;
	if (typeof value.isolatedPart === 'boolean') next.isolatedPart = value.isolatedPart;
	if (typeof value.autoAdvance === 'boolean') next.autoAdvance = value.autoAdvance;
	if (value.diffStyle === 'split' || value.diffStyle === 'unified') next.diffStyle = value.diffStyle;
	if (typeof value.wrap === 'boolean') next.wrap = value.wrap;
	return next;
}

function sanitizeAutorun(value: ReviewAutorunSettings | undefined): ReviewAutorunSettings | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const next: ReviewAutorunSettings = {
		enabled: value.enabled === true,
		unconditional: value.unconditional === true
	};
	if (typeof value.minLines === 'number' && Number.isFinite(value.minLines)) next.minLines = value.minLines;
	if (typeof value.minFiles === 'number' && Number.isFinite(value.minFiles)) next.minFiles = value.minFiles;
	if (typeof value.onUncommitted === 'boolean') next.onUncommitted = value.onUncommitted;
	if (typeof value.onSingleCommit === 'boolean') next.onSingleCommit = value.onSingleCommit;
	return next;
}
