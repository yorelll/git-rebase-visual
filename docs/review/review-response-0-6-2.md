# Git Rebase Visual — 评审回复（0-6-2）

> 对应评审报告：[`code-review-0-6-2.md`](code-review-0-6-2.md)
>
> 评审基线：`v0.6.1`（`6485715`）之后的第三轮 UI 交互可靠性修复。

---

## 0-6-2 回复（对应 `code-review-0-6-2.md`）

### 已修复项

- [x] **刷新期间的 locked run / 搜索 / 更多提交选项状态**

  连续 ≥3 locked commit 可安全折叠，展开状态跨 refresh 保留；搜索 focus/selection 和更多提交 options 的展开状态也会恢复。锁定摘要支持上/下半区 drop，不要求先展开。

- [x] **拖拽稳定性与 canonical order 验证**

  grip-only drag 使用明确 dataTransfer、drag session 和 deferred refresh；过滤时不重排；宿主按 source/anchor/placement/revision/完整 order 推导并验证，拒绝陈旧、部分或 locked source 请求。

- [x] **Compose 原 message / trailer / draft 可靠性**

  通过 session/revision/ready/ack 交付解决首包和 reload 丢失；dirty draft 按 target 恢复；旧 session 不能写入新 target；Panel context、cancel/recovery 和 stale target 均有明确语义。

- [x] **edit 停靠操作路径**

  banner 实际显示 target hash amend、新建 commit、draft-only；host 严格验证 edit stop/target/conflict/staged/session。Amend 保 trailer，新 commit 不继承 target trailer，draft-only 不提交。

- [x] **通知和上下文**

  success 使用面板 inline toast；warning/error 系统通知；Push/AI/rebase SourceControl progress；branch/upstream/ahead/behind/range context bar 已接入。

- [x] **locked patch continuity**

  正常前序 edit/reword 导致 locked commit hash 改写时，patch-id lock 继续有效；locked patch 真消失时保留 lock、给 warning 和 Undo，不静默解锁。

### 仍需人工验收

- [ ] High Contrast Light/Dark、screen reader、窄面板 locked summary 拖放、真实 Compose tab reload/reveal、scroll 发生 policy warning 时的 Webview trace。
  - 原因：这些需要真实 VS Code 图形/辅助技术环境；自动测试验证协议和 Git 状态，但不能替代人工交互走查。

### 最终验证

```bash
npm run typecheck  # 通过
npm test           # 89 / 89 通过
npm run compile    # 通过
git diff --check   # 通过
```

**结论：**0.6.2 修复了第三轮用户报告的状态重置、拖拽、Compose payload、edit-stop、通知和上下文问题，并保持 Git 历史安全保护，可进入发布流程。