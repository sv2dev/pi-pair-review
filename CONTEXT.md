# Story Review

Story Review is a guided code review context for turning a selected git diff into focused human feedback for Pi.

## Language

**Review Scope**:
The subset of a review target that the reviewer has currently chosen to inspect.
_Avoid_: entire diff, all changes

**Review Complete**:
The state where every **Review Chunk** across the whole review (all **Parts**) has been marked reviewed — independent of the current focus window.
_Avoid_: all files reviewed, diff complete, scope complete

**Review Progress**:
Reviewed state, aggregated up the hierarchy **Review Chunk** → **Part** → whole review. The reviewer can mark any level reviewed; progress rolls up automatically.
_Avoid_: diff progress, file progress

**Review Chunk**:
The file-grouped hunks within a single **Part** — the smallest reviewable unit that can be marked reviewed.
_Avoid_: file, hunk, review unit

**Review Strategy**:
How the diff is partitioned into **Parts**: `flat` (all changes as one part), `smart` (one **Patch** per part), or `commits` (one **Commit** per part). `smart` requires an AI run.
_Avoid_: mode, review mode

**Part**:
One partition of the review target under the active **Review Strategy**; the reviewer advances part by part. In `smart` strategy a part is a story part.
_Avoid_: level, attention level, criticality tier

**Patch**:
An AI-extracted, logically-closed group of changes (may span files) with a title and summary, used as a **Part** in `smart` strategy. Patches are ordered as an AI-authored story whose arc reflects the impact of the changes.
_Avoid_: hunk, chunk

**Commit**:
An original git commit, used as a **Part** in `commits` strategy, ordered chronologically.
_Avoid_: patch

**Sort Order**:
How **Review Chunks** are ordered within a **Part**: `tree` (file-tree order) or `causality` (AI understanding order — definitions before usages). `causality` requires an AI run.
_Avoid_: ranking, priority

**Insert Feedback**:
The action that returns the collected review feedback to Pi.
_Avoid_: finish, submit

**Review Complete Celebration**:
A confirmation moment shown when the reviewer explicitly marks the current **Review Scope** complete.
_Avoid_: automatic modal, passive completion popup

**Closing Notes**:
Optional overall feedback added at the end of a review.
_Avoid_: summary

**Review Marker**:
An interactive root, **Part**, directory, file, or **Review Chunk** indicator that shows **Review Progress** (a circle around the checkmark) and toggles reviewed state for its target, replacing file and directory icons during review.
_Avoid_: status icon, decoration

**Agent Comment**:
A model-suggested review comment attached to the review target.
_Avoid_: agent annotation, highlight

**User Comment**:
A reviewer-authored review comment attached to the review target.
_Avoid_: user annotation, note

**Cue**:
An optional per-**Review Chunk** AI note answering "why does this chunk exist?" — its causality. Orientation only: never a finding, never feeds **Insert Feedback**. Off by default; requires an AI run.
_Avoid_: guiding, comment, annotation

**Overview**:
A whole-review description of what the entire change does (squashed commit messages or AI-generated).
_Avoid_: summary

**Brief**:
A per-**Part** description of what changed in that part (commit body or AI-generated). The Patch Brief in `smart`, the Commit Brief in `commits`.
_Avoid_: summary

**Assessment**:
The agent review's overview of what the review flagged — the **Agent Comment** readout.
_Avoid_: summary, findings summary

