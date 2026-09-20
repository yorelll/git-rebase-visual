# Code Review — 0.7.2 Native TreeView Remediation

## 基线与范围

- **审查日期**：2026-09-14
- **已发布基线**：`4a1e2088ee5c83202eab9e17ad83f5372dbf21e3`（`chore: release v0.7.1`）
- **初始原生候选**：`4482e4ebfd07f1831c39472d4ea53e5e95e7fb8c`（`feat: use native commit context UI`）
- **本次整改候选**：`89791fe901af227748c690f1ae73075f3f808504`（`fix: retain locked batch native actions`）
- **整改范围**：`4482e4e..89791fe`：
  - `50d96d3ad55b4bde5651f114ce72ad80f7ba7aef`（`fix: restore native tree action parity`）
  - `b047cf80420e9b1dbc128ec0ce3e6f3afb9ee4e3`（`test: cover native tree drag intent`）
  - `89791fe901af227748c690f1ae73075f3f808504`（`fix: retain locked batch native actions`）
- **前序报告**：已阅读 [`code-review-0-7-2-release.md`](code-review-0-7-2-release.md)；该报告针对 `4482e4e…` 的 R72R-1 至 R72R-5 是本轮整改输入，不被改写。
- **评审台账**：已先阅读 [`code-review-commit.md`](code-review-commit.md)。本报告在同一变更中登记本次确切 SHA；状态为已评审但**不批准发布**。
- **视觉输入**：已检查 `pic_ref/review6/右键直接显示在编辑区.png`。截图中的右侧 `Git Rebase` 编辑器 Tab 是本轮禁止的实现。候选的激活路径改为 `createTreeView()`、`TreeItem.tooltip` 和 `view/item/context`，没有把 commit hover/context 操作重新接回 `CommitInspectorPanel`。

## 结论

**不建议发布。** 本次整改修复了原报告的单提交 Generated Diff revision、暂停 rebase/edit-stop/squash/fixup 的主要原生入口、暂存区 AI message 入口，以及每轮轮询全量读取详情的问题；但是仍有 **6 项 P1**。其中包括用户明确要求保留的工作区 AI 入口、可用的完整拖拽范围、原生多选安全语义，以及不可信 Git 元数据的安全渲染。

- **P0**：0 项
- **P1**：6 项未解决
- **P2**：2 项
- **发布决定**：**阻止 v0.7.2 发布。**

## 已验证的整改项

- [x] **R72R-1 已修复**：`nativeCommandIntent("generateDiff", ...)` 为单 commit 带入当前 canonical revision，随后由 `generateCommitDiffDocument()` 做快照和完成时复核（`src/ui/nativeCommandIntent.ts:17-40`、`src/ui/rebaseViewProvider.ts:820-827,2367-2400`）。
- [x] **R72R-2 的主要入口已恢复**：manifest/`extension.ts` 注册了 Continue、Abort、Skip、edit-stop amend/new/draft、squash、fixup 及工作区批量操作；暂停提示行有对应原生 context menu（`package.json:132-225,388-416`、`src/extension.ts:33-51`、`src/ui/rebaseViewProvider.ts:501-522,642-712`）。
- [x] **R72R-3 部分修复**：暂存区标题提供了 AI message 入口，生成后仍经 Compose 由用户决定是否提交（`package.json:193-195,383-385`、`src/ui/rebaseViewProvider.ts:527-530,707-709`）。下述 R72RM-1 说明工作区一侧仍缺入口。
- [x] **R72R-5 已修复**：tooltip 详情改为选择行时按需加载、合并并发读取、容量为 64 的 LRU 缓存；刷新不再为全部 commit 启动 `commitDetail()`（`src/ui/rebaseViewProvider.ts:162-163,205-221,483-498`、`src/ui/commitDetailCache.ts:1-57`）。
- [x] 未跟踪文件仍经专用删除路径，确认前后均重新读取 porcelain 状态并验证未暂存/未跟踪，满足需求 3（`src/ui/rebaseViewProvider.ts:2286-2305`）。
- [x] 活跃原生 locked-run 汇总使用要求的 `🔒 : 8 lock` 空格格式（`src/ui/nativeCommitTree.ts:90-102`）。
- [x] 原生 TreeView 的 context menu / tooltip 由 VS Code workbench 绘制，不是 Webview iframe 内的 CSS 浮层；这符合需求 1 的架构方向（`src/ui/rebaseViewProvider.ts:177-182,469-471`）。
- [x] 移除的 legacy Webview 底部重复 draft-only 按钮未重新引入；保留的 Compose 面板不承担 commit context/hover UI。

## P1 发现

### [ ] R72RM-1 — 工作区（unstaged/working）AI message 入口仍然丢失

