# Git Rebase Visual — 功能、架构与测试总结

> 当前基线：v0.8.1——侧栏内 hover tooltip 与右键菜单、owner 可解释的写锁与看门狗恢复、确定性结算的 Git 进程回收、位于用户主目录下的带轮转/脱敏会话文件日志、与真实 Git 状态对账的待恢复改动处理，以及 keep-index 残留快照的误报冲突修复。

## 1. 项目定位

Git Rebase Visual 是一个 VS Code 扩展：将原生 `git rebase -i` 封装成侧栏中的可视化提交时间线。用户可以拖拽排序、修改或删除 commit、锁定依赖提交、生成 AI commit message、管理 stash/push，并将暂存区内容追加到已有 commit。

```text
Webview (media/main.js)
  └─ postMessage
       └─ RebaseViewProvider
            ├─ git/       Git 命令、rebase、stash、push
            ├─ lock/      patch-id 锁定
            ├─ llm/       OpenAI 兼容消息生成
            └─ ui state   refresh、互斥、webview 状态同步
```

## 2. 核心功能

| 功能 | 行为与保护 |
|---|---|
| 拖拽重排 | scripted interactive rebase 的 oldest-first todo；Base/HEAD、拖拽前后语义、grip-only drag、键盘 pickup/drop 与历史改写确认。 |
| edit / reword / drop / Skip | 原生 rebase 中执行；暂停时提供 Continue / Abort；Skip 仅 conflict pause 可用且强确认 patch 丢弃。Compose reword 失败/暂停保留输入。 |
| squash / fixup / diff | 首项、locked current/前驱和 rebase 中时防御式禁用；受控只读 Git diff、复制完整 message。 |
| commit 锁定 | 稳定 `patch-id`，重排/cherry-pick 后仍识别同一修改；push 前阻止 locked 范围；locked commit 不能被 Drop/squash/fixup/append 静默修改。 |
| Undo 与操作历史 | 每次成功 rewrite 创建私有 before ref/journal；Undo 验证仓库、分支、HEAD、rebase、工作区、checkpoint 与 pushed 风险，使用 `reset --keep`。 |
| rebase session | 解析步骤 N/M、completed/active/pending、edit/conflict/paused/unknown；待重放 hash 明确会变化，不伪造外部 rebase 进度。 |
| Compose Panel / AI | 编辑器区 subject/body Panel、50/72、72 列参考、原 message/trailer 折叠、AI draft/取消/替换/追加/恢复、失败保留输入。 |
| stash | autoStash 以 stash commit SHA 持久化定位，避免 `stash@{0}` 漂移；append Abort 避免完整 snapshot 与 keep-index stash 重复恢复。 |
| push | 普通分支 `--force-with-lease`；可选评审 refspec；可取消进度/Output；rebase edit 停靠时仍可推送，并明确 detached HEAD 的分支/upstream 语义。 |
| 自动状态同步 | 文件事件与节流 index 轮询刷新 staged/unstaged 文件数；后台 status 使用 `GIT_OPTIONAL_LOCKS=0`，避免 optional `index.lock` 与终端写操作竞争。 |
| 列表/上下文/可访问性 | 作者文字前缀和稳定语义色、pending 文本、branch/upstream/ahead-behind、`author:`/`msg:`/`hash:0x` 搜索、IME composition、多选、右击目标重定向、安全 locked-run 折叠、ARIA、roving menu、状态栏和 High Contrast fallback。 |
| 文件级 SCM 恢复与 Diff | porcelain v2 `-z` 结构化 staged/working/untracked 状态；单文件 working/staged restore、确认删除未跟踪文件；公开 `vscode.diff` 的 index↔working、HEAD↔index 和 parent↔commit 对比；opaque request store 防止 URI 暴露仓库/ref/path。 |
| 连续 generated Diff | 单项或连续多选 commit 的 oldest-first frozen Diff snapshot；webview 禁用非连续选择，host 重验完整 hash、revision 与连续性；扩展私有只读 provider 使用 opaque token、TTL/LRU/repository invalidation。 |
| 写入与交互协议 | stage/restore/bulk stage-discard-unstage 作为 mutation 经 busy 串行化，paused edit-stop 由明确 allow-list 控制；pointer/native drag 使用 immutable canonical session，routine worktree refresh 不会使其 stale，而真正 timeline/lock/rebase 变化仍会拒绝旧手势；无副作用 UI 流量不触发暂停告警。 |
| 详情与菜单 | 悬停 400ms 由 `requestDetail` 取 `commitDetail`，host 回发 `detail`，webview 在侧栏行旁渲染浮动 tooltip（复制 message / 打开变更，指针移入不消失）；右键与 `Shift+F10`/Menu 在侧栏内打开 `#menu`，多选 ≥2 时提供批量锁定、批量删除与连续区间生成 Diff。不创建编辑器区面板，编辑器/窗口事件只下发 `closeMenu`。 |
| 写锁与恢复 | `MutationLock` 持有 `{id, action, label, source, startedAt}`，提供 owner 身份校验的 `release`、`forceRelease`、`markSettled`/`reapSettled` 与 stale 判定；拒绝消息命名 owner、来源与耗时，90s 看门狗写入 `mutation-stuck` 诊断并提供“强制解除并刷新”（先重读 rebase 标记/冲突文件/commit 列表）。 |
| 进程与日志 | `runGit` 以 `exit`（输出排空或 50ms 宽限）结算，超时/取消在固定宽限后只结算一次并**尝试**回收进程树（已脱离的孙进程可能存活，属进程泄漏，不阻塞结算）；`FileLogger` 每次会话一个 `<home>/tmp/log/git-rebase-visual-<version>/session-*.log`（0.8.1 起在用户主目录下，0.8.0 及更早为 `<tmp>/log/...`），按大小轮转、保留最近 10 个、脱敏凭据，失败即静默禁用；日志与 Output 首行为会话头（版本、扩展路径、VS Code 版本、宿主 pid、平台）。 |
| 待恢复改动对账 | `pendingRecovery.ts` 以真实 Git 状态判定遗留记录：rebase 是否进行、stash 是否仍列出、stash 内容是否已在 index/worktree（`diff --quiet` / `--cached --quiet` / `hash-object` vs `stash^3`）、`targetHash` 是否仍是 HEAD 祖先，追加落地则用 `git ls-tree -z` 逐路径比较快照 `^2` 与 HEAD 的 **mode + object**。内容已在即 resolved（静默清记录、不重复 apply）；未落地则 `apply --index`，冲突保持 pending。**整轮恢复不执行任何 `stash drop/pop/clear`**：任何结论都只决定记录是否清除，stash 一律保留，`recoveryCommands()` 给出 `apply --index` / `apply` / 用户自己执行的 `drop` 三条命令（槽位无法解析时回退到 sha，且只给两条 apply——Git 没有按 sha 的 `stash drop`）。`pendingRecoveryPolicy.ts` 提供 `(sha, reason)` 告警去重、可关闭横幅与按记录单飞的 `RecoveryCoordinator`；`refresh()` 不再因记录存在而跳过渲染，也不在写锁持有时插队执行恢复。 |

