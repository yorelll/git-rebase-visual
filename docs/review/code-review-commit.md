# Code Review Commit 评审台账

> 本台账是版本化代码评审覆盖范围的唯一依据。开始评审前，必须先读取本文件，以确认哪些 commit 已有独立评审报告。完成评审后，必须在创建新的 `code-review-<major>-<minor>-<patch>.md` 的同一个变更中，把本次覆盖的 commit 追加到台账。
>
> 只有当某个 commit 的**完整 SHA**与对应评审文件同时记录在下表中时，才视为已经评审。不得编辑或删除历史记录。回复/修复 commit 不会自动视为已评审，必须由后续独立评审覆盖。

## 已评审 Commit

| 已评审 Commit SHA | Commit 说明 | 评审文件 | 回复文件 / 章节 | 状态 | 评审日期 | 备注 |
|---|---|---|---|---|---|---|
| `c4d0ce1dadce433c1e250d0475bf94e7bf85ecf9` | `chore: release v0.3.0` | [`code-review-0-3-0.md`](code-review-0-3-0.md) | [`review-response.md`](review-response.md) — `0-3-0 回复` | 已回复；CR-1 至 CR-3 已修复 | 2026-09-01 | 评审基线包含 v0.3.0 功能实现 commit `cbd4596`；此 release commit 主要包含版本号与文档元数据。 |

## 待评审 Commit

以下 commit 创建于 `0-3-0` 评审基线之后，需要由下一份独立的版本化 code review 覆盖：

| Commit SHA | Commit 说明 | 待评审原因 |
|---|---|---|
| `78bf1f1b521d94d6c8c31c0c5062f41d90051481` | `fix: address code review 3.0 findings` | code review 3.0 的整改实现，尚未被独立评审。 |
| `af9d033` | `chore: release v0.3.1` | review 整改的版本与发布文档变更，尚未被独立评审。 |
| `d487c94` | `docs: track versioned code review coverage` | 新增版本化评审 commit 台账与规则，尚未被独立评审。 |

> 未来评审覆盖上述任一 commit 时，必须在“已评审 Commit”表中新增或补充对应记录，写明完整 SHA、评审文件、回复章节、状态和日期；保留“待评审 Commit”中的历史上下文，不得直接删除。