**位置**：

- `src/ui/rebaseViewProvider.ts:527-533,707-709`
- `src/extension.ts:42-51`
- `package.json:178-225,368-416`

**复现**：仅存在未暂存工作区改动时，在原生 TreeView 中右键 `Changes (...)` 标题或任一 working 文件。可见的是暂存全部、恢复全部、单文件 Diff/Stage/Restore；没有“AI 生成 message”入口。

**根因**：整改只注册了 `gitRebaseVisual.worktree.stagedAiMessage`；没有 working 对应 command、manifest contribution 或 `nativeCommand()` 分支。`openCompose()` 仍支持 `mode: "working"`，因此该能力被迁移 UI 遗漏，而非有意移除。

**影响**：需求 2 只允许移除重复的“仅生成 message（不提交）”按钮，明确要求保留 AI 生成能力。用户必须先手动暂存才能生成工作区改动 message，较 v0.7.1 丢失一条可达工作流。

**修复要求**：增加 working-section 的原生命令与 context menu，路由 `openCompose` 为 `mode: "working"`、`ai: true`；覆盖正常、未配置 LLM、暂停 rebase 仅草稿情形。

### [ ] R72RM-2 — 不可信 Git 元数据被直接解释为 Markdown

**位置**：`src/ui/nativeCommitTree.ts:62-71`

**复现**：仓库中创建 subject、author、body 或 stat 含有 Markdown 链接/图片/格式控制符的 commit，悬停该 commit。

**根因**：`commitTooltip()` 把 Git 控制的 `subject`、`author`、email、日期、stat 和完整 message 直接插入 `MarkdownString.appendMarkdown()`。`isTrusted = false` 只阻止受信任 command URI，不能把这些内容转义为纯文本。

**影响**：仓库提交元数据可伪造 tooltip 中的链接、格式或外部资源表现；这是原生 hover 面的未转义内容注入，且与已审查候选的安全要求不符。

**修复要求**：仅对固定标题/分隔符使用 `appendMarkdown()`，全部 Git 派生值使用 `MarkdownString.appendText()`；增加含 Markdown/链接字符的回归测试。

### [ ] R72RM-3 — 普通点击 commit 行仍打开 Diff，破坏原生选择/多选并改变编辑器

**位置**：`src/ui/nativeCommitTree.ts:125-138`

**复现**：在原生 TreeView 单击任一 commit 行，或以 Ctrl/Cmd 单击建立多选。

**根因**：每个 commit `TreeItem` 固定绑定 `gitRebaseVisual.commit.openDiff`。TreeItem command 会在行点击时执行，而非只在 context menu 执行。

**影响**：用户尝试选择、尤其是建立用于批量锁定/Drop/Generated Diff 的多选时，会不断打开 Diff 并改变当前编辑器/Tab。这违背 native selection 的预期，也与“弹层关闭不改变当前文件/Tab”的交互目标相冲突。

**修复要求**：移除 commit 行的默认 `item.command`；仅在原生 context menu 提供 Open Diff。增加普通单击只改变 TreeView selection、不会执行命令或打开编辑器的回归测试。

### [ ] R72RM-4 — 原生拖拽无法移动到最后/latest 位置

**位置**：

- `src/ui/rebaseViewProvider.ts:605-639`
- `src/ui/rebasePointerDragState.ts:38-51`

**复现**：把任一非最后 commit 拖到列表最底部、成为 latest/HEAD 之前的最后一行。

**根因**：`handleDrop()` 在 `target === undefined` 时立即返回，且 `nativeTreeDropIntent()` 固定为 `placement: "before"`。最后一个 commit 只能作为“其前面”的 target，TreeView 中也没有代表 latest/HEAD 的可投放行。

**影响**：完整的 rebase 重排范围被缩短；拖拽无法达成“移动到最底部/最新”的自然意图。虽然 native 实现不插入 normal-flow 提示行、满足需求 4 的不下移目标，但不能以丢失末端重排能力为代价。

**修复要求**：提供受 canonical revision/lock 验证保护的 latest-end 投放目标（例如可投放的 native latest boundary row，或正确处理 root/end drop），并测试 source 移到 final position 以及锁定/过期拒绝。

### [ ] R72RM-5 — 批量命令未验证 context target 属于当前选择，可对无关选择执行 destructive 操作

**位置**：

- `src/ui/rebaseViewProvider.ts:586-603,681-686`
- `src/ui/nativeCommandIntent.ts:17-40`

**复现**：选择 commit A、B；随后通过 Command Palette/API 调用 `gitRebaseVisual.commit.bulkDrop`（或 `bulkLock`/`bulkGenerateDiff`）并传入未选中的 commit C。

