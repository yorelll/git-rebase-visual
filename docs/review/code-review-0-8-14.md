# Code Review 0-8-14 — 0.8.3 整改复核（push 成功/失败二义性、目标分支推导、draft 入口矩阵）

- 基线：`main` @ `577ce8766a46707a60c471cf8090e9f63cd8d49c`（`test: run each file in its own process and split the slowest suite`）+ 未提交工作树（14 项：9 个已跟踪文件修改、5 个新增）。`577ce87` 不在 `docs/review/code-review-commit.md` 任何一条记录的完整 SHA 中，因此本次属于**未覆盖 commit**，按台账规则纳入本次评审范围。台账条目需由维护者在提交时补登（我只读，按本轮规则不得修改产品代码/测试/文档，只允许写本报告）。
- 评审性质：**第 2 轮**，对 `code-review-0-8-13.md` 中 1×P0 / 2×P1 / 4×P3 的整改做独立复核。被评审对象是**未提交工作树**（基线 `577ce87` + `git diff` + 4 个 untracked 文件），无新 commit SHA 可记录；本轮结束后该工作树提交时，仍需后续独立评审按真实 SHA 覆盖。
- 方法：Node `v24.x`、仓库内 `tsx`、Git `2.45.0.windows.1`、仓库内 JSDOM。真实 provider（真实 `vscode` stub + 真实 Git 仓库 + 真实 bare remote）驱动；破坏性探针全部在 OS 临时目录（`grv-probe-b`、`grv-b*`）内，结束前已删除。
- 工作树：`git status --short` 开始时 **14** 项，结束时 **15** 项——多出的 1 项是本报告 `docs/review/code-review-0-8-14.md`（本次唯一允许写的文件，也是本轮唯一写入）。`HEAD` 未变（`577ce87`），`git stash list` 为空；未做任何 commit / tag / checkout / stash / reset。
- 进程表：开始时仅 3 个 `node.exe`（codegraph prompt hook、codegraph serve、drawio-mcp），均非产品/测试残留；结束后同。未发现可归因于实现者的孤儿 hook shell，本轮也没有留下自己的进程。
- **完整套件（290 项）未由我运行**，这是规则要求（约 13 分钟）；290/290 全绿**未独立确认**。我独立运行的是三个受影响的测试文件：`test/pushNotification.test.ts`（11/11）、`test/webviewDom.test.ts` + `test/restoreFileProtocol.test.ts`（12/12）；并做了两次独立类型检查。

---

## 一、结论摘要

