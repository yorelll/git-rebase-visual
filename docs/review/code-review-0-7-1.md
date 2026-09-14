# Git Rebase Visual — 代码评审报告（0.7.1）

> **评审基线**：`e96f60f5af700c3733ee84f38f1b1391261795e0`（已发布 v0.7.0）。
>
> **本次独立评审提交**：`8a61f6549117b9729f2f269ddc173e76bc085512` — `feat: refine review5 rebase interactions`。
>
> **评审输入**：用户 review5 的 9 张截图、全部 16 项需求、提交源码与真实 Git/jsdom 回归。已实际查看：`选中多个右键.png`、`文件暂存管理界面.png`、`参考vscode文件暂存管理界面.png`、`vscode工作区1.png`、`vscode工作区2.png`、`长黄线参考1.png`、`message显示界面.png`、`跨界面显示.png`、`vscode快捷键.png`。
>
> **结论**：发现 **1 项 P1 发布阻止问题**。R71-1 使 inspector 关闭后无法再次打开，并会让公开 editor-area 操作面板失效；因此当前提交**不可发布**。其余 review5 的核心实现已得到源码、DOM/真实 Git 回归验证，Alt+Arrow 的 VS Code keybinding 评估结论合理，但仍需真实 VS Code 人工验收。

---

## 1. 发布裁决

- [ ] **不可发布。** 必须修复 R71-1，并由后续独立 review 复核整改提交。
- [x] 未发现 P0。
- [ ] 发布前仍需在真实 VS Code 完成 IME、pointer/触控拖拽、inspector editor-group 生命周期、SCM header hover/bulk confirmation、High Contrast 与 screen reader 走查；Node/jsdom 不能替代这些体验验收。

---

## 2. Finding

### R71-1 — P1：关闭 Commit Inspector 后会释放一个仍被复用的 WebviewPanel，并使后续右键/详情操作崩溃

- [ ] **未修复；发布阻止。**

**位置**：`src/ui/commitInspectorPanel.ts:47-74`，调用路径 `src/ui/rebaseViewProvider.ts:185-195`、`2212-2270`。

**根因**：`CommitInspectorPanel.open()` 第一次创建 panel 后，把 `panel.webview.onDidReceiveMessage(...)` 和 `panel.onDidDispose(...)` 放入类级 `this.disposables`。当用户点击任意编辑器区域，provider 的 `onDidChangeActiveTextEditor` / `onDidChangeTextEditorSelection` 会调用 `this.inspector.close()`；`panel.dispose()` 触发 `onDidDispose`，其中执行：

```ts
while (this.disposables.length) this.disposables.pop()!.dispose();
```

这会把刚刚触发的 `onDidDispose` listener 本身也 dispose。下一次右键调用 `open()` 时，新的 listener 仍会被 push 到同一个数组；但再次关闭时，旧的 `onDidDispose` listener 已不存在，新的 panel 没有任何 dispose cleanup。`this.panel` 因而持续指向已 dispose 的 WebviewPanel，随后右键 `open()` 只会执行 `postMessage()` 而不会重建 editor-area panel。公开的右键/详情入口从此不再显示检查器，且其内部 listener 会泄漏。

**复现**：

1. 在侧边栏右击任意 commit，打开 editor-area **Git Rebase · Commit** inspector。
2. 点击任意 editor 或改变 editor selection；需求 3 的关闭桥接会 dispose inspector。
3. 再次右击任意 commit。
4. 不会重新打开 inspector；后续切换/关闭重复后，listener 继续累积。

这是需求 3 与 13 的组合回归：首次外部点击能够关闭，但该正确关闭会破坏后续 context/detail 操作。

**必须修复**：

1. 将每个 panel 实例的 listener/disposable 生命周期与 extension-level `CommitInspectorPanel` 生命周期分离。dispose 当前 panel 时仅清理当前 panel 的 listener，并清空 `panel`；不得销毁用于后续 panel 的 class-level ownership state。
2. 追加实际 lifecycle regression：open → host close → open → host close → open，断言每次均创建/显示有效 panel，`panel` 被正确清空，且 listener 不累积。
3. 保持 editor-area click 关闭、right-click/keyboard Context Menu 重新打开、以及 inspector 内 keyboard/focus 行为。

---

## 3. 已验证的 review5 需求