## 3. 「追加暂存区」事务

用户在 VS Code SCM（或终端）执行 `git add` 后，右键一个 commit 选择 **追加暂存区**。

```text
确认 staged 存在
  ├─ 拒绝被锁定的目标 commit
  ├─ 若目标已在 upstream：确认框要求显式二次确认「我已推送同内容，仍要改写」
  ├─ stashPush(-u) 保存完整初始快照
  ├─ interactive rebase：目标 action = edit
  ├─ 校验 stopped SHA 是目标 SHA
  ├─ stash apply --index 恢复初始 staged 内容
  ├─ git commit --amend --no-edit
  ├─ 若原来有 unstaged：stash push --keep-index -u
  ├─ 持久化 pendingAppend（含原目标 SHA；跨刷新时区分完成与外部 Abort）
  ├─ git rebase --continue 重放后续 commit
  └─ apply 未暂存 stash（不删除）；初始 snapshot stash 保留给用户
```

### 关键边界

- 暂存区为空：菜单禁用，后端也会复查并拒绝。
- 目标已锁定：必须先解除锁定，避免 amend 改变 patch-id 后失去推送保护。
- 目标已推送：确认框明确提示公开历史将被改写并要求显式二次确认，后续需 `--force-with-lease`。
- 发生重放冲突：保持 Git 原生 rebase 状态，面板 Continue/Abort 负责恢复 pending append stash。
- 扩展在事务中途退出：下次刷新先按真实 Git 状态对账（rebase 是否进行、stash 是否仍列出、内容是否已在 index/worktree、原目标是否仍是 HEAD 祖先），再决定 resolved / restored / pending；记录本身永远不会阻止 commit 列表渲染或后续写操作。
- 所有写操作由 provider 互斥；refresh 采用 generation token，避免旧请求覆盖当前 commit 快照。

