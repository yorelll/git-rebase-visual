# Code Review 0-8-18 — 0.8.3 第六轮复核（四.1/四.2 的修法是否结构性、注入是否仍被挡住、打包产物、新缺陷）

- 评审日期：2026-11-06
- 评审角色：独立评审（Agent B，第六轮）
- 基线 commit：`577ce8766a46707a60c471cf8090e9f63cd8d49c`（`test: run each file in its own process and split the slowest suite`）
- 被评审材料：基线之上的**未提交工作树**——`git diff 577ce87`（**17 个修改文件**）+ **10 个 untracked**（`src/ui/pushNotification.ts`、`test/pushIsolation.test.ts`、`test/pushNotification.test.ts`、`test/restoreFileProtocol.test.ts`、`docs/release-notes/0.8.3.md`、`docs/review/code-review-0-8-13/14/15/16/17.md`）。`git status --short` 共 27 行，无新的可记录 commit SHA。
- 本轮回答 `code-review-0-8-17.md` 的四.1（P2，`recentN`）与四.2（P3，注释），并按任务要求独立复核五件事：`recentN` 是否端到端修好、修法是否**结构性**、`mainBranch` 注入是否仍被挡住、`sendDetail` 的注释改动是否成立、A 声称的 §五站点审计是否完整；此外检查本轮是否引入新缺陷、测试计数与文档、以及重建后的 VSIX。
- 环境：Windows 11 + MSYS Git `git version 2.53.0.windows.2`，Node `v24.16.0`。命令一律直接调用 `/d/Program Files/nodejs/node`（该 shell 里 `node`/`npm` 解析不到）。
- 本报告**不修改** `code-review-0-8-13/14/15/16/17.md`，不修改账本，不修改任何 `src/`、`test/`、`media/`、`docs/` 与仓库根目录文件。

---

## 一、结论摘要

| 复核项 | 结论 |
| --- | --- |
| 1. `recentN` 回归是否端到端消失 | **已消失**。真实 `RebaseViewProvider` + 真实仓库：`recentCount=5` → **5 条**、默认 20（仓库 8 条）→ **8 条**、`error=undefined`。`upstream` → 2 条、`all` → 8 条、`mainBranch(main)` → 3 条、`mainBranch(nope)` → 可见错误，均与上一轮一致。把 `recentN` 改回上一轮的字符串形态后，集成层与 provider 层**两层同时变红**，报错正是原始 `fatal: option '-n' must come before non-option arguments`——用例非空转。 |
| 2. 修法是否结构性 | **是**。四种范围全部返回 `RangeArgv { options, positionals }`，每个消费点都经 `withPositionals` 组装；`src/` 与打包产物里 **`revRange.split` 出现 0 次**，`withPositionals` 7 处（与源码 7 处一致）。`hasBase` 仍**没有读者**（与基线相同），语义未变。`canonicalSnapshotKey` 只在内存中（`private canonicalSnapshotKey?: string`），**不写 memento**，且 `rangeArgvKey` 产出的文本与旧存储串逐字相同，持久状态无从被破坏。 |
| 3. 注入保护是否被削弱 | **没有**。`mainBranch = "HEAD --output=<绝对路径>"` 经真实 provider 的 `mainBranch`/`all`/`recentN` 三种配置：目标文件**从未被创建**，`mainBranch` 配置下给出 `Base branch '…' not found.`。挡住它的第一道是 `rev-parse --verify --quiet`（对 `--output=…`、`--all`、`--branches`、`--not`、`-n` 全部 exit 1）；第二道是我另行证明**仍然有效**的 `getCommits` 标记（见 §三.3）。 |
| 4. `sendDetail` 的 P3 | **A 选了加注释，没有加标记**；注释描述的耦合是**准确的**。我实测 `git show -s --pretty=%s HEAD --output=<file>` 确实写文件（内容就是标题），而 `git show -s --pretty=%s --end-of-options <40-hex>` 正常返回、且标记之后再加 `--output=` 被拒绝（exit 128、无文件）——所以"加标记"本来也是可行选项，A 选择不动行为只写清依赖，我认可这个取舍。 |
| 5. A 声称的 §五站点审计 | **抽查通过**。`rev-parse --verify --quiet --end-of-options` 对 40-hex / tag / 分支名全部 exit 0（标记不误伤合法 rev）；`for-each-ref … --end-of-options <ref>` 正常；`pushRefspec` 的 dash 远端结论独立复现。审计表覆盖了本轮全部 `log`/`rev-parse`/`for-each-ref` 位置参数站点，但**漏了两处 `rev-list`**（见 §四.1）。 |
| 本轮是否引入新缺陷 | **没有引入产品行为缺陷**（前五轮每轮都有，这一轮断了）。新发现 4 项，全部为 **P3/P4**：两处未加标记的 `rev-list`（**基线即存在**）、一条新用例的**名称与它实际钉住的东西不符**（测试质量）、两处文档与实现不一致。 |
| 计数与文档 | 静态枚举 **46 个文件 / 311 个顶层 `test(`**，与 `docs/summary/summary.md:150`、`RELEASE.md:136`、`docs/release-notes/0.8.3.md:44` 的 **311** 一致；账本已有 `0-8-17` 行。 |
| 重建后的 VSIX | **12 个条目、白名单通过、包内每个 payload 文件与工作树逐字节相同**；包内 `extension/dist/extension.js` 的 sha256 为 `4b0b3d329478cd6d602c0e2cadbaac654339c32b5131c0e4c637bc5e863a534e`，与我现场 `node esbuild.js` 重建的结果**完全相同**（重建前后同为该值）。包内含正确的 `recentN` 结构、`getCommits` 标记、`getUpstream` 的 `[gone]` 判定，且不含 `revRange.split`。 |

