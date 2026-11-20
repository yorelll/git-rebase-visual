# code-review-0-8-28 — `code-review-0-8-27.md` 的 P4-1/P4-2/P4-4/P4-5 跟进验证

## 一、结论摘要

| 验证项 | 结论 | 关键证据 |
| --- | --- | --- |
| P4-1 `stash <option> store` 被识别为拒绝子命令，`stash apply --index` 不受影响 | 通过。生产 `subcommandOf` 对 `stash --quiet store`、`stash -m store store`、`stash -- store` 均返回 `stash store` 并让 `withPositionals` 抛错；`stash apply --index` 返回 `stash apply` 并正常生成 argv | 见 4.1 |
| P4-1 不误伤“选项值恰好等于 `store`”的合法形状 | 通过。`stash -m store push`、`stash --message store push`、`stash --message=store push`、`stash -m store` 都不被误判为 `stash store`；`-m`/`--message` 的独立值被跳过 | 见 4.1 |
| P4-1 现有 stash 调用不被运行时拒绝 | 通过。13 处 `stash ...` 调用全部是直接 `runGit([...])`，不经过 `withPositionals`；14 处 `withPositionals` 中没有一处以 `stash` 为子命令，静态扫描也全部通过 | 见 4.1 |
| P4-2 静态守卫扫描 `git([...])`，带标记的 `checkout` 会报红 | 通过。在 `%TEMP%` 副本中注入 `git(["checkout", END_OF_OPTIONS, "--", path])` 后守卫用例失败并点名 `src/__probe__.ts:4 checkout`（退出码 1）；删除后恢复 3/3 绿；同一 callee 不带标记仍绿 | 见 4.2 |
| P4-2 残余边界陈述（别名、变量 argv、spread）准确 | 基本准确，但注释中把变量 argv 的示例写成不存在的 `pushGit`。`src/` 无导入别名，所有带标记的 argv 都始于被扫描的数组字面量；真实缺口仍是变量 argv/spread，陈述方向正确 | 见 4.2、5.2 |
| P4-4 多根工作区选第一个真实仓库 | 通过。真实目录（第一个非仓库、第二个仓库）实测：跳过第一个，第二个执行 4 条标记检查，`ok=true`，日志点名被跳过的根 | 见 4.3 |
| P4-4 无仓库时只查版本并说明 | 通过。两个候选都不是仓库时只发 2 次只读 `rev-parse`，不做标记检查，日志包含两个被跳过的根 | 见 4.3 |
| P4-4 不会无限挂起 | 通过（有界）。仓库探测走 `runGit` 默认 120 s 超时，逐候选串行，且探测是 fire-and-forget；不会阻塞激活，也不会无限挂起。最坏延迟可能较长，列为观察项 | 见 4.3、5.3 |
| P4-5 `git --version` 读取失败与“未找到 Git”分开 | 通过。ENOENT → `git-not-found`（提示安装 Git）；EACCES → `version-read-failed`；返回 undefined → `version-read-failed`。后两者文案不再让用户安装 Git，改为检查 PATH/包装脚本/权限 | 见 4.4 |
| 四项修复无回归：checkout 站点仍无标记；探测只从 `activate()` 调用一次；成功通知文本不变 | 通过。`worktree.ts:331` 仍为 `["checkout", \`${sha}^3\`, "--", path]`；`activationProbe` 只在 `extension.ts` 接线并 `void run()` 一次；成功文案精确为 `Git Rebase Visual <version> 已启用` | 见 4.5 |
| 测试计数与文档一致 | 通过（静态计数）。52 个 `test/*.test.ts`、355 个顶层 `test(`；四处文档均为 355/52。完整套件的 pass 数不是本次评审执行的 | 见 4.6 |
| 根目录无杂散文件；VSIX 12 条目、白名单通过、包内产物等于现场 esbuild | 通过。根目录无 `.log/.tmp/.bak`；`--verify-only` 报 12 条目；包内 `extension.js` sha256 = `031c0471…4b5351`，与现场 `node esbuild.js` 产物一致 | 见 4.6 |
| 0-8-27 台账行已更新且不臆造 SHA | 通过。行内明确“无 commit SHA，本行不写臆造 SHA”，记录了 P4-1/2/4/5 跟进与 P4-3 保留 | 见 4.6 |

