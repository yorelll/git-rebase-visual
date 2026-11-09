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
* \[x] **只删除插件自己创建的 stash 条目（0.8.2）**：0.8.0 把“永不自动删除 stash”写成了不变量，实际效果是把插件自己的临时 `-u` 条目永久留在列表最前面，用户的裸 `git stash pop` 先命中它并以 `could not restore untracked files from stash` 失败。0.8.2 恢复“只删自己的、绝不碰用户的”：内容被 `stashPresence().complete`（列表 / 索引 / 工作区 / 未跟踪四处全部正面确认）之后，才按 sha 解析槽位、复核占用者仍等于自己的 sha、`drop` 后复核 Git 实际删掉的 sha，不符则 `git stash store` 原样恢复；任一步不符都拒绝并报告，绝不重试。`stash pop` 仍只存在于用户显式点击的 **Pop** 命令里（`-u` 条目在内容已回到工作区后本就无法 pop，实测）。
* \[x] **本地化 Git 输出与重命名折叠（0.8.2 复审）**：上一轮把 `--no-renames` 加到 `worktree.diffNames` 却漏了 `pendingRecovery.changedPaths`，而后者才是 `complete` 的唯一判据来源——暂存一次重命名、用户只还原目标文件时，`index` 报 `present`、`complete` 为真、条目被删，而 `a.txt` 的暂存删除从未回到索引。现在两处一致带 `--no-renames`（`stagedSnapshotInHead` 共用同一函数，因此一并修好）。同一轮把两处依赖英文文案的判断改为按身份判断：`git stash push` 是否创建条目由**前后 sha 集合差**决定（不再用 `/No local changes to save/` + `stash@{0}`，后者在本地化环境里会把**用户自己的**条目记成插件创建的），`git stash drop` 删掉的是否自己那条由**删除前后的 sha 集合差**决定（`/Dropped …/` 只作旁证，解析不出时拒绝而不是谎报成功）；`git stash store` 复原后条目会移到列表最上方、**reflog 说明 `%gs`**（`git stash list` 打印的那行）被改写成 `git-rebase-visual restored <sha7>`，而 stash commit 的**标题 `%s`**（`git log` 打印的那行）不变，回滚消息现在把两个字段都点名说明（只写“说明文字”会让按 `git log` 核对的人得出相反结论）。同一个 sha 出现在多个槽位（用户执行过 `git stash store`）时**拒绝**删除并报告，不猜哪个是自己的。所有需要读 Git 人类可读输出的调用统一带 `LC_ALL=C`（共享常量 `gitRunner.C_LOCALE`）。
* \[x] **“自己的 sha 不在列表”不是只删了自己那一条的证明 / 损坏 reflog 的两处相反答案（0.8.2 第三次复审）**：删除前列表 `[自己的, 用户的]`，删除窗口内并发删掉插件那条、插件的 drop 又删掉用户那条，删除后列表为空——旧实现只看“自己的 sha 不在列表”就返回 `ok/gone`，用户的条目从此只剩待 gc 的悬挂对象。现在两个方向都核对：自己那条不在列表时，仍在删除前快照里找出**同时消失的其他 sha**，零个才是 `ours-only`，恰好一个按普通误删 `stash store` 复原，多于一个拒绝并点名；快照读不出来时仍返回已删除，但消息明确写出**未做交叉核对**。判据抽成纯函数 `dropVerdict`（`worktree.ts`），六种结论直接单测。同一轮统一了 stash 列表读取：`worktree` 的前后集合比较与 `stashIndexBySha` 曾把“`git stash list` 退出 0 但无输出”当作**空栈**，`pendingRecovery.stashShas` 把同一形状当作**不可读**，同一份字节两个答案、只因调用顺序才没出事（`stashIndexBySha` 那一处更糟：三条恢复入口会把“读不出”报成“条目已消失”，等于告诉用户唯一一份改动没了）；现在只有一个判据 `worktree.readStashList`（`listed` / `empty` / `unreadable`），损坏的 reflog 一律 `unreadable`，真正的空栈仍是 `empty`。另修一处提示语缺陷：回滚消息里的“说明文字”改为点名 reflog 说明 `%gs` 与 commit 标题 `%s`。
* \[x] **删除前预检仍是第四份 stash 列表判据 / 恢复公告靠中文文案分类（0.8.2 第四次复审）**：上一轮把三处读取统一到 `readStashList`，却漏了 `stashRemoveBySha` 开头那次独立的 `git stash list`——它只看退出码，损坏 reflog（退出 0、无输出、`refs/stash` 仍解析得到）会被读成“栈为空”。该形状当时仅因 `removeOwnStash` 先过 `presence.listed !== true` 才不可达；现在预检也走 `readStashList`，`unreadable` 返回**拒绝**（`refused: true`）且不做任何写入，只有 `empty` 才是 `gone`。`git stash drop` 非零退出原先返回 `refused: false`（等同于“没拒绝”），也已改为 `refused: true`。同时 `rebaseViewProvider.announceSettled` 原先用 `removal.message.includes("git stash store")` 区分结果，实测两个方向都错：`ambiguous` 拒绝（什么都没恢复）被公告成“删到了别的条目…已原样恢复”，drop 后列表读不出来（不含该子串）被归进残留分支并给出 `git stash drop stash@{0}`——而那个槽位此刻属于谁未知。现在 `StashRemoveResult` 与 `StashRemoval` 都带 `kind`（`removed` / `leftover` / `undo-restored` / `undo-unknown` / `ambiguous-refusal`），公告只按 `kind` 分支，**全链路不再对自产文案做子串/正则判断**。`removeOwnStash` 曾把“删除前列表未能读取、无法交叉核对”的说明构造出来后又丢掉（`res.ok || res.gone` 时只返回 `{status:"removed"}`），现在该说明作为 `uncrosschecked` 一路带到日志与弹出提示，用户能真正看到。
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

### P3-2. 0.8.3 评审遗留（`code-review-0-8-14.md` 的 N-1 / N-2 / N-3 / N-5）

> 来源：`code-review-0-8-14.md` 第五节。四项均在 0.8.3 内处理完毕，此处记录实现方式与仍然存在的边界，供后续版本复核。