### 裁决：**批准**

**本评审批准 0.8.3 以当前工作树发布，并覆盖 `dist-vsix/git-rebase-visual-0.8.3.vsix`。**

理由分三层，全部有本轮实测支撑：

1. 上一轮唯一的发布阻断项（`recentN` 被标记打断）**确实修好了**，而且是按我建议的结构修的：不是把 `-n` 挪个位置，而是把"选项"与"位置参数"变成两个**不能互相冒充**的字段，由 `withPositionals` 统一插标记。两层回归用例（执行结果优先、argv 形状其次）都实测能变红。
2. 上一轮那批安全修复**没有被这次重构削弱**。`--output=` 通过设置进入 `mainBranch` 的三条路径我逐条走过，文件都没被写；而且我额外证明 `getCommits` 自己的标记仍然是"最后一道"（去掉它，`--output=<file>..HEAD` 会真的落盘）。
3. 这一轮**没有引入新的产品行为缺陷**——这是连续第六轮里第一次；新发现 4 项都是 P3/P4（两处基线遗留的未加标记 `rev-list`、一条用例名与实际钉住对象不符、两处文档与实现不符），没有一项改变用户可见的正确行为，也没有一项落在发布阻断面上。

P3/P4 不阻塞，但我按同样的严格度写在 §四，建议在 0.8.4 一并处理（尤其是 §四.1 与 §四.2，它们与本轮主题同源）。

---

## 二、我实际跑了什么（以及没有跑什么）

**明确声明：完整套件（311 项）不是我跑的。** 按任务约束，另有一轮完整套件正在运行，我没有启动第二个全量运行。我跑的是**定向文件**、两个类型检查、以及大量真实仓库探针与变体对照：

1. `node node_modules/typescript/bin/tsc --noEmit` → **exit 0、零输出**（`wc -l` 为 0）。
2. `node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit` → **exit 0、零输出**。
3. `test/pushIsolation.test.ts` + `test/commitLog.integration.test.ts`（`--test-concurrency=3`）→ **24 项全绿**（11 + 13），`143.6 s`。
4. `test/pushGuard.integration.test.ts` + `test/pushNotification.test.ts`（`--test-concurrency=3`）→ **22 项全绿**（2 + 20），`145.9 s`。
5. 我自己写的端到端探针（全部放在 OS 临时目录，不属仓库）：`ranges18` / `up18` / `inj2` / `dashrefresh2` / `dashlock4`，一律用**真实 `RebaseViewProvider` + 真实 bare 远端 + 真实 Git 仓库**（`test/helpers/gitTestRepo` + `test/helpers/vscodeStub`），并以 `process.exit(0)` 收尾（provider 的 1.5 s 状态轮询会钉住事件循环）。
6. **变体对照**：`src/`+`test/` 复制到 `%TEMP%\mut18`（node_modules 用 junction 指回工作树），**只在副本里**改动后重跑同一组用例；另用 `git archive 577ce87 src` 建了 `%TEMP%\mut18b`（基线 `src` + 当前 `test`）做"修前的代码、修后的用例"对照。
7. 裸 Git 对照实验（`git log` / `git show` / `git rev-list` / `git rev-parse` / `git for-each-ref` 在各种标记摆放下的退出码与落盘行为）。
8. 重建与打包：`node esbuild.js`、`node scripts/package-vsix.js --verify-only`、手工解 zip 逐条比对 sha256。

