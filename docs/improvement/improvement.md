# Git Rebase Visual — 后续改进路线图

> 本文档只记录尚未实施的改进项。已完成的 review 整改、测试和 Release 门禁见 \[`../review/review-response-0-4-0.md`](../review/review-response-0-4-0.md)，当前架构见 \[`../summary/summary.md`](../summary/summary.md)。
>
> 外部版本化评审使用 `code-review-<major>-<minor>-<patch>.md`；项目回复按同版本放在 `review-response-<major>-<minor>-<patch>.md`。

## 已完成（从待办移除）

* \[x] 历史操作互斥与 refresh generation 防竞态。
* \[x] reorder 全集合校验与 commit hash 当前快照校验。
* \[x] append 前锁定保护与已推送历史警告。
* \[x] Git 输出上限、超时、取消 signal。
* \[x] rebase 元数据使用 absolute git-path。
* \[x] trailer 原 trailer 块保留修复。
* \[x] 逻辑、边界、真实 Git 集成测试；Release CI 测试、VSIX 内容与 RELEASE.md 门禁。
* \[x] 测试覆盖扩展：真实 bare-remote 推送/锁定拦截、append 前置守卫、streamChat 流式取消/超时（P2-6，v0.4.0）。
* \[x] 大仓库性能：patch-id session cache 与 `--numstat` 结构化 hover 统计（P2-3 部分，v0.4.0）。
* \[x] Stash 恢复可见性：精确 stash@{n} 提示 + `stashList` 命令（P2-1，v0.4.0）。
* \[x] 安全与可移植（部分）：Git 最低版本检查与 SecretStorage 接入管线（P2-5 部分，v0.4.0）。

\---

## P1：0.3.0 已完成

### P1-1. LLM 超时、错误脱敏与流式体验

* \[x] 用 `gitRebaseVisual.llm.timeoutMs`（默认 120 秒）实现 LLM 请求 deadline，并保留用户主动取消。
* \[x] 401/403、429、5xx 采用分类且不包含服务端响应正文的错误提示。
* \[x] 接入 `streamChat`，SSE delta 实时填入 commit message 输入框。
* \[x] 补 mock HTTP 服务测试：流式 chunk、`\[DONE]`、畸形 SSE、超时、取消和认证错误脱敏。

### P1-2. Push 操作的可取消进度与诊断输出

* \[x] Push 采用可取消的 VS Code progress，并将 `AbortSignal` 传到 `pushRefspec/runGit`。
* \[x] 新增 **Git Rebase Visual** OutputChannel，记录 push 的开始、完成和失败摘要。
* \[x] Git runner 已有 timeout/取消覆盖；push 使用同一执行链。

### P1-3. 暂存状态自动刷新

* \[x] 通过 workspace 文件事件和 1.5 秒节流 status 轮询触发刷新，覆盖终端 `git add` 只修改 index 的情况。
* \[x] 400ms debounce、busy 检查和现有 refresh generation 共同避免频繁/过期刷新。

### P1-4. 删除与高风险历史操作的 UX

* \[x] drop 前显示目标 short hash、subject 和重写历史警告的模态确认。
* \[x] rebase/push 失败记录到 OutputChannel；push 可在通知进度中取消；rebase 冲突时列出并自动打开冲突文件。
* \[x] edit 停靠 banner 显示目标 commit 和 Continue/Abort 行动提示。

\---

## P2：功能与工程增强（保留规划）

### P2-1. Stash 恢复可见性

* 为 append 失败/Abort 场景显示精确 stash 名称与恢复状态；
* 考虑提供“打开 Git stash 列表”命令，而不是自动替用户丢弃冲突中的安全副本；
* 覆盖 original index apply 成功、worktree stash pop 冲突、外部 pop 三种组合。

> 裁决（2026-09-03）：✅ 已实施。`popPendingStash`/`restorePendingAppend`/`restoreAppendSnapshot` 冲突提示改为精确 `stash@{n}` 名称 + 短 sha + 可执行的手动恢复命令（`git stash list` / `git stash pop <name>`）；新增 `gitRebaseVisual.stashList` 命令（优先调用 `git.openStash`，降级列出到 Output）。三种组合中“original index apply 成功 / worktree stash pop 冲突 / 外部 pop”已有既有集成测试覆盖（`worktree.integration.test.ts` / `appendStaged.integration.test.ts`），并新增 `stashList` 名称/sha 测试。

### P2-2. Commit 历史功能

* squash/fixup （这里应该考虑用ctrl 选中多个commit进行合并操作）；
* 搜索、hash/author/subject 过滤；
* 两个 commit 的 VS Code diff；
* 一次操作前记录 ref，提供显式“撤销上次历史操作”；
* 多远端/目标分支选择。

> 裁决（2026-09-03）：❌ 未实施。该组为全新建交互特性（ctrl 多选合并、搜索过滤、双 commit diff、历史撤销、多远端选择），涉及新的 webview UI + 后端回滚语义，改动面大且需要新的验收测试；不属于本轮“高价值低风险”范围，保留为后续迭代规划。

### P2-3. 大仓库性能