* **N-1（P2，带斜杠的远端名）**：已不再自行拆分 `@{upstream}`。`getUpstream` 用一次 `git for-each-ref --format='%(upstream:short)%09%(upstream:remotename)%09%(upstream:remoteref)%09%(upstream:track)'` 取 Git 自己解析出的远端名、远端分支与上游状态，`team/origin` 不再被切成 `team` + `origin/master`。`pushDestination` 另加一道护栏：传入 `git remote` 的实际远端名单，名单里没有的名字直接降级为 `（无法确定目标分支）`，宁可明说不知道也不打印一个看着合理的目标。回归用例在 `.git/config` 里手写 `team/origin`，并在同一仓库放一个名为 `team` 的诱饵远端，断言提示是 `team/origin/master` 且 `team` 远端上没有任何 ref 被创建；把实现临时改回“按第一个 `/` 切分”该用例变红（`actual: 'team'` / `expected: 'team/origin'`），恢复后通过。
* **N-2（P3，非 HEAD 源的 refspec）**：commit 标题改由 `pushSource(refspec)` 从 refspec 源端解析（去掉 `+` 前缀，取冒号左侧；无冒号时用整个 refspec），解析不出才回退 `HEAD`。剩余边界：源端写成符号引用（如 `HEAD:refs/heads/x`）时标题仍是当前 HEAD 的标题，而 `HEAD` 在推送时才求值，两者理论上有极小的不一致窗口；要彻底消除需在推送前后各读一次源端 hash 并比对。
* **N-3（P3，删除不存在的远端分支）**：`pushRefspec` 改为返回 `{ changed }`，对 `Everything up-to-date` 与 `deleting a non-existent ref` 判为无变化，provider 报 `无需推送：…（远端已是该状态）`，不再报“已推送”。剩余边界：判定读取的是 Git 的英文输出，现已在推送子进程上固定 `LC_ALL=C`；若 Git 未来改动这两句措辞，判定会退化为按“已推送”报告（不会误报成功，但会丢掉更准确的“无需推送”措辞），需随 Git 升级复核。另外 `refs/for/*` 评审推送即使远端 ref 未动，服务端仍会新建评审单，`Everything up-to-date` 不一定出现，此时按“已推送”报告是正确的。
* **N-5（P3，既有行为）**：`src/extension.ts` 的 `gitRebaseVisual.push` 命令注册改为 `provider.pushBranch().catch(...)`，取消推送或未预期异常不再变成 unhandled rejection，而是经 `warnDiagnostic("push", …)` 记一条诊断日志（不弹窗：用户主动取消不是错误，真正需要用户知道的失败已经由 provider 自己提示过）。剩余边界：本次只按评审点名处理了 `push`；其余命令注册（`refresh`、`stash`、`undo` 等）没有逐个复核是否也会逃逸 rejection，新增命令时应沿用同一模式。

### P3-3. 0.8.3 第三轮复核（`code-review-0-8-15.md` 新发现 1–6）

> 来源：`code-review-0-8-15.md` 第九节。六项均已在 0.8.3 内处理完毕；下面记录实现方式与仍然存在的边界。

* **新发现 1（P2，上游分支被 prune 后推送完全没有反馈）**——这是 N-1 修复引入的回归，两个改动叠加造成：`for-each-ref` 在被 prune 后仍报告 `origin/master`，而 N-5 的 `.catch` 只写诊断日志。`getUpstream` 现在确认远端跟踪 ref 真实存在，不存在就返回 `undefined`，由调用方原有的「未配置 upstream」中文提示接住。**该条目的实现已在第四轮复核后改写**：最初用 `git rev-parse --verify --quiet refs/remotes/<remote>/<branch>`，但那条路径是**拼出来的**，对重命名/嵌套的 fetch 命名空间会误报（见下文 P3-4 四.3）；现在改为读取 Git 自己报告的 `%(upstream:track)`（`[gone]` 即视为没有可用上游），并把检测合并进同一次 `for-each-ref`（见 P3-4 四.4）。没有放宽 `.catch`：取消仍然静默，已报告的失败不会二次报告。**剩余边界**：`getUpstream` 现在把「被 prune」和「未配置」合并成同一句提示。用户看到的都是「没有可用 upstream」，但前者其实可以通过重新推送重建分支；若将来要让两者分开，需要一个新的返回值（例如 `"gone"`）并同步两个调用点，而不是在这里塞一条 toast。
* **新发现 2（P3，`branch.<b>.remote = "."` 被当成真远端）**——`%(upstream:remotename)` 对本地跟踪上游返回字面量 `"."` 而不是空串（原先 `pushGuard.ts` 的注释正好写反了，已改正）。`getUpstream` 把 `"."` 视为无远端；`pushDestination` 也独立拦截 `"."`，因此无论调用方走哪条路径，`./other` 都不会被打印。确认框与通知现在共用**同一份** `git remote` 名单（此前只有通知拿到名单，于是同一流程里确认框写 `./other`、通知写「无法确定目标分支」）。回归用例断言 `getUpstream` 返回 `undefined`、不弹确认框、且任何可见文本都不含 `./other`。
* **新发现 3（P3，删除型 refspec 声称推送了某个 commit）**——`:refs/heads/obsolete` 不发布任何 commit，但源端为空时调用方回退到 `HEAD`，于是提示把 HEAD 的标题安在了一次纯删除上。新增 `isDeletionRefspec()` 与 `describeDeletion()`，删除型 refspec 的提示是 `自定义推送：删除远端 ref → origin/obsolete`，不再引用任何 commit。`PUSH_SUBJECT_UNKNOWN` 的语义保持不变（「读不出标题」与「没有 commit」是两件事）。**剩余边界**：只有「源端为空且目的端非空」被判定为删除；`+` 前缀与空白已处理，但一个既非删除又解析不出源端的 refspec 仍回退 `HEAD`。
* **新发现 4（P3，`symbolic-ref` 恒不生效且注释误导）**——`git symbolic-ref` 只接受符号引用，而两个调用点都传短分支名，那一行恒 exit 1。已**删除这次调用**，`getUpstream` 的签名与文档改为明确的「传入短分支名」，并在函数内对 `refs/heads/` 前缀做归一化，使将来误传完整 ref 也不会静默失效。行为不变，但这意味着**不再支持 `HEAD` 作为入参**：detached 场景本来就由调用方传 `rebasingBranch()` 的结果。
* **新发现 5（P3，`docs/research/test-performance.md` 横幅自身过时）**——横幅原本写死「275 个测试 / 43 个文件」，现改为指向 `scripts/run-tests.js` 的实时枚举，不再写数字。同一句里「`pendingRecovery` 拆为 3 个文件共 60 个测试」仍然正确，保留。
* **新发现 6（P3，`gitRunner.ts` 审计表过期）**——`git/pushGuard.ts` 原本整条标为 `structural — refs, not messages`，但 `pushRefspec` 现在按英文散文（`Everything up-to-date` / `deleting a non-existent ref`）判定无操作。已拆成两行：`pushRefspec` 标为 **prose** 并注明传了 `LC_ALL=C`，`getUpstream` 标为 structural（上游名由 Git 解析，存在性检查只看退出码）。
* **变异 1 幸存（N-2 未被钉住）**——把 `pushSource(refspec) ?? "HEAD"` 改成常量 `"HEAD"` 后原有 15 条用例全绿。新增 provider 级端到端用例：自定义 refspec `HEAD~1:refs/heads/older` 必须让标题写出 `HEAD~1` 的标题而不是 `HEAD` 的，并断言该 commit 真的落在远端 `refs/heads/older`。已实测该变异下用例变红（`the title names the commit the refspec publishes`）。