**我修改过的文件**：只有本报告。`src/`、`test/`、`media/`、`docs/`（除本文件）与仓库根目录均未留下改动——评审结束时 `git status --short` 仍为 **27 行**（17 修改 + 10 untracked），`git stash list` 为空，无 `git add` / commit / tag / push，账本未改。`dist/extension.js` 被 `node esbuild.js` 重写（这是任务明确要求的复现步骤），**重建前后 sha256 同为 `4b0b3d32…`**，内容不变；`dist/` 本就在 `.gitignore` 里。

> 一处需要如实说明的副作用：§四.2 的变异跑动中，一个**被削弱过的副本**真的把文件写到了 OS 临时目录，名字是 `grv-range-hijack-<fixture>.txt..HEAD`（注意末尾的 `..HEAD`，这是这个形状的特征）。我在发现后立即删除，并复查 `<TEMP>` 下 `grv-range-hijack` / `grv-getcommits` / `grv18-inj` 前缀的残留数为 **0**。

---

## 三、逐项复核（证据均为本轮实测输出）

### 1. `recentN` 端到端消失，`upstream`/`all`/`mainBranch` 未受影响

真实 provider、真实仓库、`commitRange` 逐个切换（`ranges18` / `up18`）：

```
recentN count=5      : commits=5 error=undefined ahead=0 behind=0
recentN default 20   : commits=8 error=undefined ahead=0 behind=0
all                  : commits=8 error=undefined ahead=0 behind=0
mainBranch main      : commits=3 error=undefined ahead=0 behind=0
mainBranch nope      : commits=undefined error=Base branch 'nope' not found.
upstream             : commits=2 error=undefined ahead=2 behind=0 titles=["c7","c8"]
```

（`upstream` 一例的远端跟踪 ref 被我显式放在 `hs[5]`，因此 `upstream..HEAD` 恰好是 `c7`/`c8` 两条——与 `ahead=2` 自洽。）

**非空转证明**：在副本里把 `recentN` 改回上一轮的形状（`positionals: ["-n", …, tipRef]`，标记仍在它们之前），两层同时变红：

```
✖ every committed range executes and returns the commits it promises
  Error: git log … --end-of-options -n 2 HEAD failed (128): fatal: option '-n' must come before non-option arguments

✖ commitRange=recentN through the real provider returns commits, not an error
  AssertionError: no error is reported; got "… --end-of-options -n 20 HEAD failed (128): fatal: option '-n' …"
```

即：集成层断言的是**执行结果**（`getCommits` 真的返回 2 条、条数与标题都对），provider 层断言的是**用户看到的东西**（`error` 为 `undefined`、`commits.length === 20`）。上一轮的缺口正是"只断言 argv 形状"，现在这个缺口被两层都堵上了。

### 2. 修法是结构性的，不是挪字符串

