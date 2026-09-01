# Git Rebase Visual — 二次代码评审（code-review）

> 评审基线：`main` 最新提交 `c4d0ce1`（v0.3.0；功能基线与 `cbd4596` 相同，`c4d0ce1` 仅发布版本号/文档）
> 方法：独立通读全部源码 + 逐项核验 `review-report.md` 声称已修复的项（代码证据 + 测试证据）+ 针对新增实现做边界推演。
> 验证：`npm run typecheck` 通过；`npm test` **26 项全部通过**（逻辑 8 + Git 集成 9 + LLM HTTP mock 4 + 其它）。
>
> 本文档独立于你的 `review-report.md`（那是你对我的回复）。两者不修改同一文件。**这里只报告我在最新代码上独立复核后仍有把握的发现**，每项带 checkbox 供跟踪。

---

## 1. 总体结论

v0.3.0 是一次高质量的可靠性收口：

- R-1..R-20 中，绝大多数我都能在代码里**找到符合描述的修复**，并且大部分有测试背书（不是嘴上修了）；
- 互斥 + generation token、绝对 git-path、50 MiB 超时上限、LLM 分类报错、流式、可取消 push、append 锁定/已推送保护、Release 门禁——实现都确实落地了；
- 但独立复核后我确认 **2 个新问题** 仍存在（其中 1 个是 R-4 修复的盲区，属中危、可复现），另有若干 **测试覆盖缺口** 和建议项。

| 级别 | 数量 | 本次新增 |
|------|------|---------|
| 🟠 中 | 2 | CR-1（apply/openCompose hash 校验盲区）、CR-2（面板关闭后后台轮询不停） |
| 🟡 低 | 3 | CR-3（gitRunner maxBuffer O(n²)）、CR-4（pushGuard/append 集成测试缺口）、CR-5（小项） |
| 🔵 建议 | 2 | CR-6、CR-7 |

---

## 2. 对「review-report 已修复项」的独立核验（抽查通过项）

> 说明：这里只列**我实际复查过代码并认同**的项，作为对已声称修复的背书，不重复展开叙述。

- [x] **R-1（输出上限/超时/取消）** — `gitRunner.ts` 实现：`maxBuffer` 默认 50 MiB、`timeout` 默认 120s、`signal` 支持；超时/超限 kill 后 `code=-1` + stderr 注入原因。`gitRunner.integration.test.ts` 覆盖。✅ 且比 R-1 原描述做得更好（超限/超时统一返回失败结果而非抛错）。
- [x] **R-2（绝对 git-path）** — `commitLog.ts` 三处均改 `--path-format=absolute --git-path`；`rebaseStoppedSha` 还补 `rev-parse` 展开全 hash。`commitLog.integration.test.ts` 有 edit 停靠真实验证。✅
- [x] **R-3（reorder 完整校验）** — `handleReorder` 校验长度/去重/40 位 SHA/集合一致。✅
- [x] **R-4（hash 校验）** — `handleMessage` 用 `isCurrentCommitHash` 校验 **copyHash/requestDetail/drop/rebaseTo/lock/unlock/appendStaged**。⚠️ **但盲区是 `openCompose` 与 `apply` 的 commit 模式 hash** —— 见 CR-1，本次最重要新发现。
- [x] **R-5（LLM deadline/脱敏/流式）** — `client.ts` 重写为 `startRequest` + `PendingRequest`：内部 `AbortController` + `timeout`；`llmErrorMessage` 只分类 401/403/429/5xx，不回显正文；`streamChat` 已接入 `messageGen`，`rebaseViewProvider.generate` 通过 `genDelta` 流式回填。`llmClient.test.ts` 覆盖 SSE/deadline/取消/脱敏。✅
- [x] **R-6（trailer 保留）** — `message.ts` 增加 `GENERIC_TRAILER_RE` 相邻标准行识别，`applyTrailers` 区分「用户显式改写了尾部 trailer 块」vs「需保留原块」。`message.test.ts` 6 例。✅ 设计合理。
- [x] **R-7（push 可取消 + OutputChannel）** — `pushBranchInternal` 用 cancellable `withProgress` + `controller.signal` → `pushRefspec` → `runGit`;`output` channel 记录开始/成功/失败。✅
- [x] **R-8（refresh 竞态 + busy）** — `refreshGeneration` + `isCurrent()` 丢弃过期 state；`onMessage` 对 mutating 全体包 `busy`；`scheduleRefresh` 在 busy 时合并为完成后一次。✅ 实现正确。
- [x] **R-9（append 锁检查）** — `appendStagedToCommit` 先 `computePatchId` + `isLocked` 检查，锁定则拒绝。✅
- [x] **R-10（append 已推送检测）** — 用 `@{upstream}` + `merge-base --is-ancestor` 检测，已推送则在确认框提示 force-with-lease。✅
- [x] **R-13（暂存态自动刷新）** — 文件事件 + 1.5s 节流 index 轮询 + 400ms debounce + busy 合并。✅（但引发 CR-2 的后台轮询问题，见下）
- [x] **R-16（测试体系）** — 26 项测试落地，`test/index.test.ts` 聚合。✅（但 CR-4 指出仍有覆盖缺口）
- [x] **CI-C（RELEASE.md 门禁）** — `release.yml` 顺序：版本校验 → `test:release` → 打包 → VSIX 内容校验（必须含 dist 两份 JS + media/main.js + package.json，且不含 src/test/docs/node_modules）→ `grep RELEASE.md` 版本记录 → `gh release create`。✅ 质量很高。
- [x] **UX-1/2/3（drop 确认、OutputChannel、edit 引导、冲突开文件）** — `drop` 有 modal 确认；`runRebase` 里 `conflictedFiles` 后自动 `openTextDocument` 冲突文件；banner 显示停靠目标。✅

