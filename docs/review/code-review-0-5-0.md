# Git Rebase Visual — 代码评审报告（0.5.0）

> **评审基线**：`v0.4.0` tag（`a467e58`）之后至本报告创建前的 UI 迭代。
>
> **覆盖提交**：
>
> - `4c76d62 feat: implement UI review improvements`
> - `ba9645d fix: harden UI rebase safety paths`
> - `00023b9 fix: avoid duplicate append stash restore`
> - `f720f3f fix: distinguish rebase edit stops`
> - `fb8b672 fix: preserve compose input when reword pauses`
> - `e623b49 docs: add UI review suggestions`
>
> **评审方式**：用户 UI 建议与六张截图评审（Agent A）→ 汇总裁决与实现（Agent B）→ 独立代码审查和修正（Agent C）→ 主 agent 复核、真实 Git 集成测试、类型检查与构建。
>
> **验证结果**：`npm run typecheck`、`npm test`（48/48）、`npm run compile`、`git diff --check` 均通过。

---

## 1. 总体结论

本轮将 UI 评审中最重要的原则落实为可验证的安全行为：**历史改写必须有正确的锁定状态、暂停状态、错误反馈和输入保留边界**，而不是仅做视觉重排。

重点改善包括：

- locked commit 不可直接 Drop，避免失败/Abort 后锁被提前移除；
- 冲突 rebase 显示冲突文件，Continue 在未解决时禁用，宿主仍做二次 Git 检查；
- append conflict → Abort 时避免完整 snapshot 与 keep-index stash 的双重恢复；
- Compose Apply 在 reword/rebase 暂停或失败时保留手写 message；
- oldest-first 时间轴增加 Base/HEAD 方向、拖拽提示和改写确认；
- 列表、菜单、dialog 的可读性和最低可访问性得到加强。

没有发现需阻止 0.5.0 发布的遗留缺陷。复杂且高风险的 Undo、Skip、squash/fixup、默认 newest-first、Panel 迁移、精确 rebase 进度均被刻意延后，并在 UI 专项文档中保留具体原因。

---

## 2. 已确认并修复的问题

### UI-1. locked commit 的 Drop 在失败/Abort 后可能丢失锁定

- [x] **已修复。**

**原问题**：Drop 流程曾在 rebase 调用后无条件 unlock。若 drop rebase 发生冲突、失败或用户 Abort，commit 仍可能回到历史中，但 push guard 所依赖的锁已经被删除。

**实现**：

- `RebaseViewProvider.handleMessage("drop")` 在确认前按 hash/patch-id 检查 lock；
- `runRebase()` 也在 auto-stash 之前二次检查，避免 UI 绕过或陈旧消息造成副作用；
- 前端 Drop 对 locked commit 禁用并写明“已锁定，需先解锁”；
- 原无条件 unlock 路径已删除。

**证据**：`test/rebaseSafety.integration.test.ts` 用真实 Git 冲突 rebase 验证暂停和 Abort 后 `LockStore` 仍保留锁。

### UI-2. 冲突时 Continue 无可见反馈

- [x] **已修复。**

**原问题**：`continueRebase()` 返回 `{ ok: false, stopped: true }` 时，调用方仅在 `!stopped` 时显示错误。用户点击 Continue 后可能看不到变化或错误。

**实现**：

- 新增 `src/ui/rebaseState.ts`，通过未合并路径实时派生 `conflictFiles`、`conflictCount`、`pausedReason`；
- Refresh 将状态传给 webview；
- 冲突未解决时 Continue 禁用，并显示冲突文件；
- 宿主 Continue 前再次调用 `conflictedFiles()`，避免 UI 轮询窗口造成竞态；
- 无冲突但 Git Continue 仍失败时，显示 Git 返回的错误。

**证据**：

- `test/rebasePauseState.test.ts` 覆盖冲突优先级、去重排序和 edit 状态；
- `test/rebaseSafety.integration.test.ts` 覆盖真实冲突下 Continue 失败、解决并暂存后完成。

### UI-3. append replay 冲突后 Abort 重复恢复未暂存改动

- [x] **已修复。**

**原问题**：Abort 时 `stashApplyIndexBySha(changeStash)` 已恢复完整 pre-append snapshot（含 staged、unstaged、untracked），随后又 pop `unstagedStash`，造成同一未暂存改动双重应用、冲突和 pending stash 残留。

**实现**：`restorePendingAppend(..., restoreOriginalIndex=true)` 在完整 snapshot 成功恢复后，直接 drop `unstagedStash` 与 `changeStash` 并清理 pending record，不再 pop 第二份 subset stash。

**评审结论**：这是本轮独立审查发现的发布 blocker，修复后已复核通过。

### UI-4. `stopped-sha` 会把已解决的 replay conflict 错标为 edit stop