- 四种范围全部返回结构体，且 `RangeArgv` 的文档注释写明了**为什么必须是两个字段**（一个空格可拆的字符串无法表达"选项在标记前、位置参数在标记后"）以及"将来新增范围类型必须自己决定每个参数在哪一侧"。这是把不变式前移到类型上，而不是在调用点小心。
- 消费侧：`getCommits` 用 `withPositionals([...固定选项, ...range.options], range.positionals)`；`resolveRange` 的两处 `runGit` 也走 `withPositionals`。
- 全仓扫描：`revRange.split` 在 `src/` 为 **0**，在 `dist/extension.js` 也为 **0**；`withPositionals` 源码 7 处、产物 7 处（`commitLog.ts:133/153/228`、`pushGuard.ts:69/223`、`rebaseViewProvider.ts:3100`，加定义本身）。剩余的 `.join(" ")` 只有三类：`rangeArgvKey`（**故意**复刻旧文本）、错误消息里的 `git ${args.join(" ")}`、以及 `mutationLock` 的日志标签——都不是"把范围拼成命令"。
- `rangeArgvKey` 与旧存储文本的一致性我逐种核对：`recentN` → `"-n 5 HEAD"`、`all` → `"HEAD"`、`upstream` → `"HEAD@{upstream}..HEAD"`、`mainBranch` → `"<b>..HEAD"`，与基线 `revRange` 字符串完全相同。
- **快照身份不会漂移**：`canonicalSnapshotKey` 的 `range` 分量现在由 `rangeArgvKey(range.revRange)` 提供；`canonicalSnapshotKey`/`canonicalRevision` 是 `private` 字段，只在进程内比较与下发，**不写 `globalState`**（`grep 'canonicalSnapshotKey' src/` 只命中声明、赋值与读取）。因此即便将来格式变化，也不会与任何持久化副本冲突。
- `hasBase` 语义未变：四种范围仍是 `true/true/false/false`，且 `grep hasBase` 显示它**没有读者**（只有生产者与 `test/commitLog.integration.test.ts:98` 的断言）——与基线一致，本轮既没削弱也没"顺手用起来"。

### 3. 注入保护没有被削弱（`mainBranch` 与其它消费它的范围）

`mainBranch = "HEAD --output=<目标>"` 经真实 provider：

```
[mainBranch] error= Base branch 'HEAD --output=…\grv18-inj-…txt' not found.
[mainBranch] injected file exists? false
[all]        commits=2  error=undefined   injected file exists? false
[recentN]    commits=2  error=undefined   injected file exists? false
```

**两道防线，我分别单独证过：**

- **第一道（`rev-parse --verify --quiet`）**：对 `--output=…`、`--all`、`--branches`、`--not`、`-n`、`--`、`@{upstream}` 全部 **exit 1**；对 40-hex / tag / 分支名全部 exit 0。带不带标记结论相同（标记加上后仍是这个表）。
- **第二道（`getCommits` 的标记）仍然有效，而且不是摆设**。如果 `rev-parse` 那道被放宽（`sendDetail` 的注释正是在警告这种放宽），范围会退化成单个位置参数 `"--output=<目标>..HEAD"`。裸 Git 对照：

```
没有标记：git log --pretty=%s "--output=/tmp/…/w1..HEAD"   → exit 0，文件被创建，内容 ["one"]
有标记：  git log --pretty=%s --end-of-options "…"          → exit 128，无文件
```

也就是说：**这条路现在是两道独立的闸**，本轮没有把任何一道拆掉。§四.2 会指出这第二道闸**没有对应的用例**（这是测试质量缺口，不是产品缺陷）。

### 4. `sendDetail` 的 P3：A 加了注释，理由成立

`src/ui/rebaseViewProvider.ts:2829-2837` 的新注释，我逐句验证：

```
$ git show -s --pretty=%s <40-hex> --output=/tmp/…/out.txt   → exit 0，文件内容 ["hello subject"]
$ git show -s --pretty=%s --end-of-options <40-hex>          → hello subject，exit 0
$ git show -s --pretty=%s --end-of-options <40-hex> --output=…/out2.txt → exit 128，无文件
```

- 注释第一句（"`git show -s --pretty=%s HEAD --output=<file>` 确实会写那个文件"）**成立**。
- 注释第二句（"安全只因为 `requestDetail ∈ requiresCurrentCommitHash` 且 `isCurrentCommitHash` 限定 40-hex 且在快照内"）**成立**：`webviewProtocolState.ts:53-56` 的集合里确实有 `requestDetail`，`isCurrentCommitHash` 是 `/^[0-9a-f]{40}$/i` + `this.commits.some(...)`。
- 注释第三句（"放宽 gate 就会变成 `getCommits` 那种写入注入"）**成立且被我的探针佐证**。
- `commitDetail`/`fullMessage`/`generated diff` 的 `git show` 仍然传裸 hash、**没有**加标记——所以这个注释不是"补了注释就安全了"的自我安慰，而是如实说明"这一处靠上游校验"。