---

## 3. 新增发现（重点）

### CR-1.【🟠 中｜P1】`openCompose` / `apply` 的 commit 模式 hash 未被当前快照校验 —— R-4 修复的盲区

**位置**：`src/ui/rebaseViewProvider.ts:316-330`（hashActions 集合）、`:398-409`（openCompose/apply 分支）

**现状**：`hashActions` 只包含 `copyHash / requestDetail / drop / rebaseTo / lock / unlock / appendStaged`，**没有 `openCompose` 和 `apply`**。而这两个消息在 `mode === "commit"` 时携带 hash，且 `apply` 会真正写历史（reword/edit + `--amend`）。

**可复现路径**：
1. 用户打开某 commit 的「更改 message」弹窗（`openCompose`，携带 hash H）；
2. 在弹窗打开期间，列表状态已更新（1.5s 轮询 / 外部 rebase / 另一窗口操作），H 已不在 `this.commits`；
3. 用户点击「应用」（`apply`，携带同一个过期 hash H）：
   - `itemsWith(h => h === H ? "reword" : undefined)` 在 `this.commits` 里**找不到 H** → 全部项都是 `pick`；
   - `runRebase` 执行一次**全 pick 的“无操作”rebase**：重写整个范围内所有 commit 的 hash（内容不变），却**没有应用用户要的 message 修改**。

**后果**：用户以为 message 已改，实际本地历史被无意义重写、目标 commit 的锁定/引用随之失效，且用户毫无感知。这正是 R-3/R-4 想要防止的「静默历史改写」，恰恰经由 `apply` 这条没被校验的路径漏了过去。

**建议**：把 `openCompose`（仅 `mode==="commit"` 且有 hash 时）与 `apply`（`mode==="commit"` 且有 hash 时）加入校验；或至少保证：`apply` 前 hash 不在当前快照时**直接拒绝并提示刷新**，而不是退化为全 pick rebase。附带的好处是 `applyTrailers` / `fullMessage(H)` 也不会对已不存在的 commit 工作。

- [ ] 已修复

---

### CR-2.【🟠 中｜P1】面板关闭后，1.5s index 轮询仍持续在后台跑 git 命令