## 4. 模块地图

```text
src/
├─ extension.ts                    激活、命令注册、会话日志与 Git 调用观察者接线
├─ config.ts                       VS Code settings 读取
├─ git/
│  ├─ gitRunner.ts                 spawn Git + 超时/输出上限/取消；exit 结算、尝试回收进程树、调用审计
│  ├─ commitLog.ts                 log/range/status/rebase 元数据
│  ├─ worktreeChanges.ts           porcelain v2 -z 解析、单文件 stage/restore/删除保护
│  ├─ rebaseEngine.ts              todo、execute/continue/abort rebase
│  ├─ worktree.ts                  stash 按 SHA apply、提交；仅用户显式 Pop 会 pop
│  ├─ message.ts                   message trailer 拆分与保留
│  ├─ pushGuard.ts                 upstream/refspec/锁定范围检查
│  ├─ pendingRecovery.ts           遗留记录与真实 Git 状态对账；只 apply，永不自动删除 stash
│  ├─ undo.ts                      私有 before ref、操作 journal、Undo preflight/reset --keep
│  └─ seq-editor.js                Git 调用的 sequence editor
├─ lock/lockStore.ts               patch-id 持久化锁与批量 lockMany
├─ llm/client.ts                   OpenAI-compatible chat / streamChat、deadline、错误脱敏
├─ llm/messageGen.ts               diff 和提示词构造、流式生成入口
├─ ui/rebaseViewProvider.ts        webview 协调、历史事务、SCM/Diff、session/progress、Undo、暂停/冲突、状态栏
├─ ui/worktreeDiff.ts              工作区/commit 文件 Diff 与 opaque content provider
├─ ui/gitDiffRequestState.ts       Git Diff request 的 URI opaque-token/TTL/LRU store
├─ ui/generatedDiffState.ts        连续 commit selection、stale guard 与 frozen Diff 构建
├─ ui/generatedDiffDocument.ts     generated Diff opaque snapshot/TTL/LRU store
├─ ui/generatedDiffProvider.ts     generated Diff 只读虚拟文档 provider
├─ ui/webviewProtocolState.ts      webview read/UI/mutation 分类与 paused allow-list
├─ ui/mutationGate.ts              busy / paused mutation 入口判定
├─ ui/rebaseState.ts               pause/progress/pending/unknown rebase 状态派生
├─ ui/composePanel.ts              编辑器区 Compose WebviewPanel 与 draft/session 状态
├─ ui/mutationLock.ts              owner 可解释的写锁、stale 判定与 busy/stuck 文案
├─ ui/pendingRecoveryPolicy.ts     恢复告警去重/横幅状态、按记录单飞的 RecoveryCoordinator
├─ diagnostics/fileLogger.ts       会话日志路径、轮转/保留、凭据脱敏、失败容忍
├─ diagnostics/diagnostics.ts      进程级日志 sink（未安装时静默降级）
├─ ui/canonicalSnapshot.ts          drag canonical revision key
├─ ui/refreshFeedbackPolicy.ts     manual/poll refresh feedback 策略
├─ ui/secretsAccess.ts             SecretStorage 访问器注入桩（安全降级）

media/main.js                      sidebar DOM、拖拽/键盘重排、菜单、筛选/多选/locked 折叠
media/style.css                    主题语义、pending/status/高对比度 fallback
.github/workflows/release.yml      tag 发布门禁与 GitHub Release
```

## 5. 测试体系

使用 Node 内置 `node:test`，由 `tsx` 直接执行 TypeScript。

