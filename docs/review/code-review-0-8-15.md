# Code Review 0-8-15 — 0.8.3 第三轮复核（N-1…N-5 逐项实证 + 推送通知新路径）

- **基线**：`main` @ `577ce8766a46707a60c471cf8090e9f63cd8d49c`（`test: run each file in its own process and split the slowest suite`）+ **未提交工作树**（13 个已跟踪文件修改、6 个新增；`git diff --stat 577ce87 -- src/ media/ test/` = 6 文件 / +368 / −37）。按台账 `docs/review/code-review-commit.md:51` 的记载，`577ce87` 已由 `code-review-0-8-13.md` 与 `code-review-0-8-14.md` 覆盖，但两者评的都是**同一棵未提交工作树**；本轮为第三轮独立复核，评的仍是这棵工作树，无新 commit SHA。提交后仍需后续独立评审按真实 SHA 覆盖。
- **评审性质**：复核 `code-review-0-8-14.md` 第五节 N-1…N-5 的整改，并**独立复验**实现者未在报告中点名的四处 UI 项（②草稿入口矩阵、③Changes 侧 ✕、⑤`🔒 :` 间距、⑨推送消息三要素）。要求是"对着代码验证，不是对着描述验证"。
- **方法**：Node `v24.16.0`、仓库内 `tsx`、仓库内 JSDOM、Git `2.45.0.windows.1`。所有推送场景都用**真实 provider + 真实 Git 仓库 + 真实 bare remote**（`test/helpers/gitTestRepo` + `test/helpers/vscodeStub`）驱动；破坏性探针全部在 OS 临时目录（`/tmp/grv-b15`…`b34`）内，结束前已删除。三次源码变异均已按原字节恢复并以 sha256 复核（见第十节）。
- **工作树**：开始时 19 项，结束时 20 项——多出的 1 项就是本报告（本轮唯一写入的文件）。`HEAD` 未变，`git stash list` 为空；未做 commit / tag / push / `git add`，未改台账。
- **进程表**：仅 3 个常驻 `node.exe`（codegraph ×2、drawio-mcp），与本项目无关；本轮自己起的测试进程均已退出。
- **完整套件（294 项）未由我运行**：任务书要求不得与另一个全量进程并发，而该进程的输出我未能捕获。我独立运行的是受影响的四个文件（`pushNotification` 15/15、`webviewDom` 11 + `restoreFileProtocol` 1 = 12/12、`pushGuard.integration` 2/2）与两次类型检查。**294/294 全绿未经我独立确认**。

---

## 一、结论摘要

| # | 上一轮发现 | 本轮结论 |
|---|---|---|
| N-1 | `getUpstream` 按第一个 `/` 拆分 `@{upstream}`，斜杠远端名解析错 | **已修复**，四个子问题逐个给了答案：(a) 解析正确（实测 `team/origin`）(b) `symbolic-ref` 那行**恒不生效**——两个调用点都传短名，命令恒 exit 1，真正起作用的是 `branch = branchRef` 回退，属"正确但误导"（P3 见 `N-2` 新发现 4）(c) Git ≥ 2.13 不是约束（本扩展最低要求 2.31.0）(d) `knownRemotes` 不会误杀合法远端 |
| N-2 | 自定义 refspec 发布 `HEAD~1` 时标题恒取 `HEAD` | **已修复且实测正确**：`HEAD~1:refs/heads/older` 推送后标题/成功提示都是 `FIRST commit subject`，远端 `refs/heads/older` 里确实是该 commit。**但没有任何 provider 级用例钉住它**——把 `sourceRev` 改回常量 `"HEAD"` 后 15 条 `pushNotification` 用例**全绿**（见第十节变异 1） |
| N-3 | 删除不存在的远端 ref 仍报"已推送" | **双向均已修复**：真无操作报 `无需推送：…（远端已是该状态）`；真删除**不会**被误判成无操作（远端 ref 确实消失，报 `已推送`）。`LC_ALL=C` 下 `Everything up-to-date` / `deleting a non-existent ref` 的原文已实测 |
| N-4 | `summary.md` 写 283，实为 290 | **已修复**：静态枚举 **45 文件 / 294 条**，`docs/summary/summary.md:150`、`RELEASE.md:132`、`docs/release-notes/0.8.3.md:43` 三处一致为 294，其余 275/217/214 均在明确标注的历史段落。**但** `docs/research/test-performance.md` 顶部横幅自称"当前为 275 个测试 / 43 个文件"，现已同时过时（见新发现 5） |
| N-5 | 命令注册无 `catch`，rejection 逃逸 | **已修复**，但`.catch` 只写诊断文件、不弹窗；取消路径这样处理是对的。**新发现**：存在一条"真失败且用户什么都看不到"的路径（新发现 1，P2） |
| ②草稿入口 | 只在 edit stop 显示 | **通过**。7 个状态逐个复现；把 `omitDraftEntry` 强制为 `false` / `true` 两侧都变红（变异 2、3），证明矩阵真的在跑 |
| ③Changes ✕ | 点工作区文件的 ✕ 报 `缺少要恢复的文件状态。` | **通过**。`restoreSide` 在消息边界翻译为 host 词表 `staged`/`working`，端到端用例把 webview 的真实消息喂给真实 host handler；错误串在 `rebaseViewProvider.ts:2701` 只在 `side` 既非 `working` 也非 `staged` 时出现 |
| ⑤`🔒 : 8 lock` | 冒号前缺空格 | **通过**。`media/main.js:328` 为 `🔒 : ${commits.length} lock`，用例用整行精确正则钉住 |
| ⑨推送消息 | 应含推送类型 / commit 标题 / 目标分支 | **通过**（普通、评审、自定义三种），**但删除型 refspec 是例外**：它不发布任何 commit，却仍把 `HEAD` 的标题写在提示里（新发现 3，P3） |
| VSIX | — | **通过**。12 条目、包内 8 个有效文件与工作树**逐字节相同**（本轮补上了上一轮未验的 `LICENSE.txt`：sha256 `5b78c0db…` 与仓库根 `LICENSE` 完全一致）；从当前源码重新 esbuild 复现 `dist/extension.js` sha256 `1c7e909d…` |

