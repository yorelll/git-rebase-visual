# Code Review — 0.7.2 Documentation Remediation

## 基线与范围

- **评审日期**：2026-09-20
- **已发布基线**：`4a1e2088ee5c83202eab9e17ad83f5372dbf21e3`（`chore: release v0.7.1`）
- **本次精确候选**：`1075328e2c4500df1adfdb1e8d0ab7fc332b2166`（`docs: align 0.7.2 native TreeView documentation`）
- **本次变更范围**：`1075328e^..1075328e`，仅改动 `README.md`、`RELEASE.md`、`docs/summary/summary.md` 并新增 `docs/release-notes/0.7.2.md`。
- **前序结论**：`a3a21a61611c54cce08e6d96deb24819acda066c` 的独立最终审查指出 P1 `V072-F1`：README 和当前架构总结仍将已移除的 editor-area Commit Inspector 描述为当前行为。本报告只复核该文档整改 commit，不改写历史报告。
- **台账检查**：评审开始前已阅读 `docs/review/code-review-commit.md`；其中没有 `1075328e2c4500df1adfdb1e8d0ab7fc332b2166` 的精确 SHA 记录。
- **视觉输入**：已检查 `pic_ref/review6/右键直接显示在编辑区.png`。截图中右侧的 `Git Rebase` editor Tab 是被本版本替代的旧行为，不是当前目标 UI。

## 结论

**不批准发布。** `V072-F1` 所指的 Inspector 叙述已经在本次变更涉及的文档中得到纠正：当前 README、架构总结、发布说明和 `RELEASE.md` 均明确说明 commit hover/context 由原生 TreeView tooltip/context menu 提供，且 Commit Inspector 不是激活用户路径。

但是本次对当前文档与激活实现的复核发现一项新的 **P1**：README 和架构总结仍把已随 Webview UI 迁移而失去可达性的搜索、IME 搜索、键盘 pickup/drop、右键目标重定向以及 Webview 置灰语义描述为当前功能。`package.json` 只贡献 `gitRebaseVisual.commits` 原生 TreeView；`extension.ts` 只创建 `createTreeView()`；`RebaseViewProvider` 不注册 WebviewView provider，也未将 `commitSearch`/`oneStepReorderIntent` 接入活跃 UI。用户将被错误引导到不存在的搜索输入与键盘操作，因此不满足发布前“当前文档准确”的要求。

- **P0**：0 项
- **P1**：1 项未解决
- **P2**：1 项记录
- **发布决定**：依照“无 P0/P1 才可发布”阈值，**阻止 v0.7.2 发布**。

## 已确认的整改

- [x] **V072-F1 已修复（本次修改范围内）**：
  - `README.md` 将旧的“约 0.4 秒后在 editor-area `Git Rebase · Commit` Inspector 展示详情/操作”替换为原生 TreeView tooltip、原生 context menu 和普通点击只选择。
  - `docs/summary/summary.md` 将当前架构更新为 `NativeCommitTreeProvider` + `vscode.window.createTreeView()`，并明确 `CommitInspectorPanel` 是历史、非激活源码；ComposePanel 是唯一仍用于编辑/生成 message 的 editor-area WebviewPanel。
  - `docs/release-notes/0.7.2.md` 和 `RELEASE.md` 的 0.7.2 项准确说明原生 hover/context、多选、end boundary DnD、working/staged AI、锁定摘要和未跟踪文件确认后的 porcelain 重验证。
- [x] **当前实现一致性已静态核验**：
  - `src/ui/rebaseViewProvider.ts` 创建 `vscode.window.createTreeView()`，并由 `NativeCommitTreeProvider` 提供行项目；`src/extension.ts` 注册的是原生菜单命令。
  - `src/ui/nativeCommitTree.ts` 不为 commit 行配置默认 command，因此普通点击不会打开 Diff/editor；tooltip 的 Git 派生值均使用 `MarkdownString.appendText()`。
  - `src/ui/rebaseViewProvider.ts` 的 native DnD 对 `target === undefined` 使用 `nativeTreeDropAtEndIntent()`；未跟踪删除在 modal 确认后再次读取并验证 porcelain 状态。
- [x] **发布资料结构一致**：0.7.2 release note 标题符合 CI 的 `## Git Rebase Visual 0.7.2` 要求，`RELEASE.md` 有 `**0.7.2**` 更新项，且没有模板占位符。

## P1 发现