- [x] **已修复。**

**原问题**：Git 的 `stopped-sha` 既可能出现在 explicit edit stop，也可能保留在 replay conflict 上。仅凭它显示“停在此”会把冲突恢复窗口误导为用户主动 edit 停靠。

**实现**：新增 `rebaseAtEditStop()`，读取真正的 rebase-merge action 状态；`rebasePauseState()` 只在无冲突且明确 edit action 时标记 `pausedReason: "edit"`。

**证据**：`test/rebaseSafety.integration.test.ts` 真实验证冲突解决后、Continue 前仍存在 stopped SHA 时不会被标记为 edit。

### UI-5. Compose Apply 在普通 reword 因冲突暂停时仍会关闭 dialog

- [x] **已修复。**

**原问题**：Apply 协议虽增加了 `applySucceeded` / `applyFailed`，但普通 reword 分支忽略 `runRebase()` outcome。若前序 replay conflict 导致 `{ ok: false, stopped: true }`，代码仍发送 `applySucceeded`，dialog 关闭、手写 message 丢失。

**实现**：普通 reword 分支现检查 outcome；非成功（含 stopped）即抛出可读错误，统一 catch 发 `applyFailed`。webview 保持 dialog、文本和焦点。

**验证**：TypeScript 严格检查与 48 项测试通过；协议路径通过宿主 outcome/错误处理复核。

### UI-6. oldest-first 时间轴缺方向、菜单风险层级和列表可读性弱

- [x] **已修复。**

**实现**：

- 保持与 rebase todo 一致的 oldest-first，不改变默认排序；
- 显示 Base/较早 和 HEAD/较新；拖拽显示前/后（较早/较新）文字与确认；
- subject 最多两行作为主信息，hash/author/date 为 metadata；普通行不再全部使用 inactive-selection 背景；
- 移除无语义 hash HSL 圆点色，改为中性时间轴装饰；
- 菜单增加目标 header、分组、危险 Drop 尾置和 locked append 的禁用原因；
- 支持最低的 ARIA、`lang="zh-CN"`、Escape、Shift+F10/Menu 键、Ctrl/Cmd+Enter。

**专项裁决与截图核对**：见 [`../ui-reivew/ui-review-0-5-0.md`](../ui-reivew/ui-review-0-5-0.md)。

---

## 3. 刻意延后的建议

以下不是遗漏，而是经 UI/Git 安全评估后暂缓：

- [ ] **不直接以 ORIG_HEAD 实现一键 Undo。**
  - 原因：ORIG_HEAD 可被其它 Git 操作覆盖；`reset --hard` 会覆盖用户后续工作。安全 Undo 需要扩展私有 ref、持久化事务、expected tip 检查、干净工作区检查和集成测试。
- [ ] **不实现 Skip、squash/fixup、完整键盘重排。**
  - 原因：它们扩大 rebase action、锁定/append/stash 恢复和冲突测试矩阵；不以半成品历史操作换 UI 功能数量。
- [ ] **不改默认 newest-first。**
  - 原因：显示顺序应与 Git interactive rebase todo 保持一致；方向提示已消除主要误解。
- [ ] **不迁移 Compose 到 Webview Panel/原生编辑器。**
  - 原因：Panel 不会自动获得原生编辑器能力；真实编辑器方案需设计临时文档、保存/取消、失败恢复和 rebase 生命周期。
- [ ] **不实现精确 `N/M` progress、状态栏常驻或未重放项透明。**
  - 原因：不同 rebase backend 与暂停类型下需可靠的 Git 元数据模型，当前不应猜测状态。
- [ ] **不把 hover 当 layout shift 修复。**
  - 事实纠正：现有 tooltip 已是 `position: fixed`，不参与文档流；该判断不成立。

---

## 4. 验证证据

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过，0 TypeScript 错误 |
| `npm test` | 48/48 通过 |
| `npm run compile` | 通过 |
| `git diff --check` | 通过，无空白错误 |

新增/扩展测试：

- `test/rebaseSafety.integration.test.ts`：locked Drop conflict/Abort、Continue conflict、edit-stop Abort；
- `test/rebasePauseState.test.ts`：冲突/explicit edit 状态；
- `test/commitLog.integration.test.ts`：staged/unstaged 文件计数、rebase-apply 分支；
- `test/index.test.ts`：登记新增测试。

---

## 5. 最终审查结论

- [x] Agent A 的独立 UI 评审与截图核对已完成；
- [x] Agent B 的文档裁决与实施已完成；
- [x] Agent C 的安全审查修复已合并；
- [x] 主 agent 额外发现并修复普通 reword paused outcome 导致 Compose 输入丢失的协议漏洞；
- [x] 本版本可以进入 0.5.0 发布流程。
