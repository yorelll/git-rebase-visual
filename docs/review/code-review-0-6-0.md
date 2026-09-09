# Git Rebase Visual — 代码评审报告（0.6.0）

> **评审基线**：`v0.5.1`（`b5d10b6`）之后至本报告创建前的 rebase 交互大版本升级。
>
> **覆盖提交**：
>
> - `ff260667727ba3c92dde861c74b2f594ec736ca5 feat: implement 0.6 rebase experience`
> - `02ff57da31d2f2a8a485ab7446417f8bc0caf492 fix: harden 0.6 rebase experience`
> - `612556664652601269438156fc5df8cec1ceac99 fix: harden 0.6 rebase experience`
>
> **评审方法**：用户两轮 UI 建议与 `pic_ref/review2` 六张截图 → Agent A 独立 UI/UX 评审 → Agent B 大版本实现与 UI 裁决 → Agent C 深审修正 → 主 agent 复核、真实 Git 测试与 release gate。
>
> **验证结果**：`npm run typecheck`、`npm test`（64/64）、`npm run compile`、`git diff --check` 均通过；发布前执行完整 `npm run test:release` 与 VSIX 打包。

---

## 1. 总体结论

0.6.0 将插件从“能触发 interactive rebase”提升为“能解释、控制并安全恢复 rebase 生命周期”的交互系统。核心改进不是单纯 UI 重绘，而是建立三个受控状态模型：

1. **Rewrite journal / Undo ref**：任何成功改写前记录可验证的 before checkpoint；
2. **Rebase session / progress**：区分 completed、active、pending、conflict、edit 和 unknown；
3. **Compose draft / Panel session**：编辑、生成、失败和恢复不再依赖侧栏 dialog 的短生命周期。

Agent C 的独立审查发现并修复了跨仓库 Undo journal、私有 ref 累积、todo 进度虚构、`messageOnly` 误提交、Panel listener 生命周期、append Abort 双恢复、stale edit-stop 和 reword 暂停误报成功等问题。

没有发现阻止 0.6.0 发布的遗留代码缺陷。仍需发布前/后人工完成 High Contrast 与 screen reader 实机验收；这不是已声称完成的自动化能力。

---

## 2. 已确认并修复的问题

### R6-1. 历史改写没有可验证 Undo 边界

- [x] **已修复。**

**原问题**：只记录 old/new tip，不提供 UI 恢复入口；直接使用 `ORIG_HEAD + reset --hard` 会被其它 Git 操作覆盖，并可能丢失用户后续工作。

**实现**：

- 新增 `src/git/undo.ts`；每次 rewrite 前创建 `refs/gitRebaseVisual/undo/<id>`；
- journal 记录 repository root、branch、before ref/tip、after tip、操作和 pushed 状态；
- 工具栏、成功操作结果和历史 QuickPick 可执行 Undo；
- Undo 验证无 rebase、同一仓库/分支、HEAD=expected after tip、工作区干净、checkpoint 存在；
- 使用 `git reset --keep`，不自动 force-push；已推送改写要求明确确认；
- journal 淘汰时清理对应私有 ref，避免累积。

**证据**：`test/undo.integration.test.ts` 覆盖成功恢复、dirty/HEAD/rebase/branch/ref 拒绝、跨仓库隔离、journal 淘汰 ref 清理。

### R6-2. rebase 暂停状态与待重放 hash 不可解释或可能虚构

- [x] **已修复。**

**原问题**：列表无法区分已重放/当前/待重放 commit；`stopped-sha` 可同时存在于 edit 和 replay conflict；外部 todo 未知时不能安全推导进度。

**实现**：

- `src/ui/rebaseState.ts` 建立 session presentation，解析 `done`/todo；
- 显示步骤 N/M、active/pending、pause reason、conflict files；
- pending 项有文字说明和 `*`，明确原 hash 会在 Continue 后变化；
- `exec`、`break`、`label`、`reset`、`merge`、`update-ref` 被正确计步；没有 source hash 的步骤不伪造 pending hash；未知语法整体降级为 unknown；
- `rebaseAtEditStop()` 区分真正 todo edit action 与 stale `stopped-sha`。

**证据**：`test/rebaseProgressState.test.ts`、`test/rebasePauseState.test.ts`、`test/rebaseSafety.integration.test.ts`。

### R6-3. edit pause 的面板入口与宿主安全规则矛盾；Skip 语义缺失

- [x] **已修复。**

**原问题**：横幅允许用户“修改代码或提交新改动”，但普通 Compose/Apply guard 会粗粒度拒绝任何 rebase 中操作；没有安全的 Skip。

**实现**：