**裁决：四项 P4 均已按报告修好，没有发现回归，没有 P0/P1/P2/P3 阻塞项，可以提交。** 作为 **0.8.6** 补丁发布前仍需一步：`package.json` 仍是 `0.8.5`，必须先升到 `0.8.6` 并重建 VSIX；当前工作树本身不是可发布的 0.8.6 产物（与上一轮结论相同）。

## 二、基线与被评审内容

- 仓库：`D:\work\tools\git plugin`，分支 `main`。
- 基线：`4e51d98`（`4e51d98657760811d8905cc0d0891f2117dc669a`，`build: run CI on Node 24 to match local development`）。`git rev-list --count 4e51d98..HEAD` 为 `0`，基线之后没有新提交。
- 被评审内容：基线之上的未提交工作树。本轮重点只验证上一份报告 `code-review-0-8-27.md` 第五节中 Agent A 声称已修的 P4-1、P4-2、P4-4、P4-5，以及四项修复是否引入回归；P4-3（`gitVersionSync()` 约 0.3–0.4 s 的激活同步开销）按任务要求保留为已记录的取舍，本轮不改，也不作为缺陷重开。
- `package.json` 版本仍为 `0.8.5`；本轮未改版本号、未提交、未打 tag、未推送。
- 评审方式：只读。未修改 `src/`、`test/`、`media/`、`docs/` 下任何既有文件，唯一写入是本报告；未执行 `git add`、`commit`、`tag`、`push`；未编辑台账。
- 机器：Windows 11；Node `v24.16.0`；本机 Git `2.53.0.windows.2`。**没有在 Git 2.31–2.34 上运行代码。**

## 三、我实际跑了什么

在 `D:\work\tools\git plugin` 下（Node 为 `/d/Program Files/nodejs/node`）：

```text
node node_modules/typescript/bin/tsc --noEmit
  -> 退出码 0，无输出
node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit
  -> 退出码 0，无输出

node node_modules/tsx/dist/cli.mjs --test --test-concurrency=3 \
  test/endOfOptionsGuard.test.ts test/capabilityProbe.test.ts
  -> tests 18, pass 18, fail 0, skipped 0, duration_ms 4112.47

node node_modules/tsx/dist/cli.mjs --test \
  --test-name-pattern "without --end-of-options" test/worktree.integration.test.ts
  -> tests 1, pass 1, fail 0（checkout argv 精确为 ["checkout","<sha>^3","--","restored.txt"]）

node scripts/package-vsix.js --verify-only
  -> VSIX contents match the allowlist (12 entries).

unzip -l dist-vsix/git-rebase-visual-0.8.5.vsix
  -> 12 files

node esbuild.js
  -> 无输出；dist/extension.js sha256 前后均为 031c0471…4b5351
unzip -p dist-vsix/git-rebase-visual-0.8.5.vsix extension/dist/extension.js | sha256sum
  -> 031c0471…4b5351（与现场 esbuild 产物一致）
```

计数与环境核对：

```text
ls test/*.test.ts | wc -l                    -> 52
grep -rhoE '^test\(' test/*.test.ts | wc -l  -> 355
node -e "console.log(require('./package.json').version)"  -> 0.8.5
git rev-list --count 4e51d98..HEAD           -> 0
```

**完整套件不是本次评审启动的。** 按任务约束没有启动第二个全量运行；上表的 18 + 1 条只覆盖本轮关键文件。文档中的 355/52 与我的静态计数一致，但 pass 355 这一现场结果不是由我复现的。

另外在 `%TEMP%` 中做了三组独立实验（已全部清理）：生产 `subcommandOf`/`withPositionals` 的形状探测、静态守卫注入/恢复、真实多根目录探测与 `git --version` 分支验证。

## 四、逐项验证

### 4.1 P4-1：`stash` 嵌套子命令

生产代码 `stashSubcommandOf`/`subcommandOf` 会先跳过 `stash` 自己的选项（`-m`/`--message` 的独立值、`--` 之前以 `-` 开头的项），再取嵌套子命令。用生产函数实测（`%TEMP%` 脚本，输出为原始结果）：