**根因**：菜单显示条件确实只在 selected row 上生成 batch context，但命令参数本身不可信。`nativeSelectedHashes()` 只要全局选择数大于 1 就返回 A、B，未检查传入 element C 是否属于选择；`nativeCommandIntent()` 随后删除 target hash 并把 A、B 发往 host。

**影响**：右键 target 语义可以被命令调用绕过；一个非目标元素的 batch command 仍可对 A、B 请求锁定/删除/生成 Diff。Drop 在 host 仍有确认，但 selection-target 边界已经失效，违反 native command 参数必须验证和“右键未选 C 不得操作 A+B”的安全要求。

**修复要求**：对于 batch commands，要求 `element.kind === "commit"` 且其 hash 在当前 selection 中；否则拒绝。为“选择 A+B、传入 C”添加针对三种 batch 命令的测试。

### [ ] R72RM-6 — Locked/批量 commit 的原生右键菜单丢失只读常用操作

**位置**：

- `src/ui/nativeCommitTree.ts:105-118`
- `package.json:267-346`

**复现**：右键单个 locked commit，或右键已选中的 locked batch commit。

**根因**：TreeItem 的 `contextValue` 从普通 `gitRebaseVisual.commit` 换成 locked/batch 精确值；manifest 的 Copy Hash、Copy Message、Open Diff、Generate Diff 等仅匹配普通值。locked 单项只显示 Unlock；locked batch 仅显示 batch 操作。

**影响**：锁定本应阻止历史改写，不能阻止查看、复制和生成只读 Diff。迁移后这些用户可达的只读操作被错误隐藏；批量 locked 行还无法用单项命令处理。

**修复要求**：用能同时表达普通/locked/selection 能力的安全 context design（或为 locked 与 batch contexts 显式贡献只读菜单项），同时保持锁定状态对 rewrite 操作的严格阻止。

## P2 / 测试与可维护性

### [ ] R72RM-7 — 原生路由回归测试仍主要停留在 intent/manifest 片段

`test/nativeCommandIntent.test.ts` 覆盖 Generated Diff revision，但没有覆盖 working AI 路由、伪造/未选 context target、locked contexts 的只读菜单可达性、默认行点击副作用或 latest-end DnD。现有 `nativeCommitTree` 测试甚至将默认 Open Diff command 作为期望（`test/nativeCommitTree.test.ts:46-76`），因此未能保护 R72RM-3。

### [ ] R72RM-8 — inactive Inspector 源码/测试仍保留，增加维护和误接回风险

`src/ui/commitInspectorPanel.ts` 及其 lifecycle tests 仍随包编译，尽管激活路径已不导入它。当前没有用户可达路线，故不是本轮 P1；建议在迁移稳定后删除不再适用的 Inspector 实现与测试，或明确隔离其未来用途，避免后续误恢复编辑器 Tab 方案。

## 用户需求逐项核对

| 需求 | 结论 | 证据 |
|---|---|---|
| 1. 原生浮层、可覆盖 editor、非 Tab/Panel/View | **架构通过，发布仍被其他 P1 阻止** | `createTreeView` + host context menu/tooltip；未发现 active inspector route。 |
| 2. 删除底部重复 draft-only，但保留 AI | **未通过** | legacy 重复按钮未恢复；staged AI 已恢复，但 working AI 缺失（R72RM-1）。 |
| 3. untracked `x` 安全删除 | **通过** | 独立 delete route、modal、确认后 porcelain revalidation。 |
| 4. 拖拽信息不推移列表，覆盖 Base/earliest | **基本通过但完整拖拽回归** | native DnD 无 normal-flow hint；无法放到 latest（R72RM-4）。 |
| 5. `🔒 : 8 lock` 空格 | **通过** | active native `lockedRunSummary()` 的可见文本格式正确。 |

## 验证证据

- [x] 已检查 review6 截图，并将右侧 Inspector Tab 作为禁止实现进行核验。
- [x] `npm run typecheck`：通过。
- [x] 焦点测试（native TreeItem / command intent / DnD / detail cache）：**11/11 通过**。
- [x] `npm test`：**141/141 通过**，约 367.7 秒。
- [x] `git diff --check 4a1e208… 89791fe…`：通过。
- [x] 静态审查确认 R72R-1、暂停 rebase/edit-stop/squash/fixup 入口、staged AI 和详情缓存已按整改候选实现。
- [ ] 以上自动化未覆盖 R72RM-1 至 R72RM-7，不能作为发布批准证据。

## 发布建议

在修复全部 P1 后，必须对新的精确候选 SHA 再次进行独立审查；不得用本报告把 `89791fe…` 视为发布批准。P2 可在下一轮独立审查时一并处理或按发行阈值记录明确决定。