| # | 上轮发现 | 本轮结论 |
|---|---|---|
| P0-1 | 推送失败同时弹出"已推送"成功提示、丢失 refresh | **已修复，证据充分**。失败路径零 `已推送`（inline sink 与通知列表双双为零）、恰 1 次 refresh、错误通知含三要素 + Git 原始错误；成功路径 `已推送` 恰 1 次、零失败通知；取消抛 `推送已取消。` 且无成功/失败提示；普通异常不被 `PushAlreadyReported` 吞掉；把源码临时改回 `return` 形状后测试立即变红（见 2.1） |
| P1-1 | 目标分支恒为 upstream，自定义/评审 refspec 会撒谎 | **主要形状已修复**。普通 / `refs/for/*` / `refs/drafts/*` / `HEAD:refs/heads/hotfix` / `+HEAD:refs/heads/x` / 源=目的 / 无冒号的分支名模板，打印目标与远端**真正移动的 ref** 逐一一致；回退文案只在 `HEAD`、`HEAD:`、`""`、`HEAD:refs/`、`HEAD:refs/heads/` 触发。**但残留两处**：带斜杠的远端名（P1-2 下文新编号 N-1）与非 HEAD 源的 refspec（N-2） |
| P1-2 | draft 入口被从所有非停靠状态删除 | **已修复且矩阵可复现**。六个声称状态全部复现；当前工作树与 `HEAD` 的差异**只有一格**（空闲 + 全部已暂存：Changes 从 1 → 0）。该格**确实是能力损失**（`✦` 的 compose 面不显示"复制 message"，apply 会提交），但已作为用户明确要求的取舍在 `README.md` / `docs/release-notes/0.8.3.md` 中如实写明，不再是"已完全覆盖"的错误理由 |
| P3-1 | README 说`仅生成 message`只出现在横幅 | **已修复**。该句已不存在；`README.md:114` 现为"唯一省略的情况：空闲、且改动全部已暂存" |
| P3-2 | README 仍列出已删除的入口 | **已修复**。`README.md:55` 与第 9 节条目一致，不再把已删入口当既有功能描述 |
| P3-3 | 锁定运行测试缺少 ` · replay` | **已修复**。`runSummary` 输出 `🔒 : 3 lock · no push · la ×1 · sa ×1 · yu ×1 · replay`；测试钉整行精确匹配 `/^🔒 : 3 lock · no push · la ×1 · sa ×1 · yu ×1$/`，`aria-label` 独立断言 |
| P3-4 | 失败路径不 refresh | **已修复**。失败后立即 refresh 计数 1，600 ms 后仍为 1（无双重刷新，无反馈 toast） |
| 回归 | — | 确认弹窗语义与 refspec 仍在；`PushAlreadyReported` 从不进日志、不作为 Git 错误显示（仅 `push: 失败 <git message>`）；`side` 词表对既有 `working`/`staged` 调用者不变 |
| 版本/文档 | — | `package.json` / `package-lock.json` 两处 / release notes 标题 / `RELEASE.md` 均为 0.8.3；无 `{{…}}` 占位。**一处不符**：`docs/summary/summary.md:150` 仍写 **283 项**，静态枚举实为 **290**（N-4） |
| VSIX | — | **通过**。12 条目与白名单逐项一致、`--verify-only` 通过、manifest 与包内 `package.json` 均为 0.8.3；包内 7 个文件与工作树逐字节相同；重新 `node esbuild.js` 复现 sha256 `ea14df5e…f28cca3731656`；mtime 显示产物在最后一次源码编辑（17:57）之后构建（bundle 18:17:53，VSIX 18:18:10） |

**发布裁决：批准 0.8.3 发布，且批准覆盖 `dist-vsix/git-rebase-visual-0.8.3.vsix`。** 上轮的 1×P0 与 2×P1 均已修复并有对抗性证据；本轮新发现 4 处，最高 P2，均不阻塞：带斜杠远端名把提示写成错误目标（罕见配置，且该配置下推送本身通常会失败），非 HEAD 源 refspec 的 commit 标题取自 `HEAD`（用户手写 refspec），`:refs/heads/<不存在>` 的空操作仍报"已推送"（与 Git 自身 `exit 0` 一致），以及 `docs/summary/summary.md:150` 的 283 与 290 不符（纯文档）。四者都不影响本轮所修三条主路径的正确性。

---

## 二、P0-1 复核 — 失败不再报成功、不再丢 refresh

### 2.1 真实 provider + 真实不可达远端（探针 `p0.ts`）

```
== FAILED PUSH ==
caller threw: (resolved)
refresh count: 1
inline toasts: []
notifications: [
 { "level": "warn",  "text": "推送到 origin/master？（HEAD:refs/heads/master）" },
 { "level": "error", "text": "推送失败：普通推送：\"fix: reject an unreadable stash list\" → origin/master。git push --force-with-lease=master origin HEAD:refs/heads/master failed (128): fatal: … does not appear to be a git repository …" }
]
titles: ["推送中：普通推送：\"…\" → origin/master"]
inline has 已推送: false
notif  has 已推送: false
```

- `已推送` 在 **inline sink 与 `showInformationMessage`/`showErrorMessage` 两个 sink 都不存在**（上轮的假成功正是出现在 inline sink）。
- 失败后 **恰 1 次** refresh；600 ms 后再测仍为 1（`p8.ts`），没有"失败刷新 + finally 队列刷新"的双重刷新。
- 失败路径没有额外的 inline 反馈提示（`p8.ts`：`inline toasts (any feedback?): []`），只留那条红色通知。
- 错误通知同时含**推送方式 / commit 标题 / 目标分支**三要素与 Git 原始错误，满足上轮"失败提示也应可读"的要求。

### 2.2 成功路径