* 对 patch-id 做 session cache；
* 对 `all` 模式采用虚拟滚动或默认上限；
* 以结构化 `--numstat` 替代 hover 的文本 shortstat 解析；
* 引入性能测试仓库，监控刷新延迟和 Git 调用次数。

> 裁决（2026-09-03）：✅ 部分实施 / 部分未实施。已实施：patchId 增加按 `<repoRoot>:<hash>` 的 session cache（`clearPatchIdCache` 供测试重置）；`commitDetail` 改用结构化 `--numstat` 解析（`summarizeNumstat`，数字列 + 二进制行处理），`--shortstat` 文本解析仅作降级回退；补了缓存命中、跨 cherry-pick 稳定、numstat 摘要的集成测试。未实施：`all` 模式虚拟滚动/默认上限（需 webview 改造且改变现有“显示全历史”语义）、性能测试仓库（需维护专用大数据 fixture，收益在当前规模下不明显）。

### P2-4. 架构与类型

* 将 webview 消息定义为 discriminated union，替换 `{ type: string; \[k: string]: any }`；
* 将 provider 拆为消息控制器、rebase/stash 操作器、append 控制器、compose 控制器；
* 将 stash 工具单独拆模块；
* 先为拆分出的模块增加测试，再重构，确保行为不变。

> 裁决（2026-09-03）：❌ 未实施。`rebaseViewProvider.ts` 承担协商/消息分发/操作编排，纯机械拆类会引入大量 vscode mock 测试依赖且改动面广；discriminated union 需同步重构 `media/main.js` 消费端。两者建议在引入 P2-2 新交互时一并做（届时消息集才稳定）。

### P2-5. 安全与可移植性

* 将 API key 迁移到 `ExtensionContext.secrets` / `SecretStorage`；
* 启动时检查 Git 最低版本与所需特性；
* 评估移除 CSP `style-src 'unsafe-inline'` 前，先将动态颜色转为安全 CSS class 或变量；
* 增加 `vscode.l10n`，将硬编码中文提示外置。

> 裁决（2026-09-03）：✅ 部分实施 / 部分未实施。已实施：Git 最低版本/特性检查加入 `refresh()` 启动路径（`checkGitFeature`，低于 2.31.0 显示错误状态而非崩溃）；SecretStorage 接入管线已打通——`activate` 用 `context.secrets` 注入 `SecretsAccessModule`，评审推送确认时若 API key 仍只存在 settings 会提示迁移（`get()` 读不到密钥即安全降级）。未实施：API key 本身的完整读写迁移（配置项仍读 `gitRebaseVisual.llm.apiKey`，需要读写往返 + 设置迁移策略，另开迭代）、CSP `'unsafe-inline'` 移除（`main.js` 中 commit hash 派生的动态 hsl 颜色仍是硬编码内联样式，直接收紧会破坏 hover/列表着色；需先改为 CSS 变量/class）、l10n（改动面覆盖所有 webview 文案，且当前仅中文单语）。

### P2-6. 测试覆盖扩展（来自 3-0 / CR-4）

* 为 `lockedInPush` 和 `pushRefspec` 增加本地 bare remote 集成测试，包括 `--force-with-lease` 与锁定拦截；
* 为 append 增加锁定拒绝、已推送确认、edit 前冲突与外部 abort 恢复测试；
* 为 `streamChat` 增加流读取途中取消和 timeout 的 HTTP mock 测试。

> 裁决（2026-09-03）：✅ 已实施。新增 `test/pushGuard.integration.test.ts`（真实 bare remote：`--force-with-lease` 在并发远端变更下的拒绝、`lockedInPush` 锁定块/解锁放行）；`test/appendGuard.integration.test.ts`（已推 upstream 的守卫判定 + 锁定 commit 的 patch-id 跨重写稳定）；`test/llmClient.test.ts` 新增中途取消与 timeout 的 HTTP mock 测试。为此加固了 `streamChat`：每次 read 与取消/timeout 竞速、吸收进行中 read 的取消拒绝、撤销时清理计时器，避免挂死与 unhandled rejection。

### P2-7. 发布增强

* Release notes 继续以 `RELEASE.md` 为人工记录、GitHub generate notes 为提交索引；必要时由脚本把版本段落同步到 release body；
* 定义发布产物签名/校验策略后再引入签名；
* 可选增加手动触发的完整 CI（非 tag）以便提前发现平台差异。

> 裁决（2026-09-03）：❌ 未实施。现有 `.github/workflows/release.yml` 已用 `--generate-notes` 生成提交索引、`RELEASE.md` 人工记录并用门禁校验版本段落存在；release-body 同步脚本会覆盖人工措辞、签名需要先定信任/分发策略、手动触发 CI 需评估 fork/secret 风险。三者均属发布流程决策，非代码缺陷，保留规划。

\---

## 验收原则

所有后续历史改写功能应满足：

1. 输入来自 webview 时在后端验证当前快照、类型与完整性；
2. 任何长事务有明确 busy/取消/恢复语义；
3. 任何 worktree/index 改动以可定位 SHA 的 stash 或等价安全副本保护；
4. 每条成功与失败路径至少有一个真实 Git 临时仓库集成测试；
5. Release tag 必须通过 `npm run test:release` 和 VSIX 内容检查后才能发布。

