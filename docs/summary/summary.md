# Git Rebase Visual — 功能、架构与测试总结

> 当前基线：v0.7.2 原生 TreeView 交互——canonical native DnD、原生 tooltip/context menu、宿主命令重验证、结构化 SCM 批量操作与安静的状态轮询。

## 1. 项目定位

Git Rebase Visual 是一个 VS Code 扩展：将原生 `git rebase -i` 封装成侧栏中的可视化提交时间线。用户可以拖拽排序、修改或删除 commit、锁定依赖提交、生成 AI commit message、管理 stash/push，并将暂存区内容追加到已有 commit。

```text
VS Code Native TreeView
  ├─ NativeCommitTreeProvider / TreeItem
  │    └─ 原生 tooltip、原生 context menu、选择与 native DnD
  └─ RebaseViewProvider（宿主命令路由与重验证）
       ├─ git/       Git 命令、rebase、stash、push
       ├─ lock/      patch-id 锁定
       ├─ llm/       OpenAI 兼容消息生成
       └─ ui state   refresh、互斥、canonical snapshot、Compose 会话

ComposePanel 是唯一保留的 editor-area WebviewPanel，仅用于编辑/生成 commit message；
Commit Inspector 不在当前激活架构或用户路径中，仅保留为历史源码。
```

## 2. 核心功能

| 功能 | 行为与保护 |
|---|---|
| 原生 TreeView / tooltip / context menu | commit、暂停 rebase、edit stop 和工作区操作均通过 VS Code 原生 TreeView/context menu 呈现；commit tooltip 按需加载 immutable detail，并以 `MarkdownString.appendText()` 呈现 Git 派生文本；普通点击只选择，不打开 editor。 |
| 拖拽重排 | scripted interactive rebase 的 oldest-first todo；native DnD 以 source/anchor/placement/revision/完整 canonical order 建立意图，可放到 newest/end 边界；宿主在确认前后重验证 revision、顺序和锁定状态。 |
| edit / reword / drop / Skip | 原生 rebase 中执行；暂停时提供 Continue / Abort；Skip 仅 conflict pause 可用且强确认 patch 丢弃。Compose reword 失败/暂停保留输入。 |
| squash / fixup / diff | 首项、locked current/前驱和 rebase 中时防御式禁用；受控只读 Git diff、复制完整 message。locked/batch 项仍保留安全的复制与只读 Diff 入口。 |
| commit 锁定 | 稳定 `patch-id`，重排/cherry-pick 后仍识别同一修改；push 前阻止 locked 范围；locked commit 不能被 Drop/squash/fixup/append 静默修改。连续 locked 项可以原生折叠为 `🔒 : N lock · no push` 摘要。 |
| Undo 与操作历史 | 每次成功 rewrite 创建私有 before ref/journal；Undo 验证仓库、分支、HEAD、rebase、工作区、checkpoint 与 pushed 风险，使用 `reset --keep`。 |
| rebase session | 解析步骤 N/M、completed/active/pending、edit/conflict/paused/unknown；待重放 hash 明确会变化，不伪造外部 rebase 进度。 |
| Compose Panel / AI | 编辑器区 subject/body Panel 仅用于 Compose：50/72、72 列参考、原 message/trailer 折叠、AI draft/取消/替换/追加/恢复、失败保留输入。Staged Changes 和 Changes 均有原生 AI 入口；暂停 rebase 时 working/staged AI 只能生成不提交的草稿。 |
| stash | autoStash 以 stash commit SHA 持久化定位，避免 `stash@{0}` 漂移；append Abort 避免完整 snapshot 与 keep-index stash 重复恢复。 |
| push | 普通分支 `--force-with-lease`；可选评审 refspec；可取消进度/Output；rebase edit 停靠时仍可推送，并明确 detached HEAD 的分支/upstream 语义。 |
| 自动状态同步 | 文件事件与节流 index 轮询刷新 staged/unstaged 文件数；后台 status 使用 `GIT_OPTIONAL_LOCKS=0`，避免 optional `index.lock` 与终端写操作竞争。 |
| 列表/上下文/可访问性 | 作者文字前缀和稳定语义色、pending 文本、branch/upstream/ahead-behind、原生多选、原生 context target、锁定批次限制、locked-run 折叠、状态栏和 High Contrast fallback。历史 Webview 的 `author:`/`msg:`/`hash:0x` 搜索、IME 输入和键盘 pickup/drop 不属于当前 TreeView 用户路径。 |
| 文件级 SCM 恢复与 Diff | porcelain v2 `-z` 结构化 staged/working/untracked 状态；单文件 working/staged restore、host modal 确认后再次读取并验证状态才删除未跟踪文件；公开 `vscode.diff` 的 index↔working、HEAD↔index 和 parent↔commit 对比；opaque request store 防止 URI 暴露仓库/ref/path。 |
| 连续 generated Diff | 单项或连续多选 commit 的 oldest-first frozen Diff snapshot；原生 context menu 不向非连续选择暴露批量 Generate Diff，host 仍重验完整 hash、revision 与连续性；扩展私有只读 provider 使用 opaque token、TTL/LRU/repository invalidation。 |
| 写入与交互协议 | stage/restore/bulk stage-discard-unstage 作为 mutation 经 busy 串行化，paused edit-stop 由明确 allow-list 控制；native DnD 使用 immutable canonical session，routine worktree refresh 不会使其 stale，而真正 timeline/lock/rebase 变化仍会拒绝旧手势；无副作用 UI 流量不触发暂停告警。 |
| 历史 Inspector | `commitInspectorPanel` 及相关测试仅为历史/非激活代码，不属于当前用户界面。当前 hover 和 context 操作均由原生 TreeView tooltip/context menu 承担，禁止用 Inspector 重新创建 editor-area 详情或上下文面板。 |

