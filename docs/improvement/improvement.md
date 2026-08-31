# Git Rebase Visual — 后续改进路线图

> 本文档只记录尚未实施的改进项。已完成的 review 整改、测试和 Release 门禁见 [`../review/review-report.md`](../review/review-report.md)，当前架构见 [`../summary/summary.md`](../summary/summary.md)。

## 已完成（从待办移除）

- [x] 历史操作互斥与 refresh generation 防竞态。
- [x] reorder 全集合校验与 commit hash 当前快照校验。
- [x] append 前锁定保护与已推送历史警告。
- [x] Git 输出上限、超时、取消 signal。
- [x] rebase 元数据使用 absolute git-path。
- [x] trailer 原 trailer 块保留修复。
- [x] 逻辑、边界、真实 Git 集成测试；Release CI 测试、VSIX 内容与 RELEASE.md 门禁。

---

## P1：下一迭代

### P1-1. LLM 超时、错误脱敏与流式体验

**目标：**解决 LLM 请求无独立超时、错误正文可能过长，以及已有 `streamChat` 尚未连接 UI 的问题。

- 用组合 `AbortSignal` 实现可配置请求 deadline；
- 对 401/403/429/5xx 显示分类、安全的错误消息，不回显完整服务端正文；
- 将 `streamChat` 的 delta 通过 webview 消息逐步填入 textarea；
- 补 mock HTTP server 测试：流式 chunk、`[DONE]`、畸形 SSE、超时、取消、错误状态。

### P1-2. Push 操作的可取消进度与诊断输出

**目标：**让远端推送失败可定位、长时间推送可主动取消。

- 将 push 接入 cancellable `withProgress` 并传递 signal 到 `pushRefspec/runGit`；
- 增加 `OutputChannel`，记录 Git 命令（脱敏后）、stdout/stderr 与失败时间；
- 测试取消、超时、拒绝推送和锁定拒绝。

### P1-3. 暂存状态自动刷新

**目标：**无需手动点击 Refresh 即可启用「将暂存区文件添加到此 commit」。

- 研究 VS Code Git API 可用性；不能依赖时使用 `workspace.onDidSaveTextDocument` / 文件系统 watcher + 300–500ms debounce；
- refresh 正在运行或 provider busy 时合并刷新请求；
- 测试频繁文件变化不会并发刷新或覆盖新状态。

### P1-4. 删除与高风险历史操作的 UX

- drop 前使用 modal confirm，并显示 short hash/subject；
- rebase/push 失败写入 OutputChannel；
- 冲突时枚举冲突文件并提供打开入口；
- edit 停靠横幅显示目标 commit 与下一步指引。

---

## P2：功能与工程增强

### P2-1. Stash 恢复可见性

- 为 append 失败/Abort 场景显示精确 stash 名称与恢复状态；
- 考虑提供“打开 Git stash 列表”命令，而不是自动替用户丢弃冲突中的安全副本；
- 覆盖 original index apply 成功、worktree stash pop 冲突、外部 pop 三种组合。

### P2-2. Commit 历史功能

- squash/fixup 单项与多选；
- 搜索、hash/author/subject 过滤；
- 两个 commit 的 VS Code diff；
- 一次操作前记录 ref，提供显式“撤销上次历史操作”；
- 多远端/目标分支选择。

### P2-3. 大仓库性能

- 对 patch-id 做 session cache；
- 对 `all` 模式采用虚拟滚动或默认上限；
- 以结构化 `--numstat` 替代 hover 的文本 shortstat 解析；
- 引入性能测试仓库，监控刷新延迟和 Git 调用次数。

### P2-4. 架构与类型

- 将 webview 消息定义为 discriminated union，替换 `{ type: string; [k: string]: any }`；
- 将 provider 拆为消息控制器、rebase/stash 操作器、append 控制器、compose 控制器；
- 将 stash 工具单独拆模块；
- 先为拆分出的模块增加测试，再重构，确保行为不变。

### P2-5. 安全与可移植性

- 将 API key 迁移到 `ExtensionContext.secrets` / `SecretStorage`；
- 启动时检查 Git 最低版本与所需特性；
- 评估移除 CSP `style-src 'unsafe-inline'` 前，先将动态颜色转为安全 CSS class 或变量；
- 增加 `vscode.l10n`，将硬编码中文提示外置。

### P2-6. 发布增强

- Release notes 继续以 `RELEASE.md` 为人工记录、GitHub generate notes 为提交索引；必要时由脚本把版本段落同步到 release body；
- 定义发布产物签名/校验策略后再引入签名；
- 可选增加手动触发的完整 CI（非 tag）以便提前发现平台差异。

---

## 验收原则

所有后续历史改写功能应满足：

1. 输入来自 webview 时在后端验证当前快照、类型与完整性；
2. 任何长事务有明确 busy/取消/恢复语义；
3. 任何 worktree/index 改动以可定位 SHA 的 stash 或等价安全副本保护；
4. 每条成功与失败路径至少有一个真实 Git 临时仓库集成测试；
5. Release tag 必须通过 `npm run test:release` 和 VSIX 内容检查后才能发布。