**Autorun**:
A setting that triggers the AI run automatically. When enabled unconditionally it always runs; otherwise it runs when any enabled precondition holds (preconditions are OR'ed) — e.g. at least X lines changed, at least Y files touched, uncommitted changes, or a single commit to the base branch.
_Avoid_: auto review, auto agent

**Auto-advance**:
A reviewer setting that moves to the next **Part** when every **Review Chunk** in the current **Part** is reviewed.
_Avoid_: autocontinue, autorun

**Diff Pane**:
The central review area where the selected **Review Scope** is rendered for inspection.
_Avoid_: review pane

## Relationships

- A **Review Strategy** partitions the review target into one or more **Parts**
- A **Part** contains one or more **Review Chunks**
- **Parts** advance in a fixed order set by the **Review Strategy** (chronological for `commits`, AI story for `smart`); **Sort Order** only reorders **Review Chunks** within a **Part**
- A **Patch** carries a title (used as the **Part** name) and a summary (shown on demand and when advancing to the next **Part**)
- Without an AI run, only `flat` and `commits` strategies with `tree` ordering are available
- Reviewed state is tracked per hunk and rolls up through **Review Chunk** → **Part** → whole review, so it survives a **Review Strategy** switch
- Default **Review Strategy** is `commits` + `tree` for committed changes and `flat` + `tree` for uncommitted/staged/unstaged/untracked changes; after an AI run it auto-switches once to `smart` + `causality`
- A **Cue** explains the causality of a single **Review Chunk**; an **Agent Comment** flags a specific issue — they are distinct
- An **Overview** describes the whole review target; a **Brief** describes one **Part**; an **Assessment** describes the agent review
- A **Review Scope** contains one or more **Review Chunks**
- **Review Progress** is surfaced through **Insert Feedback** and **Review Markers**
- The root **Review Marker** toggles reviewed state for all visible files in the current **Review Scope**
- A file **Review Marker** toggles all **Review Chunks** for that file in the current **Review Scope**
- A directory **Review Marker** replaces the directory icon and toggles reviewed state for all visible descendant files in the current **Review Scope**
- Marking a file reviewed advances navigation only when that file is the active review target
- **Agent Comments** and **User Comments** start hidden until their first item appears in a session
- Once a comments section has appeared, manual collapse is respected
- **Review Complete** applies to the whole review (all **Parts**), independent of the current focus window or **Review Scope**
- Reviewed state aggregates **Review Chunk** → **Part** → whole review; the reviewer can mark any level reviewed
- A **Cue** is shown only when a single **Part** is in view (the first **Part**, or isolated)
- **Insert Feedback** is available before or after **Review Complete**
- **Auto-advance** applies to the current **Part**, while **Review Complete** applies to the whole review
- **Auto-advance** is restored across review sessions as a reviewer setting
- **Auto-advance** triggers only after an explicit reviewer action marks the current **Part** complete, not after passive state changes such as restoring reviewed state, switching **Review Strategy**, or toggling **Auto-advance** on
- Any explicit reviewer action that completes the current **Part** can trigger **Auto-advance**, regardless of whether it marks a file, directory, root, **Review Chunk**, or **Part** reviewed
- **Auto-advance** and manual continuation are gated by the current **Part** being complete, not by all visible **Parts** being complete in cumulative view
- **Review Complete Celebration** takes precedence over **Auto-advance** when marking the current **Part** complete also completes the whole review
- When **Auto-advance** is off, manual continuation to the next **Part** is offered at the bottom of the **Diff Pane** only if a next **Part** exists; it remains visible and disabled until the current **Part** is complete
- Bottom **Diff Pane** controls for continuation and **Auto-advance** are shown only when a next **Part** exists
- When **Auto-advance** is on, the bottom **Diff Pane** controls keep an **Auto-advance** toggle available but do not show the manual continuation action
- Manual continuation and **Auto-advance** preserve the current **Review Scope** style: cumulative when parts are not isolated, single-part when **Isolate current part** is enabled
- A **Review Complete Celebration** fires only when the whole review is reviewed, following the reviewer's marking action, not a passive change
- **Closing Notes** can be added during the **Review Complete Celebration** before **Insert Feedback**

## Example dialogue

> **Dev:** "If the reviewer is in a focused mode, should the completion indicator wait for every file in the diff before allowing feedback insertion?"
> **Domain expert:** "No — **Review Complete** means every **Review Chunk** across all **Parts** is reviewed, but **Insert Feedback** stays available when the reviewer chooses to stop early. The **Review Complete Celebration** only fires at whole-review completion, and it can collect **Closing Notes** before feedback is inserted."

## Flagged ambiguities

- "review complete" could mean either the whole diff is reviewed or only the selected scope is reviewed — resolved: it means every **Review Chunk** across all **Parts** is reviewed; the focus window (isolated **Part**) does not gate completion.
- "finish" could imply a gated completion step — resolved: the canonical action is **Insert Feedback**, and it is not gated by **Review Complete**.
- "completion" could be triggered by passive scope changes — resolved: a **Review Complete Celebration** only follows an explicit reviewer action.
- "progress" could describe the whole diff or the current scope — resolved: **Review Progress** aggregates reviewed state up **Review Chunk** → **Part** → whole review, using the same marker wherever progress/reviewed state appears.
- "annotation" and "comment" were both used for review feedback items — resolved: use **Agent Comment** and **User Comment** as canonical nouns.
- "finding" remains acceptable only for internal agent-review output; the user-facing term is **Agent Comment**.
- "mode" was overloaded — the diff-partitioning concept is now **Review Strategy** (flat/smart/commits); the old criticality-based presentation tiers (deep-focus/careful/...) are retired along with **Review Unit** and attention levels.
- "summary" was overloaded across the whole change, a single part, and the agent review — resolved: **Overview** (whole review), **Brief** (one **Part**), **Assessment** (agent review). The existing `preReview.summary` field is an **Overview** and should be split from the **Assessment**.
- "autocontinue" conflicted with **Autorun** — resolved: use **Auto-advance** for automatic **Part** navigation and keep **Autorun** for AI review execution.
- "review pane" was ambiguous between the central review area and the sidebars — resolved: use **Diff Pane** for the central area that renders the current **Review Scope**.
