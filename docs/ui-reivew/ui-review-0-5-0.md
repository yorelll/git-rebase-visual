# Git Rebase Visual UI 评审与裁决（0.5.0）

## 基线、范围与验证方法

- **评审基线**：`0.4.0`（提交 `a467e58 fix: stabilize v0.4.0 release test`）。本次变更未修改 `package.json` 版本，也未创建 tag 或提交。
- **输入**：`suggestion.md` 的全部建议、`pic_ref/` 的六张参考截图、当前 webview/扩展宿主/Git 引擎实现，以及独立审查结论。
- **范围**：优先处理会造成历史安全风险、暂停 rebase 时反馈不足、写入输入丢失、列表可读性和基本可访问性的问题；不以功能数量为目标。
- **验证方式**：
  - 静态类型：`npm run typecheck`；
  - 自动测试：`npm test`，包括真实临时 Git 仓库的 drop 冲突、Continue、Abort、锁 patch-id、working-status 覆盖；
  - 构建：`npm run compile`；
  - 差异卫生：`git diff --check`；
  - 代码走查：webview 消息协议、宿主二次 Git 状态检查、主题 token/ARIA 标记。

## 0.5.0 已实施项

- [x] **禁止直接删除 locked commit，且不会在失败/冲突/Abort 时自动解锁。**
  - 实现：`src/ui/rebaseViewProvider.ts` 在 Drop 菜单入口和 `runRebase()` 内部均按 hash/patch-id 复查锁；菜单将 Drop 设为不可用并说明“已锁定，需先解锁”。原来无条件 `unlock()` 的路径已移除。
  - 证据：`test/rebaseSafety.integration.test.ts` 用真实冲突 rebase 验证 rebase 暂停和 Abort 后 `LockStore` 仍锁定目标；既有 `test/appendGuard.integration.test.ts` 验证 patch-id 稳定身份。

- [x] **补齐冲突 state 与 Continue 反馈闭环。**
  - 实现：`src/ui/rebaseState.ts` 基于 Git 的未合并文件实时派生 `conflictFiles`、`conflictCount`、暂停原因；`src/ui/rebaseViewProvider.ts` 每次刷新发送这些字段，宿主在 Continue 前再次调用 `conflictedFiles()` 复查；`media/main.js` 显示冲突数量/文件名、禁用 Continue 并给出原因。若没有未解决冲突而 Continue 仍失败，会显示 Git 返回错误。
  - 证据：`test/rebasePauseState.test.ts` 覆盖 conflict 优先级/去重排序/edit 状态；`test/rebaseSafety.integration.test.ts` 覆盖真实冲突时 Continue 失败、解决并暂存后 Continue 完成。

- [x] **为 oldest-first 时间轴和拖拽提供方向、发现性与确认。**
  - 实现：`media/main.js` 顶/底显示 `Base / 较早` 与 `HEAD / 较新`，拖拽过程中显示“移动到目标之前（较早）/之后（较新）”；行有 grip、grab cursor、插入线。宿主在真正执行重排、Drop、edit-stop 前给出历史改写确认；成功路径将操作、old tip/new tip、影响数量写进 Output 和结果通知。
  - 证据：`src/ui/rebaseViewProvider.ts` 对 display order 严格校验后确认；`test/rebaseEngine.test.ts` 验证 todo 为 oldest-first；`npm run typecheck` 和 `npm test` 通过。

- [x] **Compose Apply 不再在宿主结果返回前关闭；失败保留输入。**
  - 实现：`media/main.js` 使用 `applySucceeded`/`applyFailed` 协议，Apply pending 时禁用按钮并将 textarea 设为只读；宿主成功后才关 dialog，失败则在 dialog 内显示错误、恢复控件和焦点。`src/ui/rebaseViewProvider.ts` 在应用路径异常和 stale commit 情况发送失败消息。
  - 证据：协议路径由 TypeScript 编译及构建检查；宿主的 rebase/message Git 测试均通过。此类 DOM 行为未引入浏览器测试基础设施，保留为后续端到端走查重点。

- [x] **重组右键菜单的风险层级并解释禁用原因。**
  - 实现：`media/main.js` 菜单含目标 hash/subject header，按“查看 / 编辑与变基 / 保护 / 危险操作”分组；`停靠在此 (edit)` 取代含混的“变基到此”；Drop 位于最后且使用危险语义色；Append 在锁定、暂存区为空、rebase 中时禁用并说明理由。
  - 证据：`media/main.js` 仅把禁用原因作为 tooltip/ARIA description，不绕过宿主 guard；`test/appendGuard.integration.test.ts` 仍验证宿主层 locked/upstream 防护。