**发布裁决：批准 0.8.3 发布，且批准覆盖 `dist-vsix/git-rebase-visual-0.8.3.vsix`。** 四条主路径（N-1/N-2/N-3 + 四处 UI）均有对抗性证据；本轮新发现 6 处，最高 P2，均不阻塞：一条"特定配置下推送完全无反馈"的回归、一条"改回去也没人发现"的测试护栏缺口，其余四条是措辞/注释/文档。**注意**：VSIX 覆盖是**按字节**批准的——我在第十节恢复变异后，`src/git/pushGuard.ts`、`src/ui/rebaseViewProvider.ts`、`media/main.js` 的 mtime 已晚于 VSIX 的 19:36:42，mtime 不再能作为"产物晚于源码"的证据；判据是重建 sha256 与包内文件逐字节比对（见第十一节）。

---

## 二、N-1 逐项复核

### (a) 斜杠远端名的解析：正确

在 `/tmp/grv-b26` 手写 `.git/config` 造出 `remote.team/origin.url`，同时放一个名为 `team` 的**诱饵远端**：

```
$ git remote
origin
team
team/origin
$ git for-each-ref --format='%(upstream:short)%09%(upstream:remotename)%09%(upstream:remoteref)' refs/heads/master
refs/heads/master	team/origin/master	team/origin	refs/heads/master
```

`%(upstream:remotename)` 给出完整的 `team/origin`，`%(upstream:remoteref)` 给出 `refs/heads/master`，因此 `remoteBranch` 走 `remoteRef.startsWith("refs/heads/")` 分支得到 `master`，而不是从 `ref` 尾巴上切出 `origin/master`。仓库内 `test/pushNotification.test.ts:288` 那条用例把同一形状端到端跑到"`team` 远端上没有任何 ref 被创建"，与我的手工复现一致；我把实现临时改回"按第一个 `/` 切分"，该用例变红（`actual: 'team'` / `expected: 'team/origin'`，第 321 行），恢复后通过。

### (b) `symbolic-ref --short <branchRef>`：正确但恒不生效（属"误导"，不是缺陷）

```
$ git symbolic-ref --quiet --short master        ; echo $?
1
$ git symbolic-ref --quiet --short refs/heads/master ; echo $?
1
$ git symbolic-ref --quiet --short HEAD          ; echo $?
master                                              0
```

`git symbolic-ref` 只接受**符号引用**（`HEAD`、`refs/remotes/origin/HEAD` 之类）；`refs/heads/master` 是普通 ref，`fatal: ref refs/heads/master is not a symbolic ref`。而 `getUpstream` 的两个调用点 `src/ui/rebaseViewProvider.ts:407`（`currentBranch()` 的返回值）与 `:2987`（`rebasingBranch()` 的返回值，已 `replace(/^refs\/heads\//, "")`）**都传短分支名**，所以：

