# Git Rebase Visual — 后续改进路线图

> 本文档只记录尚未实施的改进项。已完成的 review 整改、测试和 Release 门禁见 [`../review/review-response.md`](../review/review-response.md)，当前架构见 [`../summary/summary.md`](../summary/summary.md)。
>
> 外部版本化评审使用 `code-review-<major>-<minor>-<patch>.md`；项目回复只追加到 `review-response.md` 的同版本章节。

## 已完成（从待办移除）

- [x] 历史操作互斥与 refresh generation 防竞态。
- [x] reorder 全集合校验与 commit hash 当前快照校验。
- [x] append 前锁定保护与已推送历史警告。
- [x] Git 输出上限、超时、取消 signal。
- [x] rebase 元数据使用 absolute git-path。
- [x] trailer 原 trailer 块保留修复。
- [x] 逻辑、边界、真实 Git 集成测试；Release CI 测试、VSIX 内容与 RELEASE.md 门禁。

---

## P1：0.3.0 已完成

### P1-1. LLM 超时、错误脱敏与流式体验

- [x] 用 `gitRebaseVisual.llm.timeoutMs`（默认 120 秒）实现 LLM 请求 deadline，并保留用户主动取消。
- [x] 401/403、429、5xx 采用分类且不包含服务端响应正文的错误提示。
- [x] 接入 `streamChat`，SSE delta 实时填入 commit message 输入框。
- [x] 补 mock HTTP 服务测试：流式 chunk、`[DONE]`、畸形 SSE、超时、取消和认证错误脱敏。

### P1-2. Push 操作的可取消进度与诊断输出

- [x] Push 采用可取消的 VS Code progress，并将 `AbortSignal` 传到 `pushRefspec/runGit`。
- [x] 新增 **Git Rebase Visual** OutputChannel，记录 push 的开始、完成和失败摘要。
- [x] Git runner 已有 timeout/取消覆盖；push 使用同一执行链。

### P1-3. 暂存状态自动刷新

- [x] 通过 workspace 文件事件和 1.5 秒节流 status 轮询触发刷新，覆盖终端 `git add` 只修改 index 的情况。
- [x] 400ms debounce、busy 检查和现有 refresh generation 共同避免频繁/过期刷新。

### P1-4. 删除与高风险历史操作的 UX

- [x] drop 前显示目标 short hash、subject 和重写历史警告的模态确认。
- [x] rebase/push 失败记录到 OutputChannel；push 可在通知进度中取消；rebase 冲突时列出并自动打开冲突文件。
- [x] edit 停靠 banner 显示目标 commit 和 Continue/Abort 行动提示。

---

## P2：功能与工程增强（保留规划）

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

### P2-6. 测试覆盖扩展（来自 3-0 / CR-4）

- 为 `lockedInPush` 和 `pushRefspec` 增加本地 bare remote 集成测试，包括 `--force-with-lease` 与锁定拦截；
- 为 append 增加锁定拒绝、已推送确认、edit 前冲突与外部 abort 恢复测试；
- 为 `streamChat` 增加流读取途中取消和 timeout 的 HTTP mock 测试。

### P2-7. 发布增强

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
