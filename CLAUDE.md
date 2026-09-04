# Git Rebase Visual — Project Instructions

## Versioned Code Review Workflow

The project keeps external versioned code-review reports and project responses separate so that review history remains auditable.

### External review report

- For every released or reviewed version, create a new independent report under `docs/review/` named exactly:

  ```text
  code-review-<major>-<minor>-<patch>.md
  ```

  Example: `code-review-0-3-0.md`.

- A code-review report assesses that version's code. Do **not** edit, rewrite, rename, merge, or delete an existing `code-review-*.md` while replying to it.
- A new review always receives a new versioned filename. Never overwrite a previous review.

### Review coverage ledger

- Before beginning a code review, read `docs/review/code-review-commit.md` first.
- Treat a commit as already reviewed only when its exact full SHA is recorded in that ledger with a review report path. Do not repeat an already recorded review unless the user explicitly requests a re-review.
- Review every commit reachable from the requested target that is not covered by the ledger. State the reviewed SHA/range in the new report's baseline section.
- Immediately after completing a review, update `code-review-commit.md` in the same change with the exact commit SHA, subject, review filename, response filename (if one exists), review status, and date. Never remove historical ledger entries.
- A review response or implementation fix does not make its own commit reviewed. It requires a subsequent independent `code-review-<major>-<minor>-<patch>.md` entry.

### Review response

- Write project responses in versioned files `docs/review/review-response-<major>-<minor>-<patch>.md`.
- For a report named `code-review-X-Y-Z.md`, create/replace the response file for that version, `review-response-X-Y-Z.md`, with one top-level section named exactly:

  ```markdown
  ## X-Y-Z 回复（对应 `code-review-X-Y-Z.md`）
  ```

- Do not revise prior response files after a later review arrives. Add the next version file instead; for example `review-response-0-4-0.md` after `review-response-0-3-0.md`.
- Each response section must include:
  1. the review baseline/version;
  2. a decision for every finding: fixed, intentionally not changed, or deferred;
  3. exact implementation and test evidence for fixed findings;
  4. a concrete reason for every finding not changed or deferred;
  5. final verification commands and results.
- Mark checkboxes `[x]` only for findings actually fixed and verified. Retain `[ ]` for deferred or rejected items and write the reason directly below.

### Documentation consistency

- When review-related docs are renamed, update links in `docs/`, `README.md`, `RELEASE.md`, and other project documentation in the same change.
- Keep P2 follow-up tasks in `docs/improvement/improvement.md`; reference their original review finding/version.
- Do not add review-source documents, tests, development-only assets, or local tooling state to the VSIX package.
