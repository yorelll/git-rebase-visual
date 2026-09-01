# Code Review Commit Ledger

> This ledger is the authoritative coverage map for versioned code reviews. Before starting a review, read it to determine which commits already have an independent review report. After completing a review, append the reviewed commit(s) in the same change as the new `code-review-<major>-<minor>-<patch>.md` file.
>
> A commit is considered reviewed only when its exact full SHA is recorded below with a review file. Do not edit or delete historic rows. A response/fix commit is not automatically reviewed; it must be covered by a later independent review.

| Reviewed commit SHA | Subject | Review file | Response file / section | Status | Reviewed date | Notes |
|---|---|---|---|---|---|---|
| `c4d0ce1dadce433c1e250d0475bf94e7bf85ecf9` | `chore: release v0.3.0` | [`code-review-0-3-0.md`](code-review-0-3-0.md) | [`review-response.md`](review-response.md) — `0-3-0 回复` | Responded; CR-1 through CR-3 fixed | 2026-09-01 | Review baseline includes v0.3.0 implementation commit `cbd4596`; this release commit contains version/documentation metadata. |

## Unreviewed commits

The following commits were created after the `0-3-0` review baseline and require coverage by the next independent versioned review:

| Commit SHA | Subject | Reason |
|---|---|---|
| `78bf1f1b521d94d6c8c31c0c5062f41d90051481` | `fix: address code review 3.0 findings` | Review-response implementation changes; not independently reviewed yet. |
| `af9d033` | `chore: release v0.3.1` | Version/release documentation for the review fixes; not independently reviewed yet. |

> When a future review covers either entry, move or duplicate it into the historical ledger table with the exact review filename and response section; retain this history by changing its status rather than deleting context.
