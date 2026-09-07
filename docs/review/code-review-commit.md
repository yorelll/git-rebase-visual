# Code Review Commit 评审台账

> 本台账是版本化代码评审覆盖范围的唯一依据。开始评审前，必须先读取本文件，以确认哪些 commit 已有独立评审报告。完成评审后，必须在创建新的 `code-review-<major>-<minor>-<patch>.md` 的同一个变更中，把本次覆盖的 commit 追加到台账。
>
> 只有当某个 commit 的**完整 SHA**与对应评审文件同时记录在下表中时，才视为已经评审。不得编辑或删除历史记录。回复/修复 commit 不会自动视为已评审，必须由后续独立评审覆盖。

## 已评审 Commit

| 已评审 Commit SHA | Commit 说明 | 评审文件 | 回复文件 / 章节 | 状态 | 评审日期 | 备注 |
|---|---|---|---|---|---|---|
| `c4d0ce1dadce433c1e250d0475bf94e7bf85ecf9` | `chore: release v0.3.0` | [`code-review-0-3-0.md`](code-review-0-3-0.md) | [`review-response-0-3-0.md`](review-response-0-3-0.md) — 0-3-0 回复 | 已回复；CR-1 至 CR-3 已修复 | 2026-09-01 | 评审基线包含 v0.3.0 功能实现 commit `cbd4596`；此 release commit 主要包含版本号与文档元数据。 |
| `78bf1f1b521d94d6c8c31c0c5062f41d90051481` | `fix: address code review 3.0 findings` | 0-4-0 复核（子 agent 独立评审 + 主 agent 验证） | [`review-response-0-4-0.md`](review-response-0-4-0.md) — 0-4-0 回复 | 已复核；整改确认有效，无返工 | 2026-09-03 | 该 commit 为 code review 3.0 整改实现；在 0-4-0 迭代中被独立复核（代理 B reviewer 逐项核验 + 主 agent 验证 typecheck/40 测试）。 |
| `af9d033` | `chore: release v0.3.1` | 0-4-0 复核 | [`review-response-0-4-0.md`](review-response-0-4-0.md) | 已复核；版本与文档元数据无缺陷 | 2026-09-03 | 在 0-4-0 迭代中随整改一并复核。 |
| `d487c94` | `docs: track versioned code review coverage` | 0-4-0 复核 | [`review-response-0-4-0.md`](review-response-0-4-0.md) | 已复核；台账与命名规则有效 | 2026-09-03 | 在 0-4-0 迭代中复核，并确认回复文件改为版本化命名（见下）。 |
| `4c76d62f57dfe4a15dc8244018828f5418e29d5d` | `feat: implement UI review improvements` | [`code-review-0-5-0.md`](code-review-0-5-0.md) | [`review-response-0-5-0.md`](review-response-0-5-0.md) — 0-5-0 回复 | 已评审；安全反馈/UI 改进通过 | 2026-09-05 | 基于截图、用户建议、Agent A 独立评审、Agent B 实施与 Agent C 审查。 |
| `ba9645d7e56a594ffd7405464b337faf289dc9a0` | `fix: harden UI rebase safety paths` | [`code-review-0-5-0.md`](code-review-0-5-0.md) | [`review-response-0-5-0.md`](review-response-0-5-0.md) | 已评审；修正 rebase 安全路径 | 2026-09-05 | Agent C 修正并经主 agent 48 测试复核。 |
| `00023b9bdc9dc300317654e9c742b5a7af3fa6ee` | `fix: avoid duplicate append stash restore` | [`code-review-0-5-0.md`](code-review-0-5-0.md) | [`review-response-0-5-0.md`](review-response-0-5-0.md) | 已评审；修正 Abort 双恢复 | 2026-09-05 | append replay conflict → Abort blocker 已修复。 |
| `f720f3fbb9ae9b12cf8f036e64f92fc4ca35677b` | `fix: distinguish rebase edit stops` | [`code-review-0-5-0.md`](code-review-0-5-0.md) | [`review-response-0-5-0.md`](review-response-0-5-0.md) | 已评审；暂停原因判定有效 | 2026-09-05 | 不再将 conflict 的 stale stopped-sha 错标 edit。 |
| `fb8b6726fbd8b1cb6353a23542e4eca34e42f478` | `fix: preserve compose input when reword pauses` | [`code-review-0-5-0.md`](code-review-0-5-0.md) | [`review-response-0-5-0.md`](review-response-0-5-0.md) | 已评审；Compose 输入保留有效 | 2026-09-05 | 主 agent 发现并修正普通 reword 暂停误发成功协议。 |
| `e623b497c2062a8bcbc40f7bf66fddc7f5a09970` | `docs: add UI review suggestions` | [`code-review-0-5-0.md`](code-review-0-5-0.md) | [`review-response-0-5-0.md`](review-response-0-5-0.md) | 已评审；原始建议归档 | 2026-09-05 | 用户提供的 UI 建议作为 0.5.0 评审输入保留。 |
| `e54c03b` | `fix: avoid optional index lock contention` | [`code-review-0-5-1.md`](code-review-0-5-1.md) | [`review-response-0-5-1.md`](review-response-0-5-1.md) — 0-5-1 回复 | 已评审；后台 status optional lock 修复 | 2026-09-07 | Linux 实际 index.lock 观测、最小环境修复、临时仓库回归测试和发布 body 工作流升级。 |

