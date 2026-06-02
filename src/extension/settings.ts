import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export type ReviewUiSettings = Partial<{
	modelKey: string;
	thinkingLevel: string;
	suggestComments: boolean;
	autoReview: boolean;
	isolatedLevel: boolean;
	diffStyle: 'split' | 'unified';
	wrap: boolean;
}>;

const settingsPath = join(getAgentDir(), 'extensions', 'pi-pair-review', 'settings.json');
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
	if (typeof value.autoReview === 'boolean') next.autoReview = value.autoReview;
	if (typeof value.isolatedLevel === 'boolean') next.isolatedLevel = value.isolatedLevel;
	if (value.diffStyle === 'split' || value.diffStyle === 'unified') next.diffStyle = value.diffStyle;
	if (typeof value.wrap === 'boolean') next.wrap = value.wrap;
	return next;
}