### P3-4. 0.8.3 第四轮复核（`code-review-0-8-16.md` 四.1–四.6）

> 来源：`code-review-0-8-16.md` 第四节。四.1 与四.2 已修复并有端到端/直接调用两层回归用例；四.3–四.6 一并处理；下面记录实现方式与仍然存在的边界。

* **四.1（P2，本轮引入，已修复）**——`pushSource(refspec)` 的源端来自工作区设置 `gitRebaseVisual.push.refspecTemplate` 或自定义 refspec 输入框，而被直接拼进 `git log` 的位置参数；`git log` 在位置参数之后仍解析选项，`--output=<file>` 会**截断并写入**任意可写文件（实测把 `.git/config` 从完整配置截成一行 commit 标题，之后仓库所有 Git 命令报 `error: key does not contain a section`）。新增 `gitRunner.withPositionals()` / `END_OF_OPTIONS`，`git log` 改为 `["log","-1","--pretty=%s","--end-of-options", sourceRev]`；同时把 `.catch(() => "")` 去掉，源端不可解析时**可见地**报 `refspec 的源端 … 不是可解析的 commit` 并中止推送，而不是回退成 `（无法读取 commit 标题）` 继续推。回归用例 `test/pushIsolation.test.ts` 走**真实 `RebaseViewProvider`**：模板为 `--output=<相对路径>` 时断言文件从未被创建；手输 `--output=.git/config` 时断言 `.git/config` 逐字节不变且仓库仍能解析。把实现改回旧形态后两条都变红（`actual: 'second\n'`，以及文件真的被创建），恢复后通过。**剩余边界**：只隔离了这一个消费者；同一类"用户数据进位置参数"的通道已按 `gitRunner.ts` 审计表逐条排查（见四.3 的说明），但审计表本身需要在每次新增 `git()`/`runGit()` 调用时更新。
* **四.2（P1，基线即存在，已修复）**——`pushRefspec` 的 `args.push(up.remote, refspec)` 同样没有隔离：`git push` 允许选项出现在位置参数之后，`--receive-pack=<prog>` 会**执行本地程序**，`--mirror` 会**改写整个远端**（实测在远端创建 `refs/remotes/*`）。改为 `args.push("--end-of-options", up.remote, refspec)`。回归分两层：provider 级端到端（`--receive-pack` 的程序未被创建、远端 tip 未移动、拒绝是可见的且不报"已推送"；`--mirror` 后远端 ref 列表不变），以及**直接调用 `pushRefspec`** 的两条（provider 级会在源端检查处提前拒绝，走不到 `pushRefspec`，所以只测 provider 会漏掉标记本身）。把 `pushRefspec` 改回 `args.push(up.remote, refspec)` 后，直接调用层实测红：`--receive-pack` 的程序**被执行**（`true !== false`），`--mirror` **成功且不报错**（`Missing expected rejection`）；恢复后 9 条全绿。**剩余边界**：`--end-of-options` 必须自己是最后一个选项，因此 `up.remote` / `up.branch` 若以 `-` 开头仍会被当选项读——但这一点随后被实测推翻：远端名**可以**以 `-` 开头（`git remote add -- -evil …` 被接受，`git remote` 原样打印 `-evil`），所以它们的确是"设置/输入可达"的，只是标记恰好让这种形状**可用**而不是失效（见下一小节四.2 的实测）。真正的不变式是"所有选项都写在它们之前，因此它们是构造上的位置参数"。该边界写在 `pushRefspec` 的注释里，没有假装已覆盖。
* **四.3（P3，本轮引入，已修复）**——`getUpstream` 曾用拼出来的 `refs/remotes/<remote>/<branch>` 做存在性检查，只要 `remote.<r>.fetch` 把分支落到别的命名空间（`+refs/heads/*:refs/remotes/upstream/*`、`refs/remotes/origin/nested/*`、`refs/mirror/*`）就会对一个**健康的**仓库断言"未配置 upstream"并拒绝推送。现在直接用 Git 报告的 `%(upstream)` 作为 `ref`，并用 `%(upstream:track)` 的 `[gone]` 判定存在性（`[gone]` 是 prune 的可靠信号）。回归用例覆盖三种命名空间的健康态与 prune 态；把实现改回拼路径后实测红（`the upstream resolves in refs/remotes/upstream/*`、`refs/mirror/* is rejected once pruned`）。**剩余边界（重要）**：`%(upstream:track)` 对"配置了但从未 fetch"与"远端分支整个被删除且未 prune"返回**空串**而不是 `[gone]`，所以判据是"只有 `[gone]` 才拒绝"，不能反过来写"空即不存在"。
* **四.4（P3，本轮引入，已修复）**——上面的存在性检查此前是第二次 `spawn`，实测 `getUpstream` 680.5 ms vs 350.5 ms（**+330 ms/次**），而它挂在一次实测 3823 ms 的 `refresh()` 上、轮询 1500 ms。四.3 改成单次 `for-each-ref` 后这次 `spawn` 消失。回归用例用 `setGitInvocationObserver` 断言 `getUpstream` 恰好产生 **1** 次调用且是 `for-each-ref`；把第二次 `rev-parse --verify` 加回去后实测红（`2 !== 1`，`saw ["for-each-ref …", "rev-parse --verify --quiet refs/remotes/origin/master"]`）。**补充（2026-11-07）**：单次调用还不够，**必须带 ref 模式**。同一台机器实测（spawn 占主导，因此差值是保守下限）：

  | 仓库 ref 总数 | `for-each-ref refs/heads/master`（现行） | 全量 `for-each-ref`（无模式） |
  | --- | --- | --- |
  | 2 | 637 ms | 614 ms |
  | 2 000 | 602 ms | 761 ms |
  | 20 000 | 633 ms | **2049 ms** |

  即"只 spawn 一次"若不带模式，会把每次 `refresh()` 的成本从与分支数无关变成随**全部 ref 数量**线性增长。原用例只断言 `^for-each-ref `，去掉模式仍然全绿——现已补一条断言要求调用**以 `refs/heads/master` 结尾**，实测在去掉模式的变异下变红（`and it is scoped to the one branch, not the whole ref database; saw for-each-ref … --end-of-options`），恢复后通过。