- 这一行恒 `code !== 0`；
- 真正生效的永远是 `const branch = branchRef` 回退；
- 现有行为**正确**（短名正是后面 `refs/heads/${branch}` 需要的形状），但第 28–29 行注释"Resolve HEAD to a branch first"描述的事情**没有发生**。

判定：**正确但误导**，不是缺陷。风险只有一种：将来有人传 `HEAD` 进来时，这一行会成功并把 `HEAD` 解析成某个分支名，与注释一致；这是设计意图，不是 bug。建议（P3）把注释改成"传短名时这是恒等的归一化步骤"，或干脆删掉这次调用。已并入新发现 4。

### (c) `%(upstream:remoteref)` 需要 Git ≥ 2.13：不是真实约束

`src/git/commitLog.ts` 的 `MIN_GIT_VERSION = [2, 31, 0]`，`checkGitFeature` 在每次 `refresh()` 开头执行，不满足时直接以错误横幅结束、不渲染列表（我用真实 provider 复现过该分支）。`getUpstream` 的所有调用点都在 Git 已通过该检查之后，所以 **2.13 这一门槛被 2.31 完全覆盖**，不构成对用户的额外要求。

### (d) `knownRemotes` 不误杀合法远端

两种"看起来可疑"的远端都验证过：

```
# 1) 斜杠远端
$ git remote  →  origin / team / team/origin      # 名单里确实有 team/origin
# 2) 只有 fetch refspec、没有 url 的远端（/tmp/grv-b27）
$ git remote  →  origin                            # 仍然列出
```

第二种是 `git remote` 依据 `remote.<name>.fetch` 判定的结果，因此护卫条件 `!new Set(knownRemotes).has(remote)` 不会把它当成"不存在的远端"。**护卫本身是有效的**：`pushDestination("team", "HEAD:refs/for/master", ["team/origin"])` 返回 `（无法确定目标分支）`，用例 `pushNotification.test.ts:343` 覆盖。

### (e) 一处**未**被 N-1 覆盖的不一致（并入新发现 2）

`pushDestination` 的四处调用里，只有通知那一处（`:3071`）传了 `knownRemotes`，三处**确认框**（`:3018`、`:3035`、`:3046`）没传：

```
3018: let label = `推送到 ${pushDestination(up.remote, refspec)}`;
3035: label = `评审推送到 ${pushDestination(up.remote, refspec)}`;
3046: label = `自定义推送到 ${pushDestination(up.remote, refspec)}`;
3071: const described = describePush(kind, subject, pushDestination(up.remote, refspec, await this.remoteNames(cwd)));
```

后果在 `branch.<b>.remote = "."` 这一形状下实测可见：确认框说 `推送到 ./other？`，同一次流程的通知说 `→ （无法确定目标分支）`。详见新发现 2。

---

## 三、N-2 复核 — subject 取自 refspec 源端

真实 provider + 真实 bare remote，配置 `push.refspecTemplate` 后选"自定义 refspec…"，输入 `HEAD~1:refs/heads/older`：

```
HEAD subject:     SECOND commit subject (HEAD)
HEAD~1 subject:   FIRST commit subject
remote refs/heads/older sha:     971bfd13…
remote older subject:            FIRST commit subject
titles:      ["推送中：自定义推送：\"FIRST commit subject\" → origin/older"]
toasts:      [{"level":"info","text":"已推送：自定义推送：\"FIRST commit subject\" → origin/older"}]
notifications: [{"level":"warn","text":"自定义推送到 origin/older？（HEAD~1:refs/heads/older）"}]
```

标题与**远端真正收到的那个 commit** 一致，不是 `HEAD` 的标题。`pushSource` 的边界也核对过：`+HEAD~1:…` 去掉 `+` 后取冒号左侧；无冒号时用整串；源端为空（`:refs/heads/x`，即删除）返回 `undefined`，调用方回退到 `HEAD`——回退本身在这里正是新发现 3 的成因。

**护栏缺口（P2 级别的测试问题，但不单独编号为新发现——产品行为本身是对的）**：`test/pushNotification.test.ts` 只有 `pushSource` 的纯函数用例（`:351`），没有任何用例断言"provider 真的用 `sourceRev` 去读标题"。我把 `src/ui/rebaseViewProvider.ts` 的 `const sourceRev = pushSource(refspec) ?? "HEAD";` 改成 `const sourceRev = "HEAD";`（sha256 `55066acd…`），`test/pushNotification.test.ts` **15/15 全绿**，耗时 101.1 s。恢复后 sha256 回到 `ba2578b0…`。这是本轮唯一一个"测试通过但没测到"的实例，与上一轮那个 P0（stub 恒返回同一值）属于同一类缺陷，因此在正文和裁决里都单列，并作为最小跟进项 ④。