### [ ] V072-D1 — 当前文档仍将失去可达性的 Webview 搜索与键盘交互当作原生 TreeView 功能

**位置**：

- `README.md:79-85,94`
- `docs/summary/summary.md:38,40-41`

**复现**：安装该候选版本，打开 `Git Rebase: Commits` 原生 TreeView。尝试按文档寻找 `author:`/`msg:`/`hash:0x` 搜索输入，使用 IME 搜索，使用 Space/Arrow/Home/End/Escape pickup/drop 或 `Alt+↑/↓` 重排，或期待右击未选行会先重置当前多选、非连续 Generated Diff 被 Webview 置灰。

**实际结果**：这些描述对应 `media/main.js` 与未接入的 `commitSearch`/`oneStepReorderIntent` 辅助代码；当前激活路径没有 `registerWebviewViewProvider`/`resolveWebviewView`，也没有搜索控件或这些键盘 handler。原生 TreeView 只提供原生选择、context menu 与 DnD；可达菜单的连续性以 `contextValue` 控制，而非 Webview 提示/置灰。

**影响**：用户会根据 README 和当前架构摘要寻找不存在的控件或触发不存在的键盘交互。这个错误与 V072-F1 一样属于将旧 UI 行为作为当前行为来记录，发布说明“当前原生 TreeView”与实际体验不一致。

**修复要求**：在新的文档整改 commit 中删除或明确标为历史/非激活的上述 Webview 专属行为；若计划保留这些能力，则需要先将等效搜索、键盘重排和相关可访问性行为实现并测试到活跃 TreeView。完成后必须对新 SHA 再做独立审查。

## P2 / 人工验收边界

### [ ] V072-D2 — 原生 Workbench 浮层体验仍需在真实 Extension Development Host 手工确认

当前代码架构使用 VS Code 原生 TreeView/context menu/tooltip，符合不从 Webview iframe 尝试跨边界绘制的实现方向；静态审查不能替代 Workbench 运行时验证。发布前应在真实 Extension Development Host 记录：右键菜单与 tooltip 的指针锚定/跨 sidebar-editor 边界、Esc 与点击外部关闭、不激活 editor Tab、Ctrl/Cmd 多选、end-boundary DnD、未跟踪文件确认期间状态变化、锁定/批量菜单限制。

该项按既定发行阈值为 P2，不单独阻止发布；本报告的发布阻塞来自 V072-D1。

## 需求与资料核对

| 项目 | 结论 | 证据 |
|---|---|---|
| 不再把截图中的右侧 Inspector Tab 当作当前 hover/context 实现 | 通过 | 本次修改的 README/summary/release docs 明确原生 TreeView；`createTreeView()` 激活路径未接回 Inspector。 |
| 原生 tooltip/context、无默认 commit click command | 通过（静态） | `nativeCommitTree.ts` 的 literal tooltip 和无 `item.command` 的 commit 行；manifest `view/item/context` 菜单。 |
| working/staged AI、末端拖拽、未跟踪删除、锁定摘要的 release 说明 | 通过（静态） | release note 与 `RELEASE.md` 同源描述，分别对应 host compose policy、native end intent、fresh status revalidation、`🔒 : N lock`。 |
| 当前文档不再承诺旧 Webview 控件/行为 | **未通过** | V072-D1：README/summary 仍称搜索、IME、键盘 pickup/drop、右击重定向与 Webview 置灰为当前能力。 |

## 验证证据

- [x] 评审开始前读取 `docs/review/code-review-commit.md`，确认候选精确 SHA 未被覆盖。
- [x] 检查 `1075328e^..1075328e`，确认仅为文档/发布说明变更。
- [x] `git diff --check 1075328e^ 1075328e`：通过。
- [x] 检查 release workflow：release note 标题、`RELEASE.md` 版本项和无模板占位符符合其静态要求。
- [x] 核验 active `createTreeView()`、原生 command/menu、tooltip 转义、end DnD、working AI 与未跟踪删除重验证实现。
- [ ] `npm run test:release`：**未执行**。此隔离工作树中 `npm` 不在 PATH，命令报 `npm: command not found`；文档 commit 不改生产代码，且实现候选此前已报告 146/146 通过。该环境限制不能作为测试通过证据。

## 发布建议

先修复 V072-D1，再对新的精确 SHA 独立评审。P1 清零且 P2 人工 Workbench 验收边界被明确记录后，才能进入 v0.7.2 版本号、打包、标签与发布流程。