* **四.5（P3，文档，已修复）**——`RELEASE.md:129` 与 `docs/improvement/improvement.md:147` 曾写"先 `git symbolic-ref --short` 解析分支"，与同一条目内"`symbolic-ref` 那次调用已删除"自相矛盾。两处都改写为"一次 `for-each-ref` 取 `%(upstream:short)` / `%(upstream:remotename)` / `%(upstream:remoteref)` / `%(upstream:track)`"；现在全文只剩两处"已删除"的说明，与新描述一致。
* **四.6（P3，文案边界，保持合并并写明理由）**——"被 prune"与"从未配置"仍共用一句 `分支 <b> 未配置 upstream。`。**这是有意合并的**，理由写在 `getUpstream` 的文档注释里：两者都让用户没有可推送的上游、下一步相同（重建或配置一个），而分开需要一个第三态（`"gone"`）穿过两个调用点。若将来要分开，做法是给 `getUpstream` 增加返回值并同步两个调用点，而不是在 `getUpstream` 内部塞一条 toast。

### P3-5. 0.8.3 第五轮复核（`code-review-0-8-17.md` 四.1–四.2）

> 来源：`code-review-0-8-17.md` 第四节。四.1 是本轮引入的 P2 回归，已按"分开选项与位置参数"的结构修好；四.2 是注释认知错误，已按实测改写。

* **四.1（P2，本轮引入，已修复）——`recentN` 的 `-n` 落在 `--end-of-options` 之后，提交列表整段失效。** 上一轮把 `revRange` 当"一串位置参数"传给 `getCommits`，而 `recentN` 的范围字符串是 `-n <count> <tip>`：标记插在它前面，`-n` 与计数都成了位置参数，Git 直接拒绝整条命令（`fatal: option '-n' must come before non-option arguments`，exit 128）。`gitRebaseVisual.commitRange: "recentN"` 是公开设置（`recentCount` 默认 20），用户看到的是空列表 + 一条 Git 英文原文。**修的是结构不是字符串**：`resolveRange` 现在返回 `RangeArgv { options, positionals }`，`getCommits` 用 `withPositionals([...固定选项, ...range.options], range.positionals)` 组装，标记永远落在"所有选项之后、第一个位置参数之前"。`RangeArgv` 的文档注释写明了为什么必须是两个字段而不是一个可空格拆分的字符串，以及将来新增范围类型必须自己决定每个参数在哪一侧。
  * **回归用例分两层**：`test/commitLog.integration.test.ts` 新增"每个已提交范围都真的执行并返回承诺的 commit 数"——对 `recentN`（含 `count: 0` 的钳制）、`all`、`upstream`、`mainBranch` 四种都调用 `getCommits` 并断言条数，且**先断言执行结果、再断言 argv 形状**（上一轮的缺口正是只断言形状）；`test/pushIsolation.test.ts` 新增真实 provider 端到端用例（`commitRange=recentN`、25 个 commit、`recentCount=20`，断言 `error` 为 `undefined` 且 `commits.length === 20`）。
  * **实测红/绿**：把 `recentN` 改回 `positionals: ["-n", …, tipRef]` 后，两层都红——集成层 `Error: git log … --end-of-options -n 2 HEAD failed (128): fatal: option '-n' must come before non-option arguments`，provider 层 `no error is reported; got "… --end-of-options -n 20 HEAD failed (128): fatal: option '-n' …"`；恢复后均绿。
  * **同时消除的耦合**：`canonicalSnapshotKey` 需要字符串身份，新增 `rangeArgvKey()` 生成与旧存储文本完全一致的串（`[...options, ...positionals].join(" ")`），快照身份不因类型改变而漂移。
  * **剩余边界**：`recentCount` 来自设置但类型是 `number`，经 `Math.max(1, count)` 后以 `String()` 进入 `options`，不可能携带选项；若将来把范围改成"用户可输入任意字符串"，必须重新审这一处。
* **四.2（P3，认知/注释错误，已修复）——`pushRefspec` 把 `up.remote` 的残余风险说反了。** 原注释称"远端名不以 `-` 开头"，实测不成立：`git remote add -- -evil ../remote.git` 被接受且 `git remote` 会原样打印 `-evil`。同一条实测还发现标记是**修好**而不是**绕过**这个形状：无标记时 `git push --force-with-lease=master -evil …` 把 `-evil` 当成 `-e` 而以 `unknown switch` 失败，有标记时同一形状正常推送。分支侧同理：`git push origin HEAD:refs/heads/-foo` 会成功，`%(upstream:remoteref)` 报 `refs/heads/-foo`；`git check-ref-format --branch -foo` 只拒绝"分支简写"，`git check-ref-format refs/heads/-foo` 是 **exit 0**。注释已按实测重写，说明真正的不变式是"所有选项（含标记）都写在它们之前，因此它们是构造上的位置参数"。**行为未变**（标记本来就是对的），只改文字。
* **第五节的完整性**：B 在 `code-review-0-8-17.md` §五逐条过了所有"设置/输入 → 位置参数"的站点，结论是没有遗漏。我独立复核了它点出的两处：`commitLog.ts:103` 的 `tipRef` 只来自 `"HEAD"` 或 `rebasingBranch()` 的短名；`sendDetail` 的 `hash` 走 `commitDetail` 的 `git show` 位置参数，确实存在 `--output=` 注入面，但被 `requiresCurrentCommitHash`（`requestDetail` 在其集合内）+ `isCurrentCommitHash`（40-hex 且在快照内）双重挡住——已在 `sendDetail` 上加注释说明这条耦合，防止将来放宽 gate 时无声退化成四.1。

