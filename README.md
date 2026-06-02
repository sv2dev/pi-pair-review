# Pi Pair Review

Pi coding-agent extension with a lean SvelteKit review UI powered by `@pierre/diffs`.

## Use locally

```bash
npm install
npm run build
pi -e .
```

Then run `/pair-review` inside Pi.

Commands:

- `/pair-review` — auto-detect: uncommitted changes, otherwise the last commit
- `/pair-review --unstaged` or `/pair-review -u` — review unstaged changes
- `/pair-review --staged` or `/pair-review -s` — review staged changes
- `/pair-review --uncommitted` or `/pair-review -c` — review staged and unstaged changes against `HEAD`
- `/pair-review --branch` — review committed branch changes against `origin/main...HEAD`
- `/pair-review --branch <base>`, `/pair-review --base <base>`, or `/pair-review <base>` — review committed branch changes against `<base>...HEAD`
- `/pair-review --cwd <path>` — review from another git worktree; can be combined with the diff options above

Compatible extensions can set the active review cwd by appending a session custom entry named `pi-active-cwd` with `{ "cwd": "/path/to/worktree" }`. Append `{ "cwd": null }` to clear it. Explicit `--cwd` wins.

The web UI opens immediately. Use **Diff source** to switch worktrees or review modes. Click **Run** in the agent comments panel to start an agent review with the selected model and thinking level. Click line numbers to add your own comments; click **Insert feedback** or close the review page to insert the collected user feedback into Pi's input editor and close the review app.

This is a test
