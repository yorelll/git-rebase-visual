## 0-7-4 回复（对应 `code-review-0-7-4.md`）

### 评审基线与发布决定

- 发布基线：已发布 v0.7.0 `e96f60f5af700c3733ee84f38f1b1391261795e0`。
- 本次最终发布评审覆盖的新增整改 commit：`c3371b4`、`7529834`、`e2a3875`、`67352fc`、`348e84e`、`a7626f6`；初始实现及前序整改保留在 `code-review-0-7-1.md` 至 `code-review-0-7-3.md`。
- 发布规则：无 P0/P1 即可发布；P2 如有须文档记录但不阻断发布。
- 决定：内部 R71-1 P1、R72-1 P2 与后续 cross-pane inspector 问题均已修正；最终候选无已知未解决 P0/P1/P2，进入 v0.7.1 发布流程。

### 逐项决定与证据

- [x] **R71-1（P1）：Commit Inspector lifecycle。**
  - 已采用 `PanelLifecycle` lease、per-panel listener map 和真实 adapter fake regression。`close()`、native dispose、延迟旧 callback 与 extension dispose 不会复用/保留 disposed panel，也不会清空 successor。
  - 证据：`src/ui/panelLifecycle.ts`、`src/ui/commitInspectorPanel.ts`、`test/panelLifecycle.test.ts`、`test/commitInspectorPanel.test.ts`。

- [x] **R72-1（P2）：adapter lifecycle coverage。**
  - 已补充，不再仅依赖 pure ownership helper。测试实际加载 `CommitInspectorPanel`，驱动 fake VS Code panel 的 `onDidDispose`、message routing、close/reopen 和 listener cleanup。
  - 证据：`test/commitInspectorPanel.test.ts`；原始 finding/整改分别保留在 `code-review-0-7-2.md` 与 `review-response-0-7-2.md`。

- [x] **R73-1：创建 inspector 时的 focus self-close。**
  - 已改用 `{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }`；创建 companion panel 不抢占 active TextEditor，真实外部 editor click 仍走关闭桥接。
  - 证据：`src/ui/commitInspectorPanel.ts`、`test/commitInspectorPanel.test.ts`。

- [x] **R74-1：hover detail 未显示。**
  - preview 现在实际显示在 editor-area inspector，且 payload 不含 mutation/action buttons；右键 action 继续显示完整操作。
  - 证据：`src/ui/rebaseViewProvider.ts`、`src/ui/commitInspectorPanel.ts`、`test/webviewDom.test.ts`。

- [x] **R75-1：slow preview / queued dismiss 覆盖 action。**
  - 已增加 preview/single/batch action session coordinator；只有当前 owner 可显示/关闭 panel。
  - 证据：`src/ui/inspectorPreviewState.ts`、`test/inspectorPreviewState.test.ts`。

- [x] **R76-1：inspector action 因 panel focus 自关闭。**
  - 只在 concrete TextEditor active/selection event 关闭 inspector；undefined active editor 不构成外部 interaction 证据。
  - 证据：`src/ui/inspectorDismissPolicy.ts`、`test/inspectorDismissPolicy.test.ts`。

- [x] **R77-1：跨界面 preview 不可阅读。**
  - mouseleave 只取消尚未触发的 hover timer；已显示 preview 保持，以便移动到右侧阅读/复制。
  - 证据：`media/main.js`、`test/webviewDom.test.ts`。

- [x] **R78-1/R78-2/R78-3：Refresh feedback、untracked 删除重验和 preview 文案。**
  - command/title Refresh 走 `refreshFromCommand()` 显示“已刷新”；删除未跟踪文件在 modal 后重新读取 porcelain；preview 说明与实际 persistent behavior 一致。
  - 证据：`src/extension.ts`、`src/ui/refreshFeedbackPolicy.ts`、`src/ui/rebaseViewProvider.ts`、`test/refreshFeedbackPolicy.test.ts`、`test/worktreeChanges.integration.test.ts`。

### 未改变 / 延后项

- [ ] **真实 VS Code 人工体验验收。**
  - 原因：自动化运行环境无法可靠启动目标 VS Code、主题、输入法和实际指针设备；该边界已记录在 `docs/ui-reivew/ui-review-0-7-1.md`。它不是已确认的 P0/P1，且不改变现有安全校验或发布门禁。

### 发布门禁

发布前在最终整合 `main` 执行：

```bash
npm ci
npm run test:release
npm run package
git diff --check
```

随后检查 VSIX 仅包含 runtime 必需文件，并推送 `main` 与 annotated `v0.7.1` tag，等待 GitHub Actions 重新执行同等门禁并创建 Release。
