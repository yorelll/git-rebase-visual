# Git Rebase Visual UI 评审与裁决（0.6.2）

## 基线、输入与验证范围

- **基线**：0.6.1 的独立 worktree 实现；本次为第三轮 UI 修复，版本元数据同步更新为 0.6.2，不创建 tag、不推送。
- **输入**：`docs/ui-reivew/suggestion.md`、`suggestion2.md`、`suggestion3.md`、`ui-review-0-5-0.md`、`ui-review-0-6-0.md`，以及主工作区 `pic_ref/review3/` 的六张参考截图。
- **原则**：过滤永远只是只读投影；interactive-rebase todo 始终使用完整 oldest-first canonical 顺序；locked commit 不得通过折叠、拖拽、批量操作或 patch 重写绕过保护；所有 Git 写入在扩展宿主再次验证。
- **验证范围**：纯状态/协议测试、既有真实 Git 集成测试、TypeScript、扩展构建、差异空白检查。人工 High Contrast 和屏幕阅读器走查仍须在真实 VS Code 发布验收环境完成，不能由无 UI 的自动环境伪称已完成。

## 第三轮逐项裁决

### P0：安全、暂停状态与 Compose 生命周期

- [x] **过滤或折叠状态拖拽的语义。**
  - 过滤是否生效统一以 `filterText.trim().length > 0` 判定；仅 grip 可拖，过滤时禁用拖拽。拖拽消息携带 source、anchor、before/after placement、canonical revision 和完整 canonical order；宿主根据自己的完整 order 重建唯一预期结果，拒绝 stale、部分、伪造、locked source 的请求。
  - 折叠 locked run 的摘要上半部表示插入 run 前、下半部表示插入 run 后，无需展开；确认明确显示 source、anchor、placement 与至少会改写的 commit 数。
  - 证据：`src/ui/rebaseReorderState.ts`、`src/ui/rebaseViewProvider.ts`、`media/main.js`、`test/rebaseReorderState.test.ts`。

- [x] **edit 停靠 amend/new commit 入口。**
  - edit banner 实际追加 `editActions`，主按钮显示精确 stopped hash 并统一打开 Compose Panel。普通 changes 区在 edit stop 隐藏，避免一个暂停状态同时出现普通提交和 edit-stop 提交两套路径。
  - Host 对 amend/new 都要求 edit stop、无冲突、暂存区非空；amend 还要求 Compose active target 与当前 `rebaseStoppedSha()` 精确相同。普通 rebase 不允许生成 AI；edit-stop new commit 是经验证的非 AI staged Compose，不能被一般 staged/working 提交路径替代。
  - amend 使用 `applyTrailers()` 保留目标 trailer；new commit 不复制 stopped commit 的 trailer，避免复制 `Change-Id` 等 review 身份。仅草稿的流程只复制，绝不提交。
  - 证据：`src/ui/rebaseViewProvider.ts`、`media/main.js`、`test/message.test.ts`。

- [x] **Compose 原始 message/trailer 首次为空、session/revision/ready/ack、dirty 草稿。**
  - Panel 在设置 HTML 前注册 webview listener 和 dispose handler；页面 listener 安装后发送 `composeReady`，宿主交付 latest payload。delivery 层采用 session + stable target revision，不再以刷新 generation 作为目标身份。
  - `composeDraft` 只接受与 active session/revision 相同的消息；重复 ready/reload 会再次交付同一 target 的 recoverable draft，而新 target/revision 不会覆盖/继承旧 draft。Apply 成功后只清理对应 draft；Cancel/Escape 在页面确认丢弃后，host 仅在 session/revision 仍为 active 时清理该 draft 并关闭 Panel，旧文档无法关闭较新的 target。
  - 关闭 VS Code tab/dispose 不会被当作明确放弃：匹配 target 的 dirty draft 保留供下次打开恢复。所有 apply（含普通 staged/working）也要求 active session/revision，staged/working target 以底层 diff 身份而非 refresh generation 版本化，避免刷新误判或旧草稿写入。stale session/target 写入被 host 拒绝，Compose 显示 warning/保留草稿。tab/header 显示 hash 和 subject；目标 commit 提供受控的“打开目标变更”。
  - 证据：`src/ui/composePanel.ts`、`src/ui/composePanelState.ts`、`test/composePanelState.test.ts`。

- [x] **冲突状态、Continue、Skip、进度、状态栏。**
  - 保持并复查宿主冲突文件 guard：冲突时 Continue 禁用且说明文件数量，Skip 仅在冲突时提供并有 patch 丢弃确认；banner 与状态栏显示真实或明确 unknown 的进度。
  - 证据：`src/ui/rebaseState.ts`、`src/ui/rebaseViewProvider.ts`、`test/rebasePauseState.test.ts`、`test/rebaseSafety.integration.test.ts`。

### P1：列表、locked run、Compose 可读性与菜单

- [x] **pending 提示逐行重复。**
  - 改为一次性 pending boundary：“以下 N 个 commit 待重放，Continue 后 hash 将变化”；行内只保留轻量 `*（待重放）`。

