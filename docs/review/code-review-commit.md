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
| `ff260667727ba3c92dde861c74b2f594ec736ca5` | `feat: implement 0.6 rebase experience` | [`code-review-0-6-0.md`](code-review-0-6-0.md) | [`review-response-0-6-0.md`](review-response-0-6-0.md) — 0-6-0 回复 | 已评审；rebase session/Undo/Panel/操作升级通过 | 2026-09-09 | 由两轮 UI 建议、截图、Agent A/B/C 和主 agent 复核覆盖。 |
| `02ff57da31d2f2a8a485ab7446417f8bc0caf492` | `fix: harden 0.6 rebase experience` | [`code-review-0-6-0.md`](code-review-0-6-0.md) | [`review-response-0-6-0.md`](review-response-0-6-0.md) | 已评审；Undo/progress/Compose 安全修正 | 2026-09-09 | Agent C 第一轮深审修正。 |
| `612556664652601269438156fc5df8cec1ceac99` | `fix: harden 0.6 rebase experience` | [`code-review-0-6-0.md`](code-review-0-6-0.md) | [`review-response-0-6-0.md`](review-response-0-6-0.md) | 已评审；多选/过滤/locked run/键盘修正 | 2026-09-09 | Agent C 按大版本价值要求补齐的安全实现。 |
| `45e663a` | `fix: initialize compose panel after webview ready` | [`code-review-0-6-1.md`](code-review-0-6-1.md) | [`review-response-0-6-1.md`](review-response-0-6-1.md) — 0-6-1 回复 | 已评审；Compose payload handshake 修复 | 2026-09-09 | Panel ready/reload payload delivery 的初始修正。 |
| `e8a6027` | `fix: stabilize rebase panel interactions` | [`code-review-0-6-1.md`](code-review-0-6-1.md) | [`review-response-0-6-1.md`](review-response-0-6-1.md) | 已评审；交互状态持久化与上下文修复 | 2026-09-09 | locked run、search、inline toast、branch context、SourceControl progress。 |
| `6a71abb` | `fix: keep edit-stop message generation draft-only` | [`code-review-0-6-1.md`](code-review-0-6-1.md) | [`review-response-0-6-1.md`](review-response-0-6-1.md) | 已评审；draft-only 语义修复 | 2026-09-09 | edit stop 的仅生成 message 不再进入提交路径。 |
| `ca1801d` | `fix: harden 0.6.1 panel interactions` | [`code-review-0-6-1.md`](code-review-0-6-1.md) | [`review-response-0-6-1.md`](review-response-0-6-1.md) | 已评审；暂停 Compose policy 加固 | 2026-09-09 | Agent 审查修正 host allow-list。 |
| `06476b3050dc3b4f884663c63dbd45cd94e7a92b` | `feat: implement 0.6.2 rebase UX` | [`code-review-0-6-2.md`](code-review-0-6-2.md) | [`review-response-0-6-2.md`](review-response-0-6-2.md) — 0-6-2 回复 | 已评审；第三轮 UI/状态升级通过 | 2026-09-10 | 基于 review3、Agent A/B/C 与主 agent 复核。 |
| `b259d4e7a1116ab618885fb99f808bc902c9067e` | `fix: harden 0.6.2 rebase interactions` | [`code-review-0-6-2.md`](code-review-0-6-2.md) | [`review-response-0-6-2.md`](review-response-0-6-2.md) | 已评审；Compose/trailer/edit-stop 修正 | 2026-09-10 | Agent C 第一轮深审修正。 |
| `fba41f8d1ce1fbe351bd6c35ac0f234064d96e17` | `fix: harden 0.6.2 rebase interactions` | [`code-review-0-6-2.md`](code-review-0-6-2.md) | [`review-response-0-6-2.md`](review-response-0-6-2.md) | 已评审；locked continuity/Undo 修正 | 2026-09-10 | 保留正常 locked replay 的 patch-id 语义。 |
| `03c05065fbaf5c50b274acdf46295608a6831e38` | `fix: harden 0.6.2 rebase interactions` | [`code-review-0-6-2.md`](code-review-0-6-2.md) | [`review-response-0-6-2.md`](review-response-0-6-2.md) | 已评审；共同祖先审计修正 | 2026-09-10 | 避免 locked patch continuity 审计假阳性。 |
| `828bd4cfa7e62e4dc90f5c3b899c3d0ebde72992` | `feat: implement 0.6.3 rebase interactions` | [`code-review-0-6-3.md`](code-review-0-6-3.md) | [`review-response-0-6-3.md`](review-response-0-6-3.md) — 0-6-3 回复 | 已回复；R63-1、R63-5 已提交整改，待独立复核 | 2026-09-12 | 历史台账保留；不属于本次 0.7.0 覆盖范围。 |
| `499dfc1053f69a392bbf0da72b7fe2df2dab37fc` | `feat: implement 0.7 rebase interactions` | [`code-review-0-7-0.md`](code-review-0-7-0.md) | [`review-response-0-7-0.md`](review-response-0-7-0.md) — 0-7-0 回复 | 已评审；R70-1 至 R70-8 已修正并复核 | 2026-09-13 | 与独立初审的 `40d5dd3` 内容一致；从已发布 v0.6.3 基线线性重建后使用新 SHA。 |
| `2711b66681ca20e530a94651a1dca702234de12f` | `fix: address 0.7 interaction review findings` | [`code-review-0-7-0.md`](code-review-0-7-0.md) | [`review-response-0-7-0.md`](review-response-0-7-0.md) — 0-7-0 回复 | 已评审；R70-1 至 R70-5 整改有效 | 2026-09-13 | 与后续独立复核的 `ed9c11c` 内容一致；R71-1 在后续候选提交中修正。 |
| `ee85a85c208a44a491e6b228415362bd45c4025c` | `fix: complete LLM safe port policy` | [`code-review-0-7-0.md`](code-review-0-7-0.md) | [`review-response-0-7-0.md`](review-response-0-7-0.md) — 0-7-0 回复 | 已评审；R71-1 整改有效，R72-1 在后续候选提交中修正 | 2026-09-13 | 与独立复核使用的 `147f76b` 内容一致。 |
| `715234af9794d369fae724620e299a371741dd41` | `fix: align LLM ports with Fetch standard` | [`code-review-0-7-0.md`](code-review-0-7-0.md) | [`review-response-0-7-0.md`](review-response-0-7-0.md) — 0-7-0 回复 | 已评审；R72-1 整改有效，0.7.0 自动化批准 | 2026-09-13 | 与最终独立核验的 `371aafb` 内容一致；完整 Fetch bad-port policy 已复核。 |
| `8a61f6549117b9729f2f269ddc173e76bc085512` | `feat: refine review5 rebase interactions` | [`code-review-0-7-1.md`](code-review-0-7-1.md) | [`review-response-0-7-1.md`](review-response-0-7-1.md) — 0-7-1 回复 | 已评审；R71-1 P1 已发现，后续整改已由 0-7-2 复核 | 2026-09-14 | 基线为已发布 v0.7.0 `e96f60f`；review5 的 inspector lifecycle 初始实现关闭后无法可靠重开。 |
| `853f26ab8b3219a95d5467dd847e0729e847974c` | `fix: stabilize commit inspector lifecycle` | [`code-review-0-7-2.md`](code-review-0-7-2.md) | [`review-response-0-7-1.md`](review-response-0-7-1.md) — R71-1 整改回复 | 已评审；R71-1 P1 已修正，R72-1 P2 adapter lifecycle 自动化覆盖待补 | 2026-09-14 | `0-7-2` 为未发布 0.7.1 的内部补充审查轮次，不是 release version。 |
| `3a247aae223786ea67f72c39e7865eb5e50ce870` | `test: cover commit inspector adapter lifecycle` | [`code-review-0-7-3.md`](code-review-0-7-3.md) | [`review-response-0-7-2.md`](review-response-0-7-2.md) — R72-1 整改回复 | 已评审；R72-1 P2 已修正，0.7.1 自动化审查闭环通过 | 2026-09-14 | `0-7-3` 为未发布 0.7.1 的内部最终补充审查轮次，不是 release version。 |
| `c3371b48f744053cc3b1b4edcea0f94ca123d295` | `fix: preserve editor focus for inspector` | [`code-review-0-7-4.md`](code-review-0-7-4.md) | [`review-response-0-7-4.md`](review-response-0-7-4.md) — 0-7-4 回复 | 已评审；v0.7.1 最终整改汇总 | 2026-09-14 | `42c4d94` 的整合等价 cherry-pick；修正 inspector 创建时 focus self-close。 |
| `75298342a71728db99d18bf4cf40333121d2f3a2` | `feat: show commit detail in inspector preview` | [`code-review-0-7-4.md`](code-review-0-7-4.md) | [`review-response-0-7-4.md`](review-response-0-7-4.md) — 0-7-4 回复 | 已评审；v0.7.1 最终整改汇总 | 2026-09-14 | `6840489` 的整合等价 cherry-pick；hover detail 交给 editor-area preview。 |
| `e2a3875664f59f66188f2759faa41a38a901b800` | `fix: serialize inspector preview ownership` | [`code-review-0-7-4.md`](code-review-0-7-4.md) | [`review-response-0-7-4.md`](review-response-0-7-4.md) — 0-7-4 回复 | 已评审；v0.7.1 最终整改汇总 | 2026-09-14 | `93a6e22` 的整合等价 cherry-pick；消除 preview/action 异步竞态。 |
| `67352fc8425082fdf67f0bee16e32051824faf4a` | `fix: retain inspector during panel focus` | [`code-review-0-7-4.md`](code-review-0-7-4.md) | [`review-response-0-7-4.md`](review-response-0-7-4.md) — 0-7-4 回复 | 已评审；v0.7.1 最终整改汇总 | 2026-09-14 | `5e9f399` 的整合等价 cherry-pick；仅真实 TextEditor interaction 关闭 inspector。 |
| `348e84e5a385cb82b5cea2d7f77226aa46051609` | `fix: keep cross-pane commit preview readable` | [`code-review-0-7-4.md`](code-review-0-7-4.md) | [`review-response-0-7-4.md`](review-response-0-7-4.md) — 0-7-4 回复 | 已评审；v0.7.1 最终整改汇总 | 2026-09-14 | `7c584b4` 的整合等价 cherry-pick；preview 可移至右侧阅读/复制。 |
| `a7626f652294ab2d46257f3b02feabdfec835f96` | `fix: harden refresh feedback and file deletion` | [`code-review-0-7-4.md`](code-review-0-7-4.md) | [`review-response-0-7-4.md`](review-response-0-7-4.md) — 0-7-4 回复 | 已评审；v0.7.1 最终整改汇总 | 2026-09-14 | `6bec006` 的整合等价 cherry-pick；manual Refresh feedback 与删除确认后 fresh status revalidation。 |
| `50d96d3ad55b4bde5651f114ce72ad80f7ba7aef` | `fix: restore native tree action parity` | [`code-review-0-7-2-remediation.md`](code-review-0-7-2-remediation.md) | — | 已评审；发现 P1，未批准发布 | 2026-09-14 | 覆盖 `4482e4e…` 后的原生 TreeView 功能整改；具体问题见 R72RM-1 至 R72RM-8。 |
| `b047cf80420e9b1dbc128ec0ce3e6f3afb9ee4e3` | `test: cover native tree drag intent` | [`code-review-0-7-2-remediation.md`](code-review-0-7-2-remediation.md) | — | 已评审；发现 P1，未批准发布 | 2026-09-14 | 同一整改候选范围内的测试提交。 |
| `89791fe901af227748c690f1ae73075f3f808504` | `fix: retain locked batch native actions` | [`code-review-0-7-2-remediation.md`](code-review-0-7-2-remediation.md) | — | 已评审；发现 P1，未批准发布 | 2026-09-14 | 本报告的精确整改候选 HEAD；不得视为发行批准。 |
| `4482e4ebfd07f1831c39472d4ea53e5e95e7fb8c` | `feat: use native commit context UI` | [`code-review-0-7-2-final.md`](code-review-0-7-2-final.md) | 待实现方回复 | 已评审；V072-F1（P1）待整改 | 2026-09-14 | v0.7.2 native TreeView 迁移初始实现；当前候选不批准发布。 |
| `c108037cadf40182c8af9e37c50f969a12f582c5` | `fix: retain native read actions for locks` | [`code-review-0-7-2-final.md`](code-review-0-7-2-final.md) | 待实现方回复 | 已评审；V072-F1（P1）待整改 | 2026-09-14 | locked context readonly action 整改。 |
| `60571fbb26fb06731db427e17ad0b0a79e5d517e` | `fix: complete native tree P1 remediation` | [`code-review-0-7-2-final.md`](code-review-0-7-2-final.md) | 待实现方回复 | 已评审；V072-F1（P1）待整改 | 2026-09-14 | native TreeView P1 整改完成。 |
| `0861c9b1ec2dc0fa7033e3eab0dc8ec5b4636abc` | `fix: preserve locked batch restrictions` | [`code-review-0-7-2-final.md`](code-review-0-7-2-final.md) | 待实现方回复 | 已评审；V072-F1（P1）待整改 | 2026-09-14 | locked selection 的 batch Drop 限制整改。 |
| `d131d4052b4b97c682186ee3f6ac7aec793de027` | `fix: derive working AI pause policy from Git state` | [`code-review-0-7-2-final.md`](code-review-0-7-2-final.md) | 待实现方回复 | 已评审；V072-F1（P1）待整改 | 2026-09-14 | working AI paused-rebase policy 改为权威 Git state。 |
| `a3a21a61611c54cce08e6d96deb24819acda066c` | `fix: hide batch drop for locked selections` | [`code-review-0-7-2-final.md`](code-review-0-7-2-final.md) | 待实现方回复 | 已评审；V072-F1（P1）待整改 | 2026-09-14 | 当前最终候选；不批准发布，等待文档整改和独立复审。 |
| `1075328e2c4500df1adfdb1e8d0ab7fc332b2166` | `docs: align 0.7.2 native TreeView documentation` | [`code-review-0-7-2-docs.md`](code-review-0-7-2-docs.md) | — | 已评审；发现 P1，未批准发布 | 2026-09-20 | 复核 V072-F1 文档整改：Inspector 当前路径叙述已更正；仍发现旧 Webview 搜索/键盘交互被作为当前原生能力描述。 |
| `9087314e9be1f9bd1b4fed34300ce56cbde54fc2` | `chore: prepare release v0.7.2` | [`code-review-0-7-2-release.md`](code-review-0-7-2-release.md) | [`review-response-0-7-2-release.md`](review-response-0-7-2-release.md) — 0-7-2 发布回复 | 已评审；无 P0/P1 | 2026-09-20 | package/package-lock 版本更新和发布资料结构经最终独立复核。 |
| `44c6d162ac8eacd555aef50e5565e38aec61e5af` | `docs: correct native TreeView interaction guide` | [`code-review-0-7-2-release.md`](code-review-0-7-2-release.md) | [`review-response-0-7-2-release.md`](review-response-0-7-2-release.md) — 0-7-2 发布回复 | 已评审；V072-D1 整改有效，无 P0/P1 | 2026-09-20 | 删除当前文档中不可达 Webview 搜索/键盘交互承诺。 |
| `1fa107ceb200696ac01a0f52cf9fdfbefdf83b5c` | `docs: describe native generated Diff gating` | [`code-review-0-7-2-release.md`](code-review-0-7-2-release.md) | [`review-response-0-7-2-release.md`](review-response-0-7-2-release.md) — 0-7-2 发布回复 | 已评审；V072-D1 最终整改有效，无 P0/P1 | 2026-09-20 | 将残留的 Webview disabled 叙述改为活跃原生菜单与宿主复验语义。 |