## 3. 「将暂存区文件添加到此 commit」事务

用户在 VS Code SCM（或终端）执行 `git add` 后，右键一个 commit 选择该命令。

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
  └─ pop 未暂存 stash、drop 初始 snapshot stash
```

### 关键边界

- 暂存区为空：菜单禁用，后端也会复查并拒绝。
- 目标已锁定：必须先解除锁定，避免 amend 改变 patch-id 后失去推送保护。
- 目标已推送：确认框明确提示公开历史将被改写并要求显式二次确认，后续需 `--force-with-lease`。
- 发生重放冲突：保持 Git 原生 rebase 状态，面板 Continue/Abort 负责恢复 pending append stash。
- 所有写操作由 provider 互斥；refresh 采用 generation token，避免旧请求覆盖当前 commit 快照。

## 4. 模块地图

```text
src/
├─ extension.ts                    激活、命令注册
├─ config.ts                       VS Code settings 读取
├─ git/
│  ├─ gitRunner.ts                 spawn Git + 超时/输出上限/取消
│  ├─ commitLog.ts                 log/range/status/rebase 元数据
│  ├─ worktreeChanges.ts           porcelain v2 -z 解析、单文件 stage/restore/删除保护
│  ├─ rebaseEngine.ts              todo、execute/continue/abort rebase
│  ├─ worktree.ts                  stash 按 SHA apply/pop/drop、提交
│  ├─ message.ts                   message trailer 拆分与保留
│  ├─ pushGuard.ts                 upstream/refspec/锁定范围检查
│  └─ seq-editor.js                Git 调用的 sequence editor
├─ lock/lockStore.ts               patch-id 持久化锁与批量 lockMany
├─ llm/client.ts                   OpenAI-compatible chat / streamChat、deadline、错误脱敏
├─ llm/messageGen.ts               diff 和提示词构造、流式生成入口
├─ ui/rebaseViewProvider.ts        Native TreeView 协调、宿主命令重验证、历史事务、SCM/Diff、session/progress、Undo、暂停/冲突、状态栏
├─ ui/nativeCommitTree.ts          TreeDataProvider、TreeItem、原生 tooltip/context、locked-run 摘要
├─ ui/nativeCommandIntent.ts       原生命令参数与 batch target/selection 校验
├─ ui/rebasePointerDragState.ts    native DnD/end boundary 的 canonical intent
├─ ui/rebaseReorderState.ts        source/anchor/placement/revision/order/lock 重验证
├─ ui/commitDetailCache.ts         选中项按需详情读取的 LRU/并发合并缓存
├─ ui/worktreeDiff.ts              工作区/commit 文件 Diff 与 opaque content provider
├─ ui/gitDiffRequestState.ts       Git Diff request 的 URI opaque-token/TTL/LRU store
├─ ui/generatedDiffState.ts        连续 commit selection、stale guard 与 frozen Diff 构建
├─ ui/generatedDiffDocument.ts     generated Diff opaque snapshot/TTL/LRU store
├─ ui/generatedDiffProvider.ts     generated Diff 只读虚拟文档 provider
├─ ui/webviewProtocolState.ts      webview read/UI/mutation 分类与 paused allow-list
├─ ui/mutationGate.ts              busy / paused mutation 入口判定
├─ ui/rebaseState.ts               pause/progress/pending/unknown rebase 状态派生
├─ ui/undo.ts                      私有 before ref、操作 journal、Undo preflight/reset --keep
├─ ui/composePanel.ts              编辑器区 Compose WebviewPanel 与 draft/session 状态（唯一激活 editor-area 面板）
├─ ui/composePolicy.ts             正常/暂停 rebase 的 staged/working AI draft-only 策略
├─ ui/commitInspectorPanel.ts      历史、非激活的 inspector 源码；不用于当前 UI
├─ ui/panelLifecycle.ts            历史 inspector 的 WebviewPanel lease 测试辅助
├─ ui/inspectorPreviewState.ts     历史 inspector preview/action 状态辅助
├─ ui/inspectorDismissPolicy.ts    历史 inspector close 判定辅助
├─ ui/canonicalSnapshot.ts          drag canonical revision key
├─ ui/refreshFeedbackPolicy.ts     manual/poll refresh feedback 策略
├─ ui/secretsAccess.ts             SecretStorage 访问器注入桩（安全降级）