- [x] **提高侧栏列表可读性。**
  - 实现：`media/main.js`/`media/style.css` 将 subject 提升为主行（最多两行），hash、author、date 放入次级 metadata；普通行改为透明背景，仅 hover/stop 状态强调；移除无语义的 hash HSL 着色，圆点改成中性时间轴装饰。
  - 证据：读取数据仍由 `src/git/commitLog.ts#getCommits` 提供；静态构建和 CSS/JS 走查通过。

- [x] **Abort 二次确认和操作结果可见化。**
  - 实现：`src/ui/rebaseViewProvider.ts` 的 Abort 需 modal 确认；`runRebase()` 及 Append 路径跟踪旧 tip，完成时记录 new tip、操作和影响范围。暂停后 Continue 成功也会通过保留的 operation context 报告 old/new tip。
  - 证据：`test/rebaseSafety.integration.test.ts` 覆盖 edit-stop Abort 回到原 tip；`npm test` 通过。

- [x] **最低 ARIA、语言和 Escape 基线。**
  - 实现：`src/ui/rebaseViewProvider.ts` 设置 `lang="zh-CN"`，list/row/menu/dialog/live region 语义；`media/main.js` 支持 Escape 关闭菜单/非 pending dialog、`Shift+F10`/Menu 键打开行菜单、`Ctrl/Cmd+Enter` 应用 dialog；`media/style.css` 添加 `:focus-visible`。
  - 证据：`npm run typecheck`、`npm run compile` 通过；仍需要辅助技术实际朗读测试，见延后项。

- [x] **显示未提交改动的范围，并保留未配置 LLM 时的发现性。**
  - 实现：`src/git/commitLog.ts#workingStatus` 新增 staged/unstaged 文件数；`src/ui/rebaseViewProvider.ts` 传给状态；`media/main.js` 明示“工作区 N 个文件，git add -A”，未配 LLM 时显示设置说明和“打开 LLM 设置”入口。
  - 证据：`test/commitLog.integration.test.ts` 覆盖 staged、untracked 和同一文件 index/worktree 双侧计数；`npm test` 通过。

## 用户建议与独立审查的逐项裁决

### Commit 列表与方向

- [x] 采用两层阅读结构（subject 优先、hash/author/date 次级），不新增 density 设置。
  - 原因：在固定侧栏内优先解决阅读断裂；density 需要额外配置、迁移与视觉组合测试，当前收益不足。
- [x] 保持默认 **oldest-first**，以 Base/HEAD、较早/较新及拖拽目标文字消除歧义。
  - 原因：display order 与 Git interactive-rebase todo 一致，避免新排序模式增加转换和安全测试面。
- [ ] 不提供 newest-first 配置。
  - 原因：会引入拖拽/执行 todo 的双向转换和更多误操作可能；本版选择通过明确方向修复问题。
- [ ] 不实现完整竖线时间轴、upstream 分界线、分支/upstream/ahead-behind 头信息或空态/骨架屏。
  - 原因：属于上下文和视觉深化，不影响本次已修复的历史安全和可读性；需先定义范围/远端异常状态。
- [x] 移除 hash 派生彩色圆点，改为中性且主题可见的装饰。
  - 原因：原色没有可解释语义，也不应同时承担作者/状态含义。
- [ ] 不在本版建立作者色系统或用圆点编码多种状态。
  - 原因：作者识别需稳定 email 数据和无障碍替代符号设计；状态色不得成为唯一信息通道。
- [x] 加入 grip、cursor、插入线和拖拽方向文字；执行前加历史改写确认。
  - 代码与测试证据见“已实施项”。

### 右键菜单与危险操作

- [x] 菜单加入目标 header、分组、禁用原因、危险 Drop 尾置和错误语义色。
- [x] “变基到此 commit”改为“停靠在此 (edit)”；会打开编辑 dialog 的动作用省略号。
- [x] locked Append 从前端禁用且宿主继续防御式检查。
- [ ] 不实现“复制 message”或“查看变更 / VS Code diff”。
  - 原因：需要定义多文件/二进制/重命名 diff 的可靠展示与 webview 到 VS Code command 的安全参数边界；不应仓促加入。
- [ ] 不实现 squash/fixup。
  - 原因：这是高价值但会扩大 rebase plan、锁语义、冲突和测试矩阵；本次优先完成已有动作的安全性。

### Compose 与 AI