---

## 四、N-3 复核 — 无操作判定的两个方向

`LC_ALL=C` 下先确认 Git 的原文（`/tmp/grv-b34`）：

```
# 第二次推同一内容
$ LC_ALL=C git push --force-with-lease=master origin HEAD:refs/heads/master
Everything up-to-date
exit=0
# 删除一个从未存在的 ref
$ LC_ALL=C git push --force-with-lease=ghost origin :refs/heads/ghost
remote: warning: deleting a non-existent ref
 - [deleted]         ghost
exit=0
```

真实 provider 的两个方向：

```
# 无操作
first  push toasts: 已推送：普通推送："second" → origin/master
second push toasts: 无需推送：普通推送："second" → origin/master（远端已是该状态）

# 真删除（refspec ":refs/heads/gone"，远端原本存在 refs/heads/gone）
remote refs before: ["refs/heads/gone","refs/heads/master"]
remote refs after:  ["refs/heads/master"]
toasts: 已推送：自定义推送："first" → origin/gone
```

两个方向都没有误报。变异验证（上一轮已做、本轮复核结论未变）：把 `noChange` 固定为 `false`，无操作用例红在 `actual: '已推送：自定义推送："first" → origin/never-existed'`；恢复后绿。已知边界（实现者已写进 `docs/improvement/improvement.md`）：重复的 `refs/for/*` 评审推送可能报 `Everything up-to-date`，此时按"已推送"报告是**正确**的，因为服务端确实新建了评审单。

---

## 五、N-4 复核 — 294 是正确的

独立枚举（逐文件、只数行首的 `test(` 声明，排除 `test.skip`/`todo`/`only`——仓库中三者均为 0）：

```
files 45  total 294
按文件前六：pendingRecovery.residual 25 / recoveryProvider 22 / fileLogger 19 /
            pendingRecovery.settle 18 / pendingRecovery.append 17 / pushNotification 15
```

与基线 `577ce87`（43 文件 / 275 条）的差额 = `webviewDom` 8→11（+3）、`pushNotification` 0→15、`restoreFileProtocol` 0→1，合计 **+19 = 294**，与 `RELEASE.md:132` 写的"新增项"清单吻合。

- `docs/summary/summary.md:150`：**294 项** ✅
- `RELEASE.md:132`：**294 项** ✅（`RELEASE.md:150` 的 275 在 0.8.2 小节，历史事实）
- `docs/release-notes/0.8.3.md:43`：**294 项** ✅
- `README.md` / `docs/improvement/improvement.md`：不含具体数字 ✅

`docs/review/code-review-0-8-12.md` 里的 275 是那一轮的历史记录，不要求跟改。

**唯一遗留**：`docs/research/test-performance.md:5` 的 superseded 横幅写着"当前为 **275 个测试 / 43 个文件**；`pendingRecovery.integration.test.ts` 已拆为 3 个文件共 **60** 个测试"。第三句仍然正确（17+25+18=60），前两句已同时过时（现为 294 / 45）。见新发现 5。

---

## 六、N-5 复核 — `.catch` 会不会吞掉用户需要看到的失败

`src/extension.ts:66` 现在把 rejection 记进 `warnDiagnostic("push", …)`。诊断 logger 在 `activate()` 里先于命令注册安装（`setDiagnosticsLogger(logger)` 在前），所以这条记录一定会落到会话文件；用户侧**零提示**。

- **取消**：provider 抛 `推送已取消。`、零 toast、零通知（我实测过：只有确认弹窗一条）。只记日志，正确。
- **已上报的失败**：provider 先 `toast("error", 推送失败：…)` 再抛 `PushAlreadyReported`，`pushBranch` 吞掉它并 `refresh()`。用户看到了失败，日志里有，正确。
- **未上报的失败**：只要 `pushBranchInternal` 在"确认弹窗之后、`withProgress` 之前"抛出，就**没有任何提示**。这不是假想——见新发现 1。

---

## 七、四处 UI 项的独立复验