### P3-6. 0.8.3 第六轮复核（`code-review-0-8-18.md` 四.1–四.4）

> 来源：`code-review-0-8-18.md` 第四节。B **批准 0.8.3 发布**（含 `dist-vsix/git-rebase-visual-0.8.3.vsix`），四项均为 P3 且被列为提交前的必做项；其中四.2 是**我上一轮留下的假覆盖**——一条名字声称钉住了 `getCommits` 标记、实际只钉住 `rev-parse` 门的用例。

* **四.1（P3，基线即存在，已修复）——两处 `rev-list` 没有跟 `git log` 一起加标记。** `pushGuard.pushRange` 的 `git(["rev-list", `${upstreamRef}..${tip}`])` 与 `rebaseViewProvider` 刷新计数的 `runGit(["rev-list","--left-right","--count",`${upstream.ref}...HEAD`])` 仍是"一串字符"形态。`upstreamRef` 是 Git 自己的 `%(upstream:short)`，而远端名**可以**以 `-` 开头（见 P3-5 四.2 的实测），于是：
  * 推送路径实测 `pushBranch THREW: git rev-list -evil/master..HEAD failed (129)`（`usage: git rev-list …`），`titles: []`、`visible messages: []`、`remote advanced: false`——用户点了推送什么也看不到；
  * 刷新路径实测 `git rev-list --left-right --count -evil/master...HEAD` 真值 `0 2`，而 provider 报 `ahead=0 behind=0`。
  两处都改成 `withPositionals(["rev-list", …], [...])`；实测修复后推送路径 exit 0 并列出待推 commit，刷新路径 `0 1` 正确。
  * **穷举审计（本轮要求的重点）**：B 指出"被告知去审计后仍漏了两处"。这次按命令族逐个过了一遍全部 `git()`/`runGit()` 调用点，凡位置参数可能来自 Git 输出、设置或 webview 的都改成 `withPositionals`，覆盖 `rev-list`、`rev-parse`、`for-each-ref`、`show`、`diff`、`diff-tree`、`cat-file`、`ls-tree`、`checkout`、`reset`、`update-ref`、`show-ref`、`merge-base --is-ancestor`。**审计中额外发现一处 B 未点名的注入面**：`llm/messageGen.getCommitDiff` 的 `git show <hash>`，其 `hash` 经 `generate` 从 webview 传入，而 `generate` **不在** `requiresCurrentCommitHash` 集合内——所以这是真实的 webview 注入通道，不只是加固。修法两道：加标记，并在 `generate` 里要求目标 hash 等于 `activeSession()` 的 hash，否则可见地拒绝且**不发送 AI 请求**。
  * **两条命令经实测拒绝标记，未加**：`git stash store`（自带参数解析，`"git stash store" requires one <commit> argument`，exit 1）与**裸 `git rev-parse`**（会把 `--end-of-options` 打到 stdout，污染结果；只有 `rev-parse --verify` 安全）。两处都在注释里写明"为什么不加"以及真正起保护作用的是什么（`store` 的保护是 `dropped` 为从 `git stash list --format=%H` 解析出的 40-hex）。
  * **"范围算不出来"不再等于静默**：按指示选了**一条共享路径**而不是再加一道前置检查——`BranchPresentation` 新增 `upstreamNote`，在**上游可解析、但对着它计数失败**时填入该字段；webview 在它存在时用 `↑? ↓? · <原因>` **替换**箭头计数，而不是并排显示，因为 `↑0 ↓0` 与"无法计算"同时出现时前者会赢。推送侧 `pushBranchInternal` 用 try/catch 把 `pushRange` 的抛出变成可见的 `无法计算推送范围（…）。未执行推送。`——`pushRange` 抛而不是返回 `[]`，正是因为空数组在锁守卫眼里等于"范围内没有锁定 commit"。
    * 范围限定（第七轮实测后补）：这条 note **不**覆盖"上游被 prune、配置了但 ref 不解析、悬空 sha、坏 symref、非 commit 跟踪 ref"等形态——它们在 `%(upstream:track)` 报 `[gone]`，`getUpstream` 就返回 `undefined`，由 `upstreamRef` 的 `未配置 upstream` 承担；退出码非零只是"计数失败"的**表现形式**，不是独立入口。唯一实测能走到这里的是"HEAD 与上游 tip 相同 + 其身后有一个对象损坏"。
  * **回归用例**：`test/pushIsolation.test.ts` 新增 3 条（`-evil` 远端下 `pushRange` 算出范围、锁定 commit 仍被拦住且**不出现内部 usage 错误**、刷新 ahead/behind 为 `1/0` 且 `upstreamNote === undefined`）；`test/webviewDom.test.ts` 新增 1 条（`upstreamNote` 存在时 `↑0 ↓0` 必须消失）。**实测红/绿**：把两处 `rev-list` 的标记同时去掉，三条 `-evil` 用例全红，报错正是 B 看到的 `git rev-list -evil/master..HEAD failed (129): usage: git rev-list …`；恢复后全绿。
* **四.2（P3，测试质量，已修复）——一条名字说谎的用例让 `getCommits` 的标记完全没有覆盖。** 原 `test/pushIsolation.test.ts` 的 `"a mainBranch of 'HEAD --output=<file>' cannot write that file"` **只**钉住 `resolveRange` 的 `rev-parse --verify` 门：实测只去掉 `getCommits` 标记它**仍然绿**，只去掉 `rev-parse` 门它才红。也就是说上一轮声称"标记有用例"是不成立的。
  * 已补 B 提出的用例（`getCommits does not let an option-shaped positional write a file`，直接以 `RangeArgv` 调用并断言 `--output=<file>..HEAD` 没有被创建），并把原用例改名为 `resolveRange rejects a mainBranch whose base is 'HEAD --output=<file>'`，前面写明它钉的是哪一道门、为什么不是标记。
  * **两个方向都实测**：去掉 `getCommits` 标记 → 新用例红、改名后的原用例绿（这正是四.2 的论点）；去掉 `rev-parse` 门 → 改名后的原用例红；两者恢复后全绿。
  * **剩余边界**：`--end-of-options` 不在 `git stash store` 与裸 `git rev-parse` 上使用是**实测结论**，不是偏好；将来若升级 Git 应重测这两处，而不是照抄"所有位置参数都加标记"。
