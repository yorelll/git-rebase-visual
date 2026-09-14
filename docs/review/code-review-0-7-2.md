# Git Rebase Visual — 补充独立代码评审报告（0.7.2）

> **内部审查轮次说明**：本文档名中的 `0.7.2` 是未发布 **0.7.1** 开发过程中的第二轮独立审查编号，**不代表 v0.7.2，也不创建或授权任何 0.7.2 release**。0.7.1 的最终发布记录仍须由主 agent 汇总。
>
> **评审基线**：已发布 v0.7.0 `e96f60f5af700c3733ee84f38f1b1391261795e0`。
>
> **前序报告 / 回复**：[`code-review-0-7-1.md`](code-review-0-7-1.md) 的 R71-1；[`review-response-0-7-1.md`](review-response-0-7-1.md)。
>
> **本次独立复核提交**：`853f26ab8b3219a95d5467dd847e0729e847974c` — `fix: stabilize commit inspector lifecycle`。
>
> **输入**：review5 的全部 9 张参考图、R71-1 复现路径、commit diff、panel ownership/dispose call path、focused DOM/真实 Git 测试和完整套件。
>
> **结论**：R71-1 的**功能性 P1 已修正**，未发现新的 P0/P1。`PanelLifecycle` lease 与 `CommitInspectorPanel` 的 per-panel listener map 正确消除了 close → reopen 过程中的 stale disposed panel 和旧 dispose callback 清理 successor 的风险。发现 1 项 P2 自动化覆盖缺口（R72-1）：现有 regression 验证纯 lifecycle helper，尚未 mock/驱动 `CommitInspectorPanel` 的真实 `WebviewPanel.onDidDispose` adapter 路径。它不否定本轮 P1 修正，但应在发布前补充或在真实 VS Code 连续操作中完成针对性验收。

---

## 1. 发布裁决

- [x] **R71-1 P1 已修正并独立复核。** 关闭 inspector 后的后续右键/键盘 Context Menu 可以获得新的 panel ownership；旧 callback 不会清空 successor。
- [x] **未发现新的 P0/P1。**
- [ ] **R72-1 P2 测试覆盖待补。** 需覆盖具体 `CommitInspectorPanel` adapter 的 native dispose → close/reopen，而不能仅覆盖其抽出的 pure lease helper；或在真实 VS Code 中完成等价、可记录的连续循环验收。
- [ ] **发布前人工验收仍必需。** IME、pointer/触控 drag、SCM header action/confirmation/staged AI、High Contrast、screen reader、窄窗口和多 editor group 的 inspector close/reopen。

---

## 2. R71-1 复核

### R71-1 — P1：关闭 Commit Inspector 后无法可靠重开

- [x] **已修正。**

**原问题**：首次 panel 的 `onDidDispose` 被放入 class-level disposable collection；第一次 editor-area close 销毁其自身 callback，后续新 panel 没有 native cleanup，`this.panel` 可保留 disposed object，导致后续右键/详情无法重开。

**修正实现**：

- `src/ui/panelLifecycle.ts` 新增带 id 的 `PanelLease`。`release()` 幂等，并且仅当 lease 仍是 active 时清空 current；延迟到达的旧 native dispose 不会清除 successor。
- `src/ui/commitInspectorPanel.ts` 不再共享所有 native listener。每个 `WebviewPanel` 由自身 lease ID 对应 `panelDisposables`；native `onDidDispose` 仅 release 当前 lease 并清理该 panel 的 listener collection。
- `close()` 只 dispose 当前 panel；下一次 `open()` 在 lifecycle current 为空时创建新 `WebviewPanel`，并重新注册 listener/HTML。
- `dispose()` 可与 native dispose 重复调用，listener cleanup 为 map-key scoped/idempotent。

**复核结果**：通过。close → reopen → delayed old dispose → close → reopen 的 ownership 状态机满足 R71-1；没有发现旧 callback 清空新 panel 或重复 cleanup 的路径。

---

## 3. Finding

### R72-1 — P2：R71-1 的 regression 仅覆盖抽象 lease，不直接验证 `CommitInspectorPanel` 的 VS Code adapter wiring

- [ ] **待补充自动化覆盖；不阻止本轮 P1 功能修正。**