```
== SUCCESS PUSH ==
inline toasts: [{"level":"info","text":"已推送：普通推送：\"second subject\" → origin/master"}]
notifications: [{"level":"warn","text":"推送到 origin/master？（HEAD:refs/heads/master）"}]
已推送 count(inline): 1
failure notifications: 0
```

`已推送` 恰 1 次、无失败通知。

### 2.3 取消路径

```
== CANCELLED PUSH ==
caller threw: Error: 推送已取消。
inline toasts: []
notifications: [{"level":"warn","text":"推送到 origin/master？…"}]
已推送 present: false
推送失败 present: false
remote master unchanged: true
```

取消是显式用户动作，因此走 throw 而不是"失败"提示，**既没有成功也没有失败文案**，远端 ref 未前进。

### 2.4 普通异常不被 `PushAlreadyReported` 吞掉

`p8.ts`：把 `pushBranchInternal` 换成抛普通错误的版本后，`pushBranchInternal called: 1`、`ordinary error propagated to caller: Error: probe:ordinary-error`、`lock released: true`。`pushBranch` 的 `instanceof PushAlreadyReported` 门只吞控制流异常，真实的 Git / 编程错误照旧上抛，锁在 `finally` 中释放。

### 2.5 红-对照-旧（探针 `p6.ts`）

在临时副本中把 catch 分支改回上轮的 `return` 形状（`\r?\n` 适配 CRLF，patch 未命中时探针拒绝报告），类型检查干净，运行失败推送用例：

```
AssertionError: a failed push never also reports success
actual: [ { level: 'info', text: '已推送：普通推送："fix: reject an unreadable stash list" → origin/master' } ]
expected: []
```

即新用例**不是空转**：只要失败路径再次落到成功提示，它就会变红。

### 2.6 控制流异常不会以 Git 错误身份出现（`p10.ts`）

```
(a) log mentions PushAlreadyReported: false
(a) log message lines: ["… push: 开始 origin HEAD:refs/heads/master",
                        "… push: 失败 git push --force-with-lease=master origin HEAD:refs/he…"]
```

日志里只有 `开始` 与 `失败 <git message>` 两类，`PushAlreadyReported` 及其 `name` 不出现；用户侧也没有第二次错误通知（2.1 的通知列表只有一条 error）。

**P0-1 判定：已修复。**

---

## 三、P1-1 复核 — 打印的目标分支 vs 真正移动的 ref

探针 `p1.ts` 为每种形状建独立真实 bare remote，推送后读远端 `for-each-ref` 判定"到底哪个 ref 动了"。全部结果：

| 形状 | 提示中的目标 | 远端实际移动的 ref | 一致 |
|---|---|---|---|
| 普通 `HEAD:refs/heads/master` | `origin/master` | `refs/heads/master` | ✅ |
| 评审 `HEAD:refs/for/${branch}` | `origin:refs/for/master` | `refs/for/master` | ✅ |
| 自定义 `HEAD:refs/heads/hotfix` | `origin/hotfix` | `refs/heads/hotfix` | ✅ |
| 自定义 `HEAD`（无冒号） | `（无法确定目标分支）` | `refs/heads/master`（Git 的源名规则） | ✅ 回退恰当 |
| 自定义 `HEAD:` | `（无法确定目标分支）`（且推送真失败 `invalid refspec`） | — | ✅ |
| 自定义 `:` / 删除 `:refs/heads/hotfix` | `origin/hotfix` | `refs/heads/hotfix` 被删除 | ✅ |
| 强制 `+HEAD:refs/heads/forced` | `origin/forced` | `refs/heads/forced` | ✅ |
| 源=目的 `refs/heads/master:refs/heads/master` | `origin/master` | `refs/heads/master` | ✅ |
| 无冒号的分支名模板 `refs/heads/${branch}` | `origin/master` | `refs/heads/master` | ✅ |
| 评审 `HEAD:refs/drafts/${branch}` | `origin:refs/drafts/master` | `refs/drafts/master` | ✅ |

纯函数形状（`pushDestination`）：