| 层级 | 文件 | 覆盖内容 |
|---|---|---|
| 逻辑 | `test/message.test.ts` | trailer 拆分、保留、显式替换、通用 trailer |
| 逻辑 | `test/rebaseEngine.test.ts` | todo 顺序、各种 rebase action、空 todo |
| Undo/Git 集成 | `test/undo.integration.test.ts` | 私有 ref、journal、reset --keep、dirty/HEAD/branch/rebase/ref 拒绝、跨仓库隔离 |
| session/progress | `test/rebaseProgressState.test.ts` | done/todo、pending、unknown todo、exec/merge workflow、选择完整性 |
| rebase 合并 | `test/squashFixup.integration.test.ts` | squash message、fixup 丢弃 message、todo action |
| Compose 草稿 | `test/composeDraft.test.ts` | subject/body、字数阈值、恢复 draft 状态 |
| 逻辑 | `test/pushGuard.test.ts` | 默认/refspec 模板/空白模板 |
| 边界 | `test/gitRunner.integration.test.ts` | 非零 Git 结果、输出上限、取消信号；hook 留下继承 stdio 的孙进程时仍在 `exit` 结算；超时/取消只结算一次并尝试回收孙进程 |
| 逻辑 | `test/mutationLock.test.ts` | 获取/拒绝命名 owner、owner 身份校验的释放、`forceRelease`、settled 自愈、stale 判定与 busy/stuck 文案 |
| 逻辑 | `test/fileLogger.test.ts` | `<home>/tmp/log/git-rebase-visual-<version>` 路径（注入 home，POSIX/Windows 均不依赖运行机器）、旧临时目录路径、会话文件名、凭据脱敏、大小轮转、保留策略、只读/写入失败容忍 |
| Git 集成 | `test/commitLog.integration.test.ts` | staged/unstaged 文件数、commit 顺序、absolute git-path、edit stop/rebase-apply 分支 |
| Git 集成 | `test/worktree.integration.test.ts` | stash apply、keep-index、外部删除 stash（stash 列表如实反映外部删除） |
| 功能集成 | `test/appendStaged.integration.test.ts` | staged append、amend、后续重放、未暂存恢复 |
| Git 安全 | `test/rebaseSafety.integration.test.ts` | locked Drop conflict/Abort、冲突 Continue、edit-stop Abort 恢复 |
| 暂停状态 | `test/rebasePauseState.test.ts` | conflict / explicit edit / paused 状态派生 |
| LLM HTTP mock | `test/llmClient.test.ts` | SSE delta、畸形事件、deadline、预取消、流读取途中取消/超时（取消由首个 delta 送达触发，不依赖定时器；服务端有上限地继续推送，取消失效即断言失败）、错误正文脱敏，以及 Fetch Standard 全量 bad-port policy、真实 listener close/retry 生命周期 |
| Git 集成（推送/守卫） | `test/pushGuard.integration.test.ts` | bare-remote：force-with-lease 并发拒绝、lockedInPush 拦截/解锁 |
| Git 集成（append 守卫） | `test/appendGuard.integration.test.ts` | 已推 upstream 守卫、锁定 commit patch-id 跨重写稳定 |
| 注入桩 | `test/secretsAccess.test.ts` | SecretStorage 访问器安全降级与委托 |
| 恢复策略 | `test/pendingRecoveryPolicy.test.ts` | 同一 `(stash sha, 原因)` 只警告一次、已装填横幅在槽位漂移后**只更新文本、不重复弹窗**、横幅关闭后保持关闭（槽位漂移也不复活）、记录清空后重置、恢复单飞与失败后释放槽位、恢复在锁内运行且锁忙时整轮跳过、同步抛出不污染单飞键 |
| 恢复集成 | `test/pendingRecovery.integration.test.ts` | **不变量：整轮恢复不出现任何 `stash drop/pop/clear`**（Git 调用观察器断言）。已应用快照静默清除且 stash 仍在、手动 `stash apply --index` 后静默清除、stash 已消失的空记录静默清除、fresh snapshot 只恢复一次且 stash 保留、冲突的工作区恢复保留两份 stash、amend 落地后按 `ls-tree` mode+object 结算并保留 stash、未完成追加保持 pending、reset 只清孤儿记录而保留有内容的 stash；失败探测（`^1`/`^2`/`^3` 对象或 `^3` 树缺失、`git diff` 非零、stash reflog 损坏）一律保留记录与 stash；`targetHash` 被改写但 HEAD 不含快照时保持 pending；仅改文件模式且已落地可结算、chmod 未落地则保留；revert 形状的 amend + 后续编辑保留（旧 raw-log 扫描看不见）、目录重命名保留、同字节巧合保留；stash 上方压入新条目时按 sha 解析到自身槽位且不动其它条目；索引匹配但未跟踪/未暂存内容仍只存在于 stash 时补回工作区；残留的已跟踪路径只在与快照内容一致或路径缺失时才写回，已提交的更新内容不会被覆盖；keep-index 残留快照在 `amend` 之后被 `rebase --continue` 还原成 `stash^2` 内容时视为本次事务自己的内容并真实写回（结论 `restored`，不再报误冲突），两份 stash 均保留；`recoveryCommands` 给出 `apply --index` / `apply` / 用户自己执行的 `drop` 三条命令，且**每条打印出来的命令都会在独立临时仓库里真正执行并断言退出码为 0**（槽位可解析时三条；无法解析时只给两条 apply，不提供 Git 无法执行的 `stash drop <sha>`） |
| 恢复（provider 级） | `test/recoveryProvider.test.ts` | 真实 provider + 真实 Git：`dismissRecoveryNotice` 写入去重状态后跨 refresh（及推送的 state）不再出现横幅、并发 `stash push` 把记录压到 `stash@{1}` 后横幅改述新槽位且不重复弹窗、关闭后槽位漂移也不复活、`resetExtensionState` 保留不可验证/未恢复的 stash 并清除真正孤儿记录、`forceReleaseMutationLock` 重读 Git 状态、恢复在 mutation 持锁期间整轮跳过、settled 未释放的 owner 被 reap、看门狗对同一 owner 只告警一次且忽略外部 disarm、显式 **Pop** 只有确认后才执行（拒绝则 stash 完好，确认后条目被删且改动已恢复） |
当前测试套件在 v0.8.1 中扩展至 217 项测试；v0.7.1 的 UI/交互与安全裁决见 [`../ui-reivew/ui-review-0-7-1.md`](../ui-reivew/ui-review-0-7-1.md)，最终发布评审见 [`../review/code-review-0-7-4.md`](../review/code-review-0-7-4.md)。