**位置**：`test/panelLifecycle.test.ts:5-23`；关联实现 `src/ui/commitInspectorPanel.ts:47-88`。

**问题**：新增 test 正确覆盖了 `PanelLifecycle` 的 open → release → successor → delayed old release → reopen。然而它没有构造 fake `vscode.WebviewPanel`，因而不直接执行 `CommitInspectorPanel.open()` 中：

```ts
panel.onDidDispose(() => {
  lease.release();
  this.disposePanelListeners(lease.id);
});
```

以及真实 adapter 的 `close()` → panel.dispose() → native callback → second `open()` 链路。R71-1 正是该 adapter 生命周期错误，而非单独的 pure ownership 算法；仅 helper test 虽能证明核心逻辑，却不能防止 panel listener wiring 被未来改坏。

**要求**：

1. 建立最小 fake VS Code panel/webview harness，或把 adapter listener binding 再抽成可注入单元；覆盖至少三轮：open → host close → open → native delayed old dispose → current preserved → close → open。
2. 断言每轮重新注册 message/dispose listener、`postMessage(show)` 到正确新 panel，旧 panel 的 dispose 不影响 successor，map listener 数不累积。
3. 保留真实 VS Code 人工走查作为补充，而不是把 Node helper test 描述为真实 UI lifecycle 测试。

---

## 4. review5 需求复核状态

本轮只对 R71-1 整改重新审查；以下结论沿用前一轮并检查本次整改未回退：

| 需求 | 本轮状态 |
| --- | --- |
| 1. routine refresh 不应令正常 drag stale | [x] 无回退；canonical snapshot/revision 在 routine status refresh 下保持稳定，host revision/order/lock 复验仍在。 |
| 2. 顶部重复 batch actions | [x] 无回退。 |
| 3. editor-area click 关闭 context surface | [x] close bridge 仍使用公开 VS Code editor/window events；R71-1 修正后可重新打开。真实 editor area 行为仍需人工验收。 |
| 4–8. SCM 路径/overlay/row Diff/restore-delete/header bulk/staged AI | [x] 无回退；真实 Git integration tests 通过。 |
| 9. Refresh inline “已刷新” | [x] 无回退。 |
| 10–11. compact locked summary / expanded rail | [x] 无回退。 |
| 12. edit action first | [x] 无回退。 |
| 13. cross-pane inspector | [x] ownership修正后可在 repeated close/reopen 生命周期中继续使用；R72-1 仅要求补 adapter regression。 |
| 16. Alt+Arrow | [x] 评估结论不变：focused row 的 extension path 已处理；编辑器/list/terminal 的系统 keybinding 竞争不应被插件抢占。 |

---

## 5. 独立验证证据

已查看 review5 全部参考图：`选中多个右键.png`、`文件暂存管理界面.png`、`参考vscode文件暂存管理界面.png`、`vscode工作区1.png`、`vscode工作区2.png`、`长黄线参考1.png`、`message显示界面.png`、`跨界面显示.png`、`vscode快捷键.png`。

| 命令 / 方法 | 结果 |
| --- | --- |
| `git diff 8a61f65..853f26a` + lifecycle source path inspection | 确认 R71-1 改为 lease + per-panel listener collection，未见 P0/P1 回归。 |
| `npx tsx --test test/panelLifecycle.test.ts test/webviewDom.test.ts test/canonicalSnapshot.test.ts test/worktreeChanges.integration.test.ts` | **13/13 通过**。 |
| `npm run typecheck` | 通过。 |
| `npm test` | **125/125 通过**，约 383 秒。 |
| `npm run compile` | 通过。 |
| `node --check media/main.js` | 通过。 |
| `git diff --check` | 通过。 |

---

## 6. 后续要求

1. Agent A 应创建新的整改提交处理 R72-1，或主 agent 在真实 VS Code 按第 3 节的连续 close/reopen 场景完成并记录人工验收；不得修改本报告。
2. 若出现新的 implementation commit，该 commit 不自动成为已评审提交，必须由不同 reviewer 进行后续独立复核。
3. 在 R72-1 的自动化或明确人工验收闭环前，发布说明不得声称 Commit Inspector lifecycle 已实现完整端到端自动覆盖。