> `code-review-0-7-1.md`、`code-review-0-7-2.md`、`code-review-0-7-3.md` 及对应回复保留为未发布 0.7.1 开发过程的原始独立审查证据。v0.7.1 的最终发行汇总记录为 [`code-review-0-7-4.md`](code-review-0-7-4.md) 与 [`review-response-0-7-4.md`](review-response-0-7-4.md)；本表以精确实际 SHA 作为覆盖依据。

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
| `ff260667727ba3c92dde861c74b2f594ec736ca5` | `feat: implement 0.6 rebase experience` | ✅ 已在 2026-09-09 的 `code-review-0-6-0.md` 中评审；保留此上下文作为历史记录。 |
| `02ff57da31d2f2a8a485ab7446417f8bc0caf492` | `fix: harden 0.6 rebase experience` | ✅ 已在 2026-09-09 的 `code-review-0-6-0.md` 中评审；保留此上下文作为历史记录。 |
| `612556664652601269438156fc5df8cec1ceac99` | `fix: harden 0.6 rebase experience` | ✅ 已在 2026-09-09 的 `code-review-0-6-0.md` 中评审；保留此上下文作为历史记录。 |
| `45e663a` | `fix: initialize compose panel after webview ready` | ✅ 已在 2026-09-09 的 `code-review-0-6-1.md` 中评审；保留此上下文作为历史记录。 |
| `e8a6027` | `fix: stabilize rebase panel interactions` | ✅ 已在 2026-09-09 的 `code-review-0-6-1.md` 中评审；保留此上下文作为历史记录。 |
| `6a71abb` | `fix: keep edit-stop message generation draft-only` | ✅ 已在 2026-09-09 的 `code-review-0-6-1.md` 中评审；保留此上下文作为历史记录。 |
| `ca1801d` | `fix: harden 0.6.1 panel interactions` | ✅ 已在 2026-09-09 的 `code-review-0-6-1.md` 中评审；保留此上下文作为历史记录。 |
| `06476b3050dc3b4f884663c63dbd45cd94e7a92b` | `feat: implement 0.6.2 rebase UX` | ✅ 已在 2026-09-10 的 `code-review-0-6-2.md` 中评审；保留此上下文作为历史记录。 |
| `b259d4e7a1116ab618885fb99f808bc902c9067e` | `fix: harden 0.6.2 rebase interactions` | ✅ 已在 2026-09-10 的 `code-review-0-6-2.md` 中评审；保留此上下文作为历史记录。 |
| `fba41f8d1ce1fbe351bd6c35ac0f234064d96e17` | `fix: harden 0.6.2 rebase interactions` | ✅ 已在 2026-09-10 的 `code-review-0-6-2.md` 中评审；保留此上下文作为历史记录。 |
| `03c05065fbaf5c50b274acdf46295608a6831e38` | `fix: harden 0.6.2 rebase interactions` | ✅ 已在 2026-09-10 的 `code-review-0-6-2.md` 中评审；保留此上下文作为历史记录。 |

> 未来评审覆盖上述任一 commit 时，必须在“已评审 Commit”表中新增或补充对应记录，写明完整 SHA、评审文件、回复章节、状态和日期；保留“待评审 Commit”中的历史上下文，不得直接删除。
>
> **命名约定更新（2026-09-03）**：回复文件改为按版本命名 `review-response-<major>-<minor>-<patch>.md`（如 `review-response-0-4-0.md`），替代原单一 `review-response.md`；上一版本的回复归档为 `review-response-0-3-0.md`。`CLAUDE.md` 命名规则已同步。
