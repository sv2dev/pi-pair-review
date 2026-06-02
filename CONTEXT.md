# Pi Pair Review

Pi Pair Review is a guided code review context for turning a selected git diff into focused human feedback for Pi.

## Language

**Review Scope**:
The subset of a review target that the reviewer has currently chosen to inspect.
_Avoid_: entire diff, all changes

**Review Complete**:
The state where every review unit in the current **Review Scope** has been marked reviewed.
_Avoid_: all files reviewed, diff complete

**Review Progress**:
The percentage of **Review Units** in the current **Review Scope** that have been marked reviewed.
_Avoid_: diff progress, file progress

**Review Unit**:
A file-and-attention-level slice that can be marked reviewed within a **Review Scope**.
_Avoid_: file, hunk

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
An interactive file-or-directory indicator that shows **Review Progress** and toggles reviewed state for its target, acting as the file-tree icon during review.
_Avoid_: status icon, decoration

**Agent Comment**:
A model-suggested review comment attached to the review target.
_Avoid_: agent annotation, highlight

**User Comment**:
A reviewer-authored review comment attached to the review target.
_Avoid_: user annotation, note

## Relationships

- A **Review Scope** contains one or more **Review Units**
- **Review Progress** is surfaced through **Insert Feedback** and **Review Markers**
- A file **Review Marker** toggles all **Review Units** for that file in the current **Review Scope**
- A directory **Review Marker** replaces the directory icon and toggles reviewed state for all visible descendant files in the current **Review Scope**
- Marking a file reviewed advances navigation only when that file is the active review target
- **Agent Comments** and **User Comments** start hidden until their first item appears in a session
- Once a comments section has appeared, manual collapse is respected
- **Review Complete** applies to the current **Review Scope**, not necessarily to the entire review target
- **Insert Feedback** is available before or after **Review Complete**
- A **Review Complete Celebration** follows an explicit reviewer action, not a passive **Review Scope** change
- **Closing Notes** can be added during the **Review Complete Celebration** before **Insert Feedback**

## Example dialogue

> **Dev:** "If the reviewer is in a focused mode, should the completion indicator wait for every file in the diff before allowing feedback insertion?"
> **Domain expert:** "No — **Review Complete** means the selected **Review Scope** is complete, but **Insert Feedback** stays available when the reviewer chooses to stop early. The **Review Complete Celebration** should only appear when the reviewer deliberately marks the scope complete, and it can collect **Closing Notes** before feedback is inserted."

## Flagged ambiguities

- "review complete" could mean either the whole diff is reviewed or only the selected scope is reviewed — resolved: it means the current **Review Scope** is complete.
- "finish" could imply a gated completion step — resolved: the canonical action is **Insert Feedback**, and it is not gated by **Review Complete**.
- "completion" could be triggered by passive scope changes — resolved: a **Review Complete Celebration** only follows an explicit reviewer action.
- "progress" could describe the whole diff or the current scope — resolved: **Review Progress** describes the current **Review Scope** and uses the same marker wherever progress/reviewed state appears.
- "annotation" and "comment" were both used for review feedback items — resolved: use **Agent Comment** and **User Comment** as canonical nouns.
- "finding" remains acceptable only for internal agent-review output; the user-facing term is **Agent Comment**.