* **四.3（P3，文档自相矛盾，已修复）**——`docs/improvement/improvement.md` 的 P3-4 四.2 段落仍写"远端名不以 `-` 开头…不是设置可达的"，而同一文件 P3-5 四.2 已用实测推翻它。按要求把前者改成与后者一致，并明确指出真正的不变式是"所有选项都写在位置参数之前"。
* **四.4（P3，文档过期，已修复）**——`docs/release-notes/0.8.3.md` 与 `docs/summary/summary.md` 都还写着 `getUpstream` "会先 `git rev-parse --verify` 确认它存在"，而该调用两轮前就被单次 `for-each-ref` + `%(upstream:track)` 的 `[gone]` 取代了（`RELEASE.md` 当时是对的）。同一句还把杀死性变异写成"把 `rev-parse --verify` 的存在性检查去掉"——现在已不可能。两处都改写为 `for-each-ref` + `[gone]`，并把变异改成"去掉 `[gone]` 判定"。**实测**：去掉 `[gone]` 判定后 `test/pushNotification.test.ts` 的 `a pruned upstream reports a visible error instead of failing silently` 变红，报错为 `git rev-list origin/master..HEAD failed (128): … unknown revision`；恢复后通过。

### P3-7. 0.8.3 第七轮复核（`code-review-0-8-19.md` 新发现 1–6）

> 来源：`code-review-0-8-19.md` 第四节。B 维持对 0.8.3 的批准并确认穷举审计**没有遗漏**（48 处 `withPositionals` 与所有 `runGit([...])` / `git([...])` 字面量逐一比对，没有设置或 webview 可达的位置参数漏掉标记）——"那项工作已经做完，不要重开"。本轮六项里三项是**覆盖缺口**：功能是好的，但没有任何用例会让它在被改坏时变红。

* **新发现 1（P3，覆盖缺口，已修复）——provider 层对 `upstreamNote` 的赋值没有用例。** B 用 `mut19j`（只把 `:440` 那行换成注释）跑 `rebasePresentation` + `webviewDom` + 两条 `pushIsolation`（共 17 条）**全绿**；反向的 `mut19i`（把 `if (counts.code === 0 …)` 改成 `if (true)`，让 `else` 永不可达）同样全绿。也就是说 note 只被**合成**用例覆盖过，没有一条从 provider 走到 webview。
  * 新增 `test/pushIsolation.test.ts` 的 `refresh shows the 'cannot compute' note instead of 0/0 when the count fails`：构造一个上游仍可解析、但计数必失败的真实仓库，驱动真实 `refresh()`，断言 state 里的 `upstreamNote` 以 `无法计算与 origin/master 的领先/落后（` 开头、是单行、且保留了 `fatal: … is corrupt`。**前置断言 `getUpstream` 仍返回 ref**——否则该用例会滑到无关的"未配置 upstream"路径而什么也没钉住。
  * **实测红/绿**：把赋值换回 `void upstreamNote;` → 红，报错 `the note names the upstream it could not measure; saw undefined`（`actual: 'undefined'`）；恢复后绿。
  * **构造形状是实测出来的**，记在这里以免下次重推：能让 `for-each-ref` 退出 0、`getUpstream` 有值、而 `rev-list --left-right --count` 退出 128 的唯一形状是**两个 tip 相同 + 它们身后有一个对象损坏**。prune / 从未 fetch / 悬空 sha / 坏 symref / blob、tree、annotated tag 作跟踪 ref **全都**在 `%(upstream:track)` 报 `[gone]`，在 `getUpstream` 就被吸收。若 tip 不同（哪怕只差一个 commit），`for-each-ref` 自己也要走历史而以 128 失败，于是连 `getUpstream` 都返回 `undefined`。也试过造一个"ref 列表能答、范围查询不能"的 refspec 形状：`refs/remotes/src/.git/packed-refs` 被 Git 以 `fatal: invalid refspec` 拒绝（`.git` 是保留路径前缀），所以那条路不存在。
* **新发现 2（P3，覆盖缺口，已修复）——推送侧 `无法计算推送范围` 的 catch 没有用例。** B 的 `mut19d`（`pushRange` 的 `if (res.code !== 0)` → `if (false)`）与 `mut19e`（只把 catch 文案换成 `MUTATED catch`）都让 `pushNotification` + `pushIsolation` **35/35 全绿**；并指出 `pushIsolation.test.ts:494` 的 `assert.match(reported, /推送被拒绝|无法计算推送范围/)` 因为第一个分支永远成立而**零约束**。
  * 新增 `a push whose range cannot be computed reports that, and never reports success`：同一形状下先 `refresh()` 记下 repo root、再写入一条真实锁（`lockedInPush` 在两组锁都为空时会提前返回 `[]`，不写锁就根本走不到 `pushRange`），然后驱动真实 `pushBranch()`。断言：`无法计算推送范围（origin/master..HEAD）：`、`git rev-list origin/master..HEAD failed (128)`、`未执行推送` 三条**同时**成立，且**不含** `已推送`、不含 `推送被拒绝`（本次不是被锁拦住，是范围本身失败），`titles` 为空（进度条从未打开）。
  * **实测红/绿两个方向**：`mut19d`（`if (false)`）→ 红，`the reason is named; saw "推送到 origin/master？（…）\nrefspec 的源端 HEAD 不是可解析的 commit：… corrupt。未执行推送。"`（漏到了下游的另一条提示）；`mut19e`（文案换掉）→ 红，`saw "MUTATED catch"`。恢复后绿。这也顺带说明原 `-evil` 用例的弱断言应当收紧，但它钉的是另一件事（`-evil` 下不出现内部 usage 错误），故保留。