| 用户需求 | 结论与证据 |
| --- | --- |
| 1. 正常拖拽不应因轮询刷新 false stale | [x] `canonicalSnapshotKey` 仅纳入 repo/branch/range/rebase/hash order/locks；`canonicalRevision` 不再由 worktree/presentation poll 增加。`test/canonicalSnapshot.test.ts` 与 jsdom pointer/native drag same-revision refresh 覆盖通过；host 仍在确认前后重验 revision/order/lock。 |
| 2. 去除顶部重复批量操作 | [x] `media/main.js` 移除了 controls 内 bulk lock/drop；batch action 在 editor-area inspector 保留。DOM test 验证 `.list-controls .btn` 为 0。 |
| 3. editor 点击关闭上下文操作 | [ ] 首次关闭桥接采用公开 VS Code editor/window events，方向正确；但 R71-1 使关闭后的再次打开失效。 |
| 4–6. SCM 路径、hover action、Diff 行点击 | [x] file row 静止时路径可用空间展示，hover/focus action absolute overlay；file target title 为 path；冗余 open icon 移除，行点击仍发 `openWorktreeDiff`。DOM test 覆盖。 |
| 7. 单文件 restore/delete | [x] webview 不再二次 `confirm()`；action pointer/click stop propagation，host fresh porcelain + modal confirmation 后执行。integration test 覆盖 restore/untracked delete，DOM 确认 delete wording 为“删除未跟踪文件”。 |
| 8. SCM header actions 与 staged AI | [x] Changes 有 stage-all/discard-all，Staged Changes 有 unstage-all/AI compose；均为 mutation，host fresh status + confirmation（discard/unstage）处理。staged apply 使用既有 `commitIndex()`，不会 stage working tree。真实 Git test 覆盖 stage/discard/unstage 边界。真实 VS Code modal/AI flow 仍待手动验收。 |
| 9. Refresh feedback | [x] `refresh` completion 调用既有 inline toast `已刷新`；branch context overlay 不改变 document flow。 |
| 10. Compact lock summary | [x] 输出 `🔒 :N lock · no push · xx ×N`，移除 hash range；title/ARIA 保留完整作者信息。DOM test 覆盖。 |
| 11. expanded long yellow rail | [x] `.locked-run[open]` 透明化左 rail；individual locked rows 保留短 marker，collapsed summary 保留 rail。 |
| 12. edit 排首位 | [x] inspector 的“变基与编辑”第一项为 primary `停靠在此 (edit)`。 |
| 13. 不遮挡 commit 列表的详情/右键 | [ ] Inspector 采用 `WebviewPanel` + `ViewColumn.Beside`，不是 sidebar fixed tooltip/menu，视觉策略符合跨界面参考；但 R71-1 阻断其重复使用。hover preview 不会遮挡列表。 |
| 16. Alt+Arrow | [x] 评估正确：webview focused row 中 handler 已 `preventDefault()`、基于 immutable session 发送 intent；截图显示多个 VS Code 全局 bindings 会在 editor/list/terminal 等 `when` 条件优先消费。焦点不在 commit row 时扩展不应抢占。未发现须修改的 extension logic defect。 |

---

## 4. 验证证据

| 命令 | 结果 |
| --- | --- |
| CodeGraph exploration（跨 worktree 提示后以实际 commit source 复核） | 完成；审查 canonical snapshot、provider/inspector、SCM action、mutation gate、reorder 与 DOM 路径。 |
| `npx tsx --test test/webviewProtocolState.test.ts test/mutationGate.test.ts test/webviewDom.test.ts test/canonicalSnapshot.test.ts test/worktreeChanges.integration.test.ts` | **19/19 通过**。 |
| `npm run typecheck` | 通过。 |
| `npm test` | **124/124 通过**，约 410 秒。 |
| `npm run compile` | 通过。 |
| `node --check media/main.js` | 通过。 |
| `git diff --check` | 通过。 |
| 源码生命周期审查 | 确认 R71-1：`CommitInspectorPanel` 第一次 dispose 销毁自身 `onDidDispose` listener，随后 panel 无法正确重建/清理。 |

---

## 5. 后续要求

1. Agent A 只修复 R71-1，并为 close → reopen → close → reopen panel lifecycle 加入可执行 regression；不得修改本报告或既有报告。
2. Agent A 创建 `review-response-0-7-1.md`，逐项记录 R71-1 的决定、实现、测试和真实 VS Code 手动验收边界。
3. 整改提交不会自动成为已评审 commit，须由新的独立 reviewer 复核后才可解除发布阻止。
