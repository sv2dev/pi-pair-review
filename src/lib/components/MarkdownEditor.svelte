<script lang="ts">
	import { onMount } from 'svelte';
	import { EditorState } from '@codemirror/state';
	import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
	import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
	import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
	import { markdown } from '@codemirror/lang-markdown';
	import { tags as t } from '@lezer/highlight';

	let { value = $bindable(''), placeholder = 'Write a markdown comment… (paste an image to attach a temp file)', onImagePaste }: {
		value?: string;
		placeholder?: string;
		onImagePaste?: (file: File) => void;
	} = $props();

	let host: HTMLDivElement;
	let view = $state<EditorView | undefined>();
	let syncing = false;

	$effect(() => {
		if (view && !syncing && value !== view.state.doc.toString()) setDoc(value);
	});

	/** Insert text at the current selection (used for pasted image paths). */
	export function insertText(text: string) {
		if (!view) return;
		const { from, to } = view.state.selection.main;
		view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
		view.focus();
	}

	export function focus() {
		view?.focus();
	}

	function setDoc(next: string) {
		view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
	}

	const highlight = HighlightStyle.define([
		{ tag: t.heading, color: 'var(--cm-heading)', fontWeight: '600' },
		{ tag: t.strong, fontWeight: '700' },
		{ tag: t.emphasis, fontStyle: 'italic' },
		{ tag: t.strikethrough, textDecoration: 'line-through' },
		{ tag: [t.link, t.url], color: 'var(--accent)' },
		{ tag: t.monospace, color: 'var(--cm-code)' },
		{ tag: t.list, color: 'var(--accent)' },
		{ tag: t.quote, color: 'var(--muted)', fontStyle: 'italic' },
		{ tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--muted)' }
	]);

	const theme = EditorView.theme({
		'&': { backgroundColor: 'transparent', color: 'var(--fg)', fontSize: '13px' },
		'&.cm-focused': { outline: 'none' },
		'.cm-content': { fontFamily: 'var(--font-mono)', padding: '0.7rem', caretColor: 'var(--fg)' },
		'.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
		'.cm-cursor': { borderLeftColor: 'var(--fg)' },
		'.cm-placeholder': { color: 'var(--muted)' },
		'.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
			backgroundColor: 'var(--accent-soft)'
		}
	});

	function onPaste(event: ClipboardEvent): boolean {
		const file = [...(event.clipboardData?.files ?? [])].find((item) => item.type.startsWith('image/'));
		if (!file) return false;
		event.preventDefault();
		onImagePaste?.(file);
		return true;
	}

	onMount(() => {
		view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: value,
				extensions: [
					history(),
					keymap.of([...defaultKeymap, ...historyKeymap]),
					markdown(),
					syntaxHighlighting(highlight),
					EditorView.lineWrapping,
					cmPlaceholder(placeholder),
					theme,
					EditorView.domEventHandlers({ paste: onPaste }),
					EditorView.updateListener.of((update) => {
						if (!update.docChanged) return;
						syncing = true;
						value = update.state.doc.toString();
						syncing = false;
					})
				]
			})
		});
		view.focus();
		return () => view?.destroy();
	});
</script>

<div
	class="min-h-40 overflow-auto border border-border-strong bg-bg focus-within:outline focus-within:outline-2 focus-within:outline-accent"
	bind:this={host}
></div>