**唯一的评价**：A 选择"只写注释、不改行为"，而 `--end-of-options` 在这一处**本来是可用的**（上面第二条实测）。我认为不改为好：`git show` 的这几处是全仓唯一的 40-hex 内部路径，加标记会掩盖"这里其实依赖校验"的事实。注释比标记更能防止将来放宽 gate。**这一条我判为已解决。**

### 5. §五站点审计的抽查

我独立抽了三处，结论与 A 一致（细节见 §三.3 的第一道防线、§四.1 的补漏）：

- `commitLog.ts:133`（`HEAD@{upstream}`）：`tipRef` 只会是 `"HEAD"` 或 `rebasingBranch()` 从 `rebase-merge/head-name` 读到的短名；标记加上后合法值仍 exit 0，无 upstream 时 `fatal: no upstream configured` 仍 exit 128（`rev-parse` 会把标记本身印到 stdout，但这里只读 `res.code`，无害）。
- `commitLog.ts:153`（`mainBranch`）：见 §三.3。
- `pushGuard.ts:69`（`for-each-ref` 的 `refs/heads/<branch>`）：标记加上后正常；`[gone]`/`"."` 判定不受影响。

**审计的漏项**：A 的清单里没有 `rev-list`。见 §四.1——那里有两处把**上游 ref**（可能以 `-` 开头）当裸位置参数传，虽然不是设置可达，但**确实**属于同一类，而且其中一处会让"锁定提交不得推送"的守卫失效。

---

## 四、新发现（按严重度）

> 本轮**没有**引入产品行为缺陷。以下四项全部为 P3/P4，且前两项与基线/测试质量有关，不构成发布阻断。

### 四.1（P3，基线即存在；两处）上游 ref 以 `-` 开头时，`rev-list` 未加标记

`src/git/pushGuard.ts:114`：

```ts
const out = await git(["rev-list", `${upstreamRef}..${tip}`], { cwd });
```

`src/ui/rebaseViewProvider.ts:412`：

```ts
const counts = await runGit(["rev-list", "--left-right", "--count", `${upstream.ref}...HEAD`], { cwd: root });
```

`upstreamRef` / `upstream.ref` 来自 `getUpstream`，而它返回的是 Git 自己的 `%(upstream:short)`。远端名**可以**以 `-` 开头（`git remote add -- -evil <url>` 被接受，`git remote` 原样打印 `-evil`——这正是上一轮四.2 我指出、A 已在注释里改正的事实），于是上游 ref 就是 `-evil/master`。

**实测（真实 provider、真实 bare 远端、`git remote add -- -evil`）：**

推送路径（仓库里有锁、锁的 sha 正是未推送的那条）：

```
locks under root: [ '70836dcc…' ]
pushBranch THREW: git rev-list -evil/master..HEAD failed (129): usage: git rev-list [<options>] <commit>... [--] [<path>...]
titles: []           visible messages: []           remote advanced: false
```

刷新路径（同一仓库，无锁）：

```
[-evil] truth(behind ahead)=0 2   provider ahead=0 behind=0 error=undefined upstreamRef=-evil/master
[origin] truth(behind ahead)=0 2  provider ahead=2 behind=0 error=undefined upstreamRef=origin/master
```

**后果**：

1. `pushRange` 抛错，`pushBranchInternal` 在 `lockedInPush` 这一步失败。`extension.ts` 注册处有 `.catch(warnDiagnostic)`，所以**用户看到的是"什么都没有"**——一次点了 Push 之后没有任何反馈，正是上一轮四.3 修掉的那种"静默失败"形状，只是换了触发条件。`remote advanced: false` 说明它至少**没有**在跳过守卫的情况下把锁定提交推出去。
2. 刷新路径把 exit 129 当"算不出来"，`aheadCount=behindCount=0`：侧栏会显示"没有要推的/没有落后的"——这是**显示错误**，不是数据错误。