- edit stop 提供 Amend 当前 commit、新建 commit、仅生成 message，并显示 staged/unstaged 数；
- 宿主严格验证 pause reason、stopped HEAD、冲突、目标和 index；
- Skip 仅在 conflict pause 可用，强确认显示被丢弃 patch/commit 后果；
- Continue 始终在宿主重新查询 unresolved files。

**证据**：真实 Git pause/Abort/Continue/lock 测试，以及 host-side action whitelist 审查。

### R6-4. 菜单缺核心 rebase 决策、Compose 不适合写作、作者/状态视觉无语义

- [x] **已修复。**

**实现**：

- `RebaseAction` 扩展为 squash/fixup，首项、locked 当前/前驱、rebase 中均禁用并说明；
- 右键/hover 提供复制 message 与受控只读 diff；
- Compose 迁移至 editor-area `WebviewPanel`，支持 subject/body、50/72、72 列参考、原始内容/trailer 折叠、AI 草稿状态、取消、替换、追加、恢复 draft；
- author email 驱动稳定颜色和首字母，并提供 current/other/unknown 的文字与 ARIA 表达；
- edit/conflict/locked/pending 使用不同主题语义，颜色不是唯一状态表达。

**证据**：`test/squashFixup.integration.test.ts`（包含 fixup message 丢弃语义）、`test/composeDraft.test.ts`、构建检查。

### R6-5. 鼠标/键盘、过滤、多选和 locked run 的状态安全性不完整

- [x] **已修复。**

**实现**：

- grip-only pointer drag，正文可选择；
- Space pickup/drop、Arrow/Home/End、Alt+Arrow、Escape；菜单 roving focus；
- 搜索/过滤是 view-only projection，过滤期间禁止重排，完整 canonical todo 不会丢 hidden commit；
- Ctrl/Cmd 多选，批量 lock/drop 对每个 hash 执行 host-side snapshot/lock 验证，drop 以单个完整原子 todo plan 执行；
- 连续 locked run 安全折叠，active/pending/stopped/selected 项不隐藏，摘要不是 drag/drop target。

**证据**：选择完整性、`LockStore.lockMany` 去重持久化、host validation 及 `npm test` 64/64。

---

## 3. 逐项裁决与不按原样实施的建议

完整的两轮 UI 建议裁决见 [`../ui-reivew/ui-review-0-6-0.md`](../ui-reivew/ui-review-0-6-0.md)。

- [x] **保持 oldest-first，不提供 newest-first 显示配置。**
  - 原因：interactive rebase todo 本身是 oldest-first；反转显示/执行顺序会降低 locked predecessor 和拖拽正确性。通过 Base/HEAD、步骤和 pending 状态解决方向问题。
- [x] **不以“hover layout shift”为理由修改 tooltip。**
  - 事实纠正：现有 tooltip 已是 `position: fixed`，不会推开文档流；0.6 改善的是真实存在的边缘/遮挡/动作位置问题。
- [x] **不采用裸 ORIG_HEAD Undo。**
  - 原因：它会被其它操作覆盖且 `reset --hard` 不安全；已以 private ref/journal/`reset --keep` 替代。
- [x] **不在 edit stop 启用 Skip。**
  - 原因：Skip 会丢 patch，仅 conflict pause 有明确语义；edit stop 提供 Amend/新 commit/Continue/Abort。
- [ ] **人工 High Contrast Dark/Light 与 screen reader 全流程验收尚未完成。**
  - 原因：自动环境没有可交互 VS Code 主题与辅助技术实例；已实现 token/forced-colors/ARIA 基线，但不虚称人工验收已完成。

---

## 4. 验证证据

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过，0 TypeScript 错误 |
| `npm test` | 64/64 通过 |
| `npm run compile` | 通过 |
| `git diff --check` | 通过，无空白错误 |

关键新增测试：

- `test/undo.integration.test.ts`；
- `test/rebaseProgressState.test.ts`；
- `test/squashFixup.integration.test.ts`；
- `test/composeDraft.test.ts`；
- `test/rebaseSafety.integration.test.ts` 扩展；
- `test/lockStore.test.ts` 或等价 lockMany 覆盖（已通过 index 聚合）。

发布前仍必须执行：

```bash
npm run test:release
npm run package
```

---

## 5. 最终结论

- [x] Agent A 的第二轮 UI/UX 评审已完成；
- [x] Agent B 的大版本实施已完成；
- [x] Agent C 的深审和安全修复已合并；
- [x] 主 agent 补充 fixup message 真实 Git 回归测试，并要求将有价值的 locked collapse、filter、multi-select、键盘交互纳入实现；
- [x] 0.6.0 可以进入发布流程，前提是完整 release gate 通过，并在实际 VS Code 中完成 High Contrast/屏幕阅读器人工走查。