```
"HEAD:refs/heads/master" => origin/master        "HEAD:refs/for/master" => origin:refs/for/master
"+HEAD:refs/heads/x"     => origin/x             "  HEAD:refs/heads/master  " => origin/master
"HEAD" => （无法确定目标分支）                     "HEAD:" => （无法确定目标分支）
""     => （无法确定目标分支）                     "HEAD:refs/" => （无法确定目标分支）
"master" => （无法确定目标分支）                   ":refs/heads/gone" => origin/gone
"HEAD:refs/heads/" => （无法确定目标分支）         "HEAD:refs/tags/v1" => origin:refs/tags/v1
```

确认弹窗文案（`推送到 …？（refspec）`）也随之使用同一推导结果，不再拿 `up.ref` 冒充目标。

**P1-1 判定：主要形状已修复**；两处残留见第五节 N-1、N-2。

---

## 四、P1-2 复核 — 状态矩阵与"能力等价"问题

### 4.1 独立 JSDOM 矩阵（探针 `p2.ts`，当前工作树 vs `HEAD`）

```
[当前] idle, everything staged          banner=0 changes=0  click> (none) | ✦: openCompose mode=staged messageOnly=undefined
[HEAD] idle, everything staged          banner=0 changes=1  click> openCompose mode=staged messageOnly=true | ✦: openCompose mode=staged …
[当前] idle, nothing staged             banner=0 changes=1  click> mode=working messageOnly=true
[当前] idle, mixed                      banner=0 changes=1  click> mode=staged  messageOnly=true | ✦: mode=staged messageOnly=undefined
[当前] rebase paused (staged)           banner=0 changes=1  click> mode=staged  messageOnly=true
[当前] rebase paused (working only)     banner=0 changes=1  click> mode=working messageOnly=true
[当前] conflict pause                   banner=0 changes=1  click> mode=working messageOnly=true
[当前] conflict pause (with staged too) banner=0 changes=1  click> mode=staged  messageOnly=true
[当前] edit stop                        banner=1 changes=1  click> mode=staged  messageOnly=true | ✦: mode=staged messageOnly=undefined
[当前] edit stop, working only          banner=1 changes=1  click> mode=working messageOnly=true
[当前] no changes at all                banner=0 changes=0  click> (none) | ✦: (not rendered)
```

- 实现者声称的六个状态全部复现（空闲三态、普通暂停、冲突暂停、edit 停靠；edit 停靠时横幅与「更多提交选项」各一处）。
- 当前与 `HEAD` 的差异**只有一格**：`idle, everything staged` 的 Changes 入口 1 → 0。上轮"从所有非停靠状态一并删除"的问题不再存在。
- 额外的"完全没有改动"状态两个版本都是 0/0，没有丢失任何东西。

### 4.2 省略的那一格是否"能力等价"？

`p2.ts` 直接驱动 compose 面板的两条路径：

```
messageOnly=false (Staged Changes ✦): { copyVisible:false, applyLabel:"应用 Ctrl/Cmd+Enter",
                                        applyPosts:"apply mode=staged", draftOnlyWarningVisible:false }
messageOnly=true  (draft-only 入口):  { copyVisible:true,  applyLabel:"复制 message",
                                        applyPosts:"copyText", draftOnlyWarningVisible:true }
```

`src/ui/composePanel.ts` 的内联脚本只在 `messageOnly` 时才显示 `#copy`，并把 `#apply` 的文案改成"复制 message"、点击改为 `post('copyText', …)`。因此 **`✦` 打开的面没有"不提交就复制"的路径**，它的 apply 会 `mode=staged` 提交。

结论：这一格**确实是能力损失**，不是"已被 `✦` 完全覆盖"。但：

- 它正是用户明确要求的取舍；
- 现在的 `README.md:114` 与 `docs/release-notes/0.8.3.md:30` 都**如实写明**了这点（"即便在这里它也仍是唯一不写 Git 的路径，省略它是遵循用户的要求，而不是因为它已被完全覆盖"），上轮"理由不成立"的问题已经消除；
- 用"全部已暂存"这一具体条件精确圈定，而不是整个 idle 状态。

因此本轮**不再作为阻塞项**：这是一个被明确记录的产品取舍，不是隐性回归。

### 4.3 暂停期草稿路径真的可用（`p10.ts`）

```
(b) merge exit (non-zero = real conflict): 1
(b) unmerged paths: c.txt
(b) active session: working messageOnly=true
(b) clipboard after copyText mid-conflict: "draft message"
```