**为什么判 P3 而不是 P2**：不可由任何设置构造，需要用户手工 `git remote add -- -evil`（porcelain 接受，但这不是常见形状），且失败方向安全（不推、不写、不删）。**为什么仍然要报**：这是上一轮四.2 的另一半——注释把 `-evil` 这件事说清楚了，但只修了 `git push`；同一份"上游名"还被两个 `rev-list` 当裸位置参数用。修法与 `git log` 完全同构：`withPositionals(["rev-list"], [\`${upstreamRef}..${tip}\`])`。

### 四.2（P3，测试质量；本轮新增的用例）`mainBranch` 注入用例钉住的是 `rev-parse` 闸，不是 `getCommits` 的标记

`test/pushIsolation.test.ts:362` 的用例名是 **"a mainBranch of 'HEAD --output=<file>' cannot write that file"**，读起来像是钉住了 `getCommits` 的标记。实测不是：

| 副本里的变异 | 该用例 |
| --- | --- |
| **只**去掉 `getCommits` 的标记（`resolveRange` 的 `rev-parse` 闸保留） | ✅ **仍然通过** |
| **只**去掉 `resolveRange` 的 `rev-parse` 闸（标记保留） | ❌ 变红（错误文本变成 `option '--output=…' must come before non-option arguments`，不匹配 `/not found\|Base branch/i`） |
| 两者都去掉 + 还原基线的空格拆分 | ❌ 变红（`saw undefined`），且**文件真的被写**（`grv-range-hijack-….txt..HEAD`，内容是 commit 记录） |

也就是说：`getCommits` 的那行标记**没有任何用例覆盖**。这在今天不构成漏洞（`rev-parse` 闸是硬闸），但它是"用例名声称的东西 ≠ 它实际钉住的东西"，正是 `0-8-15` 变异 1 与 `0-8-17` 四.1 同一类风险：将来有人为了让某个合法的 `mainBranch` 值通过而放宽 `rev-parse` 闸时，整套用例仍然全绿，而防线只剩注释。

**我验证过一条能钉住它的用例**（副本里红、真实树上绿，两次都实测）：

```ts
test("getCommits does not let an option-shaped positional write a file", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  commitFile(cwd, "a.txt", "a\n", "first");
  const target = path.join(os.tmpdir(), `grv-getcommits-hijack-${Date.now()}.txt`);
  const written = `${target}..HEAD`;
  t.after(() => { try { fs.rmSync(written, { force: true }); } catch {} });
  await getCommits(cwd, { options: [], positionals: [`--output=${target}..HEAD`] }).catch(() => undefined);
  assert.equal(fs.existsSync(written), false, "Git must not have honoured --output=");
});
```

- 去掉标记的副本：`✖ … Git must not have honoured --output=`（并且我另跑一版把 `getCommits` 的返回值直接打印出来，确认它**不是抛错而是"成功"**：`RESOLVED, carried no error; commits: 0`，文件已落盘）。
- 真实树：`✔`，无残留。

建议把它加进 `test/pushIsolation.test.ts`（P3/P4，不阻塞）。

### 四.3（P3，文档）`docs/improvement/improvement.md` 同一文件内自相矛盾

- `docs/improvement/improvement.md:169`（P3-4 四.2 的"剩余边界"）仍写着：**"远端名不以 `-` 开头"**，并据此说该路径"不是设置可达"。
- `docs/improvement/improvement.md:192`（P3-5 四.2）则明确写：**"原注释称'远端名不以 `-` 开头'，实测不成立"**，并给出 `git remote add -- -evil` 的实测。

即上一轮要求改正的那句话，在同一文件里改了一半：新的 P3-5 段落改对了，旧的 P3-4 段落原样留着。`src/git/pushGuard.ts` 的注释已按实测重写（本轮的代码是对的），只有这一处历史条目需要同步。另外它与 §四.1 恰好相关：正因为"远端名可以带 `-`"，两个 `rev-list` 才有问题。

### 四.4（P3，文档）发布说明与测试总结仍在描述已被替换的实现