**位置**：`src/ui/rebaseViewProvider.ts:113-119`（resolveWebviewView 里启动 poller）、`:136-148`（scheduleRefresh）、构造器 `:102-111`

**现状**：
- `statusPoller = setInterval(scheduleRefresh, 1500)` 在 `resolveWebviewView`（视图首次显示）时启动，**只在 `ctx.subscriptions` 的 `Disposable`（extension deactivate）时清理**；
- webview 视图被用户收起/关闭时，`this.view` 不会置空（没有 `view.webview.onDidDispose` 清理），provider 实例继续存活；
- 结果：**面板关闭后，后台仍每 ~1.5s 调一次 `scheduleRefresh` →（400ms 后）执行完整 `refresh`**，即每次约 5~8 条 git 命令（`repoRoot`、`isRebaseInProgress`、`getCommits`、`rebaseStoppedSha`、lock patch-id × N、`workingStatus`）。在有锁的大仓库里开销更明显。

**后果**：长期后台空转 git 进程，CPU / IO / 电池消耗且无线程风寒（降级为“支持自动刷新”的代价）。

**建议**：注册 `view.webview.onDidDispose(() => { this.view = undefined; this.statusPoller && clearInterval(this.statusPoller); this.statusPollerStarted = false; })`；`scheduleRefresh` 里已检查 `if (this.view)` 才 refresh，补上 dispose 清理即可真正停掉。视图再次打开时 `resolveWebviewView` 会重新起 poller。

- [ ] 已修复

---

### CR-3.【🟡 低｜P2】gitRunner 的 maxBuffer 计数为 O(n²)

**位置**：`src/git/gitRunner.ts:62-76`

**现状**：`append()` 里每次 `data` 都调用 `Buffer.byteLength(stdout) + Buffer.byteLength(stderr)`——对已经聚合的字符串**重复全量求字节长**。输出增长到时，总计算量为 O(n²)。

**影响**：50 MiB 上限下，若以 64 KiB 块涌入，约 800 次 × 平均 25 MiB ≈ 20 GB 字节扫描——偶发的大 diff 场景（如 `git show` 大提交、AI 生成的 `getCommitDiff`）会有一瞬间的 CPU 峰值。不是崩溃级，但可轻易改进。

**建议**：用一个计数器（`let stdoutBytes=0; stdoutBytes += data.length`）替代重复 `Buffer.byteLength(stdout)`；或者干脆限制**单条 data 块** + 一个近似总量计数。改动一行级。

- [ ] 已修复

---

### CR-4.【🟡 低｜P2】测试覆盖缺口：pushGuard / append 的全部前置守卫 / streamChat 取消-超时组合未被测试

**位置**：`test/` 全套

**现状**（非缺陷，仅覆盖不足）：
- `pushGuard.test.ts` 只测了 `resolveRefspec`，**没有测 `pushRange` / `lockedInPush`（锁定拦截） / `pushRefspec` 的 force-with-lease 分支**；
- `appendStaged.integration.test.ts` 只覆盖**成功路径**，没有覆盖：① 目标已被锁定时拒绝对话；② 已推送检测提示；③ 恢复到 edit 前冲突后的恢复（`restoreAppendSnapshot` / 用户外部 abort 后 `refresh` 自愈）；
- `llmClient.test.ts` 的取消用例是「先 aborted 再调用」的静态路径，**没有覆盖「流式读取中途被取消/超时」**（`reader.cancel` 分支），也没有覆盖 `streamChat` + deadline 的组合。

**建议**：这些块是这次可靠性收口最核心的新逻辑，建议按上面三点补集成/HTTP mock 用例。

- [ ] 已修复

---

### CR-5.【🟡 低｜P2】`openCompose` 的 `staged` / `working` 模式没有 hash，但消息进入 `mutating`（busy）与 rebase 暂停检查的语义可更细

**位置**：`src/ui/rebaseViewProvider.ts:282-294`（外层 mutating 集合含 `openCompose/generate`）

