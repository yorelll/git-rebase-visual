## 0-7-3 回复（对应 `code-review-0-7-3.md`）

### 内部整改说明与决定

- 本文件对应主 agent 即将归档的内部补充报告 `code-review-0-7-3.md`；它是未发布 **0.7.1** 开发过程的整改轮次，不代表 v0.7.3，不创建或授权任何 0.7.3 release。
- 评审基线：已发布 v0.7.0 `e96f60f5af700c3733ee84f38f1b1391261795e0`；相关 inspector lifecycle 实现来自 `853f26a`，adapter regression 来自 `3a247aa`。
- 本回复仅处理主 agent 发现的 inspector self-close 问题；未修改任何 B 评审报告或 review ledger。
- 决定：已修正为使用 VS Code `createWebviewPanel` 的 supported `showOptions` 形式，并传入 `preserveFocus: true`。整改提交仍须接受后续独立 review，才可作为 0.7.1 发布闭环的一部分。

### R73-1 — 创建 inspector 自身触发 active-editor close bridge

- [x] **已修正。**
- 根因：`createWebviewPanel(..., ViewColumn.Beside, webviewOptions)` 没有 `preserveFocus`，新 inspector 可成为 active editor；`RebaseViewProvider` 的 `onDidChangeActiveTextEditor` 正确地用于处理用户点击外部 editor，但会无条件调用 `inspector.close()`。因此 inspector 有可能在首次右键创建时立刻关闭自身。
- 实现：`CommitInspectorPanel.open()` 改用 public VS Code API 的 `showOptions`：
  ```ts
  { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }
  ```
  这会在已激活 editor 旁打开 inspector，但不改变 active editor；用户随后实际点击不同 editor 时，既有 host bridge 仍会关闭 inspector。
- 具体 adapter regression 已扩展：fake VS Code factory 断言第一次 `createWebviewPanel` 接收 `{ viewColumn: 2, preserveFocus: true }`，并确认创建后 panel 未 dispose；随后显式模拟外部 editor change 调用 close，再完整验证 reopen、delayed old dispose、listener/postMessage 不累积。

### 验证

| 命令 | 结果 |
| --- | --- |
| `npx tsx --test test/commitInspectorPanel.test.ts` | 通过；覆盖 preserveFocus create options、host close、native dispose、reopen 与 listener/postMessage 边界。 |
| `npm run typecheck` | 通过。 |
| `npm test` | **126/126 通过**（约 374 秒），包含 preserveFocus adapter regression。 |
| `npm run compile` | 通过。 |
| `node --check media/main.js` / `git diff --check` | 通过。 |

### 人工验收边界

- [ ] 真实 VS Code：右击 commit 打开 inspector 时，现有 editor 仍保持 active，inspector 保持显示；随后点击另一个 editor area / 改变 selection，inspector 关闭；再次右击可重新打开。
- [ ] 多 editor group、inspector tab 显示/隐藏、extension reload 与 keyboard Context Menu/Shift+F10 路径。
- [ ] 继续完成 review5 已列的 IME、pointer/触控、SCM bulk action、High Contrast 与 screen reader 验收。