- [x] Apply 失败保留输入并在 dialog 内反馈；支持 Escape 与 Ctrl/Cmd+Enter。
- [ ] 不迁移至 Webview Panel/原生编辑器，也不拆分 subject/body、72 列标尺、折叠 original/trailer。
  - 原因：容器迁移影响生命周期、消息协议、恢复和并排 diff 设计；输入框拆分也会改变 trailer/空行保留规则，需专门设计和端到端验证。
- [ ] 不实现 AI 流式期替换/追加选择、单次恢复、模型/上下文展示、dialog 内 tab 合并入口。
  - 原因：需保存编辑 dirty state、生成版本与取消协议；本版只处理 apply 输入丢失这一已确认高风险缺口。

### Hover、暂停 rebase 与恢复

- [x] 冲突数、冲突文件、Continue disabled、宿主 Continue 前复查、Abort 二次确认均实施。
- [ ] 不实现 Skip。
  - 原因：`git rebase --skip` 会丢弃当前 patch，需要明确确认、冲突后的 stash/append 事务恢复语义和专门的真实 Git 集成测试；不以快速添加按钮损害历史安全。
- [ ] 不实现精确进度、状态栏同步、未重放行半透明。
  - 原因：不同 rebase backend/中间编辑和冲突情况下，精确“第 N/M”语义需可靠解析 todo/done 文件；当前缺少足够稳定的状态模型。
- [x] 成功改写可看到操作、old tip、new tip 和影响范围（Output + 通知）。
- [ ] 不提供直接 ORIG_HEAD Undo 或工具栏“撤销”。
  - 原因：`ORIG_HEAD` 可被其他 Git 操作覆盖，且用户可能已提交/推送/继续多步 rebase；直接 reset 存在错误覆盖工作成果的风险。保留可审计 old/new tip 作为安全的恢复边界提示。

### 工作区、通知、主题与无障碍

- [x] 显示 staged/unstaged 文件数、明确工作区提交会执行 `git add -A`、LLM 未配置时保留设置入口。
- [ ] 不将两个提交入口合并为主按钮/下拉。
  - 原因：当前以明确范围文案降低误点；重做成 split/dropdown 需额外键盘和行为测试，收益不高。
- [ ] 不整体重做通知策略或改为面板内 toast。
  - 原因：VS Code notification API 的自动消失策略是现有架构的一部分；重新分层需处理长期任务、错误可读性和 Output 导航。此次仅让关键 rebase 结果具有 old/new tip 证据。
- [x] 继续使用 VS Code theme token；锁/冲突/菜单危险项改用语义 token，去除 hash HSL。
- [ ] 未执行人工 High Contrast 逐屏验收。
  - 原因：当前环境未启动可交互 VS Code 主题实例；CSS 有 `prefers-contrast` 最低回退，但实际主题走查应在后续人工验收完成。
- [x] 实施最低语言、ARIA、Escape、焦点环和 menu invocation。
- [ ] 不做完整键盘重排（方向键/Alt+方向键/Delete/Space）或完整屏幕阅读器流程。
  - 原因：键盘拖拽需要明确焦点、选择、撤销和变更确认模型；半成品会降低而非提升可访问性。

### 事实纠正

- [ ] 不以“修复 hover layout shift”为理由改动 hover。
  - **未实施原因/事实纠正**：当前 tooltip 已是 `position: fixed`（`media/style.css`），不在文档流中，不会将下方 commit 推开；`media/main.js` 也已有 200ms 延迟关闭。因此截图推断的内联 layout shift 不成立。本次没有对其作伪修复。
- [ ] 不修改标题栏 command 的 tooltip 或将 Stash/Pop 合并。
  - **未实施原因/事实纠正**：这些是 `package.json` 中带 title/icon 的 VS Code 命令，宿主本身会使用 command title 提供 tooltip；截图不能证明 tooltip 缺失。合并操作需要重做命令/UI 信息架构，不适合本范围。
- [ ] 不接受“全面硬编码颜色”的判断。
  - **未实施原因/事实纠正**：原实现大部分颜色已使用 VS Code CSS variables。确有 hash HSL 对比/语义问题，已移除；本版没有无依据的全量色彩重写。

## 0.5.0 验证结果

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 通过，45/45；包含新增真实 Git rebase 安全测试 |
| `npm run compile` | 通过 |
| `git diff --check` | 通过，无空白错误 |

新增/更新的测试：

- `test/rebaseSafety.integration.test.ts`：drop 产生冲突后 lock 保留、冲突 Continue 失败/解决后完成、edit-stop Abort 恢复原 tip；
- `test/rebasePauseState.test.ts`：冲突状态消息派生；
- `test/commitLog.integration.test.ts`：staged/unstaged 文件计数；
- `test/index.test.ts`：登记新增测试。