media/main.js                      遗留 sidebar DOM 的非 hover/context 辅助逻辑；当前提交行的 tooltip/context 均由原生 TreeView
media/style.css                    遗留 sidebar DOM 的主题语义、pending/status/高对比度 fallback
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
| 边界 | `test/gitRunner.integration.test.ts` | 非零 Git 结果、输出上限、取消信号 |
| Git 集成 | `test/commitLog.integration.test.ts` | staged/unstaged 文件数、commit 顺序、absolute git-path、edit stop/rebase-apply 分支 |
| Git 集成 | `test/worktree.integration.test.ts` | stash apply/pop/drop、keep-index、外部删除 stash |
| 功能集成 | `test/appendStaged.integration.test.ts` | staged append、amend、后续重放、未暂存恢复、stash 清理 |
| Git 安全 | `test/rebaseSafety.integration.test.ts` | locked Drop conflict/Abort、冲突 Continue、edit-stop Abort 恢复 |
| 暂停状态 | `test/rebasePauseState.test.ts` | conflict / explicit edit / paused 状态派生 |
| LLM HTTP mock | `test/llmClient.test.ts` | SSE delta、畸形事件、deadline、预取消、流读取途中取消/超时、错误正文脱敏，以及 Fetch Standard 全量 bad-port policy、真实 listener close/retry 生命周期 |
| Git 集成（推送/守卫） | `test/pushGuard.integration.test.ts` | bare-remote：force-with-lease 并发拒绝、lockedInPush 拦截/解锁 |
| Git 集成（append 守卫） | `test/appendGuard.integration.test.ts` | 已推 upstream 守卫、锁定 commit patch-id 跨重写稳定 |
| 注入桩 | `test/secretsAccess.test.ts` | SecretStorage 访问器安全降级与委托 |
当前测试套件在 v0.7.2 候选中为 146 项，覆盖原生 TreeItem/context、Git metadata tooltip 转义、working AI policy、batch target membership、native DnD end boundary、canonical revision/lock 拒绝及 manifest 可达性。历史 v0.7.1 Inspector 测试保留用于非激活代码的回归监控，不表示该面板是当前用户路径。

命令：

```bash
npm run typecheck       # TypeScript 严格检查
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
5. 验证 VSIX 含必要 runtime 文件，不含 `src/`、`test/`、`docs/`、`node_modules/`；
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

历史 UI 评审文档描述的是当时版本的交互；当前版本以本文件的原生 TreeView 架构为准。外部版本化评审原文位于 `../review/code-review-<major>-<minor>-<patch>.md`；项目回复按相同版本号放在 `review-response-<major>-<minor>-<patch>.md`。开始评审前需读取 [`../review/code-review-commit.md`](../review/code-review-commit.md) 确认未覆盖 commit，完成后将精确 SHA 与对应报告写回该台账。