- `docs/release-notes/0.8.3.md:26` 与 `docs/summary/summary.md:142` 都写：`getUpstream` **"会先 `git rev-parse --verify` 确认它存在"**。
- 该实现已在第四轮被替换：现在是**一次** `git for-each-ref` 取 `%(upstream:track)`，`[gone]` 即判无上游（`RELEASE.md:132` 对此有正确说明，两处文档因此与它不一致）。
- 同一句还写"把 `rev-parse --verify` 的存在性检查去掉后该用例变红"——这个变异今天**不可能**做（没有那个检查了）。实际能杀死该用例的变异是**去掉 `[gone]` 判定**，我实测：`✖ a pruned upstream reports a visible error instead of failing silently`，抛出的正是 `git rev-list origin/master..HEAD failed (128): fatal: ambiguous argument 'origin/master..HEAD': unknown revision`。

这是 `0-8-16` 四.5 的同类（文档描述已删除的实现），但这次落在**面向用户的发布说明**与测试总结里，建议一并改。

---

## 五、计数、文档与打包

- **测试计数**：静态独立枚举（只数行首 `test(`）→ **46 个文件、311 个顶层 test**；`docs/summary/summary.md:150`、`RELEASE.md:136`、`docs/release-notes/0.8.3.md:44` 均为 **311**，一致。（上一轮为 308：`0-8-17` 记录 `pushIsolation` 9 项、`commitLog.integration` 12 项，本轮分别涨到 **11** 与 **13**，合计 +3 = 311，差额对得上——涨的正是本轮新增的 provider 级 `recentN` 用例与"每种范围都真的执行"用例。）
- **账本**：`docs/review/code-review-commit.md` 已有 `code-review-0-8-17.md` 的独立行（SHA 仅为基线，注明"被评审材料为未提交工作树"），未删除任何历史条目。`review-response-*` 尚无 0-8-17 对应的回复文件——按项目约定这属于 A 侧待办，我仅记录，不改账本。
- **VSIX（`dist-vsix/git-rebase-visual-0.8.3.vsix`，156 936 B，01:07 生成，晚于最后一次 `src/`/`media/` 改动 01:03）**：

```
zip entries: 12
[Content_Types].xml / extension.vsixmanifest
extension/readme.md / package.json / LICENSE.txt / .gitignore
extension/media/{style.css,main.js,icon.svg,extension-icon.png}
extension/dist/{seq-editor.js,extension.js}

$ node scripts/package-vsix.js --verify-only
VSIX contents match the allowlist (12 entries).
```

逐字节比对（解压后与工作树比 sha256）：`readme.md→README.md`、`package.json`、`.gitignore`、`LICENSE.txt→LICENSE`、`media/style.css`、`media/main.js`、`media/icon.svg`、`media/extension-icon.png`、`dist/seq-editor.js`、`dist/extension.js` **全部 IDENTICAL**（`LICENSE.txt` 与 `readme.md` 是打包时的改名，源文件对应 `LICENSE` / `README.md`，sha 相同）。

```
包内 extension/dist/extension.js sha256 = 4b0b3d329478cd6d602c0e2cadbaac654339c32b5131c0e4c637bc5e863a534e
现场 node esbuild.js 重建后           = 4b0b3d329478cd6d602c0e2cadbaac654339c32b5131c0e4c637bc5e863a534e
```

包内代码抽查（在 `dist/extension.js` 里直接读到的）：

```js
case "recentN":
  return { revRange: { options: ["-n", String(Math.max(1, cfg.count))], positionals: [tipRef] }, hasBase: false };

async function getCommits(cwd, range) {
  const args = withPositionals(
    ["log", "--date=short", `--pretty=format:${format}`, ...range.options],
    range.positionals
  );

const res = await runGit(
  withPositionals(["rev-parse", "--verify", "--quiet"], [cfg.mainBranch]),
  { cwd }
);
if (res.code !== 0) {
  return { error: `Base branch '${cfg.mainBranch}' not found.` };
}
```

以及 `if (track.trim().replace(/^\[|\]$/g, "") === "gone") return void 0;`（`getUpstream` 的 `[gone]` 判定）。`revRange.split` 计数为 **0**。**结论：VSIX 就是本轮评审的这份代码。**

---

## 六、我没有验证的部分

