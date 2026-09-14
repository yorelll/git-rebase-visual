## 0-7-6 回复（对应 `code-review-0-7-6.md`）

### 内部整改说明与决定

- 本文件对应主 agent 即将归档的内部补充报告 `code-review-0-7-6.md`；它是未发布 **0.7.1** 开发过程的整改轮次，不代表 v0.7.6，不创建或授权任何 0.7.6 release。
- 评审基线：已发布 v0.7.0 `e96f60f5af700c3733ee84f38f1b1391261795e0`；preview/action ownership 修正见 `93a6e22`。
- 本回复仅处理 inspector action panel 因焦点事件 self-close 的问题；未修改任何 B 报告或 review ledger。
- 决定：host close bridge 现在只在可证明为真实外部 `TextEditor` 交互时关闭 inspector；WebviewPanel 自身 focus 造成的 `activeTextEditor === undefined` 不再关闭 action panel。整改提交仍须后续独立 review 覆盖。

### R76-1 — Inspector focus 触发 active-editor bridge 时可能自关闭

- [x] **已修正。**
- 根因：`onDidChangeActiveTextEditor` 和 `onDidChangeTextEditorSelection` 无条件关闭 inspector。WebviewPanel 获得焦点时，VS Code 可能将 activeTextEditor 变为 `undefined` 或产生非 TextEditor focus transition；该 transition 不是用户点击普通 editor，却会在 action button 操作前关闭 inspector。
- 实现：新增 `src/ui/inspectorDismissPolicy.ts`：
  - `shouldDismissInspectorForActiveTextEditor(editor)` 仅在 `editor` 存在时为 true；undefined 表示 inspector/webview focus，不关闭。
  - `shouldDismissInspectorForTextEditorSelection(event)` 仅在 event 提供 source `textEditor` 时为 true。
  - provider 仍始终向 sidebar 发送 `closeMenu`，但只在上述 predicate 证明真实 external TextEditor/selection interaction 时 invalidate preview coordinator 并关闭 inspector。
- 回归：`test/inspectorDismissPolicy.test.ts` 覆盖 inspector focus 的 undefined/no-editor path 不关闭，以及右侧正常 TextEditor active/selection event 关闭。该 policy 与 preserveFocus、panel lifecycle、preview/action coordinator 一起保持 action button 可用且满足用户要求的正常 editor click-to-close。

### 验证

| 命令 | 结果 |
| --- | --- |
| focused dismiss policy + preview/action + adapter + DOM + protocol + real Git tests | **25/25 通过**。 |
| `npm run typecheck` | 通过。 |
| `npm test` | **130/130 通过**（约 368 秒），包含 inspector focus/external editor close policy regression。 |
| `npm run compile` | 通过。 |
| `node --check media/main.js` / `git diff --check` | 通过。 |

### 人工验收边界

- [ ] 右击打开 inspector，点击 inspector 内 action button，确认 panel 保持直到 action 完成/用户关闭。
- [ ] 右击打开 inspector 后点击右侧普通 TextEditor 或在该 editor 改变 selection，确认 inspector 关闭；随后右击可重新打开。
- [ ] WebviewPanel focus、multiple editor groups、hover preview 到 explicit action、IME/pointer/SCM/High Contrast/screen reader 全量 review5 验收。