命令：

```bash
npm run typecheck       # TypeScript 严格检查（src + test，含测试类型门禁）
npm run test            # 逻辑、边界、Git 集成与功能测试
npm run test:coverage   # 同上，并输出 Node coverage 报告
npm run test:release    # Release 门禁：typecheck + coverage tests
npm run package         # 编译并生成 VSIX
```

## 6. Release 门禁

`v*.*.*` tag 触发 GitHub Actions，依次执行：

1. `npm ci`；
2. 校验 tag 版本等于 `package.json.version`；
3. `npm run test:release`；
4. 打包 VSIX；
5. 验证 VSIX 含必要 runtime 文件，不含 `src/`、`test/`、`docs/`、`node_modules/`，且不含任何 `.map` sourcemap（release 构建默认不生成，sourcemap 内嵌 `sourcesContent` 会泄露完整 TypeScript 源码）；
6. 验证 `RELEASE.md` 包含对应版本，且 `docs/release-notes/<version>.md` 存在、标题匹配、无未替换模板占位符；
7. 以该版本化 Markdown 作为最终 Release body 创建 GitHub Release 并上传 VSIX。

任一环节失败均不会发布。

## 7. 已知后续工作（P2 规划）

- ~~大仓库 patch-id 缓存~~（✅ v0.4.0 已实施：session cache）与结构化变更统计（✅ v0.4.0 已实施：`--numstat`）；
- ~~append/stash 恢复可见性~~（✅ v0.4.0 已实施：精确 stash@{n} 提示 + `stashList` 命令）；
- 多根工作区、`all` 模式虚拟滚动/上限、provider 模块拆分、SecretStorage 完整读写迁移和 l10n；
- 多远端选择、完整 upstream divider、density 配置、通知分层、空/加载态和性能测试仓库；
- 真实 VS Code High Contrast Dark/Light、screen reader、Compose Panel/AI 状态和 keyboard-flow 人工验收；
- 刷新延迟基准与大仓库性能测量；

UI 建议的逐项事实结论、已修复项与真实 VS Code 人工验收边界见 [`../ui-reivew/ui-review-0-7-1.md`](../ui-reivew/ui-review-0-7-1.md)；最终发布评审及项目回复见 [`../review/code-review-0-7-4.md`](../review/code-review-0-7-4.md) 与 [`../review/review-response-0-7-4.md`](../review/review-response-0-7-4.md)。

外部版本化评审原文位于 `../review/code-review-<major>-<minor>-<patch>.md`；项目回复按相同版本号放在 `review-response-<major>-<minor>-<patch>.md`。开始评审前需读取 [`../review/code-review-commit.md`](../review/code-review-commit.md) 确认未覆盖 commit，完成后将精确 SHA 与对应报告写回该台账。