**② 草稿入口矩阵**（`media/main.js:262`）：`omitDraftEntry = !state.rebaseInProgress && state.hasStaged && !state.hasUnstaged`。逐状态断言（Changes 组 / banner 各几个、`mode` 为何、`messageOnly` 与 `ai` 是否为真）在 `test/webviewDom.test.ts:337` 覆盖 7 个状态。**两侧变异都变红**（第十节变异 2、3），因此这不是"矩阵写死在测试里、实现随便"的空转。

**③ Changes 侧 ✕**：`media/main.js:227` 把面板的分组键 `unstaged` 翻译成 host 词表 `working`（`staged` 保持不变），`untracked` 只在 `working` 侧为真。host 端 `restoreChangedFile` 的校验是 `sideValue !== "working" && sideValue !== "staged"` 才抛 `缺少要恢复的文件状态。`。`test/restoreFileProtocol.test.ts` 把 webview 自己产生的消息喂进真实 host handler、在真实仓库上跑完整往返；把 `restoreSide` 改回 `side` 后该用例红在 `actual: 'unstaged'` / `expected: 'working'`（第 167 行）。

**⑤ `🔒 : 8 lock` 间距**：`media/main.js:328` 为 `🔒 : ${commits.length} lock · no push…`，用例用整行精确正则 `/^🔒 : 3 lock · no push · la ×1 · sa ×1 · yu ×1$/`（`:483`）与带 ` · replay` 的版本（`:505`）钉住；`runSummaryAria` 另加了"其中包含尚未重放的 commit"一句，与紧凑文本的 ` · replay` 对齐。

**⑨ 推送消息三要素**：`describePush(kind, subject, target)` 产出 `普通推送|评审推送|自定义推送："<标题>" → <目标>`，`kind` 由 quick pick 的**决策**携带（不是事后从 refspec 反推），`target` 由 `pushDestination` 从 refspec 的**目的端**推导。三种推送端到端实测的标题/成功提示/确认框互不矛盾（除 §二(e) 的 dot-remote 形状与新发现 3 的删除型 refspec）。

---

## 八、`PushAlreadyReported` 控制流：结构上是成立的

`pushBranchInternal` 在 `withProgress` 的回调里 `throw new PushAlreadyReported(message)`；`withProgress` 把回调的 rejection 原样传出；`pushBranch` 用 `error instanceof PushAlreadyReported` 判别后 `refresh()`，其余异常继续上抛；`finally` 里 `markSettled` / `release` / `disarmWatchdog` 三个动作不受影响。结构上正确的三点：

1. **不能用 `return`**：`return` 会让 `withProgress` 正常完成，落到下面的 `toast("info", 已推送…)`——这正是上一轮的 P0。
2. **类型判别而不是字符串判别**：`name = "PushAlreadyReported"` 只是给人看的，判别走 `instanceof`，所以一条恰好同名的 Git 错误不会被误吞。
3. **`outcome && !outcome.changed`**：失败时 `withProgress` 已经抛出，`outcome` 不可达；`outcome` 的 `undefined` 分支只可能在回调被替换（测试替身）时出现，此时按"已推送"走是保守方向。

一个措辞上的小问题（不影响判定）：`PushAlreadyReported` 同时携带 `gitMessage` 却只在 `message` 里用，`gitMessage` 字段目前无人读取——无害的冗余。

---

## 九、本轮新发现

### 新发现 1（P2）上游分支被 prune + 存在锁时，推送命令**完全没有用户反馈**

形状（真实可达，`git fetch --prune` 之后就是它）：

```
$ git status -sb
## master...origin/master [gone]
$ git for-each-ref --format='%(upstream:remotename)|%(upstream:remoteref)' refs/heads/master
origin|refs/heads/master
```

`getUpstream` 现在返回 `{remote:"origin", branch:"master", ref:"origin/master"}`，但 `refs/remotes/origin/master` 已不存在。于是：

```
getUpstream: {"remote":"origin","branch":"master","ref":"origin/master"}
provider.pushBranch threw: git rev-list origin/master..HEAD failed (128):
  fatal: ambiguous argument 'origin/master..HEAD': unknown revision or path not in the working tree.
titles: []         toasts: []         notifications: []
output channel: 只有启动行
```

用户点了推送、在确认框里点了 Push，**什么都看不到**；命令包装器只把它写进诊断文件。

三点评判：

