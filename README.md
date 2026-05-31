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

- `/pair-review` or `/pair-review --unstaged` — review unstaged changes
- `/pair-review --staged` — review staged changes
- `/pair-review --uncommitted` — review staged and unstaged changes against `HEAD`
- `/pair-review --branch` — review branch changes against `main...HEAD`
- `/pair-review --branch <base>`, `/pair-review --base <base>`, or `/pair-review <base>` — review `<base>...HEAD`

The web UI opens immediately. Click **Run** in the agent annotations panel to start an agent review with the selected model and thinking level. Click line numbers to add your own annotations; click **Insert feedback** or close the review page to insert the collected user feedback into Pi's input editor and close the review app.
