# Git Rebase Visual — 评审回复

> 本文件只保存对外部代码评审的回复；不修改任何 `code-review-*.md` 原文。
>
> 开始新评审前，请先查看 [`code-review-commit.md`](code-review-commit.md) 确认哪些精确 commit 已被独立评审；完成评审后必须在该台账中记录 review 覆盖范围。
>
> ## 文件与章节命名规则
> - 每个版本的独立评审文件必须命名为：`code-review-<major>-<minor>-<patch>.md`，例如 `code-review-0-3-0.md`。
> - 对应回复只追加到本文件，章节标题为：`## <major>-<minor>-<patch> 回复`。
> - 已写入的回复章节不可重写或删除；新的评审只新增下一版本章节，例如 `0-4-0 回复`。
> - 每个回复章节必须列出评审基线、逐项裁决、已修改的代码/测试证据，以及未修改项的明确原因。
>
> 这种一对一关系保证外部评审原文与项目回复可以长期追溯，同时互不干扰。

---

## 0-1-0 回复（历史归档）

**评审基线：**首个公开版本。

初版评审的主要问题已在后续版本整改，包括 Git 输出限制/超时/取消、绝对 git-path、reorder 与 hash 校验、历史操作互斥、append 锁定和已推送保护、trailer 保留以及 Release 测试门禁。

详细实现和发布记录见 [`../summary/summary.md`](../summary/summary.md) 与 `v0.2.1` Release。该章节为归档，不再回写。

---

## 0-2-0 回复（历史归档）

**评审基线：**v0.2.x 可靠性整改。

第二轮评审聚焦 staged append 事务、历史安全性和发布测试门禁。确认的缺陷已在 v0.2.1 中修复；其余长期建议被拆分为 P2，并保留于 [`../improvement/improvement.md`](../improvement/improvement.md)。

该章节为归档，不再回写。

---

## 0-3-0 回复（对应 `code-review-0-3-0.md`）

**评审基线：**v0.3.0 / `c4d0ce1`。

**处理结果：**CR-1、CR-2 为真实 P1 缺陷，已修复；CR-3 为正确的低风险性能问题，已修复；CR-4 为正确的测试覆盖建议，保留 P2；CR-5 为合理 UX 取舍，保持现状。
### 0-3-0 / CR-1：commit 模式 `openCompose` / `apply` 未校验当前 hash

- [x] **结论正确，已修复。**

评审指出 `openCompose` / `apply` 的 `mode === "commit"` 消息未经过当前 commit 快照校验。弹窗打开期间若外部历史发生变化，过期 hash 可使 `itemsWith` 构建全 `pick` todo，执行无意义 rebase 而不修改目标 message。

**修改：**`RebaseViewProvider.handleMessage` 对 commit 模式的 `openCompose` 与 `apply` 同样执行 `isCurrentCommitHash` 验证。hash 无效时拒绝操作、提示刷新并刷新面板，不再进入 rebase。

**结果：**过期 compose/apply 消息不会改写历史。

### 0-3-0 / CR-2：视图关闭后 index 轮询持续运行

- [x] **结论正确，已修复。**

评审正确指出，原 poller 只在 extension deactivate 时清理，视图隐藏或 dispose 后仍可能持续触发 Git refresh。

**修改：**`resolveWebviewView` 现在：

- 在 `onDidChangeVisibility` 不可见时停止轮询；可见时重新启动并刷新；
- 在 `onDidDispose` 停止轮询、清除 refresh timer 并清除 `this.view` 引用；
- 仅在视图打开时创建 poller。

**结果：**侧栏折叠、切换视图组或显式隐藏时不再后台运行 Git status 刷新；视图重新显示时恢复自动状态同步。

### 0-3-0 / CR-3：gitRunner maxBuffer 的 O(n²) 字节统计

- [x] **结论正确，已修复。**

原实现每个 data chunk 都对已聚合 stdout/stderr 执行 `Buffer.byteLength`，大输出时会重复扫描历史内容。

**修改：**`runGit` 使用 `outputBytes` 累计计数器，仅计算当前 chunk 的字节数并累加，仍对 stdout/stderr 合并总量实施相同限制。

**验证：**扩展 `test/gitRunner.integration.test.ts`，确认 stdout/stderr 合并字节数在上限内。

### 0-3-0 / CR-4：pushGuard、append 守卫与流式中途取消测试缺口

- [ ] **结论正确，保留 P2。**

**未修改原因：**当前 27 项测试已覆盖 Git runner 取消/限制、append 成功事务、LLM deadline/预取消/流式 SSE 和基础 push refspec。评审建议的剩余测试需要为 provider UI、globalState、QuickPick/WarningMessage 和真实 remote push 建立可维护的 VS Code extension-host 或 bare remote Git 测试桩；一次性引入会显著扩大测试基础设施和 CI 时长。

这些场景已写入 P2：

- `lockedInPush`、`pushRefspec` 的本地 bare remote 集成测试；
- append 锁定拒绝、已推送提示、edit 前冲突/外部 abort 恢复；
- `streamChat` 流读取途中取消与 deadline。

在实现 P2 测试桩前，不把“未覆盖”表述为已验证行为。

### 0-3-0 / CR-5：`openCompose` / `generate` 的 busy 粒度

- [ ] **结论属于可选 UX 取舍，保持现状。**

`openCompose` 本身不写历史，但当前将它与 generate 放入 busy 互斥，保证用户不能在生成、历史编辑或恢复事务中同时打开会提交旧快照的新对话框。移出互斥可提高并行交互，但会重新引入 compose 与刷新/历史操作交错的状态复杂度。

**未修改原因：**当前优先保证历史操作确定性；若后续引入类型化 webview 消息和 dialog session ID，再重新评估并行 compose。

### 0-3-0 / 对原保留项的复核

- [x] **认同**评审对 R-11、R-12、R-14、R-15、R-17、R-18、R-19、R-20、CI-D 的“保留规划或不修改”判断。
- [x] **无须反悔**此前安全结论：Git 仍通过 `spawn("git", args)` 执行，用户内容仍通过 `textContent` 渲染，API key 的 SecretStorage 迁移仍是 P2。

### 0-3-0 验证

已执行：

```bash
npm run typecheck
npm run test
```

结果：**27 / 27 测试通过**，无失败、取消或跳过。

本轮改动尚未发布为新版本；后续 release 仍会执行 `npm run test:release`、VSIX 内容验证及 RELEASE.md 版本记录验证。

---

## 当前 P2 规划

P2 任务集中维护在 [`../improvement/improvement.md`](../improvement/improvement.md)，包括 stash 可见性、多仓库/搜索/squash/撤销、性能与虚拟列表、Provider 拆分、SecretStorage/l10n、发布签名，以及 0-3-0 / CR-4 的测试覆盖扩展。