* **新发现 3（P3，覆盖缺口，已修复）——`generate` 的 Compose 会话一致性闸没有用例。** `mut19f`（`if (!target || target !== hash)` → `if (false)`）让 `composeDraft` + `webviewProtocolState` + `webviewDom` **20/20 全绿**。这道闸是本轮为 `getCommitDiff` 注入面加的第二道防线：接受会话只证明**面板**是我们开的，不证明**这条消息里的 hash** 是面板的目标。
  * 新增 `test/composeSessionGate.test.ts`（3 条）。核心一条驱动真实 `onMessage({type:"openCompose"})` 建立会话，再发 `generate` 时把 `hash` 换成**仓库里另一个真实存在、也在可见列表里**的 commit —— 两个 hash 都合法，只有会话权威能分辨。断言：`fetch` 调用列表为空、面板收到 `genError`、文案含 `生成目标与 Compose 会话不一致` 与 `未发送 AI 请求`。
  * **正向对照是同文件第二条**：hash 与会话一致时 `fetch` 恰好被调用一次、URL 以 `/chat/completions` 结尾、`genResult` 带回模型文本。没有它，"`fetch` 未被调用"在探针本身失效时也会通过。
  * **第三条钉住"用哪一个 hash"**：断言发给模型的请求体里出现会话目标 commit 的文件名、不出现其祖先的文件名。前两条只能证明"两个值不同时会拒绝"，这条证明真正参与生成的是 `targetHash`（从会话读出）而不是 `hash`（从消息读出）。
  * **实测红/绿**：`mut19f` → 核心用例红，`no AI request was sent; saw ["http://127.0.0.1:9/v1/chat/completions"]`；恢复后三条全绿。
  * **夹具注意**：默认 `commitRange` 是 `upstream`，而这些夹具没有远端，列表为空时 `openCompose` 会因"目标 commit 已变化"拒绝所有 hash——那是另一个原因，测试里显式设成 `all`。
* **新发现 4（P3，主张/可达性，已修复）——`upstreamNote` 的 `else` 分支唯一可达形态里 note 又被丢掉。** 按 B 的建议选了**两项都做**：
  * **一行修复**：`getCommits` 的 `catch` 现在展开 `...presentation`（`return postCurrent({ type: "state", error: …, rebaseInProgress, ...presentation })`）。此前它只返回 `{ type, error, rebaseInProgress }`，于是 note 算出来又被丢弃。这直接由新发现 1 的用例钉住：**去掉这个展开 → 同一条用例红**，`the note names the upstream it could not measure; saw undefined`。
  * **注释按实测收窄**：原注释说"一个共享 note 覆盖计数失败的**任何**原因，所以新形态不会重新引入静默的 0/0"，这个主张比实现强。现在写明它覆盖的是"`getUpstream` 解析出了上游、但对着它计数失败"，并列出**不**覆盖的形态（pruned / 从未 fetch / 悬空 / symref 坏 / 非 commit 的跟踪 ref 都报 `[gone]`，在更早处被吸收），以及实测结论——今天唯一真正走到这条分支的是"HEAD 历史里一个对象损坏"。
  * **为什么选 (b) 而不是 (a)**：尝试过构造"(a) 分支可达且 `getCommits` 成功"的形状，结论是不存在。除上面那条 `for-each-ref` 与 `rev-list` 的差异外，损坏对象若位置在 `-n` 窗口之外，`git log -n 20` **会读过去**（实测：把第 25 个 commit 弄坏后 `git log -n 20 … HEAD@{upstream}..HEAD` 仍以 128 失败、`rev-list --count` 也 128，而 `for-each-ref` 同样 128），所以无法让"计数失败"与"列取成功"并存。测量的几组：深度 2/5/18/19/20/21/22/25/30，只有 tip 相同且对象损坏这一组能分离两者。
* **新发现 5（P4，注释准确性，已修复）——`gitRunner.ts` 对裸 `rev-parse` 的描述只覆盖两个例子。** 原注释说"unsuffixed 形式只用在答案是固定 ref 名的地方（`HEAD`、`--show-toplevel`）"，但 `src/git/commitLog.ts:295` 有 `runGit(["rev-parse", sha])`，其 `<sha>` 是 `.git/rebase-merge/stopped-sha` 的**文件内容**。已改写为：unsuffixed 形式同时用于固定 ref 名与从仓库内部文件读出的 sha；真正的保护不是"参数是常量"，而是**裸 `rev-parse` 只回显、不执行选项**（实测 `--output=<path>` 不落盘、`--git-dir=…` 只被打印），且所有调用点都只把 stdout 当名字字符串用；同时给"既要传不可信输入、又要从 stdout 解析出名字以外的东西"的站点写明必须改用 `--verify` 或别的子命令。
* **新发现 6（P4，呈现，已修复）——note 直接拼 Git stderr，而上下文栏是单行 `nowrap + ellipsis`。** 实测该形态的 stderr 是三行（两行 `error:` 后一行 `fatal:`），整段插进去后浏览器压成一行再从尾部截断——**被截掉的正好是 `fatal:` 那句真正的原因**。
  * 新增 `upstreamNoteDetail()`（放在 `src/ui/rebasePresentation.ts`，因为它是纯呈现逻辑；`rebasePresentation.test.ts` 因此不需要 `vscode` 桩）：取最后一条非空行（`fatal:` 既是最后一行也最具体）、按 `\r?\n` 切分以兼容 CRLF、按**码点**截断到 `NOTE_DETAIL_LIMIT = 140` 并加 `…`（按 UTF-16 码元切会留下半个代理对），stderr 全空时回退成 `git rev-list 退出码 <code>`（否则 `（）` 会被读成格式 bug 而不是 Git 失败）。
  * **实测红/绿**：把函数改回 `return counts.stderr.trim();` → 新用例红，`actual` 是那三行原文、`expected` 只有 `fatal:` 那行；恢复后绿。
* **验证**：两个类型检查零输出；完整套件 **323 项**全部通过、0 失败、0 跳过（本轮新增 6 条：provider 的 note 一条、推送范围失败一条、Compose 会话闸三条、note 单行化一条。`test/pushIsolation.test.ts` 由 15 增至 17，新增 `test/composeSessionGate.test.ts` 3 条，`test/rebasePresentation.test.ts` 由 3 增至 4 —— 故 317 + 6 = 323）。三处计数已同步：`docs/summary/summary.md`、`RELEASE.md:136`、`docs/release-notes/0.8.3.md`。

### P3-8. 0.8.3 第八轮复核（`code-review-0-8-20.md` 新发现 1–4）

