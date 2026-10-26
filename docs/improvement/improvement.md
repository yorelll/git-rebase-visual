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
* \[x] **恢复对账不再自动删除 stash（0.8.0）**：恢复全程只用 `git stash apply`，自动路径上不存在任何 `git stash drop` / `git stash pop` / `git stash clear`；`stashDropBySha`、`stashPopBySha`、`dropConfirmed`、`dropListedStash`、`pathEverHeldBlob`、`blobIntroducedInRange` 等只为“是否允许 drop”服务的实现已整体删除。记录只在内容被**正面确认**已在工作区/暂存区/HEAD 中时才清除，确认不了就保留记录、横幅与 stash；误判的最坏结果是“多留一个 stash”。退役原因：任何“内容是否已包含”的推断都存在盲区——blob id 不含文件模式（`chmod +x` 前后同一 blob），revert 形状的 amend 在 `git log --raw` 中不产生该路径的记录，`--find-object` 会把别的文件里的同字节 commit 当成证据；这些盲区在“确认即删除”的前提下会删掉唯一副本，而在“确认才清记录”的前提下只会多留一个可手动处理的 stash。新增的 `stagedSnapshotInHead` 用 `git ls-tree -z` 逐路径比对 mode + object，且其否定结果只影响记录是否清除。
* \[x] 恢复对账的其余改进（0.8.0）：索引匹配不再单独代表整个快照，残留的未暂存/未跟踪内容（`stash^2..stash` 与 `stash^3`）必须回到工作区或保留记录，冲突路径绝不覆盖；工作区 stash 与 change stash 的结果合并而不是互相抑制。
* \[x] 残留的已跟踪路径以“工作区内容等于快照 blob 或路径缺失”为唯一写回条件，不再把“工作区等于 HEAD”当作未改动，避免覆盖用户已提交的更新内容（v0.8.0）。
* \[x] 发布不携带 sourcemap 源码：release 构建默认 `sourcemap: false`，`release.yml` 校验 VSIX 无 `.map`（v0.8.0）。

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

> 裁决（2026-09-03）：✅ 已实施。`popPendingStash`/`restorePendingAppend`/`restoreAppendSnapshot` 冲突提示改为精确 `stash@{n}` 名称 + 短 sha + 可执行的手动恢复命令；新增 `gitRebaseVisual.stashList` 命令（优先调用 `git.openStash`，降级列出到 Output）。三种组合中“original index apply 成功 / worktree stash 冲突 / 外部 pop”已有既有集成测试覆盖（`worktree.integration.test.ts` / `appendStaged.integration.test.ts`），并新增 `stashList` 名称/sha 测试。
>
> 0.8.0 修订：恢复命令不再建议 `git stash pop <name>`（pop 会删除条目，冲突时消耗唯一副本），改为 `git stash apply --index <name>` / `git stash apply <name>`，删除单列为需要用户自己确认的 `git stash drop <name>`。另外 `gitRebaseVisual.stashList` 只在 `activate` 里注册，未写入 `contributes.commands`，因此不会出现在命令面板里；README 已改为描述实际可用的入口（冲突提示、待恢复横幅与 reset 报告中的精确槽位）。是否把它补进 `contributes.commands` 属功能决定，未在 0.8.0 改动。

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

> 裁决（2026-09-03）：❌ 未实施。`RELEASE.md` 人工记录并由门禁校验版本段落存在；release-body 同步脚本会覆盖人工措辞、签名需要先定信任/分发策略、手动触发 CI 需评估 fork/secret 风险。三者均属发布流程决策，非代码缺陷，保留规划。
>
> 0.8.0 修订：本条原先记录“`release.yml` 已用 `--generate-notes` 生成提交索引”，该描述已过时——自 0.5.1 起 workflow 以版本化 `docs/release-notes/<version>.md` 作为最终 Release body（`gh release create --notes-file`），并校验标题版本、无未替换占位符与 `RELEASE.md` 版本记录；`--generate-notes` 与事后编辑均已不再使用。因此本条剩余范围只有产物签名/校验策略与手动触发完整 CI。编号与范围来源：`review-response-0-4-0.md` 的 P2-7 条目；其中产物签名一项可追溯到 `code-review-0-3-0.md` 的 CI-D。

\---

## P3：低优先级（保留规划）

### P3-1. 恢复流程的 Git 超时与孙进程泄漏

> 来源：0.8.0 实施与自测中记录的两项残留，不是外部评审条目——`code-review-0-8-0.md` / `code-review-0-8-1.md` 只就进程回收的**表述**与用例有效性提出问题，没有提出专用恢复超时，因此这一项没有可引用的 review 编号。

* 恢复轮次在 mutation lock 内执行，内部 `runGit` 若撞上一个挂住的 hook 会一直占用写锁直到默认 120s 超时；考虑给内部对账调用使用更短的专用超时（例如 15–20s），让写锁更快回到用户手里。
* `taskkill /T /F` 只能沿树根枚举，已经脱离或期间新建的孙进程仍可能存活。这已不再阻塞结算（`exit` 即结算），但会留下进程泄漏；彻底解决需要 Job Object（Windows）或 cgroup（Linux），超出一次修复的范围。

> 裁决（2026-09-03）：⏳ 部分处理。孙进程泄漏的**表述**已修正：`gitRunner.ts` 的 `killProcessTree` 文档、`RELEASE.md` 与 0.8.0 说明不再声称“回收整棵进程树”，而是“尝试回收”；实际行为（`taskkill` 尽力而为 + 直接 kill 兜底）未变，也不再有 EPERM，仅可能残留脱离的孙进程。专用恢复超时仍是待办。
>
> 补充（2026-10-26）：回收判活的回归用例本身也曾是空洞的——Git for Windows 的 hook 写出的 `$!` 是 MSYS pid，而断言用 Windows 的 `process.kill(pid, 0)` 探测，两者命名空间不同，用例通过时并不证明任何回收行为。现在 hook 改写 `/proc/$!/winpid`，断言前先确认该 pid 确实存活（正向对照），再要求超时后被回收；把 `killProcessTree` 临时改回“先直接 kill”后该用例会失败（已实测），恢复后通过。另一项实测结论：即使修复生效，hook 用 `&` 自守护时仍可能有一个 `sleep.exe` 在回收窗口之后存活到它自己的 `sleep 30` 结束——这是 P3-1 描述的**真实且未消除**的泄漏，`taskkill /T /F` 沿树根枚举时抓不到已脱离的孙进程，不是用例失败。
>
> 补充（2026-10-26，第二项）：另一个用例（`runGit settles on exit…`）自身会泄漏，且与产品行为无关——它的 hook 用 `while [ ! -f marker ]` 无限循环，清理时先写 marker 再 `removeRepo`；一旦删除目录先于 shell 观察到 marker，marker 就不可能再出现，循环会在已删除的临时目录里永远 `sleep 0.1`。现在该 hook 的循环带上 200 次上限，清理时先等孙进程真正退出再删目录（孙进程 pid 同样取自 `/proc/$!/winpid`）。连续三次运行后进程表干净。

## 验收原则

所有后续历史改写功能应满足：

1. 输入来自 webview 时在后端验证当前快照、类型与完整性；
2. 任何长事务有明确 busy/取消/恢复语义；
3. 任何 worktree/index 改动以可定位 SHA 的 stash 或等价安全副本保护；
4. 每条成功与失败路径至少有一个真实 Git 临时仓库集成测试；
5. Release tag 必须通过 `npm run test:release` 和 VSIX 内容检查后才能发布。