| 形状 | `subcommandOf` | `withPositionals` | 判定 |
| --- | --- | --- | --- |
| `["stash","--quiet","store","-m","msg","sha"]` | `stash store` | THROW | 正确拒绝（任务点名的形状） |
| `["stash","store"]` / `["stash","store","-m","m","sha"]` | `stash store` | THROW | 正确拒绝 |
| `["stash","-m","store","store"]` | `stash store` | THROW | 正确拒绝（`-m` 值是 `store`，真正子命令仍是 `store`） |
| `["stash","-m","store","push"]` | `stash push` | OK | 不误判：`store` 是 message 值 |
| `["stash","--message","store","push"]` | `stash push` | OK | 不误判 |
| `["stash","--message=store","push"]` | `stash push` | OK | 不误判（单 token 选项） |
| `["stash","-m","store"]` | `stash` | OK | 不误判：合法隐式 push，`store` 是 message |
| `["stash"]` / `["stash","--quiet"]` | `stash` | OK | 无嵌套子命令，不拒绝 |
| `["stash","--quiet","apply"]` / `["stash","apply","--index"]` | `stash apply` | OK | 正确不拒绝（`--index` 属于 apply） |
| `["stash","--","store"]` | `stash store` | THROW | 正确（`--` 之后 `store` 是子命令） |
| `["-c","x=y","stash","--quiet","store"]` | `stash store` | THROW | 全局选项的独立值未遮蔽子命令 |

没有找到能让**真实的 `stash store`** 逃过识别（返回 `stash`）的形状：唯一带独立值且能出现在 `store` 之前的选项是 `-m`/`--message`，已在跳过集合；`-q`/`--quiet` 等无值选项按 `-` 前缀跳过。反向的“误伤”只会发生在 `--pathspec-from-file store push` 这类 Git 本身不接受的形状上（见 5.1 的实测），当前 `src/` 没有这种调用。

现有调用面：`grep` 到的 13 处 `stash` 调用全部是直接 `runGit([...])`（`list`/`push`/`apply`/`drop`/`pop`/`store`），不经过 `withPositionals`；14 处 `withPositionals` 的子命令为 `rev-parse`/`log`/`merge-base`/`rev-list`/`rebase`/`show`/`for-each-ref`（以及 `pushRefspec` 的空数组），没有 `stash`。静态守卫“no source file passes…”本轮通过，因此**没有现有调用被这次收紧拒绝**。

### 4.2 P4-2：静态守卫纳入 `git`

在 `%TEMP%` 副本（`src`/`test` 拷贝 + `node_modules` 符号链接）中做了三步，未触碰工作树：

1. 基线：`test/endOfOptionsGuard.test.ts` → 3/3 绿。
2. 注入 `src/__probe__.ts`：

   ```ts
   import { END_OF_OPTIONS, git } from "./git/gitRunner";
   export async function probe(cwd: string, path: string): Promise<void> {
     await git(["checkout", END_OF_OPTIONS, "--", path], { cwd });
   }
   ```

   守卫用例失败，退出码 1，报告：

   ```text
   withPositionals/runGit/git must not put --end-of-options after a denied subcommand:
   …\src\__probe__.ts:4 checkout
   actual: [ { command: 'checkout', file: '…\src\__probe__.ts', line: 4 } ]
   expected: []
   ```

3. 删除该文件 → 3/3 绿；再把同一 `git(["checkout", `${path}^3`, "--", path])`（**不带**标记）放进去 → 3/3 绿，证明守卫只拒绝“标记 + 拒绝子命令”，不误伤受支持的 `checkout` 形状。

残余边界的准确性：

- **导入别名**：`src/` 中没有任何 `withPositionals`/`runGit`/`git` 的 `import … as …` 别名（grep 无命中）。陈述准确。
- **变量 argv**：准确。`runGit(args)` 的变量形态确实不被静态扫描；`pushGuard.pushRefspec` 的 `withPositionals([], [up.remote, refspec])` 调用本身会被扫描，但它以空 options 调用，无法据此判断外层 `push` 之后的子命令。这是真实缺口，陈述方向正确。
  - **但示例写错了对象**：注释说“`pushGuard.pushRefspec` builds an array that `pushGit` passes as a variable”，而仓库里**不存在 `pushGit`**；`pushRefspec` 直接 `runGit(args, …)`。列为 5.2 的 P4 文案项，不影响守卫行为。