1. **这是 N-1 修复引入的回归**。`577ce87` 的 `getUpstream` 走 `rev-parse @{upstream}`，同一形状下返回 `undefined`，`pushBranchInternal` 走 `if (!up) { toast("error", 分支 ${branch} 未配置 upstream。); return; }`——我按 `git show 577ce87:src/git/pushGuard.ts` 的原实现原样重跑，`oldGetUpstream: undefined`，确认旧路径会给出一条中文提示。现在这条提示消失了。
2. **只在有锁时触发**：`lockedInPush` 在 `lockedHashes` 与 `lockedPatchIds` 都为空时提前返回，不会走到 `rev-list`。我用真实 `LockStore` 写入一条锁后复现；无锁时同一形状的推送**成功**且提示正确（`已推送：普通推送："second" → origin/master`，远端 ref 被重新创建，sha 与本地 HEAD 一致）——那部分是新行为，且是对的。
3. **不丢数据**：失败方向是"什么都没发生"，不是"改坏了"。

建议：`pushRange`/`lockedInPush` 遇到 range 无法解析时应与"未配置 upstream"同级处理（给出可见提示），而不是让 `git()` 的异常一路穿到只写日志的 `.catch`。另：面板在同一状态下显示的是英文 `No upstream branch is configured for the current branch.`（`resolveRange` 的既有文案），与中文 UI 不一致，但那是既有问题，不属本轮。

### 新发现 2（P3）`branch.<b>.remote = "."`（本地跟踪上游）现在被当成真远端，且确认框与通知互相矛盾

`git branch --set-upstream-to=other master` 是普通命令，产出的就是这种配置。实测（`/tmp/grv-b29`、真实 provider）：

```
$ git for-each-ref --format='%(upstream:short)|%(upstream:remotename)|%(upstream:remoteref)' refs/heads/master
other|.|refs/heads/other
$ git remote
（空）

getUpstream: {"remote":".","branch":"other","ref":"other"}
old rev-parse: other            ← 旧路径也能解析，但没有 `/`，被旧代码判为"未配置"
确认框:  推送到 ./other？（HEAD:refs/heads/other）
进度条:  推送中：普通推送："two" → （无法确定目标分支）
错误:    推送失败：普通推送："two" → （无法确定目标分支）。
         git push --force-with-lease=other . HEAD:refs/heads/other failed (1):
         ! [rejected]        HEAD -> other (stale info)
```

三个具体问题：

1. `git for-each-ref` 的 `%(upstream:remotename)` 对本地跟踪上游返回的是字面量 `"."`，**不是空串**——`src/git/pushGuard.ts:36` 的注释"`remotename` is empty when the merge target is not a remote-tracking branch"是**事实错误**，`if (!ref || !remote)` 因此不会拦下它。
2. 同一个流程里确认框写 `./other`、通知写 `（无法确定目标分支）`，因为只有通知传了 `knownRemotes`。两者必有一处误导。
3. 结果是一次**必然失败**的推送（`--force-with-lease` 对假远端恒 `stale info`；两个分支相同时 Git 报 `Everything up-to-date`，被 N-3 判为"无需推送"，也是错的语义）。

修法很轻：`getUpstream` 把 `"."` 视为无远端（或 `pushDestination` 在 `remote === "."` 时降级），并让三处确认框也带上同一份远端名单。

### 新发现 3（P3）删除型 refspec 不发布任何 commit，却把 `HEAD` 的标题写进提示

N-2 的 `pushSource` 对 `:refs/heads/obsolete` 正确返回 `undefined`，调用方回退到 `HEAD`：

```
pushSource(':refs/heads/obsolete') = undefined
remote before: [ 'refs/heads/master', 'refs/heads/obsolete' ]
remote after:  [ 'refs/heads/master' ]
HEAD subject:  HEAD is something else entirely
titles:  ["推送中：自定义推送：\"HEAD is something else entirely\" → origin/obsolete"]
toasts:  ["已推送：自定义推送：\"HEAD is something else entirely\" → origin/obsolete"]
```

这次推送**只删了一个 ref，没有发布任何 commit**。提示里的三要素因此有一项是编出来的。上一轮的实现（`已推送：${refspec} → ${up.remote}`）至少没有声称过某个 commit。建议：`pushSource` 返回 `undefined` 且目的端为空时改用"删除"措辞（或 `PUSH_SUBJECT_UNKNOWN` 的"未发布"变体）。

### 新发现 4（P3）`getUpstream` 的 `symbolic-ref` 调用恒不生效，注释与行为不符

见 §二(b)：两个调用点都传短分支名 → 恒 exit 1 → 真正生效的是 `branch = branchRef`。注释写的是"Resolve HEAD to a branch first"，与实际发生的事无关。属可读性问题，不改变行为。