在**真实冲突暂停**的仓库上，`openCompose(mode=working, messageOnly=true)` 能开成会话，`copyText` 真的写进剪贴板（`vscode.env.clipboard.writeText` 被调用并收到 `"draft message"`）。上轮"暂停期丢失唯一草稿路径"的核心风险已消除。

**P1-2 判定：已修复（唯一遗漏是已记录的用户取舍，且其能力损失已如实写明）。**

---

## 五、本轮新发现（按严重度排序）

### N-1（P2）带斜杠的远端名：提示写出的是错误的目标，且推送可能落到另一个远端

`src/git/pushGuard.ts:27` 用 `ref.indexOf("/")` 在**第一个**斜杠处切分 `@{upstream}` 的缩写结果。远端名为 `team/origin` 时：

```
upstream ref: team/origin/master | remote: team | branch: origin/master
refspec: HEAD:refs/heads/origin/master
```

而 `pushDestination("team", "HEAD:refs/heads/origin/master")` 依旧打印 `team/origin/master`——因为拼接后恰好与被切坏的 upstream 长得一样。直接调用 `pushRefspec` 的实测：

- 普通推送：`git push --force-with-lease=origin/master team HEAD:refs/heads/origin/master` → 失败（`failed (1)`），远端 `team` 无 ref，用户看到的是**一条令人费解的失败**，提示里的 `team/origin/master` 也没说明它其实推的是 `team`。
- 评审推送（无 `--force-with-lease`）：**推送成功**，但落在 `team` 而不是 `team/origin`：

```
printed destination: team:refs/for/origin/master
pushRefspec: (none)
remote 'team'        refs: [ 'refs/for/origin/master 425820bf…' ]
remote 'team/origin' refs: [ 'refs/heads/master 8a6930cd…' ]
```

即用户以为推到了 `team/origin`，实际推到了 `team`。要构造这个形状必须在 `.git/config` 里直接写 `remote.team/origin.url`（`git remote add` 会以 `remote name 'team/origin' is a subset of existing remote 'team'` 拒绝），所以是罕见配置；但一旦存在，通知给出的目标是错的——正是 P1-1 要消灭的那类谎言。**建议**：`getUpstream` 改为从 `git remote` 列表里做最长前缀匹配（`git for-each-ref --format='%(upstream:remotename) %(upstream:remoteref)'` 可一次给出不受斜杠影响的拆分），或者当远端名与 `remote.*` 的实际键不完全一致时回退到 `（无法确定目标分支）`。

### N-2（P3）非 HEAD 源的自定义 refspec：commit 标题取自 `HEAD`，与真正推送的 commit 不符

`src/ui/rebaseViewProvider.ts` 的 `subject` 恒为 `git log -1 --pretty=%s HEAD`，而 refspec 的源端可以是任意 rev。实测 `HEAD~1:refs/heads/older`：

```
title:  推送中：自定义推送："SECOND commit subject (HEAD)" → origin/older
toast:  已推送：自定义推送："SECOND commit subject (HEAD)" → origin/older
HEAD  = SECOND commit subject (HEAD)
refs/heads/older on remote = 114846b… → older subject: FIRST commit subject
notification names HEAD's subject although an older commit was pushed: true
```

这与上轮 P1-1 是**同一类错误**（通知描述了没发生的事），只是入口是用户手写的 refspec，且只错在"推了哪个 commit"而不是"推到哪"。**建议**：从 refspec 的源端解析出 rev（`${tip}` 已替换为 `HEAD`；否则取冒号前的部分），对**该 rev** 取标题；解析失败时回退 `（无法读取 commit 标题）`。

### N-3（P3）删除不存在的远端分支会报"已推送"

`:refs/heads/gone`（远端无该 ref）时 Git 自身 `exit 0`（`remote: warning: deleting a non-existent ref`），provider 因此走成功路径：

```
inline sink: ["已推送：自定义推送：\"first\" → origin/gone"]
notifications: ["自定义推送到 origin/gone？（:refs/heads/gone）"]
remote refs before/after: ["refs/heads/master"] -> ["refs/heads/master"]
```