- **spread / 计算数组**：准确。`getCommits` 的 `["log", …, ...range.options]` 中 spread 部分不会被 `subcommandOf` 看到；当前子命令是字面量 `log`，所以没有真实漏报。
- “today `src/` has no alias, and every marker-using argv starts in a scanned array literal”：复核成立。`grep END_OF_OPTIONS src/` 除 `gitRunner.ts` 外**没有任何命中**，即当前所有标记都来自 `withPositionals`，而 14 处调用的首参都是数组字面量。

### 4.3 P4-4：多根工作区

源码接线：`extension.ts` 传入 `vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath)`；`capabilityProbe` 先按顺序对每个候选执行一次只读 `rev-parse --show-toplevel`，停在第一个成功者，再在该 cwd 执行 4 条标记检查。

真实目录实验（`%TEMP%` 下建 `nonrepo/` 与 `repo/`，`repo` 为真实 Git 仓库）：

```text
cwd=[nonrepo, repo]
-> ok=true, problem=undefined, gitVersion=2.53.0
-> repository: pass — Git repository: …/repo (skipped …/nonrepo: fatal: not a git repository …)
-> 4 条标记检查的 cwd 全部为 …/repo
```

即第一个根不是仓库时不会跳过标记检查，第二个根被真正探测。无仓库场景（两个候选都非仓库）只执行 2 次只读 `rev-parse`、不做标记检查、返回 `ok=true`，日志含两个被跳过的根；单元测试“multi-root with no repository runs only the version check”本轮通过。

**挂起评估**：仓库探测使用 `runGit` 的默认超时（`DEFAULT_TIMEOUT = 120_000` ms），逐候选串行，单次探测失败/超时后继续下一个；整个 `activationProbe.run()` 是 `void` 调用，`activate()` 不 await。因此：

- 不会阻塞扩展激活；
- 不会无限挂起（每次 spawn 都受 120 s 超时与 kill 结算约束）；
- 但多根 + 多个慢/断网路径时，探测 promise 最长可达“候选数 × 120 s”，可能持续数分钟。列为观察项（5.3），不是阻塞项。

### 4.4 P4-5：版本读取失败与“未找到 Git”

`ProbeProblem` 新增 `version-read-failed`；`isMissingGitError` 只在错误的 `code === "ENOENT"` 时判为缺失二进制。用生产 `createActivationProbe` 实测：

| `readVersion` 行为 | `problem` | 告警文案 | 标记检查调用数 |
| --- | --- | --- | --- |
| 抛出 `code:"ENOENT"` | `git-not-found` | `…但未找到 Git；请安装 Git 2.31.0+ 或查看日志。` | 0 |
| 抛出 `EACCES: permission denied` | `version-read-failed` | `…无法读取 Git 版本（git --version 未能运行或未返回版本）；请确认 PATH 中的 git 可执行文件（可能是包装脚本）与权限…` | 0 |
| 返回 `undefined` | `version-read-failed` | 同上 | 0 |

后两条文案都不含“未找到 Git”“安装 Git”，符合“Git 存在但 `git --version` 失败时不要把用户指去安装 Git”的要求。三条分支各有一条持久测试（`capabilityProbe.test.ts`），本轮 18/18 通过。

### 4.5 四项修复无回归