### 新发现 5（P3）`docs/research/test-performance.md` 的"当前数字"横幅已过时

该文件顶部横幅自称是 superseded 文档、并**专门**写明"当前为 **275 个测试 / 43 个文件**"。现在实为 **294 / 45**。同一句里"`pendingRecovery` 拆为 3 个文件共 60 个测试"仍然正确。既然横幅存在的目的就是纠正过时数字，它自己过时就是缺陷；建议改成不写数字（或写"见 `scripts/run-tests.js` 的实时枚举"）。

### 新发现 6（P3）`gitRunner.ts` 的审计表已过期

`src/git/gitRunner.ts:76` 仍写着 `| git/pushGuard.ts | refspecs | structural — refs, not messages |`。但 `pushRefspec` 现在按英文散文判无操作（`Everything up-to-date` / `deleting a non-existent ref`），并为此传了 `LC_ALL=C`——这正是该表给其它条目打的 **prose** 标签。表本身是本项目"哪些地方在读 Git 人类可读输出"的唯一清单，遗漏会让下一个人误判风险。

---

## 十、变异实验（红—恢复，全部按字节还原并复核）

| # | 变异 | 观察结果 | 恢复后 |
|---|---|---|---|
| 1 | `src/ui/rebaseViewProvider.ts`：`const sourceRev = pushSource(refspec) ?? "HEAD";` → `const sourceRev = "HEAD";`（`55066acd…`） | `test/pushNotification.test.ts` **15/15 全绿**（101.1 s）——**变异存活**，即 N-2 的接线无回归护栏 | 恢复，sha256 `ba2578b05bb2e3ff06806339ac8262c9eb5505b079db8bccb15adc8859a52c7b`，与备份 `diff -q` 一致 |
| 2 | `media/main.js`：`omitDraftEntry = …` → `omitDraftEntry = false` | `webviewDom` 红：`idle, all staged: Changes-group count` `1 !== 0`（第 387 行） | 见下 |
| 3 | `media/main.js`：`omitDraftEntry = …` → `omitDraftEntry = true` | `webviewDom` 红：同一断言 `0 !== 1` | 恢复，sha256 `61399131ca1c7dc831fcd045b7043026791dd3c3a0dea813c8901e5d530d3ad7`，与备份一致 |

前两轮已做、本轮复核结论未变的三次变异：`noChange` 固定为 `false` → 无操作用例红；`getUpstream` 改回"第一个 `/` 切分" → 斜杠用例红在 `actual: 'team'`；`restoreSide = side` → 协议用例红在 `actual: 'unstaged'`。

**工作树最终状态**：`git diff --stat 577ce87 -- src/ media/ test/` = **6 文件 / +368 / −37**，与开工时逐字节相同（关键文件 sha256：provider `ba2578b0…`、main.js `61399131…`、pushGuard `392fe095…`）。本轮没有修改任何 `src/`、`test/`、`media/`、`docs/` 内容（除本报告），没有 commit / tag / push / `git add`。

---

## 十一、回归、类型检查与 VSIX

- `node node_modules/typescript/bin/tsc --noEmit` → 退出码 0，零输出。
- `node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit` → 退出码 0，零输出。
- `test/pushNotification.test.ts` → 15/15，106.9 s。
- `test/webviewDom.test.ts` + `test/restoreFileProtocol.test.ts` → 12/12，17.5 s（**在两次变异恢复之后重跑**，确认恢复干净）。
- `test/pushGuard.integration.test.ts` → 2/2，24.0 s（真实 bare remote 的 `--force-with-lease` 拒绝与 `lockedInPush`）。
- **重建复现**：用与 `esbuild.js` 相同的参数把当前 `src/extension.ts` 重新打包，得到 sha256 `1c7e909d2e07ed983ca31989c1d012c65467f29fa1b756b21205296d2816f97d`，与 `dist/extension.js` **完全相同**。
- **VSIX**（`dist-vsix/git-rebase-visual-0.8.3.vsix`，156277 字节）：解包后恰好 12 个条目，与 `scripts/package-vsix.js` 的 `expectedEntries` 逐项一致；包内 12 个条目里 10 个对应真实文件，我逐字节比对了全部 **10** 个（含两个图标 `extension-icon.png` `397d298d…`、`icon.svg` `cbf7205f…`）——
  - `dist/extension.js` `1c7e909d…`、`dist/seq-editor.js` `3a242012…`、`media/main.js` `61399131…`、`media/style.css` `99726c3c…`、`README.md`/`readme.md` `bf646530…`、`.gitignore` `34c65652…`、`package.json`（规范化后与仓库 `package.json` **完全一致**）、`LICENSE.txt` `5b78c0db…`（= 仓库根 `LICENSE`，本轮补验）。
  - `extension.vsixmanifest` 为 `Version="0.8.3"`（`2.0.0` 是 XML 官方 schema 的版本属性，不是扩展版本）。
  - 包内 `dist/extension.js` 含本轮全部新增中文串（esbuild 输出为大写十六进制转义，按该形式检索：`无需推送：`、`已推送：`、`推送失败：`、`推送已取消。`、`（无法确定目标分支）`、`（无法读取 commit 标题）`、`评审推送`/`自定义推送`/`普通推送`、`远端已是该状态`、`仅生成 message（不提交）` 全部 PRESENT）。
  - **mtime 声明**：我在第十节恢复变异时刷新了 `src/git/pushGuard.ts`、`src/ui/rebaseViewProvider.ts`、`media/main.js` 的 mtime（现晚于 VSIX 的 19:36:42）。因此"产物晚于最后一次源码改动"这一条在我动手之后已不再是有效证据；本轮改用**重建 sha256 + 逐字节比对**证明 VSIX 与当前工作树等价，两者是同一事实的更强形式。