没有 ref 被改动却说"已推送"。语义上"已推送"对"删除一个不存在的 ref"是可辩解的（Git 认为目标状态已达成），且与 Git 退出码一致，因此判 P3 而非 P1；若要更贴切，可在输出里区分 `[deleted]` / `[up to date]`。

### N-4（P3）`docs/summary/summary.md:150` 的测试数量仍为 283，实际为 290

```
docs/summary/summary.md:150: 当前测试套件在 v0.8.3 中为 **283 项**（`npm run test` 全绿、0 失败、0 跳过）…
```

静态枚举（逐文件、只计行首的 `test(`/`it(` 声明，45 个测试文件）得到 **290**；上轮同法得到 283，差额为 `pushNotification.test.ts` 的 11 项减 4（`webviewDom.test.ts` 与 `restoreFileProtocol.test.ts` 的净增），与实现者"283 → 290"的说法一致，但**文档没有同步**。实现者"283 → 290 documented and matching"的声明**不成立**。这是纯文档问题，且 `npm run test` 的真实输出才是权威；建议改成 290，或干脆不写具体数字。

### N-5（P3，既有行为）取消 / 普通异常会成为 unhandled rejection

`src/extension.ts:61` 是 `vscode.commands.registerCommand("gitRebaseVisual.push", () => provider.pushBranch())`，没有 `catch`；仓库内也没有 `process.on("unhandledRejection", …)`。因此 2.3 的 `推送已取消。` 与 2.4 的普通异常都会变成扩展宿主里的 unhandled rejection，而不会显示为一条用户提示。`HEAD` 对**所有**推送错误都是这个行为（上轮的 `return` 反而把它藏起来了），本轮没有让它变差，取消路径的产品文案也确定产生（`推送已取消。` 会被抛到调用方）。若要闭环，`registerCommand` 的包装里应 `catch` 并 `showErrorMessage`；这属于既有缺口，不阻塞本轮。

---

## 六、回归检查

- **确认弹窗**：`p1.ts` / `p3.ts` 每次推送前都先出现 `推送到 origin/master？（HEAD:refs/heads/master）`、`自定义推送到 origin/gone？（:refs/heads/gone）` 这类模态文案，**refspec 仍原样展示**，确认词仍是 `Push`；拒绝/取消选择时不推送、不报任何结果（`配置模板 + 取消 quick pick` 用例）。
- **不重复刷新**：失败后 refresh 计数 1（立即）与 1（600 ms 后），成功路径 1 次；`refreshQueued` 的 finally 分支没有叠加。
- **控制流错误不冒充 Git 错误**：日志只有 `push: 开始` / `push: 完成` / `push: 失败 <git message>`；`PushAlreadyReported` 字符串不出现；用户只收到一条错误通知。
- **恢复侧别词表**：`test/restoreFileProtocol.test.ts` 通过（1/1），`side` 仍为 `working`/`staged`，未引入别名。
- **锁定摘要**：`test/webviewDom.test.ts` 的整行精确匹配通过（空格 + ` · replay`），`aria-label` 的 `尚未重放` 由新用例钉住。
- **降级路径**：无 cwd、无 upstream、锁定 commit 在推送范围内三条早退分支仍是 `toast("error", …) + return`，不经过 `PushAlreadyReported`，也没有被本次改动影响。

---

## 七、版本与文档

- `package.json:5` = `0.8.3`；`package-lock.json:3` 与 `:9` = `0.8.3`。
- `docs/release-notes/0.8.3.md` 标题为 `## Git Rebase Visual 0.8.3`；`RELEASE.md:122` 有 `**0.8.3** — 修复三处界面缺陷，并把 Push 提示改写为用户可读的三要素`。
- 三份文档（README / RELEASE / release notes）均无 `{{…}}` 占位符（唯一命中是 `RELEASE.md:104` 的规则原文）。
- `README.md:114` 的"唯一省略的情况"与 `docs/release-notes/0.8.3.md:30` 一致，且都明说"它仍是唯一不写 Git 的路径"。
- **不通过项**：`docs/summary/summary.md:150` 的 283（见 N-4）。

---

## 八、VSIX（`dist-vsix/git-rebase-visual-0.8.3.vsix`）

