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
- [x] **8 头部 branch/upstream 上下文。** 面板顶部现在显示当前 branch（变基 detached 时显示被变基分支）、upstream、ahead/behind 与实际 range 标签；无 upstream 明确显示“未配置 upstream”。这不伪造 upstream divider。
- [x] **9 连续 locked run 折叠。** 0.6 初版“连续两个及以上、刷新后保持展开、摘要不可 drop”的表述不准确，实测会因重建 DOM 自动关闭，且阻塞跨 run 重排。现改为可配置的 `collapseLockedRuns`（默认开启），仅连续 ≥3 且不含 active/pending/stopped/selected commit 的 run 折叠；摘要上/下半区分别接收插入 run 前/后，完整 canonical order 仍交由宿主验证。展开状态跨 state render 保持。
- [x] **10 未提交改动主入口/危险 add -A 收纳。** staged 是 primary；working `git add -A` 置入“更多提交选项”并带 ⚠；新增只生成 message。
- [x] **11 查看菜单。** 加入复制 message 与受控 readonly `git show --binary --find-renames` diff 文档；覆盖 binary、rename、root/merge 输出且不调用私有 Git extension command。
- [x] **12 squash/fixup。** 扩展 todo/action；首项、locked 当前项或前驱、rebase 中均禁用；宿主二次检查并确认。
- [x] **13 N/M、Skip、状态栏。** banner 显示步骤 N/M/unknown、冲突数、Continue guard；Skip 仅 conflict 可见，二次确认完整 patch 丢弃后果；状态栏显示 `rebase N/M · edit/conflict` 并可 reveal view。
- [x] **14 Compose Panel。** `src/ui/composePanel.ts` 使用 editor-area `WebviewPanel` 和 retainContext session；subject/body、50/72、72 column guide、折叠 original/trailer、AI cancel/restore/model、Ctrl/Cmd+Enter/Escape、apply failure draft 保留均实现。0.6 初版首次打开存在 host 早于 listener 发 payload 的竞态，导致 original/trailer 为空；现 listener 安装后先发 `composeReady`，host 保存并在每次 ready/reload 时重发最新 payload。
- [x] **15 grip-only drag。** draggable 仅绑定 grip，正文可选。
- [x] **16–30 P2。** 短 hash 统一为 8 位显示、pending `*`、作者/状态文字、fixed hover、危险文案、主题 token/high contrast fallback、菜单 roving navigation、搜索/过滤、多选、locked run 折叠均已实施；人工 High Contrast/屏幕阅读器逐屏验收保留为发布前人工检查。

## 上轮 suggestion / 0.5.0 未完成项复评

- [x] **Undo / 精确状态 / Skip / squash-fixup / Compose Panel**：本版实施，见上述文件和测试。
- [x] **查看变更、复制 message**：实施受控只读 Git diff 与完整 message copy。
- [x] **作者语义、hover、grip-only、主题 token。** 实施并提供非颜色文字/ARIA 信息。
- [ ] **newest-first 配置。** 不实施：interactive todo 的 oldest-first 是 Git 执行顺序；再提供反向 display/order 转换会降低重排和 locked predecessor 的历史正确性。
- [ ] **density 设置。** 不实施：两行 message-first 布局已解决可读性；额外配置没有独立产品价值，且会增加状态组合。
- [ ] **完整 upstream divider。** 不实施：当前 `upstream..HEAD` range 的事实是只含未推送 commits；不存在 divider 的两侧内容，伪造分界会误导。
- [x] **自动折叠 locked runs。** 已实施：连续 ≥2 个 locked commit 可折叠；active/pending/stopped/selected commit 不会被隐藏，折叠摘要不能作为 drag/drop target。
- [x] **多选批量 lock/drop、搜索过滤。** 已实施：过滤是 view-only projection，拖拽/键盘重排在过滤时禁用，canonical todo 不会丢 hidden commit；批量 lock/drop 对每个完整 hash 做宿主校验，批量 drop 经完整清单确认后构造单个原子 rebase plan。
- [x] **完整 roving menu/listbox、Space pickup/drop、Home/End。** 已实施：列表支持 Space pickup/drop、Arrow/Home/End、Escape 取消、Alt+Arrow 快速移动；菜单支持 Arrow/Home/End/Enter/Escape roving focus。实际屏幕阅读器流程仍需人工验收。
- [ ] **人工 High Contrast Light/Dark 逐屏。** 本次加入 token/forced-colors fallback；未声称完成实际 VS Code 人工验收，因为当前自动测试环境无交互主题实例。这不是能力拒绝，必须作为发布前人工验收。

## 具体实施与测试证据

- [x] `src/git/undo.ts` + `test/undo.integration.test.ts`：private ref、双 journal、`reset --keep`、dirty/HEAD/rebase/branch/ref 拒绝。
- [x] `src/ui/rebaseState.ts` + `test/rebaseProgressState.test.ts`：todo/done progress、pending、external unknown。
- [x] `src/git/rebaseEngine.ts`、`src/ui/rebaseViewProvider.ts`、`test/squashFixup.integration.test.ts`：squash/fixup todo/message 语义，locked host guard。
- [x] `src/ui/composePanel.ts` + `test/composeDraft.test.ts`：Panel draft/subject/body state contract。
- [x] `src/git/commitLog.ts`、`media/main.js`、`media/style.css`：author email/current identity、pending non-color text、status color tokens、grip-only drag。
- [x] `src/ui/rebaseViewProvider.ts`：conflict-only Skip、edit-stop whitelist、status bar、controlled diff document。

## 0.6 UI 回归修复（发布后补充）

- `media/main.js` 不再在 state render 后丢失搜索输入焦点/selection 或“更多提交选项”的 open 状态；locked run 使用稳定 hash 序列 key 保存 expanded 状态。
- 成功反馈（复制、stash、rewrite、push 等）改为面板顶部单一可替换 inline toast，默认 2.5 秒；失败、冲突和需要用户决定的事项继续使用 VS Code warning/error 通知且不由插件计时关闭。
- Push 与 AI 使用 Source Control 可取消进度；rebase 也使用 Source Control progress，避免一般右下角进度通知。
- 增加 `test/composePanelState.test.ts` 覆盖 panel ready/reload payload 重发，`test/rebasePresentation.test.ts` 覆盖 branch context/range 映射。

## 0.6.0 验证结果

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 通过，69/69（含选择校验、Undo 隔离/ref 清理、unknown todo、exec/merge workflow、fixup message 语义，以及 compose ready/reload、branch context 与 ahead/behind integration 测试） |
| `npm run compile` | 通过 |
| `git diff --check` | 通过 |

人工发布前仍需：在 VS Code High Contrast Dark/Light 实例中走查 Panel、fixed hover、状态栏和键盘屏幕阅读器流程。