1. **完整 311 项套件是否全绿**——按约束没有跑（另有一轮在跑）。我用 46 项定向用例 + 两个类型检查 + 独立静态计数替代，**不能等同**。特别是 `test/pendingRecovery*`（4 个文件共 70 项）、`test/recoveryProvider.test.ts`（22 项）与 `test/webviewDom.test.ts`（11 项）本轮一次都没跑，合计 **103 项**未被执行。
2. **非 Git 2.53.0.windows.2 的版本**：`--end-of-options` 在旧版本上的行为（项目声明下限 2.31.0）我没有实测；`%(upstream:remotename)` / `:remoteref` 的可用性同样按文档假设。
3. **非 C locale**：`getUpstream` 的 `[gone]` 判定依赖 `LC_ALL=C`，我只在 C locale 下验证过。若某处漏传 `C_LOCALE`，在中文/日文 locale 下会静默退化成"永远有上游"——这是本轮未覆盖的面。
4. **真实 VS Code GUI / Restricted Mode**：所有 provider 断言都跑在 `vscodeStub` 上，没有真实 webview 消息往返、没有真实 `showQuickPick` 交互。
5. **Linux/macOS**：`tokenize`/路径分隔符/大小写敏感文件系统、以及 `process.kill(-pid)` 的进程组行为未验证；本机全部是 Windows。
6. **真实 Gerrit / 真实远端服务器**：评审推送只对本地 bare 远端验证过。
7. **`package-lock.json` 的 `0.8.2 → 0.8.3` 变更**：我只确认版本号一致，没有审计依赖树。
8. **性能**：本轮没有做任何计时对比（上一轮的 `getUpstream` 单次 spawn 结论沿用，未复测）。
9. **`docs/improvement/improvement.md` 里除 §四.3 之外的历史条目**：我只核对了与本轮相关的那两段，没有逐条重审 P1-1…P3-3 的全部陈述是否仍与代码一致。

---

## 七、给 A 的清单（全部 P3/P4，不阻塞发布）

1. **（建议 0.8.4）** `src/git/pushGuard.ts:114` 的 `rev-list` 与 `src/ui/rebaseViewProvider.ts:412` 的 `rev-list --left-right --count` 改用 `withPositionals`，并补一条"远端名以 `-` 开头时锁定守卫仍生效、ahead/behind 仍正确"的用例（可从 `git remote add -- -evil` 起步，我在 §四.1 给了可复现的最小形状）。
2. **（建议本轮或 0.8.4）** 把 §四.2 里那条 `getCommits` 直接用例加进 `test/pushIsolation.test.ts`——它已经在副本里被判红/判绿，成本约 2 s。
3. **（文档）** `docs/improvement/improvement.md:169` 的"远端名不以 `-` 开头"改为与 `:192` 一致的说法。
4. **（文档）** `docs/release-notes/0.8.3.md:26` 与 `docs/summary/summary.md:142` 里"`getUpstream` 会先 `git rev-parse --verify` 确认它存在"改为 `for-each-ref` + `%(upstream:track)` 的 `[gone]` 判定，并把"去掉 `rev-parse --verify` 后变红"的变异描述改为"去掉 `[gone]` 判定后变红"。

---

## 八、裁决与覆盖范围（重述）

**批准。** 本评审覆盖基线 `577ce87` 之上的未提交工作树，以及由它构建的 **`dist-vsix/git-rebase-visual-0.8.3.vsix`**（12 条目、白名单通过、payload 与工作树逐字节一致、包内 `extension/dist/extension.js` 与现场重建 sha256 相同）。

本轮回答的两个问题（`0-8-17` 四.1、四.2）都已闭合：`recentN` 在真实 provider 上返回正确条数且无错误，修法是类型层面的选项/位置参数分离而不是字符串挪位；`pushRefspec` 的注释按实测改正、行为未变。安全面没有因为这次重构而退化——我逐条走过 `--output=` 经 `mainBranch` 进入 `git log` 的路径，文件均未被写。

新发现 4 项都是 P3/P4，不含 P0/P1/P2，也没有任何一项改变用户可见的正确行为。它们应当被记录并跟进，但不足以把已经修好回归、且没有引入新缺陷的这一版挡在发布之外。
