# Git Rebase Visual — v0.7.2 发布前独立复核

> **命名说明**：`code-review-0-7-2.md` 是未发布 v0.7.1 的历史内部轮次；`code-review-0-7-2-final.md`、`code-review-0-7-2-remediation.md` 和 `code-review-0-7-2-docs.md` 是本版本此前各阶段的独立审查记录。本报告不改写它们，专门复核最终文档整改与发布候选。
>
> **发布基线**：v0.7.1，`4a1e2088ee5c83202eab9e17ad83f5372dbf21e3`。
>
> **最终整改候选**：`1fa107ceb200696ac01a0f52cf9fdfbefdf83b5c` — `docs: describe native generated Diff gating`。
>
> **视觉参考**：`pic_ref/review6/右键直接显示在编辑区.png` 中的右侧 `Git Rebase` Inspector Tab 是 v0.7.2 要移除的旧行为，不是当前目标 UI。

---

## 1. 裁决

- [x] **P0：0 项。**
- [x] **P1：0 项。**
- [ ] **P2：真实 Extension Development Host 的 Workbench 浮层验收尚未执行。** 这是已记录的人工验收边界，不是已确认缺陷。
- [x] **发布建议：允许发布。** 最终独立复核确认此前 P1 `V072-F1`（旧 Inspector 当前文档）和 `V072-D1`（旧 Webview 搜索/键盘/置灰语义当前文档）均已修正；按“无 P0/P1 即可发布”规则，v0.7.2 可进入发布流程。

---

## 2. 精确整改复核

### [x] V072-F1 — 旧 editor-area Commit Inspector 当前文档已修正

`1075328e2c4500df1adfdb1e8d0ab7fc332b2166` 已将 README、架构总结、release note 和 `RELEASE.md` 改为当前 native TreeView 路径：

- commit hover 使用 VS Code 原生 tooltip；
- 右键和 `Shift+F10` 使用 Workbench 原生 context menu；
- 普通 click 只选择 TreeItem，Ctrl/Cmd 多选不会打开 editor Tab；
- `CommitInspectorPanel` 被明确标为历史、非激活源码；`ComposePanel` 是唯一仍用于编辑/生成 message 的 editor-area panel。

静态源代码交叉核验：`RebaseViewProvider` 创建 `vscode.window.createTreeView()`；`NativeCommitTreeProvider` 为 commit 提供 tooltip/context value 且不配置默认 row command；当前 activation/command 注册没有把 Inspector 接回活跃提交列表路径。

### [x] V072-D1 — 旧 Webview-only 搜索、键盘和置灰语义已从当前用户文档移除

`44c6d162ac8eacd555aef50e5565e38aec61e5af` 已使 README 和 summary 明确区分历史 Webview 行为与当前原生 TreeView。`1fa107ceb200696ac01a0f52cf9fdfbefdf83b5c` 修正最后一处不准确叙述：

- 原文“webview 禁用非连续选择”已替换为“原生 context menu 不向非连续选择暴露批量 Generate Diff”；
- `nativeCommitTree.ts` 用连续/非连续 batch `contextValue` 区分原生菜单；
- `package.json` 仅对 contiguous batch context 贡献 `bulkGenerateDiff`；
- `nativeCommandIntent.ts` 仍在宿主侧复验命令目标属于当前选择、canonical revision 和连续性，不能把菜单可见性当作安全边界。

因此当前文档不再承诺未接入的 Webview 搜索、IME 输入、键盘 pickup/drop、Alt-arrow 重排、右击 selection 重定向或 Webview disabled control。

---

## 3. v0.7.2 需求与活跃实现复核

| 用户要求 | 结论 | 静态证据 |
| --- | --- | --- |
| hover/右键不再新建 editor Tab/Panel/View，使用可跨边界的原生 Workbench UI | [x] 通过 | `createTreeView()`、native tooltip、`view/item/context` 菜单；commit 行无默认 command。 |
| 删除重复“仅生成 message（不提交）”入口但保留 AI 生成 | [x] 通过 | 当前 staged/working section 原生 AI 入口；暂停 rebase 时强制 draft-only。 |
| 未跟踪文件 `x` 安全删除 | [x] 通过 | modal 确认前后 fresh porcelain 读取；仅 `!staged && unstaged && untracked` 时删除。 |
| 拖拽反馈不推动列表，并可投放到最后/最新位置 | [x] 通过 | native TreeView DnD 不插入 provider row；undefined target 使用 end-boundary canonical intent。 |
| locked summary 冒号后空格 | [x] 通过 | 活跃 native label 为 `🔒 : N lock · no push`。 |
| Git 元数据 tooltip 安全 | [x] 通过 | Git 派生字段用 `MarkdownString.appendText()`，`isTrusted = false`。 |
| locked/batch 约束和 Generated Diff 宿主验证 | [x] 通过 | native context/menu 分层，host 仍复验 selection、revision、连续性、lock 和 rebase 状态。 |

---

## 4. 验证证据

- [x] 阅读 `docs/review/code-review-commit.md` 和前序报告后，按精确 SHA 复核最终整改；此前尚无 `1fa107ceb200696ac01a0f52cf9fdfbefdf83b5c` 的台账记录。
- [x] `git diff --check 1fa107c^ 1fa107c`：通过。
- [x] `git diff --check 4a1e208..1fa107c`：通过。
- [x] 扫描当前 `README.md`、`docs/summary/summary.md`、`docs/release-notes/0.7.2.md`：没有把旧 Webview-only 搜索、IME、pickup/drop、Alt-arrow、right-click selection redirect 或 disabled control 描述为当前 UI。
- [x] `package.json` 与 `package-lock.json` 版本均为 `0.7.2`；release note 标题为 `## Git Rebase Visual 0.7.2`，无模板占位符；`RELEASE.md` 含 `**0.7.2**` 条目。
- [x] 已运行 `npm run typecheck`、`npm run compile`、`node --check dist/extension.js`、`npm test`：`146 passed, 0 failed`；并重新执行 `npm run package`。
- [x] 已检查 `git-rebase-visual-0.7.2.vsix`：包含运行所需 `dist/`、`media/` 和 `package.json`；不包含 `src/`、`test/`、`docs/`、`node_modules/`、`.claude/`、`.codegraph/` 或 `pic_ref/`。

---

## 5. P2：真实 Workbench 人工验收边界

尚未在真实 Extension Development Host 中记录以下结果，因此不能把它们表述为已完成：

- [ ] 从 sidebar 最右侧 commit 打开原生 context menu，验证指针锚定、可跨 sidebar/editor、click-outside 与 `Esc` 关闭，且不创建/切换 editor Tab；
- [ ] 验证 native hover tooltip、普通 click 和 Ctrl/Cmd 多选均不打开 Inspector；
- [ ] 拖至 latest/end boundary 时列表不因正常流提示行位移；
- [ ] 未跟踪文件删除的 modal 与确认期间状态变化重验证；
- [ ] `🔒 : N lock` 可见文本及 locked/batch 菜单不暴露改写操作。

这些项目保留为 P2 人工验收边界；不构成按既定门槛发布的阻断项。
