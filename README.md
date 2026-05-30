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

- `/pair-review` — review working tree changes
- `/pair-review --staged` — review staged changes
- `/pair-review <base>` — review `<base>...HEAD`

The web UI opens immediately. The extension starts a quick background pre-review with the active Pi model and streams findings into the review.
