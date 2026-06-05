import { marked } from 'marked';

const REMOVED_ELEMENT_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select']);
const ALLOWED_GLOBAL_ATTRIBUTES = new Set(['title']);
const ALLOWED_ATTRIBUTES = new Map<string, Set<string>>([
	['a', new Set(['href', 'title'])],
	['img', new Set(['src', 'alt', 'title'])],
	['code', new Set(['class'])]
]);
const ALLOWED_TAGS = new Set([
	'a',
	'blockquote',
	'br',
	'code',
	'del',
	'div',
	'em',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'hr',
	'img',
	'li',
	'ol',
	'p',
	'pre',
	'span',
	'strong',
	'table',
	'tbody',
	'td',
	'th',
	'thead',
	'tr',
	'ul'
]);

export function renderReviewMarkdown(markdown: string, reviewId: string, fallback = ''): string {
	const source = markdown.trim() || fallback;
	return sanitizeRenderedHtml(marked.parse(renderableMarkdown(source, reviewId), { async: false, gfm: true, breaks: true }) as string);
}

function renderableMarkdown(markdown: string, reviewId: string) {
	return markdown.trim().replace(/^[ \t]*(\/[^\n\r\s)]+\.(?:png|jpe?g|gif|webp))[ \t]*$/gim, (_match, path: string) => `![pasted image](/api/reviews/${reviewId}/attachments?path=${encodeURIComponent(path)})`);
}

function sanitizeRenderedHtml(html: string) {
	const template = document.createElement('template');
	template.innerHTML = html;
	sanitizeChildren(template.content);
	return template.innerHTML;
}

function sanitizeChildren(parent: ParentNode) {
	for (const node of [...parent.childNodes]) {
		if (node.nodeType !== Node.ELEMENT_NODE) continue;
		const element = node as HTMLElement;
		const tag = element.tagName.toLowerCase();

		if (REMOVED_ELEMENT_TAGS.has(tag)) {
			element.remove();
			continue;
		}

		if (!ALLOWED_TAGS.has(tag)) {
			element.replaceWith(...element.childNodes);
			sanitizeChildren(parent);
			continue;
		}

		sanitizeAttributes(element, tag);
		sanitizeChildren(element);
	}
}

function sanitizeAttributes(element: HTMLElement, tag: string) {
	const allowed = ALLOWED_ATTRIBUTES.get(tag) ?? new Set<string>();
	for (const attribute of [...element.attributes]) {
		const name = attribute.name.toLowerCase();
		if (name.startsWith('on') || name === 'srcdoc' || name === 'style') {
			element.removeAttribute(attribute.name);
			continue;
		}
		if (!ALLOWED_GLOBAL_ATTRIBUTES.has(name) && !allowed.has(name)) element.removeAttribute(attribute.name);
	}

	if (tag === 'a') sanitizeLink(element as HTMLAnchorElement);
	if (tag === 'img') sanitizeImage(element as HTMLImageElement);
}

function sanitizeLink(link: HTMLAnchorElement) {
	const href = link.getAttribute('href');
	if (!href || !isSafeUrl(href)) {
		link.removeAttribute('href');
		return;
	}
	link.rel = 'nofollow noreferrer noopener';
}

function sanitizeImage(image: HTMLImageElement) {
	const src = image.getAttribute('src');
	if (!src || !isSafeUrl(src)) image.remove();
}

function isSafeUrl(value: string) {
	const trimmed = value.trim().replace(/[\u0000-\u001f\u007f\s]+/g, '');
	if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('#')) return true;
	try {
		const url = new URL(trimmed, window.location.origin);
		return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
	} catch {
		return false;
	}
}
