# Git Rebase Visual UI 实现记录（0.7.1）

## 基线、范围与发布口径

- 基线：已发布 v0.7.0 `e96f60f5af700c3733ee84f38f1b1391261795e0`。
- 范围：review5 的九张参考图与十六项交互需求；实现及整改提交为 `8a61f65`、`853f26`、`3a247aa`、`c3371b4`、`7529834`、`e2a3875`、`67352fc`、`348e84e`、`a7626f6`。
- 本记录只描述最终 v0.7.1 的实现结果。`code-review-0-7-1.md` 至 `code-review-0-7-3.md` 是未发布候选开发过程中的内部独立审查轮次，不代表 v0.7.2 或 v0.7.3 release。
- 所有 Git/index/worktree 写入继续由 extension host 重新读取状态、验证输入并使用 mutation gate 串行化；webview 仅表达用户意图。

## 1. 需求落地

| review5 需求 | 最终实现 |
| --- | --- |
| 1. routine refresh 不应令正常拖拽 stale | [x] canonical snapshot 只包含 repository、branch、range、rebase 状态、commit canonical order 与锁定集合。工作区计数、文件显示和轮询 refresh 不会增加 revision；真正历史/锁定变化仍会使旧 intent 被 host 拒绝。 |
| 2. 去除顶部重复批量操作 | [x] 顶部 `.list-controls` 不再显示 bulk lock/drop；多选后的操作收敛到跨编辑器 batch inspector。 |
| 3. 点击普通编辑器区关闭操作 UI | [x] 使用 VS Code 公共 editor/window 事件关闭 sidebar menu 和 inspector；仅 concrete TextEditor 交互会关闭 inspector，panel 自身 focus 不会自关闭。关闭后 lifecycle 可可靠重开。 |
| 4. 文件行静止时展示路径、hover 才操作 | [x] 文件行默认展示文件名/目录，hover 或 keyboard focus 时 absolute overlay 显示 stage/restore 等动作，不改变文件行布局。 |
| 5. 不再重复展示 Open Diff | [x] 文件行点击直接调用受控 `vscode.diff`；移除重复的 open-Diff action icon。 |
| 6. 修复 restore / 删除未跟踪文件 | [x] action 的 pointer/click 不冒泡到文件行；host 读取 fresh porcelain。删除未跟踪文件需 modal confirm，确认后再次验证它仍是 unstaged untracked，状态变化即拒绝。 |
| 7. SCM header 批量操作 | [x] Changes 支持 stage all/discard all，Staged Changes 支持 unstage all 和 staged AI compose；discard/unstage 使用明确 modal，所有命令重新读取状态。 |
| 8. 显示“已刷新” | [x] webview、view title 和 command Refresh 均在 branch-context overlay 显示“已刷新”；poll/ready refresh 无噪声。 |
| 9. compact locked summary | [x] 折叠态使用 `🔒 :N lock · no push` 的紧凑摘要，可附作者/待处理信息。 |
| 10. 展开时移除长黄线 | [x] 展开的 locked run 移除 group rail，保留单条 locked commit 的局部标识。 |
| 11. edit 排首位 | [x] single inspector 的“变基与编辑”第一项为“停靠在此 (edit)”。 |
| 12. 详情和右键操作不遮挡 commit | [x] hover preview 与右键 single/batch 操作显示在 `ViewColumn.Beside` 的 Commit Inspector；preview 无 mutation buttons，explicit action 才显示操作。 |
| 13. preview 可阅读、复制且不被竞态破坏 | [x] 鼠标离开侧栏后已显示的 preview 保持；下一 preview、明确 action 或外部 TextEditor interaction 才替换/关闭。session coordinator 阻止慢速 preview 覆盖 action。 |
| 14. Alt+Arrow | [x] commit row 获焦路径已有 `preventDefault()` 与 immutable canonical reorder intent；正常 editor/list/terminal 的 VS Code keybinding 不应由扩展抢占，未发现需要修改的扩展逻辑缺陷。 |

## 2. 关键交互边界

- `CommitInspectorPanel` 以 `ViewColumn.Beside + preserveFocus: true` 创建，避免创建 panel 本身抢走 active text editor。
- panel ownership 使用 lease 和每 panel listener collection；close、native dispose、旧 callback 和 extension dispose 可重复且不会清理 successor。
- `InspectorPreviewCoordinator` 将 preview、single action、batch action 分为不可混淆 session。explicit action 接管后 hover 不会替换它。
- 普通 TextEditor 活动/selection 事件是 inspector 的关闭条件；`activeTextEditor === undefined` 被视为 inspector/webview focus 过渡，不作为关闭证据。
- bulk discard 可能丢弃 working change/删除 untracked 文件，必须明确确认；bulk unstage 仅更新 index，不改变 working content。

## 3. 自动化覆盖

- `test/canonicalSnapshot.test.ts`：routine refresh 与真实 timeline 变化的 revision 边界。
- `test/commitInspectorPanel.test.ts`、`test/panelLifecycle.test.ts`：真实 inspector adapter fake、close/reopen、delayed old dispose、listener cleanup 与 `preserveFocus`。
- `test/inspectorPreviewState.test.ts`、`test/inspectorDismissPolicy.test.ts`：preview/action async ownership 与真实 TextEditor close policy。
- `test/refreshFeedbackPolicy.test.ts`：manual feedback 与 quiet poll/ready policy。
- `test/webviewDom.test.ts`、`test/webviewProtocolState.test.ts`、`test/mutationGate.test.ts`、`test/worktreeChanges.integration.test.ts`：DOM 交互、mutation 分类、bulk SCM 与真实 Git 状态边界。

## 4. 人工验收边界（非发布阻断项）

自动化环境不能替代真实 VS Code 环境，后续应在目标环境回归以下体验：

1. 多 editor group、窄窗口、panel hide/reveal 和 extension reload 下的 inspector close/reopen；
2. 中文 IME 搜索、pointer/触控/触笔拖拽、Alt+Arrow 与系统 keybinding 共存；
3. Changes/Staged Changes header action 的 modal、staged AI message 与外部终端并发状态变化；
4. High Contrast Dark/Light 与 screen reader 的焦点、文本和 disabled reason；
5. hover preview → 移动到右侧 inspector → 阅读/复制长 message，以及 preview 存在时进入 single/batch action。