- 条目 **12** 个，与 `scripts/package-vsix.js` 的 `expectedEntries` 集合逐项一致；`node scripts/package-vsix.js --verify-only` → `VSIX contents match the allowlist (12 entries).` 无源码 / 测试 / 文档 / node_modules。
- `extension.vsixmanifest` 的 `Identity Version="0.8.3"`；包内 `extension/package.json` 的 `version` 也是 `0.8.3`。
- 逐字节比对（打包 vs 工作树）全部相等：`dist/extension.js`、`dist/seq-editor.js`、`media/main.js`、`media/style.css`、`readme.md`、`package.json`、`LICENSE.txt`。
- 重新执行 `node esbuild.js` 后 `dist/extension.js` 的 sha256 仍为 `ea14df5e48f9391038c86e3751fca72d6a91231bec8e82cc2d7f28cca3731656`——可复现，包内就是当前源码的构建。
- 包内 `media/main.js` 确实含 `omitDraftEntry`；bundle 含 `PushAlreadyReported`、`pushDestination`、`pushKindLabel` 与 `普通推送` / `评审推送` / `自定义推送` / `推送失败：` / `已推送：` / `推送中：` / `无法确定目标分支` / `推送已取消` 等（esbuild 以 `\uXXXX` 转义，按码点搜索均为 true），旧形状 `推送中：${refspec}` 已不存在。
- 时间戳：最后源码编辑 `src/ui/rebaseViewProvider.ts` 17:57:45（`pushNotification.ts` 17:22、`media/main.js` 17:25）→ `dist/extension.js` 18:17:53 → VSIX 18:18:10。**产物在最后一次源码编辑之后构建**，上轮"可能打包了旧代码"的担忧解除。

---

## 九、我独立执行的验证命令

| 命令 | 结果 |
|---|---|
| `node node_modules/typescript/bin/tsc --noEmit` | exit 0，零输出 |
| `node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit` | exit 0，零输出 |
| `node node_modules/tsx/dist/cli.mjs --test test/pushNotification.test.ts` | 11 通过 / 0 失败 / 0 跳过 |
| `node node_modules/tsx/dist/cli.mjs --test test/webviewDom.test.ts test/restoreFileProtocol.test.ts` | 12 通过 / 0 失败 / 0 跳过 |
| `node scripts/package-vsix.js --verify-only` | 白名单 12 条目一致 |
| 静态枚举 `test/*.test.ts` 行首 `test(`/`it(` | **290** |

**完整套件（290 项）未运行，290/290 全绿未独立确认**——按规则不重跑；上面 290 只是静态计数，与 `npm run test` 的真实通过数不是一回事。

---

## 十、发布裁决

**0.8.3 可以发布；批准覆盖已产出的 `dist-vsix/git-rebase-visual-0.8.3.vsix`。**

理由：

1. 上轮阻塞的三条（P0-1 假成功、P1-1 目标撒谎、P1-2 入口删除）都已修复，且都有"把修复改回去就变红"或"真实 bare remote 上读回实际 ref"的对抗性证据，不是靠断言字符串。
2. P0-1 的修复经过红-对照-旧验证；失败、成功、取消、普通异常四条路径的行为互不污染，refresh 既不丢失也不重复。
3. P1-2 的唯一下降格已确认是用户明确要求的取舍，且现在被如实记录，不再以错误理由掩盖。
4. VSIX 为 12 条目白名单、内容与工作树逐字节一致、可复现、且在最后一次源码编辑之后构建——批准对发布物本身有效。
5. 本轮新发现最高为 P2（N-1，带斜杠远端名，需手写 `.git/config` 才能构造；且该配置下普通推送通常直接失败）；其余为 P3（N-2 非 HEAD 源标题、N-3 删除不存在 ref 的措辞、N-4 文档 283/290、N-5 既有 unhandled rejection）。建议 N-4 在打 tag 前顺手改掉（纯文档、零风险），N-1/N-2 记入 `docs/improvement/improvement.md` 作为后续版本。

**条件（非阻塞）**：`docs/summary/summary.md:150` 的 `283` 应改为 `290` 或删去具体数字；`src/git/pushGuard.ts:27` 的远端名切分与 `subject` 恒取 `HEAD` 两处建议进入下一轮改进清单。