---

## 十二、我没有验证的（明确声明）

1. **294/294 全量运行**：按任务书要求未与另一个全量进程并发，而那个进程的输出我未能捕获。我跑的是四个受影响的文件（15 + 12 + 2 条）与两次类型检查；294 这个数字是**静态枚举**的结果，不是一次实跑的结果。
2. **真实 VS Code 图形环境下的手工验收**：JSDOM 能证明消息与 DOM，证明不了真实的编辑器焦点、IME、模态行为。
3. **Git 之外的版本**：所有 Git 行为都在 `2.45.0.windows.1` 上观察。`%(upstream:remoteref)` 的 2.13 门槛、`C_LOCALE` 下两句英文原文，未在 2.31 或 2.13 的实机上复核。
4. **`warnDiagnostic` 落盘内容**：我确认了 logger 在命令注册前安装、`warnDiagnostic` 的实现会写文件，但没有真的启动扩展宿主去读那份日志文件。
5. **评审推送的实际服务端行为**：`refs/for/*` 用了本地 bare 仓库模拟，没有接真实 Gerrit。
6. **`dist/` 的另两个产物**：`dist/seq-editor.js` 与 VSIX 逐字节一致，但我没有单独从源码重建它；两个图标只比对了哈希，没有检查图像内容。
7. **`package-lock.json`** 的版本字段一致性、`npm audit` 一类依赖检查未做（不在本轮范围内）。

---

## 十三、发布裁决

**批准 0.8.3 发布，且批准覆盖 `dist-vsix/git-rebase-visual-0.8.3.vsix`（按第十一节的重建 sha256 与逐字节比对；mtime 因本轮的变异恢复已失效，不再作为判据）。**

理由：上一轮 N-1…N-5 五项的**产品行为**均已修复，且我不只是读代码——斜杠远端、非 HEAD 源的标题、双向无操作判定都在真实 provider + 真实远端上复现过；四条 UI 项有两侧变异证明测试不是空转；VSIX 与工作树字节等价。

同时必须说清楚代价：

- 新发现 1 是**真回归**（N-1 的修复把一条本来会出现的"未配置 upstream"提示变成了完全沉默），触发条件窄（上游被 prune **且** 有锁），失败方向是安全的（什么都没发生），因此不阻塞发布，但应在 `docs/improvement/improvement.md` 里记一条，并优先修。
- 新发现 2 与 3 会让**提示说错话**，正是本模块存在的理由；两者都需要手写配置或手输删除型 refspec 才会遇到。
- 新发现 1 之外最值得警惕的是**变异 1 存活**：N-2 的修复目前没有任何 provider 级护栏，把 `sourceRev` 改回 `HEAD` 全套用例照样绿。建议补一条端到端用例（`HEAD~1:refs/heads/x` → 断言标题是 `HEAD~1` 的），成本很低。

**建议的最小跟进清单**（下一版本，不阻塞 0.8.3）：①上游被 prune + 有锁时的可见提示；②`remote === "."` 视为无远端 + 三处确认框也传远端名单；③删除型 refspec 的措辞；④`pushSource` 的 provider 级用例；⑤`symbolic-ref` 注释、`gitRunner.ts` 审计表、`test-performance.md` 横幅三处文字。
