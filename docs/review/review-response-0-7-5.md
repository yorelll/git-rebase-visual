## 0-7-5 回复（对应 `code-review-0-7-5.md`）

### 内部整改说明与决定

- 本文件对应主 agent 即将归档的内部补充报告 `code-review-0-7-5.md`；它是未发布 **0.7.1** 开发过程的整改轮次，不代表 v0.7.5，不创建或授权任何 0.7.5 release。
- 评审基线：已发布 v0.7.0 `e96f60f5af700c3733ee84f38f1b1391261795e0`；此前 hover preview 实现见 `6840489`。
- 本回复仅处理 preview/action async ownership race；未修改任何 B 报告或 review ledger。
- 决定：已加入显式 preview/action session ownership，防止慢速 hover detail 或 queued dismiss 覆盖/关闭右键 action inspector。整改提交仍须后续独立 review 覆盖。

### R75-1 — 异步 hover preview/dismiss 可能覆盖或关闭明确 action inspector

- [x] **已修正。**
- 风险：`requestDetail` 需要异步 `commitDetail()`；右键 single action inspector 若在 await 期间打开，晚到 preview 原本可能覆盖 action panel。类似地，旧 hover leave 的 queued dismiss 原本可能关闭后来打开的 single/batch action inspector。
- 实现：新增 `InspectorPreviewCoordinator`，为 preview 和 explicit single/batch action 分配不可混淆 session：
  - preview 只有仍是 current pending owner 时才能显示；slow detail 结果不再覆盖 action。
  - explicit action 接管 owner 后，hover 不能替换 action inspector。
  - dismiss 包含 hover hash，仅能 transition/close其匹配 preview session；queued timer 在 close 前再次验证 owner，不能关闭 successor action panel。
  - editor/selection external close 明确 invalidate coordinator，允许下一次 hover/action 开始新 session。
- 回归：`test/inspectorPreviewState.test.ts` 覆盖 `requestDetail → openCommitInspector`、`dismiss preview → open batch action`、hover-to-hover replacement 与 external invalidation；现有 jsdom/adapter tests 保持 hover request/dismiss、cross-pane panel delivery、preserveFocus、close/reopen 和 listener cleanup 覆盖。

### 验证

| 命令 | 结果 |
| --- | --- |
| focused preview/action state + adapter + DOM + protocol + real Git tests | **24/24 通过**。 |
| `npm run typecheck` | 通过。 |
| `npm test` | **129/129 通过**（约 407 秒），包含 preview/action interleaving regressions。 |
| `npm run compile` | 通过。 |
| `node --check media/main.js` / `git diff --check` | 通过。 |

### 人工验收边界

- [ ] 在慢速大型 commit detail 情况：hover A 后立即右击 B，确认 B 的 action inspector 不被 A preview 覆盖；随后移开 A 也不关闭 B。
- [ ] 右键 single/batch inspector、hover preview、外部 editor close/reopen、不同 editor group 下连续操作。
- [ ] review5 的 IME、pointer/触控、SCM header action、High Contrast 与 screen reader 验收。
