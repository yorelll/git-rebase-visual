# Git Rebase Visual UI 评审与裁决（0.6.0）

## 基线、截图与范围

- **基线**：0.5.1；本次不修改 `package.json` version、不创建 tag。
- **输入**：`docs/ui-reivew/suggestion2.md`、上轮 `suggestion.md` 与 `ui-review-0-5-0.md`、`pic_ref/review2/*.png`、当前 `src/`、`media/`、`test/`。
- **范围**：大型 rebase 交互升级。优先安全恢复、暂停状态真实性、可完成的 edit 工作区、作者语义和交互/无障碍；所有 Git 写入继续由宿主验证。

## suggestion2.md 逐项裁决

- [x] **1 Hover 不产生 layout shift、边缘翻转、文本可选择。** `media/style.css` 保持 fixed tooltip；移除全局 `user-select: none`，commit 文本可选。现有固定定位并未参与文档流；边缘定位仍采用 clamp，避免遮挡点击目标。
- [x] **2 作者色和首字母。** `src/git/commitLog.ts` 传 author email，读取 `git config user.email`；`media/main.js`/`style.css` 使用稳定 email hash 色和首字母，同时提供 title/ARIA 的“当前/非当前/未知”非颜色表达。
- [x] **3 Undo。** `src/git/undo.ts` 建立私有 `refs/gitRebaseVisual/undo/<id>`、workspace/global journal、before/after tip、操作、hash/步骤；工具栏 command、成功通知 Undo、最近历史 QuickPick 均已接入。撤销前检查 rebase、分支、expected HEAD、脏树和 ref；用 `reset --keep`，明确已推送不自动 force push。
- [x] **4 edit 停靠入口。** banner 显示暂存/工作区数量、Amend、新建 commit、仅生成 message；宿主只在已验证 edit stop、无 conflict、staged 有内容时允许提交。
- [x] **5 edit/conflict/locked 色彩分离。** edit 为 info/focus blue，conflict 为 error red，locked 为 warning orange，全部有图标或文字。
- [x] **6 pending commits。** `rebaseProgressState` 解析 interactive done/todo 为 N/M 和 pending hashes；行显示“待重放：Continue 后 hash 将变化”和 `*`。不能可靠读取的外部 backend 显示 `unknown`，不虚构进度。
- [x] **7 方向重复。** 去除固定重复 direction hint，仅保留 Base/HEAD 锚点；拖拽时才显示 live feedback。
- [x] **8 头部 upstream 上下文。** 保持 range 的 Git 安全边界；本轮将状态栏作为跨编辑器上下文入口。真实 upstream divider 需要在 range 中同时包含 upstream 两侧 commit；当前 upstream range 本身不包含已推送段，强加 divider 会制造错误事实。
- [ ] **9 连续 locked run 折叠。** 未实施：当前 locked 行仍需要展示其准确顺序和 pending/edit 状态；在小范围、可变状态的 rebase todo 中自动折叠会隐藏安全关键的前驱关系，降低 Git 历史正确性可见性。
- [x] **10 未提交改动主入口/危险 add -A 收纳。** staged 是 primary；working `git add -A` 置入“更多提交选项”并带 ⚠；新增只生成 message。
- [x] **11 查看菜单。** 加入复制 message 与受控 readonly `git show --binary --find-renames` diff 文档；覆盖 binary、rename、root/merge 输出且不调用私有 Git extension command。
- [x] **12 squash/fixup。** 扩展 todo/action；首项、locked 当前项或前驱、rebase 中均禁用；宿主二次检查并确认。
- [x] **13 N/M、Skip、状态栏。** banner 显示步骤 N/M/unknown、冲突数、Continue guard；Skip 仅 conflict 可见，二次确认完整 patch 丢弃后果；状态栏显示 `rebase N/M · edit/conflict` 并可 reveal view。
- [x] **14 Compose Panel。** `src/ui/composePanel.ts` 使用 editor-area `WebviewPanel` 和 retainContext session；subject/body、50/72、72 column guide、折叠 original/trailer、AI cancel/restore/model、Ctrl/Cmd+Enter/Escape、apply failure draft 保留均实现。
- [x] **15 grip-only drag。** draggable 仅绑定 grip，正文可选。
- [x] **16–30 P2。** 短 hash 统一为 8 位显示、pending `*`、作者/状态文字、fixed hover、危险文案、主题 token/high contrast fallback 已实现；菜单完整 roving navigation、多选/搜索、locked run 折叠未实施（见下方复评）。