## 待评审 Commit

以下 commit 创建于 `0-3-0` 评审基线之后，需要由下一份独立的版本化 code review 覆盖：

| Commit SHA | Commit 说明 | 待评审原因 |
|---|---|---|
| `78bf1f1b521d94d6c8c31c0c5062f41d90051481` | `fix: address code review 3.0 findings` | ✅ 已在 2026-09-03 的 0-4-0 迭代中复核；保留此上下文作为历史记录。 |
| `af9d033` | `chore: release v0.3.1` | ✅ 已在 2026-09-03 的 0-4-0 迭代中复核；保留此上下文作为历史记录。 |
| `d487c94` | `docs: track versioned code review coverage` | ✅ 已在 2026-09-03 的 0-4-0 迭代中复核；保留此上下文作为历史记录。 |
| `4c76d62f57dfe4a15dc8244018828f5418e29d5d` | `feat: implement UI review improvements` | ✅ 已在 2026-09-05 的 `code-review-0-5-0.md` 中评审；保留此上下文作为历史记录。 |
| `ba9645d7e56a594ffd7405464b337faf289dc9a0` | `fix: harden UI rebase safety paths` | ✅ 已在 2026-09-05 的 `code-review-0-5-0.md` 中评审；保留此上下文作为历史记录。 |
| `00023b9bdc9dc300317654e9c742b5a7af3fa6ee` | `fix: avoid duplicate append stash restore` | ✅ 已在 2026-09-05 的 `code-review-0-5-0.md` 中评审；保留此上下文作为历史记录。 |
| `f720f3fbb9ae9b12cf8f036e64f92fc4ca35677b` | `fix: distinguish rebase edit stops` | ✅ 已在 2026-09-05 的 `code-review-0-5-0.md` 中评审；保留此上下文作为历史记录。 |
| `fb8b6726fbd8b1cb6353a23542e4eca34e42f478` | `fix: preserve compose input when reword pauses` | ✅ 已在 2026-09-05 的 `code-review-0-5-0.md` 中评审；保留此上下文作为历史记录。 |
| `e623b497c2062a8bcbc40f7bf66fddc7f5a09970` | `docs: add UI review suggestions` | ✅ 已在 2026-09-05 的 `code-review-0-5-0.md` 中评审；保留此上下文作为历史记录。 |
| `e54c03b` | `fix: avoid optional index lock contention` | ✅ 已在 2026-09-07 的 `code-review-0-5-1.md` 中评审；保留此上下文作为历史记录。 |

> 未来评审覆盖上述任一 commit 时，必须在“已评审 Commit”表中新增或补充对应记录，写明完整 SHA、评审文件、回复章节、状态和日期；保留“待评审 Commit”中的历史上下文，不得直接删除。
>
> **命名约定更新（2026-09-03）**：回复文件改为按版本命名 `review-response-<major>-<minor>-<patch>.md`（如 `review-response-0-4-0.md`），替代原单一 `review-response.md`；上一版本的回复归档为 `review-response-0-3-0.md`。`CLAUDE.md` 命名规则已同步。
