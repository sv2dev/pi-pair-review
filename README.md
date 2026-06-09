# Story Review

Pi coding-agent extension with a lean SvelteKit review UI powered by `@pierre/diffs`.

## Use locally

```bash
npm install
npm run build
pi -e .
```

Then run `/story-review` inside Pi.

Commands:

- `/story-review` — auto-detect: uncommitted changes, otherwise the last commit
- `/story-review --unstaged` or `/story-review -u` — review unstaged changes
- `/story-review --staged` or `/story-review -s` — review staged changes
- `/story-review --uncommitted` or `/story-review -c` — review staged and unstaged changes against `HEAD`
- `/story-review --branch` — review committed branch changes against `origin/main...HEAD`
- `/story-review --branch <base>`, `/story-review --base <base>`, or `/story-review <base>` — review committed branch changes against `<base>...HEAD`
- `/story-review --cwd <path>` — review from another git worktree; can be combined with the diff options above

Compatible extensions can set the active review cwd by appending a session custom entry named `pi-active-cwd` with `{ "cwd": "/path/to/worktree" }`. Append `{ "cwd": null }` to clear it. Explicit `--cwd` wins.

The web UI opens immediately. Use **Diff source** to switch worktrees or review modes. Click **Run** in the agent comments panel to start an agent review with the selected model and thinking level. Click line numbers to add your own comments; click **Send feedback** or close the review page to send the collected user feedback to Pi's input editor and close the review app.

This is a test
