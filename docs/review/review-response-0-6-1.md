# Git Rebase Visual — 评审回复（0-6-1）

> 对应评审报告：[`code-review-0-6-1.md`](code-review-0-6-1.md)
>
> 评审基线：`v0.6.0`（`87eb11b`）之后的 UI 交互稳定性修复。

---

## 0-6-1 回复（对应 `code-review-0-6-1.md`）

### 已修复项

- [x] **Compose Panel 原 message / trailer 丢失**

  通过 `composeReady` 握手和 `ComposePanelDelivery` 保存/重发最新 payload，避免首次 listener 尚未就绪或 reload 时丢失原 message、trailer 和 draft。

  **证据：**`test/composePanelState.test.ts`。

- [x] **locked run、搜索和更多提交选项被自动刷新重置**

  expanded locked run、搜索 focus/selection 与更多选项 `open` 均有持久化 presentation state；锁定折叠仅连续 ≥3 项且设置开启时生效。折叠摘要可以将非 locked commit 完整插入 run 前/后，无需先展开。

  **证据：**`gitRebaseVisual.collapseLockedRuns` 默认 true、完整 canonical order host validation、全量 70/70 测试。

- [x] **通知与上下文分层**

  成功操作使用面板 inline toast（默认 2.5 秒、不堆叠）；warning/error 使用 VS Code 系统通知；Push/AI/rebase 使用 SourceControl progress；context bar 显示 branch/upstream/ahead/behind/range。

  **证据：**`test/branchContext.integration.test.ts`、`test/rebasePresentation.test.ts`。

- [x] **edit stop “仅生成 message”不提交**

  UI 显式传递 `messageOnly: true`，宿主 `composePolicy` 只允许暂停 rebase 内 staged/working draft-only Compose，apply/commit 仍被白名单阻止。

  **证据：**`test/composePolicy.test.ts`。

### 仍需人工验收

- [ ] **真实 VS Code High Contrast Light/Dark、screen reader、窄面板 locked summary drag/drop、Panel reload/reveal。**
  - 原因：自动测试已验证状态/协议，但这些需要真实 VS Code 图形和辅助技术环境；不将其误报为已完成。

### 最终验证

```bash
npm run typecheck  # 通过
npm test           # 70 / 70 通过
npm run compile    # 通过
git diff --check   # 通过
```

**结论：**0.6.1 已修复用户报告的面板自动重置、Compose payload 丢失、通知层级和 edit-stop draft-only 问题，可发布。