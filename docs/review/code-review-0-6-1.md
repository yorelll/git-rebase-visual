# Git Rebase Visual — 代码评审报告（0.6.1）

> **评审基线**：`v0.6.0`（`87eb11b`）之后的面板交互稳定性修复。
>
> **覆盖提交**：
>
> - `45e663a fix: initialize compose panel after webview ready`
> - `e8a6027 fix: stabilize rebase panel interactions`
> - `6a71abb fix: keep edit-stop message generation draft-only`
> - `ca1801d fix: harden 0.6.1 panel interactions`
>
> **评审方式**：用户在真实 UI 中复现问题 → 实现 agent 修复 → 独立审查 agent 验证 Compose/locked run/filter/progress 交互并修正暂停 Compose policy → 主 agent 合并、类型检查、全量测试和构建。
>
> **验证**：`npm run typecheck`、`npm test`（70/70）、`npm run compile`、`git diff --check` 通过；发布前执行 `npm run test:release` 与 VSIX 打包。

---

## 1. 总体结论

0.6.1 解决了 0.6.0 大版本 UI 中暴露出的真实交互稳定性问题：刷新重建 DOM、Panel ready 时序和暂停 rebase 白名单。修复将状态从短生命周期 DOM 元素提升到明确的 presentation/delivery state，避免自动刷新破坏用户当前操作。

没有发现阻止 0.6.1 发布的遗留代码问题。真实 VS Code 中仍需人工确认 High Contrast、screen reader 和窄面板的视觉行为；这些不被标记为自动化完成。

---

## 2. 已确认并修复的问题

### R61-1. Compose Panel 首次打开/重载丢失原 message 与 trailer

- [x] **已修复。**

**原问题**：Panel 创建后宿主立即 `postMessage(openCompose)`，Webview script 的 `message` listener 可能尚未注册，导致初始 payload 被丢弃，原 message/trailer/草稿为空。

**实现**：

- 新增 `ComposePanelDelivery`；
- Webview 在 listener 注册完成后发送 `composeReady`；
- 宿主保存最新 payload，首次 ready、重复 ready 和 reload 后都重新投递；
- listener/disposable 生命周期保持单一，Panel dispose 时 reset delivery state。

**证据**：`test/composePanelState.test.ts` 覆盖 listener ready 后首次 payload 和 reload 后最新 payload 重发。

### R61-2. locked run / 搜索 / 更多提交选项在 refresh 后丢失用户交互状态

- [x] **已修复。**

**实现**：

- 连续 locked run 使用稳定 hash 序列 key 保存 expanded state；
- 仅 `collapseLockedRuns=true` 且连续 run ≥3 时折叠，默认开启；
- active/pending/stopped/selected commit 不会被折叠；
- 折叠 summary 支持上/下半区 drop，将提交完整插入 locked run 前/后；
- 搜索框 render 前捕获焦点和 selection，render 后恢复；
- `changesMoreOpen` 保存更多提交选项的 `<details>` 展开状态。

**证据**：配置 schema、presentation state 与全量 UI/host 测试通过。过滤仍是 view-only projection，过滤期间禁止重排，永不发送部分 todo order。

### R61-3. 成功通知、长任务和错误通知没有按用户注意力分层

- [x] **已修复。**

**实现**：

- 主 Webview 新增顶部 inline toast，成功信息默认 2.5 秒且替换不堆叠；
- warning/error 保留 VS Code 系统通知，不由插件的 10 秒 timer 自动关闭；
- Push、AI 生成和 rebase 使用 `SourceControl` progress，Push/AI 保持可取消；
- context bar 显示 branch、upstream、ahead/behind 与 range，正常 branch、无 upstream 和 detached rebase 均有明确状态。

**证据**：`test/branchContext.integration.test.ts` 验证 upstream divergence，`test/rebasePresentation.test.ts` 覆盖 context presentation。

### R61-4. edit stop 的“仅生成 message”可能走提交路径

- [x] **已修复并经独立审查加固。**

**原问题**：横幅入口没有传递 `messageOnly: true`，Compose 的 Apply 可能走实际 commit。

**实现**：

- 横幅入口显式发送 `messageOnly: true`；
- `composePolicy` 限制暂停 rebase 内只允许 staged/working draft-only Compose；
- 所有 apply/commit 路径继续被 host mutation allow-list 拒绝，只有 `commitEditAmend`/`commitEditNew` 走严格 edit-stop 校验。

**证据**：`test/composePolicy.test.ts` 覆盖 staged/working draft-only 准入与 commit/non-messageOnly 拒绝。

---

## 3. 评审边界

- [x] 不降低 host-side validation、locked guard 或 canonical order 校验；前端状态恢复仅改善展示与可发现性。
- [x] 不把 filter 后可见 subset 发送给 host 重排；过滤时禁用 pointer/keyboard reorder。
- [ ] 人工 High Contrast、screen reader、窄宽度 drag/drop 走查未在自动环境完成。
  - 原因：需要真实 VS Code 交互实例；已实现 token/ARIA/focus fallback，但不虚称人工验收完成。

---

## 4. 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test` | 70/70 通过 |
| `npm run compile` | 通过 |
| `git diff --check` | 通过 |

---

## 5. 最终结论

- [x] 用户报告的 seven interactions（locked run、跨 run 重排、≥3 setting、Compose payload、通知、search/more focus、branch context）已被实现与独立审查覆盖；
- [x] 0.6.1 可进入发布流程。