**观察**：`lock/unlock/openCompose/generate/continueRebase/abortRebase` 都进了外层 `busy` 互斥（合理），但 `openCompose`（纯 UI，无副作用）与 `generate`（长时间任务）一起被 `busy` 挡——用户若在 AI 生成期间想再开一个 compose 弹窗会被 toast 拒绝。属于**可接受的取舍**（避免并发状态混乱），但值得知道：`openCompose` 并非必须进互斥（它不是写操作），若希望更顺滑可把它移出 `busy` 集合（`apply` 仍在）。非必须，记录备选。

- [ ] 已处理（可选项）

---

## 4. 对「review-report 保留项 / 不修改项」的复核意见

| review-report 结论 | 我的复核意见 | 是否认同 |
|---|---|---|
| R-11 保留 P2（两个 stash 提示粒度） | 认同。数据不丢优先，提示细化属 UX 增强 | ✅ |
| R-12 不修改（edit 前冲突保留原生暂停） | 认同。自动 abort 会丢用户冲突解决，保留原生暂停更安全 | ✅ |
| R-14 不修改（force-with-lease 只限分支） | 认同。普通 refspec 恰是 `HEAD:refs/heads/<branch>`，语义正确 | ✅ |
| R-15 保留 P2（shortstat 解析） | 认同。仅 hover 展示 | ✅ |
| R-17 不修改（不用 --no-verify） | 认同。保留钩子保护 Gerrit Change-Id 更安全 | ✅ |
| R-18 不修改（CSP unsafe-inline） | 部分认同。`textContent` 渲染确实无 XSS 路径；但 `style-src 'unsafe-inline'` 仍可收紧（改动态样式为 CSS 变量后） | ✅ 认可保留 |
| R-19 保留 P2（大文件拆类） | 认同。有覆盖后再拆更安全 | ✅ |
| R-20 保留 P2（配置重复/动态导入） | 认同。manifest vs config.ts 是 VS Code 生态常见分工 | ✅ |
| CI-D 保留 P2（签名/多平台） | 认同。JS VSIX 无需平台编译 | ✅ |

**结论**：你保留/不修改的决策我都认同，没有发现应反悔的项。

---

## 5. 安全与并发现状（复验）

| 项目 | 结论 |
|---|---|
| 命令注入 | 无。`spawn("git", args)` 不经 shell；`${tip}/${branch}` 在 args 内替换 |
| Webview XSS | 低。用户数据一律 `textContent`；CSP `script-src 'nonce'` 无 connect-src |
| API key | 仍存 settings.json，SecretStorage 迁移 = P2（未动） |
| 大 diff / DoS | git 命令 50 MiB + 120s + 取消；LLM 120s deadline + 取消 |
| 并发写 | busy 互斥（reorder/drop/rebaseTo/lock/unlock/openCompose/generate/apply/appendStaged/continue/abort/push）；refresh generation token 防过期 state |
| 后台轮询 | ⚠ CR-2：view 关闭后 poller 仍跑 |
| Release 门禁 | tag 版本一致 → typecheck+coverage 测试 → VSIX 内容白名单/黑名单 → RELEASE.md 记录 → 发布 |

---

## 6. 结语与建议处理顺序

1. **CR-1 优先**（P1）：把 `openCompose`（commit 模式）与 `apply`（commit 模式）的 hash 纳入 `isCurrentCommitHash` 校验——否则 R-4 的防护有一条真实绕行路径。
2. **CR-2 优先**（P1/P2）：`onDidDispose` 清理 poller 与 view 引用，避免后台空转。
3. **CR-3**（P2）：O(n²) 计数改一行计数器。
4. **CR-4**（P2)：补 pushGuard / append 前置守卫 / streamChat 中途取消的测试。
5. CR-5 为可选项，随重构处理。

总体：本次迭代把上一轮绝大多数高危/中危项落地并且用测试证明，质量显著提升；剩余问题集中在校验盲区与后台资源占用，都是小而聚焦的修补。