> 来源：`code-review-0-8-20.md` 第四节。B 再次维持对 0.8.3 的批准：第七轮六项逐条复验（`...presentation` 只携带真值、VSIX 可逐字节复现），0 个新增产品行为缺陷。本轮四项两项 P3、两项 P4，用户决定全部修完再提交。其中新发现 2 与 3 都是**同一类反复出现的缺陷**：断言/注释比实现强（"末条非空行就是原因"、"任何原因都填同一字段"）。

* **新发现 1（P4，呈现/correctness，潜伏，已修复）——`upstreamNoteDetail` 的"末条非空行"对 `unknown revision` 形态取到的是 Git 的用法提示。** 实测 `git rev-list --left-right --count ghost/master...HEAD`（exit 128）三行 stderr 的末行是 `'git <command> [<revision>...] -- [<file>...]'`，真正原因在第一行。旧 JSDoc 还写着末行是"the line Git guarantees to print"——这个断言实测不成立。
  * 改法：取**最后一条匹配 `/^(fatal|error):/` 的行**，没有才回退到末条非空行。对损坏对象形态结果不变（它的末行本来就是 `fatal:`，且比前两行 `error:` 更具体）。
  * 新用例覆盖三种形态：`unknown revision`（三条，期望第一行 `fatal:`）、损坏对象（既有断言不变）、以及**完全没有标记行**的流（回退到末条非空行，而不是丢给退出码——否则这条规则会丢掉 Git 唯一说过的话）。
  * **实测红/绿**：把实现改回 `lines[lines.length - 1]` → 红，`actual: "'git <command> [<revision>...] -- [<file>...]'"`、`expected: "fatal: ambiguous argument 'ghost/master...HEAD': …"`；恢复后绿。
  * **可达性声明保留**：这条分支今天只由"损坏对象"形态触达，`unknown revision` 形态被 `[gone]` 吸收；本项是**潜伏**缺陷，但不是纯理论——一旦 `[gone]` 判据放宽就会变成用户可见的错信息。
* **新发现 2（P3，测试质量，已修复）——用 `✨` 冒充代理对，防孤立代理的断言是空转。** `✨` 是 U+2728，UTF-16 长度 **1**，根本不是代理对；把实现换成 UTF-16 切片后整个文件 4/4 仍绿。这是第七轮"按码点截断"那条修复留下的**空断言**，属于反复出现的"测试看起来在钉、实际没钉"。
  * 新用例改用**混合串** `"a" + "\u{1D11E}".repeat(NOTE_DETAIL_LIMIT + 5)`：前面一个 BMP 字符把每个代理对整体推到奇数偏移，140 码元的边界正好落在对中间。（纯 astral 串不行——对从 0 开始，偶数边界会"碰巧"落在对之间，变异体照样存活；这一点是反向实测出来的。）
  * 断言两条：`Array.from(result).length === NOTE_DETAIL_LIMIT + 1`，且结果不匹配孤立代理正则 `/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/`。
  * **实测红/绿**：把 `Array.from` + `chars.slice` 换成 `last.slice(0, NOTE_DETAIL_LIMIT)`（UTF-16 码元切）→ 红，`actual` 是 `cp=72, utf16=141, lone=true, tail="𝄞\ud834…"`；恢复后绿。
* **新发现 3（P4，文档/注释一致性，已修复）——第七轮已撤回的"任何原因"说法仍活在两处。** `src/ui/rebasePresentation.ts` 的 `BranchContextInput.upstreamNote` JSDoc 与 `docs/improvement/improvement.md` 的 P3-6 四.1 都还写着"上游被 prune、配置了但 ref 不解析"会填这个字段；实测这两个形态都报 `[gone]`、在 `getUpstream` 就被吸收，永远到不了这里。
  * 两处都收窄为"上游可解析、但对着它计数失败"，并各自写明**不**覆盖的形态清单与"若将来放宽 `[gone]` 判据就会开始到达这里"。
  * 按要求把 `src/`、`media/`、`docs/improvement/improvement.md` 全文件重新扫了一遍同类措辞，除这两处外没有第三处。
* **新发现 4（P3，既有缺陷，非本轮引入，已修复）——缺 `commits` 的 state 在 `renderList` 抛异常。** provider 有四个站点只发 `{type:"state", error}`（无工作区、非 Git 仓库、`resolveRange` 失败、`getCommits` 失败），而 `renderList` 直接 `state.commits.map(...)`。
  * 修复 `media/main.js`：`renderList` 与 `filteredCommits` 用 `state.commits ?? []`。
  * **顺带发现并修掉更严重的一半**：`rebaseInProgress` 变体下 `renderBanner` 的 `state.commits.find(...)` 抛在**绘制之前**，用户看到的是一条**空横幅**——连错误都没有。`:454`/`:468` 在变基进行中正是发这个形状。B 的报告说"横幅已渲染"，对那次测量的那一种形状成立，对这个变体不成立，所以一并加守卫。
  * 新用例 `a state without a commit list renders the banner and the reason instead of throwing` 覆盖两个变体，断言横幅/上下文/列表都渲染、且渲染过程中没有未捕获异常逃逸。
  * **实测红/绿（两个守卫分别验证）**：只回退 `renderList` 守卫 → 红，`actual: undefined`（期望空列表文案）；只回退 `renderBanner` 守卫 → 红，`actual: ''`（横幅全空），jsdom 报 `Cannot read properties of undefined (reading 'find')`。
  * 说明：变基进行中时横幅按既有优先级显示"变基进行中"而不显示 `error`，本项不改这个优先级；错误仍通过上下文栏的 note 可见。
* **验证**：两个类型检查零输出；完整套件 **324 项**全部通过、0 失败、0 跳过（本轮 +1：`test/webviewDom.test.ts` 12→13；`test/rebasePresentation.test.ts` 仍 4 条——新发现 1、2 的断言都加进既有那条用例，因为它们钉的是同一个函数的同一个行为）。三处计数已同步：`docs/summary/summary.md`、`RELEASE.md`、`docs/release-notes/0.8.3.md`。

## 验收原则
所有后续历史改写功能应满足：

1. 输入来自 webview 时在后端验证当前快照、类型与完整性；
2. 任何长事务有明确 busy/取消/恢复语义；
3. 任何 worktree/index 改动以可定位 SHA 的 stash 或等价安全副本保护；
4. 每条成功与失败路径至少有一个真实 Git 临时仓库集成测试；
5. Release tag 必须通过 `npm run test:release` 和 VSIX 内容检查后才能发布。