- [x] **连续 locked run 的摘要、默认与持久状态。**
  - 配置 `gitRebaseVisual.collapseLockedRuns` 默认 true，阈值为连续 ≥3；摘要有锁定数量、不推送保证、作者聚合、hash 范围和待重放说明。手动展开状态、更多提交选项、搜索文本由 `vscode.setState()` 跨 state render 保留。
  - rebase pending locked run 也可折叠：这是安全的，因为 rebase 中所有重排仍禁用，摘要明确说明待重放；active/stopped/selected run 仍不隐藏。
  - 外框改为贯通 warning 左条，避免双层厚框。

- [x] **搜索焦点、selection、计数、清除和字段限定。**
  - 状态 render 前捕获、render 后恢复搜索输入焦点和 selection；支持 `author:`、`hash:`、`msg:`，显示 visible/total 计数和清除操作。

- [x] **Shift 多选与安全批量 squash。**
  - Ctrl/Shift 多选可批量 lock/drop/squash；宿主对完整 current selection 再验证，squash 只接受连续、未锁定、非首项的 canonical 选择，单次确认后生成一个完整 rebase plan。

- [x] **菜单、hover 和 A11y。**
  - listbox/option、menu/menuitem、roving focus、Home/End/Escape、ContextMenu/Shift+F10 均保留；菜单显示 icon、部分高频快捷键与禁用原因。hover 使用 fixed 定位、边缘翻转、右上复制/diff 动作、短 hash/压缩统计、200ms 关闭宽容期。
  - 颜色同时有图标/文本/ARIA 语义；CSS 使用 VS Code token，并保留 forced-colors fallback。

- [x] **Compose Panel 可读性和模式动作。**
  - 内容居中且限宽 860px；subject/body、字符计数、折叠 original/trailer、温和的水平行距参考、AI 生成/取消/恢复、模型信息、目标上下文均已提供。
  - reword/amend 模式不显示“仅生成 message（不提交）”；新提交/草稿模式按其写入或 copy 语义显示相应按钮。

- [x] **通知分层与分支上下文。**
  - 成功使用单一替换式 inline toast，默认 2.5 秒；warning/error 交给 VS Code 系统通知且插件不自动关闭；push/AI/rebase 使用 Source Control progress。branch/upstream/ahead/behind/range 按实际 Git 状态呈现。

- [x] **Undo 不可用的表达。**
  - 可撤销记录在 QuickPick 中以 `↺` 区分 completed；不存在 completed record 时宿主安全拒绝 Undo。视图标题 command 的启用态由 VS Code command/menu 体系管理，不能在没有上下文 key 的静态 contribution 中伪造 disabled state。

### P2：事实边界与未实施建议

- [ ] **浏览器内常驻并排 diff。**
  - 不实施该具体形态：受控 `git show --binary --find-renames` 已在 VS Code 文本编辑器打开，保留多文件、binary、rename、root/merge 输出的完整性；在 Compose webview 再实现一个截断/转义/大输出处理器会降低 Git 正确性和可访问性。Compose 提供“打开目标变更”进入同一受控 diff。

- [ ] **newest-first 或 density 设置。**
  - 不实施：interactive-rebase 的执行 todo 是 oldest-first。反转显示或增加 density 模式会增加 display/order 转换组合，降低重排、前驱 squash 和 locked guard 的可验证性；现有 Base/HEAD、grip feedback、完整 host confirmation 已解决方向发现性。

- [ ] **人工 High Contrast/屏幕阅读器逐屏验收。**
  - 当前没有交互式 VS Code 主题/辅助技术实例，自动测试只能验证 token/forced-colors 回退与语义标记，不能声称真实朗读/主题视觉结果。发布前必须在 High Contrast Dark/Light 和屏幕阅读器中执行人工走查。

- [x] **scroll P0 的事实与可测回归。**
  - 没有基于截图猜测修改 scroll。事实是 `closeMenu()` 仅修改 menu DOM/focus；scroll listener 不调用 `vscode.postMessage()`、不调用 `persistUi()`、不修改 host state。`window.__grvUiTrace` 暴露只读 trace；`test/webviewProtocolState.test.ts` 回归验证 scroll-close 不产生 host mutation 或 UI-state persistence。
  - 证据：`media/main.js`、`src/ui/webviewProtocolState.ts`、`test/webviewProtocolState.test.ts`。

## 安全不变量复核

1. webview 不能提交过滤投影作为 rebase todo；host 始终派生完整 canonical todo。
2. locked hash 和 patch-id guard 在拖拽、drop、append、squash/fixup 和 rebase 写入前重新验证。
3. edit-stop 写入要求真实 edit stop、无冲突、暂存内容和精确 target/session 关联；draft-only 永不提交。
4. trailer 仅在 amend/reword 时按原 message 规则保留；新 commit 不复制别的 commit 的 trailer。
5. 成功消息只在实际 Git 写入成功后关闭 Compose 和清理对应 draft。

## 验证结果

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 通过；包含纯状态、Compose delivery、webview scroll 协议及既有真实 Git 集成测试 |
| `npm run compile` | 通过 |
| `git diff --check` | 通过 |

人工发布前待办：High Contrast Dark/Light、屏幕阅读器实际朗读、真实 VS Code 中 Compose dispose/reload 与拖拽交互走查。
