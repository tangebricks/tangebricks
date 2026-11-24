# Story Provenance Contract & Done-Gate

## Overview

In accordance with finding **F-TRUST-4**, ProjectX mandates strict provenance and empirical verification for all story deliverables. Stories cannot be marked `done` based merely on prose or paper claims; every completed story must record who authored the implementation, which model was used, the exact Git commit SHAs produced, and an accompanying plan/evidence artifact. Furthermore, a story cannot be closed as `done` unless those commits change substantive code outside of Markdown documentation.

## Provenance Front Matter Schema

Every story file under `_bmad-output/**/tickets/**/story-*.md` uses YAML front matter. When a story reaches `status: review` or `status: done`, it must include a `provenance` block:

```yaml
---
type: story
title: "Story Title"
parent: epic-uc0-truthful-baseline
epic: 0
id: 1
status: done
after: []
covers: ["F-TRUST-4"]
provenance:
  agent: "Amelia (Dev)"
  model: "claude-opus-5-5"
  commits:
    - "63a8be2"
    - "2332f00"
    - "b4294d1"
  evidence: "_bmad-output/initiative-updations-by-claude/tickets/story-name-plan.md"
---
```

### Fields

| Field | Type | Description |
| :--- | :--- | :--- |
| `agent` | `string` | The BMAD persona or human identity responsible for the story (e.g. `"Amelia (Dev)"`, `"Sofia/Bob (BMAD Method)"`). |
| `model` | `string` | The exact model identifier used (e.g. `"Gemini 3.8 Flash (High)"`, `"claude-opus-5-5"`) or `"human"`. |
| `commits` | `string[]` | Array of 7-40 character hexadecimal Git commit SHAs that implement the story. Must exist in repository history. |
| `evidence` | `string` | Relative path to the companion plan or verification evidence file (e.g. `story-*-plan.md`). |

## "Done Requires a Code Diff" Gate

When a story transitions to `status: done`, the story gate runs `git show --name-only --format= <sha>` across all commits specified in `provenance.commits`.

- **Requirement:** At least one modified file across the specified commits must NOT be a Markdown file (`*.md`) and must NOT be located under `_bmad-output/`.
- If all commits touch only Markdown files (e.g. documentation, task checklists) or `_bmad-output/` planning artifacts, the story fails verification with:
  ```
  STORY_GATE: <file>: done without code diff
  ```
- If any listed commit does not exist in git history, the story fails verification.

## Grandfathered Legacy Stories

Prior to this initiative (checkpoints CP0 through CP10), 77 legacy stories were authored before mandatory provenance front matter was established.

- These 77 legacy stories are explicitly enumerated in `scripts/story-gate.legacy.json`.
- Each entry records `{ "path": "<file>", "reason": "pre-provenance (CP0–CP10), audited in UC0.4" }`.
- `scripts/check-story-gate.ts` skips these legacy entries and reports them as `grandfathered` in the summary output.
- To prevent silent addition of new stories to the grandfathered list, `scripts/test/story-gate.node.test.ts` validates the SHA256 checksum of `scripts/story-gate.legacy.json`. Any addition or modification to the legacy file fails the test suite.

## Task-File Stories & Epic Task Lists

Stories in ProjectX can live in ticket files (`_bmad-output/**/tickets/**/story-*.md`) or in a central task file (`UPDATIONS-BY-CLAUDE-TASKS.md`). The task file was retired when the repository went public; `stories:gate` skips it when it is absent, and the rules below still apply to any task file passed to it.

For task-file stories (`UC0.1` through `UC9.9`):
- Each story is declared by a section header matching `#### [ ] UCn.m — <title>`.
- The story section specifies status via `**Status:** <status>` (e.g. `todo`, `in-progress`, `review`, `done`).
- Stories in `review` or `done` must include a provenance HTML comment immediately following the status:
  ```markdown
  #### [ ] UC0.1 — Evidence stamp helper and quarantine of simulated evidence
  **Status:** done · **Size:** M · **Depends on:** — · **Findings:** F-TRUST-3
  <!-- provenance: { "agent": "Sofia/Bob (BMAD Method)", "model": "Gemini 3.8 Flash (High)", "commits": ["63a8be2", "2332f00", "b4294d1"] } -->
  ```
- Because evidence and handoffs are recorded inline within `UPDATIONS-BY-CLAUDE-TASKS.md`, the `evidence` path field is optional for task-file stories.

### Binding Commits to Stories

To prevent a story from citing unrelated past commits:
- For any task-file story `UCn.m`, every commit cited in `provenance.commits` must have a commit subject starting with `UCn.m:` (or rework variants such as `UCn.m rework:`).
- Citing a commit from another story, base commit, or unassociated change will fail the gate with:
  ```
  STORY_GATE: UCn.m: commit <sha> does not belong to this story
  ```

### Per-Branch Commit Ancestry

- The story gate validates that all cited commits are ancestors of `targetRef` (defaulting to `HEAD`).
- In parallel track worktrees (`track-a-*`, `track-b-*`, `track-c-*`, `track-d-*`), the gate runs against the track branch's `HEAD`.
- A story's implementation commits are ancestors of its own track branch while in `review`, and only become ancestors of `updations-by-claude` after the branch is merged.

## Verification Commands

- Run story gate directly:
  ```bash
  pnpm stories:gate
  ```
- Run automated unit tests:
  ```bash
  pnpm vitest run scripts/test/story-gate.node.test.ts
  ```
- The story gate is also integrated as a required step in `ci:cp0`.