- **checkout 站点**：`grep '"checkout"' src/` 仍只有 `src/git/worktree.ts:331`，形状为 `["checkout", \`${sha}^3\`, "--", path]`，**不含** `END_OF_OPTIONS`；`worktree.integration.test.ts` 的 argv 精确断言用例本轮通过。
- **探测调用面**：`grep` 显示 `createActivationProbe`/`activationProbe` 只出现在 `src/extension.ts`（import、构造、`void activationProbe.run()` 各一次）；`rebaseViewProvider`、消息处理、`refresh()` 无引用。“runs once per activation”“message handling and refresh cannot trigger”两条测试本轮通过。
- **成功通知**：源码仍为 `options.notifyInfo(`Git Rebase Visual ${options.extensionVersion} 已启用`)`；测试精确断言文本并断言不含 `probe|探测|自检|capabilit`，本轮通过。
- 四项修复只涉及 `gitRunner.ts` 的子命令解析、`capabilityProbe.ts` 的候选/版本分支、`extension.ts` 的 cwd 传参和新测试；`checkout` 调用、标记站点与成功通知均未改动。

### 4.6 计数、文档、根目录、VSIX、台账

- **测试计数**：`test/*.test.ts` 52 个、顶层 `test(` 355 个；`RELEASE.md:128,144`、`docs/summary/summary.md:153`、`docs/release-notes/0.8.3.md:44`、`docs/improvement/improvement.md:408` 均为 355/52（Git Bash 下 pass 355 / skip 0；无 `sh` 时 354 pass / 1 skip）。静态计数一致；完整套件运行不是本次评审执行的。
- **根目录**：`git status` 的未跟踪项只有上一轮的三个新文件（`code-review-0-8-27.md` 及其余源码/测试）和本报告；根目录没有 `.log/.tmp/.bak`。
- **VSIX**：`--verify-only` 报 12 个条目；`unzip -l` 也是 12 个文件；包内 `extension/dist/extension.js` 的 sha256 为 `031c0471bfb7f5aee1166e44fbb766f52ac7e6fa69a745da9f1611f71a4b5351`，与现场重新执行 `node esbuild.js` 的产物逐字节一致。`.vscodeignore` 含 `.nvmrc`、`*.log`、`dist-vsix`、`*.vsix`。
- **台账**：`docs/review/code-review-commit.md` 中 `code-review-0-8-27.md` 行已更新为“已评审，批准；P4-1/P4-2/P4-4/P4-5 已跟进，P4-3 保留为 open follow-up”，并在备注中明确“无 commit SHA，本行不写臆造 SHA”。没有伪造的 40-hex。

## 五、新发现（按严重度）

### 5.1 P4（注释事实错误，不阻塞）——`stashSubcommandOf` 的 JSDoc 声称 Git 接受“子命令前的 stash 选项”

注释写：

```text
`git stash` accepts its own options *before* its subcommand (`git stash
--quiet store`, `git stash -m <message> push`).
```

在本机 Git `2.53.0.windows.2` 实测，这两个形状都被拒绝：

```text
git stash --quiet store <sha>
  -> fatal: subcommand wasn't specified; 'push' can't be assumed due to unexpected token 'store'
git stash -m msg2 push
  -> fatal: subcommand wasn't specified; 'push' can't be assumed due to unexpected token 'push'
git stash --quiet push        -> 同样 fatal
```

而 `git stash --quiet`（无子命令）与 `git stash -m store`（隐式 push）是合法的。也就是说：**真正的价值在于“不要把 `-m` 的值当子命令”**（这部分注释与实现都正确），而“选项在子命令之前”并不是 Git 实际接受的语法。

这不影响修复效果：守卫对 `stash --quiet store` 采取**保守拒绝**，即使 Git 本身会拒绝该形状，拒绝也无害；`stash apply --index` 等合法形状不受影响。建议把 JSDoc 改为“即使 Git 当前拒绝这种选项顺序，也保守识别，避免将来 Git 接受它或调用方拼出 `stash store` 时漏过”，避免下一位维护者按错误前提推导。**未在 2.34 上实测**，但该报错来自 Git 的子命令判定逻辑，与 `--end-of-options` 兼容性无关。

### 5.2 P4（注释示例指向不存在的符号，不阻塞）——静态守卫的残余边界示例写成 `pushGit`

`test/endOfOptionsGuard.test.ts` 的覆盖边界注释说 `pushGuard.pushRefspec` 构造的数组由 `pushGit` 以变量形式传入，但仓库中**没有 `pushGit`**：`pushRefspec` 自己调用 `runGit(args, …)`。说明的**实质**（变量 argv 不在静态扫描内）是准确的，只是示例函数名错误，容易让下一位维护者去找一个不存在的入口。建议把 `pushGit` 改成 `runGit`。

