# Git Rebase Visual — 代码评审报告（0.6.2）

> **评审基线**：`v0.6.1`（`6485715`）之后的第三轮 UI 交互可靠性修复。
>
> **覆盖提交**：
>
> - `06476b3 feat: implement 0.6.2 rebase UX`
> - `b259d4e fix: harden 0.6.2 rebase interactions`
> - `fba41f8 fix: harden 0.6.2 rebase interactions`
> - `03c0506 fix: harden 0.6.2 rebase interactions`
>
> **评审方法**：用户 `review3` 截图与第三轮建议 → Agent A 独立 UI/源码核对 → Agent B 实施 → Agent C 深审、真实 Git 与状态协议修正 → 主 agent 复核。
>
> **验证**：`npm run typecheck`、`npm test`（89/89）、`npm run compile`、`git diff --check` 通过；发布前执行完整 `npm run test:release` 与 VSIX 打包。

---

## 1. 总体结论

0.6.2 解决了 0.6.1 中暴露出来的三类真实回归：自动刷新重建 DOM、Compose Webview 生命周期时序、和 edit stop 操作入口/安全语义不一致。

本轮不将“滚动触发 rebase 警告”直接归因于 scroll handler，因为源码没有 scroll → mutation 链；改为加入可测试的消息 trace 和 UI state 回归，避免为掩盖现象误改正确的滚动关闭菜单逻辑。

Agent C 的独立审查进一步修复了 locked patch continuity、Undo/rewrite 边界、Compose session/trailer、连续 edit stop 等高风险路径。没有发现阻止 0.6.2 发布的代码缺陷。

---

## 2. 已确认并修复的问题

### R62-1. 拖拽因 grip 热区与刷新重建 DOM 而不稳定

- [x] **已修复。**

**原问题**：整行 `draggable=false` 仅 grip 可拖，但 grip 热区过小、未设置 native `dataTransfer`；自动 refresh 会 `innerHTML` 重建列表，可能在 drag 过程中销毁源节点和监听器。

**实现**：

- grip 扩大、仅 grip 可拖、设置 `dataTransfer`/effectAllowed；
- 新增 drag session，保存 source、revision 和完整 canonical order；
- drag 期间延迟渲染 state，dragend 后安全应用；
- whitespace-only filter 与真实过滤统一使用 trim；
- reorder 消息包含 source/anchor/placement/revision/完整 order，宿主重新推导并验证唯一 move；
- locked source、过滤投影、陈旧 revision 和部分 order 均拒绝；
- locked summary 上/下半区分别代表整组前/后位置。

**证据**：`test/rebaseReorderState.test.ts` 覆盖完整 order、陈旧 session、locked source、scroll 无 mutation；类型检查和 89 项测试通过。

### R62-2. locked run、搜索与更多提交选项刷新后自动复位

- [x] **已修复。**

**实现**：

- `gitRebaseVisual.collapseLockedRuns` 默认 true，只有连续 ≥3 locked commit 才折叠；
- expanded locked run、search focus/selection、更多提交 options 以 presentation state 持久；
- active/pending/stopped/selected 项不被锁定折叠隐藏；纯 pending locked run 可安全显示 replay 摘要；
- 搜索支持计数、清除和字段限定；过滤始终只是 view-only projection。

### R62-3. Compose 首次/重载时原 message、trailer 与 draft 为空

- [x] **已修复。**

**原问题**：Panel 先设置 HTML，后注册 host message listener；Webview 可能在 listener 前发送 ready，导致 payload 永远不投递。

**实现**：

- host 先注册 `onDidReceiveMessage` / dispose，再设置 HTML；
- 引入 session/revision/ready/ack delivery；
- 最新 payload 在首次 ready、reload、duplicate ready 时可靠投递；
- 同 target dirty draft 不被重复 ready 覆盖；旧 session/target 不能写入新 target；
- explicit cancel 才丢弃，native tab dispose/reopen 可恢复匹配草稿；
- Panel 标题/上下文标明 commit target，提供受控 diff 入口。

**证据**：`test/composePanelState.test.ts` 覆盖 ready/reload/draft/stale session，`test/editStopCommit.integration.test.ts` 覆盖真实 Git edit stop、amend trailer 保留、新 commit trailer 隔离。

### R62-4. edit 停靠操作承诺无法完成，draft-only 有误提交风险

- [x] **已修复。**

**原问题**：banner 创建了 editActions 但未插入 DOM；普通 changes 区在 rebase 中仍可呈现，但 host 会拒绝其提交；仅生成 message 没有一致 draft-only 标识。

**实现**：

- edit banner 实际渲染 `追加到 <hash> (amend)`、新建 commit、仅生成 message；
- edit stop 替换普通 changes 区，避免两套提交路径；
- host 验证真实 edit stop、stopped target、无 conflict、staged 内容和 active Compose session；
- amend 通过 `applyTrailers` 保留原 trailer，新 commit 不复制目标 trailer；
- rebase 暂停时仅允许 staged/working 的 draft-only Compose，apply/commit 仍严格拒绝。

### R62-5. 通知层级、分支上下文与滚动误提示

- [x] **已修复/可追溯。**

- 成功信息使用面板 inline toast（默认 2.5 秒、替换不堆叠）；
- warning/error 使用系统通知；Push/AI/rebase 使用 SourceControl progress；
- branch/upstream/ahead/behind/range 被传递到 context bar；
- scroll 只关闭菜单，不发 host mutation/不持久化 UI state；消息 trace 可帮助真实 VS Code 中继续定位用户报告的 policy warning。

---

## 3. 审查边界

- [x] 正常前序 edit/reword 后 locked 后缀 replay 允许 hash 改写：patch-id lock 本就应跨 rebase 保持。
- [x] 直接修改 locked commit（drop/edit/reword/squash/fixup/append）继续宿主拒绝。
- [x] 成功 rewrite 后审计 locked patch-id continuity；若 locked patch 真消失，保留原 lock 并给出系统警告和可用 Undo，不静默解锁。
- [ ] High Contrast Dark/Light、screen reader、窄面板 drag/drop、真实 Compose tab reload/reveal 需人工验收。
  - 原因：自动环境无法替代真实 VS Code 图形与辅助技术实例；不虚称已完成。

---

## 4. 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test` | 89/89 通过 |
| `npm run compile` | 通过 |
| `git diff --check` | 通过 |

关键新增覆盖：Compose session/revision、edit-stop amend/new/draft-only、drag/reorder canonical validation、scroll message trace、branch context、trailer 保留、locked continuity/Undo。

---

## 5. 最终结论

- [x] 用户报告的三项 P0（滚动误提示可追溯、拖拽不可用、Compose 原内容为空）均有明确源码根因或安全回归防护；
- [x] Agent A、B、C 和主 agent 多轮复核完成；
- [x] 0.6.2 可进入发布流程。
