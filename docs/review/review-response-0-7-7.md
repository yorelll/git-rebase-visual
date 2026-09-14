## 0-7-7 回复（对应 `code-review-0-7-7.md`）

### 内部整改说明与决定

- 本文件对应主 agent 即将归档的内部补充报告 `code-review-0-7-7.md`；它是未发布 **0.7.1** 开发过程的整改轮次，不代表 v0.7.7，不创建或授权任何 0.7.7 release。
- 评审基线：已发布 v0.7.0 `e96f60f5af700c3733ee84f38f1b1391261795e0`；此前 cross-pane preview 和 ownership 修正见 `6840489`、`93a6e22`、`5e9f399`。
- 本回复仅处理 cross-pane hover preview 过早自动关闭的问题；未修改任何 B 报告或 review ledger。
- 决定：preview 不再在 sidebar mouseleave 后自动关闭。它保持在右侧 editor area，直到下一条 preview 替换、右键 explicit action 替换、或真实 external TextEditor interaction 关闭，因此用户可移动到并阅读/复制完整 message。整改提交仍须后续独立 review 覆盖。

### R77-1 — Cross-pane hover preview 在 mouseleave 后过早关闭

- [x] **已修正。**
- 根因：sidebar commit `mouseleave` 在 180ms 后发送 `dismissCommitPreview`，host 随后关闭 inspector。由于 preview 位于另一个 editor area，用户必须离开 sidebar 才能移动到右侧阅读或复制，导致 message 在到达前消失。
- 实现：
  - `cancelTooltip()` 只取消尚未触发的 400ms hover request，不再发送 dismiss/timer close。
  - host 对旧 `dismissCommitPreview` 保持兼容但不关闭 cross-pane preview。
  - preview 生命周期由已存在的 ownership coordinator 管理：下一条 preview 更新它，explicit single/batch action 接管它，真实 external TextEditor/selection interaction 关闭并 invalidate 它。
  - 保留 preview non-obscuring、preserveFocus、action panel 及 async ownership protection。
- 回归：jsdom test 在 hover request 后触发 mouseleave 并等待超过原 180ms grace，断言不发送 dismissal；adapter/ownership tests 保持跨-pane preview visible/action replacement/close bridge coverage。

### 验证

| 命令 | 结果 |
| --- | --- |
| focused preview + adapter + DOM + protocol + lifecycle + real Git tests | **25/25 通过**。 |
| `npm run typecheck` | 通过。 |
| `npm test` | **130/130 通过**（约 397 秒）。 |
| `npm run compile` | 通过。 |
| `node --check media/main.js` / `git diff --check` | 通过。 |

### 人工验收边界

- [ ] hover commit → 移动鼠标到右侧 inspector → 阅读并复制长 message，确认 preview 保持；hover 下一个 commit 确认内容更新。
- [ ] preview 存在时右击 single/batch action、点击正常 TextEditor/selection、重新打开 inspector 的完整 lifecycle。
- [ ] review5 其余 IME、pointer/触控、SCM header action、High Contrast 与 screen reader 验收。