## 上轮 suggestion / 0.5.0 未完成项复评

- [x] **Undo / 精确状态 / Skip / squash-fixup / Compose Panel**：本版实施，见上述文件和测试。
- [x] **查看变更、复制 message**：实施受控只读 Git diff 与完整 message copy。
- [x] **作者语义、hover、grip-only、主题 token。** 实施并提供非颜色文字/ARIA 信息。
- [ ] **newest-first 配置。** 不实施：interactive todo 的 oldest-first 是 Git 执行顺序；再提供反向 display/order 转换会降低重排和 locked predecessor 的历史正确性。
- [ ] **density 设置。** 不实施：两行 message-first 布局已解决可读性；额外配置没有独立产品价值，且会增加状态组合。
- [ ] **完整 upstream divider。** 不实施：当前 `upstream..HEAD` range 的事实是只含未推送 commits；不存在 divider 的两侧内容，伪造分界会误导。
- [ ] **自动折叠 locked runs。** 不实施：如上，隐藏具体顺序/前驱会降低安全性。
- [ ] **多选批量 lock/drop、搜索过滤。** 延后不是因为工作量：对于 rebase todo，批量 drop 需要显示每个 patch 的独立安全后果并逐项确认；单一“批量确认”会降低数据正确性。搜索过滤会改变排序/selection 与拖拽可见集合的对应关系，必须先有不丢失隐藏 commit 的安全模型。
- [ ] **完整 roving menu/listbox、Space pickup/drop、Home/End。** 延后：现有 Enter/Shift+F10/Escape/Ctrl+Enter 和 focus ring 保留；以不完整实现替换浏览器原生可预测焦点会降低无障碍。后续应以真实 screen reader E2E 验证为前提。
- [ ] **人工 High Contrast Light/Dark 逐屏。** 本次加入 token/forced-colors fallback；未声称完成实际 VS Code 人工验收，因为当前自动测试环境无交互主题实例。这不是能力拒绝，必须作为发布前人工验收。

## 具体实施与测试证据

- [x] `src/git/undo.ts` + `test/undo.integration.test.ts`：private ref、双 journal、`reset --keep`、dirty/HEAD/rebase/branch/ref 拒绝。
- [x] `src/ui/rebaseState.ts` + `test/rebaseProgressState.test.ts`：todo/done progress、pending、external unknown。
- [x] `src/git/rebaseEngine.ts`、`src/ui/rebaseViewProvider.ts`、`test/squashFixup.integration.test.ts`：squash/fixup todo/message 语义，locked host guard。
- [x] `src/ui/composePanel.ts` + `test/composeDraft.test.ts`：Panel draft/subject/body state contract。
- [x] `src/git/commitLog.ts`、`media/main.js`、`media/style.css`：author email/current identity、pending non-color text、status color tokens、grip-only drag。
- [x] `src/ui/rebaseViewProvider.ts`：conflict-only Skip、edit-stop whitelist、status bar、controlled diff document。

## 0.6.0 验证结果

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 通过，57/57 |
| `npm run compile` | 通过 |
| `git diff --check` | 通过 |

人工发布前仍需：在 VS Code High Contrast Dark/Light 实例中走查 Panel、fixed hover、状态栏和键盘屏幕阅读器流程。
