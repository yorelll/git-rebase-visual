# Git Rebase Visual — 复核与整改报告

> 本文记录对每一份外部 `code-review-<版本>.md` 的独立回复。
>
> **规则：**不修改 `code-review-*` 原文；每次收到新评审仅在本文件追加一个新的、不可回写的章节。章节编号与评审版本对应，例如 **1-0 回复**、**2-0 回复**、**3-0 回复**。每个章节包含：范围、逐项裁决、代码/测试证据、未修改原因与验证结果，便于未来追溯且不干扰此前结论。
## 1-0 回复（历史归档）

初版评审的结论已在后续版本整改。主要完成项：Git 输出限制/超时/取消、绝对 git-path、reorder 与 hash 校验、历史操作互斥、append 锁定和已推送保护、trailer 保留与 Release 测试门禁。

详见 v0.2.1 的发布记录与 [`../summary/summary.md`](../summary/summary.md)。该章节为归档，不再回写。

## 2-0 回复（历史归档）

第二轮评审聚焦 v0.2.1 的可靠性整改和测试门禁。已确认的修复项已随 v0.2.1 发布；剩余长期建议被拆分为 P2，并保留于 [`../improvement/improvement.md`](../improvement/improvement.md)。

该章节为归档，不再回写。

## 3-0 回复（对应 `code-review-3-0.md`）

**评审基线：**v0.3.0 / `c4d0ce1`。

**本次处理原则：**CR-1、CR-2 为真实 P1 缺陷，立即修改；CR-3 是正确的低风险性能问题，低成本修复；CR-4 为正确的测试覆盖建议，保留 P2 并说明原因；CR-5 为合理取舍，保留现状。
### 3-0 / CR-1：commit 模式 `openCompose` / `apply` 未校验当前 hash

- [x] **结论正确，已修复。**

评审指出 `hashActions` 没有覆盖 `mode === "commit"` 的 `openCompose` / `apply`。在弹窗打开后发生外部历史变更时，过期 hash 可能让 `itemsWith` 构建全 `pick` todo，造成无意义 rebase 而不修改 message。该推演成立。

**修改：**`RebaseViewProvider.handleMessage` 现在对 `openCompose` 和 `apply` 的 commit 模式同样执行 `isCurrentCommitHash` 验证。hash 无效时拒绝操作、提示刷新并刷新面板，不再进入 rebase。

**结果：**过期 compose/apply 消息不会改写历史。

### 3-0 / CR-2：视图关闭后 index 轮询持续运行

- [x] **结论正确，已修复。**

评审正确指出，仅在 extension deactivate 时清理 poller 会让已隐藏或处置的 view 继续触发轮询。

**修改：**`resolveWebviewView` 现在：

- 在 `onDidChangeVisibility` 不可见时停止轮询；可见时重新启动并刷新；
- 在 `onDidDispose` 停止轮询并清除 `this.view` 引用；
- 仅在视图打开时创建 poller。

**结果：**侧栏折叠、切换视图组或显式隐藏时不再持续运行 Git status 刷新；视图重新显示时恢复自动状态同步。

### 3-0 / CR-3：gitRunner maxBuffer 的 O(n²) 字节统计

- [x] **结论正确，已修复。**

原实现每个 data chunk 都对已聚合的 stdout/stderr 字符串执行 `Buffer.byteLength`，大输出场景会重复扫描历史内容。

**修改：**`runGit` 改为 `outputBytes` 累计计数器：仅计算当前 chunk 字节数并累加，仍对 stdout/stderr 的总字节数实施相同上限。

**验证：**扩展 `test/gitRunner.integration.test.ts`，确认 stdout/stderr 合并字节数在限制内。

### 3-0 / CR-4：pushGuard、append 守卫与流式中途取消测试缺口

- [ ] **结论正确，保留 P2。**

**未修改原因：**当前 27 项测试已覆盖 Git runner 的取消/限制、append 成功事务、LLM deadline/预取消/流式 SSE 和基础 push refspec。评审建议的剩余测试需要为 provider UI、globalState、QuickPick/WarningMessage 和真实 remote push 建立可维护的 VS Code extension-host 或裸远端 Git 测试桩；一次性引入这些桩会扩大测试基础设施和 CI 时长。

这些场景仍具价值，已保留到 P2：

- `lockedInPush`、`pushRefspec` 的本地 bare remote 集成测试；
- append 锁定拒绝、已推送提示、edit 前冲突/外部 abort 恢复；
- `streamChat` 流读取途中取消与 deadline。

在实现 P2 测试桩前，不将“未覆盖”表述为已验证的行为。

### 3-0 / CR-5：`openCompose` / `generate` 的 busy 粒度

- [ ] **结论属于可选 UX 取舍，保持现状。**

`openCompose` 不是写操作，但当前将其与 generate 放入 busy 互斥，保证用户不能在生成、历史编辑或恢复事务中同时打开会提交旧快照的新对话框。移出互斥可以提高并行交互，但会重新引入 compose 消息与刷新/历史操作交错的状态复杂度。

**未修改原因：**当前优先保证历史操作确定性；CR-1 修复后仍应保持 dialog 生命周期与操作事务串行。若后续引入类型化 webview 消息和 dialog session ID，再重新评估并行 compose。

### 3-0 / 对原保留项的复核

- [x] **认同** CR 报告对 R-11、R-12、R-14、R-15、R-17、R-18、R-19、R-20、CI-D 的“保留规划或不修改”判断。
- [x] **无须反悔**此前安全结论：Git 仍通过 `spawn("git", args)` 执行，用户内容仍通过 `textContent` 渲染，API key 的 SecretStorage 迁移仍是 P2。

### 3-0 验证

已执行：

```bash
npm run typecheck
npm run test
```

结果：**27 / 27 测试通过**，无失败、取消或跳过。

本轮改动尚未发布为新版本；后续 release 仍会执行 `npm run test:release`、VSIX 内容验证及 RELEASE.md 版本记录验证。
---

## 当前 P2 规划

P2 任务集中维护在 [`../improvement/improvement.md`](../improvement/improvement.md)，包括 stash 可见性、多仓库/搜索/squash/撤销、性能与虚拟列表、Provider 拆分、SecretStorage/l10n、发布签名，以及 3-0 / CR-4 的测试覆盖扩展。