### 5.3 观察（不阻塞）——多根探测的最坏延迟可达“候选数 × 120 s”

探测是 fire-and-forget，`activate()` 不 await，也不会无限挂起；但仓库探测没有传更短的 `timeout`，使用 `runGit` 默认 120 s，并逐候选串行。多根工作区里若前几个根位于很慢或已断开的网络路径，探测 promise 可能持续数分钟（期间不影响扩展使用，只是成功/告警通知会晚到）。若想缩短诊断反馈时间，可给 `rev-parse --show-toplevel` 探测传一个更短的专用超时；这不是本轮修复引入的回归，也没有阻塞面。

### 5.4 观察（不阻塞）——非法的第一个根 + 未播种版本缓存时，spawn ENOENT 仍会归为 `git-not-found`

`readVersion` 用 `candidates[0] ?? process.cwd()`。若第一个根路径不存在/不可达且 `git --version` 的缓存尚未播种（`gitVersionSync()` 失败），`runGit` 的 spawn 会以 `code:"ENOENT"` 拒绝，从而被判为 `git-not-found`。正常激活路径下 `gitVersionSync()` 已先播种缓存，`gitVersion` 直接返回缓存、不会 spawn，因此这条不可达；仅作为 P4-5 判据的边界记录，不建议本轮为它加代码。

## 六、我没有验证的部分

1. **没有在 Git 2.31–2.34 上运行任何代码。** 本机是 2.53；`checkout`/`stash` 的新旧行为结论来自静态事实与本机实测，2.34 上的具体报错仍只有用户日志这一现场证据。
2. **没有启动全量测试套件。** 只跑了 `endOfOptionsGuard` + `capabilityProbe`（18 条）和 `worktree.integration` 的 checkout 用例（1 条）；文档的 355/52、pass 355 是静态计数与文档一致性核对，不是本次执行结果。
3. **没有在真实 VS Code 扩展宿主中观察激活通知。** 探测行为由单元测试与源码接线验证；没有手工触发一次真实多根激活来看弹窗次数与延迟。
4. **没有真实构造“慢/断网路径”的仓库根。** 4.3 的挂起结论来自 `runGit` 的默认超时与 fire-and-forget 接线，不是端到端复现。
5. **没有在 2.34 上复核 `stash` 的选项顺序。** 5.1 的实测只在 2.53 上完成。
6. **没有验证 0.8.6 VSIX**（它还不存在）：当前 `package.json` 是 0.8.5，包也是 0.8.5。

## 七、裁决与覆盖范围

- **可以提交。** 四项 P4 的行为都按报告落实：`stash <option> store` 被识别为拒绝子命令且不误伤 `stash apply --index` 与“选项值等于 `store`”的合法形状；静态守卫能对 `git(["checkout", …marker…])` 报红并能恢复绿；多根探测会跳过非仓库根、在真实仓库执行标记检查，且不会阻塞激活或无限挂起；版本读取失败与缺失 Git 分成两个 `problem`，文案不再误导用户安装 Git。四项修复没有回归：checkout 站点仍无标记，探测仍只在激活时运行一次，成功通知文本不变。
- **没有 P0/P1/P2/P3 阻塞项。** 两项新发现均为 P4（一处注释前提与本机 Git 实测不符、一处注释示例函数名不存在），另有两项有界/边界观察；它们都不改变本轮修复的效果，可在提交后跟进。
- **作为 0.8.6 补丁发布前仍需：** 把 `package.json` 从 `0.8.5` 升到 `0.8.6`，重建并重新校验 VSIX（当前包内产物哈希虽与现场构建一致，但版本元数据仍是 0.8.5）。
- 覆盖范围：基线 `4e51d98` 之上未提交工作树的四项 P4 跟进与相关回归面，不是对 0.8.5→0.8.6 全部改动的重新评审。本报告评审的是工作树；提交后应由台账记录真实 SHA，并按项目约定在下一轮独立评审中覆盖该提交。我没有编辑台账。
