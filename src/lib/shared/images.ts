const REVIEWABLE_IMAGE_EXTENSIONS = new Set(['.avif', '.gif', '.jpg', '.jpeg', '.png', '.svg', '.webp']);

export function isReviewableImagePath(path: string | undefined): path is string {
	if (!path) return false;
	return REVIEWABLE_IMAGE_EXTENSIONS.has(imageExtension(path));
}

export function imageContentType(path: string): string | undefined {
	const extension = imageExtension(path);
	if (extension === '.avif') return 'image/avif';
	if (extension === '.gif') return 'image/gif';
	if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
	if (extension === '.png') return 'image/png';
	if (extension === '.svg') return 'image/svg+xml';
	if (extension === '.webp') return 'image/webp';
	return undefined;
}

function imageExtension(path: string) {
	const clean = path.split(/[?#]/, 1)[0] ?? path;
	const index = clean.lastIndexOf('.');
	return index >= 0 ? clean.slice(index).toLowerCase() : '';
}
