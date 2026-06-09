# Pre-review model benchmark

Compares how different models (× thinking levels) perform at producing the structured
review JSON the pre-review AI pass relies on, tracking a deterministic **quality** score
and cost.

The run + scoring logic lives in `src/extension/benchmark.ts` and is shared by **both**
the standalone script (`scripts/bench.ts`) and the in-pi command (`/story-review-bench`).
It reuses the **exact** system prompt (`REVIEW_PROMPT`) and user-message construction
(`buildReviewUserMessage`) from `src/extension/pre-review.ts`, so results reflect real
product behavior. The changeset under review is the current working-tree diff
(`git diff HEAD`).

## Run

Standalone (resolves auth from `~/.pi` via a standalone `ModelRegistry`):

```bash
bun scripts/bench.ts
```

From within pi (resolves auth via the running session's `ctx.modelRegistry`):

```
/story-review-bench                  # benchmark the recommended models @ thinking off
/story-review-bench gpt-5.4 haiku    # benchmark models whose id contains these substrings
```

Each run is a real paid model call. The pi command prints how many calls it will make;
since the user invokes it explicitly there is no extra confirmation gate.

Output:

- A comparison table printed to stdout.
- Full results (including each run's raw model output) written to
  `bench/results-<timestamp>.json`.

## What it measures

Per (model × thinking level) run:

- **jsonValid** — whether the output parses via the same `extractJson` + `JSON.parse`
  path pre-review uses.
- **hunkCoverage** — fraction of canonical hunks assigned to exactly one patch (the
  model's `{file, oldStart, newStart}` refs are resolved to canonical hunk ids exactly
  as pre-review does).
- **counts** — number of `patches`, `cues`, `comments`, and `causalityOrder` entries.
- **latencyMs**, **tokens** (input/output/total), **costUsd** (`usage.cost.total` from
  the SDK — no manual pricing).

## Scoring

Each run gets a deterministic **quality** score (0–100) computed in `scoreRun`
(`src/extension/benchmark.ts`). Tunable weights live in the `DEFAULT_WEIGHTS` config
block at the top of that file and **must sum to 1**.

**Hard gate:** if `jsonValid === false` the output is unusable downstream → quality `0`.

Otherwise `quality = 100 × Σ weightᵢ · sub-metricᵢ`, where each sub-metric is 0–1:

| sub-metric | weight | meaning |
| --- | --- | --- |
| `hunkCoverage` | 0.45 | fraction of canonical hunks assigned to exactly one patch |
| `causalityCompleteness` | 0.20 | `min(1, unique-resolved causalityOrder ids / total hunks)` |
| `partitionSoundness` | 0.15 | `1 − (hunks assigned to >1 patch / total hunks)` |
| `cueCoverage` | 0.10 | partition chunks with a non-empty cue / total chunks |
| `commentsSignal` | 0.10 | `min(commentCount, EXPECTED_COMMENTS) / EXPECTED_COMMENTS` (default 3) |

Reported alongside quality:

- **costUsd**, **latencyMs**, **totalTokens**.
- **efficiency** = `quality / max(costUsd, ε)` — quality per dollar.

The sortable **score** column is `quality`. Tables are ranked by **quality desc**,
tiebroken by **costUsd asc** (`rankResults`).

## Auth / registry

The script instantiates `ModelRegistry` standalone from your local pi config
(`~/.pi`, via `AuthStorage.create()` + `ModelRegistry.create(authStorage)`). It uses
`getAvailable()` to enumerate models that have configured auth and
`getApiKeyAndHeaders(model)` to authenticate each call. No pi runtime is required.

## Adding / expanding targets

Edit the `TARGETS` array in `scripts/bench.ts`. Each entry:

```ts
{ idMatch: 'gpt-5.4', thinkingLevels: ['off', 'medium'], preferProvider: 'openai-codex' }
```

- `idMatch` — substring matched against each available model's `id`.
- `thinkingLevels` — reasoning efforts to try (`'off'` = no reasoning;
  also `minimal | low | medium | high | xhigh`).
- `preferProvider` — optional; when an `idMatch` resolves to several providers, pin one
  (otherwise the first remote match is used).

**Cost control:** every enabled (model × thinking level) line is a real paid API call.
Expensive models (gpt-5.5, opus, etc.) are listed commented-out in `TARGETS` — uncomment
to opt in.

**Local models:** providers matching `ollama`/`local`/`lmstudio`/`llama.cpp` are skipped
defensively and are never run.
