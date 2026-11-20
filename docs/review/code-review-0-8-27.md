# code-review-0-8-27 — Git 2.31–2.34 checkout 回归修复与激活 Git 能力探测

## 一、结论摘要

| 验证项 | 结论 | 关键证据 |
| --- | --- | --- |
| `restoreUntrackedHalf` 不再对 `git checkout` 使用 `--end-of-options` | 通过。全仓库唯一的 `checkout` 调用已去掉标记，注释写明了真实安全论证 | `src/git/worktree.ts:331`；全 `src/` 仅此一处 `"checkout"` |
| `sha` 与 `path` 均不可能变成选项 | 通过。`sha` 只能来自 `git stash list --format=%H` 的完整 40-hex 条目，恢复入口按精确成员匹配；`path` 位于 `--` 之后 | `worktree.ts:64-71, 86-108, 195-203, 389-407` |
| `END_OF_OPTIONS_DENIED_SUBCOMMANDS` 覆盖 `checkout` / `stash store`，`withPositionals` 命中即抛错 | 通过。运行时对两种子命令以及 `-c protocol.version=2 checkout` 均抛错 | `src/git/gitRunner.ts:126-134, 157-176, 201-207` |
| 尝试用全局选项、子命令后置、多行形状击穿探测器 | 未击穿任何现有代码实际产生的形状。发现一个当前不可达的 `stash <option> store` 形状缺口，列为 P4-1，不阻塞 | 见 4.2 的实测表 |
| 静态守卫扫描全部 `src/**/*.ts`，非空转 | 通过。临时注入跨行 `checkout` 与直接带标记的 `stash store` 后，守卫报红并点名两处；删除后恢复绿 | `test/endOfOptionsGuard.test.ts`；见 4.3 |
| 其余标记站点：保留的必须有 2.31+ 证据，去掉的必须证明 positional 不是选项 | 通过。去掉的站点均为内部 40-hex、`refs/...`、`stash@{n}`、`:path`、`HEAD:path` 或 `--` 之后的路径；保留的站点是用户/设置可达且用户 2.34.1 日志证明这些子命令接受标记 | 见 4.4 |
| 激活探测每次激活只跑一次，fire-and-forget，不抛错、不阻塞 | 通过。`createActivationProbe` 缓存同一个 promise，仅 `src/extension.ts` 调用，消息处理与 `refresh()` 无引用 | `src/git/capabilityProbe.ts:206-266`；`src/extension.ts:134-151` |
| 成功通知恰好一条、无探测/自检措辞；低于最低版本/缺失 Git/标记被拒均只告警 | 通过。测试逐条钉住精确 argv、`LC_ALL=C`、通知文本与告警分支 | `test/capabilityProbe.test.ts` 10 条 |
| 普通非零退出不被误判为能力失败 | 通过。只有匹配“标记被拒绝”文本才算失败，空仓库 unborn HEAD 归为普通失败 | `capabilityProbe.ts:116-168` |
| Git 版本可观测 | 通过。会话日志头 `git=...`；OutputChannel 第一行 `git ...` | `extension.ts:26-30`；`rebaseViewProvider.ts:207` |
| 测试计数与文档一致 | 通过。52 个测试文件、350 个顶层 `test(`；文档四处均为 350 / 52、349 pass / 1 skip | 见 4.8 |
| VSIX 12 个条目、白名单通过、包内产物与现场构建一致 | 通过。`--verify-only` 报 12 个条目；包内 `extension/dist/extension.js` 的 sha256 与工作区 `dist/extension.js` 相同 | 见 4.8 |
| 评审台账行存在且没有臆造 SHA | 通过。行内明确写“无 commit SHA”，基线为 `4e51d98` | `docs/review/code-review-commit.md:11` |

**裁决：没有 P0/P1/P2/P3 阻塞项，可以提交。** 作为 0.8.6 补丁发布还差一步：`package.json` 仍是 0.8.5，需要先升版本号并重建 VSIX；当前工作树本身不是可发布产物。P4 项见第五节，均可在提交后跟进。

## 二、基线与被评审内容

- 仓库：`D:\work\tools\git plugin`，分支 `main`。
- 基线：`4e51d98`（`4e51d98657760811d8905cc0d0891f2117dc669a`，`build: run CI on Node 24 to match local development`）。`git rev-list --count 4e51d98..HEAD` 为 `0`，即基线之后没有新提交。
- 被评审内容：基线之上的未提交工作树，共 15 个已修改文件、3 个新增文件：
  - 修改：`.vscodeignore`、`RELEASE.md`、`docs/improvement/improvement.md`、`docs/release-notes/0.8.3.md`、`docs/review/code-review-commit.md`、`docs/summary/summary.md`、`src/extension.ts`、`src/git/commitLog.ts`、`src/git/gitRunner.ts`、`src/git/pendingRecovery.ts`、`src/git/undo.ts`、`src/git/worktree.ts`、`src/llm/messageGen.ts`、`src/ui/rebaseViewProvider.ts`、`test/worktree.integration.test.ts`。
  - 新增：`src/git/capabilityProbe.ts`、`test/capabilityProbe.test.ts`、`test/endOfOptionsGuard.test.ts`。
- `package.json` 版本仍为 `0.8.5`；本轮未改版本号、未提交、未打 tag、未推送，与 `docs/improvement/improvement.md` P3-15 的声明一致。
- 评审方式：只读。未修改 `src/`、`test/`、`media/`、`docs/` 下任何既有文件，唯一写入是本报告；未执行 `git add`、`commit`、`tag`、`push`，未编辑台账。
- 机器：Windows 11；Node `v24.16.0`；本机 Git `2.53.0.windows.2`。**无法安装 Git 2.31/2.34，本报告没有在任何 2.34 环境上运行过代码。**

## 三、我实际跑了什么

在 `D:\work\tools\git plugin` 下，直接以 Node 调用（不使用 `npm run`，本机 shell 的 `node` 解析不稳定）：

```text
node node_modules/typescript/bin/tsc --noEmit
  -> 退出码 0，无输出

node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit
  -> 退出码 0，无输出

node node_modules/tsx/dist/cli.mjs --test --test-concurrency=3 \
  test/endOfOptionsGuard.test.ts test/capabilityProbe.test.ts test/worktree.integration.test.ts
  -> tests 22, pass 22, fail 0, skipped 0, duration_ms 66083.5406
```

计数与环境核对：

```text
ls test/*.test.ts | wc -l        -> 52
grep -rhoE '^test\(' test/*.test.ts | wc -l  -> 350
node -e "console.log(require('./package.json').version)"  -> 0.8.5
git rev-list --count 4e51d98..HEAD  -> 0
```

**完整套件不是本次评审启动的。** 机器上可能存在另一进程正在跑全量套件，按任务约束我没有启动第二个全量运行；上表的 22 条只覆盖本轮三个关键测试文件。文档中的 350 / 52、pass 349 / skip 1 我通过文件数与顶层 `test(` 数核对一致，但没有由我执行复现。

VSIX 核对（只读）：

```text
node scripts/package-vsix.js --verify-only
  -> VSIX contents match the allowlist (12 entries).

unzip -l dist-vsix/git-rebase-visual-0.8.5.vsix
  -> 12 files（manifest、Content_Types、readme、package.json、LICENSE、.gitignore、style.css、main.js、icon.svg、extension-icon.png、seq-editor.js、extension.js）

unzip -p dist-vsix/git-rebase-visual-0.8.5.vsix extension/dist/extension.js | sha256sum
  -> c525fa8ac30e41ec5ee4f2a9799464674ffaacf8ce863f725a7c7bb34519ebdb
sha256sum dist/extension.js
  -> c525fa8ac30e41ec5ee4f2a9799464674ffaacf8ce863f725a7c7bb34519ebdb
```

本轮没有重新执行 `node esbuild.js`（该命令会改写工作区 `dist/`）。包内产物与工作区现有 `dist/extension.js` 逐字节相同；文档所称“与现场重新执行 esbuild 的产物相同”来自本轮前段的执行记录，本次只复核了哈希一致性。

工作树清洁度：仓库根目录没有 `.log` / `.tmp` / `.bak` 残留，`git status` 的未跟踪项只有本轮三个新源码/测试文件。

## 四、逐项验证

### 4.1 checkout 站点

全仓库搜索 `"checkout"`，只有一处：

```text
src/git/worktree.ts:331
      ["checkout", `${sha}^3`, "--", path],
```

`restoreUntrackedHalf` 内其余 Git 调用及安全性：

- `["cat-file", "-e", `${sha}^3`]`：`sha` 为完整 40-hex，`^3` 后缀不改变首字符；不可能以 `-` 开头。
- `["ls-tree", "-r", "-z", "--name-only", `${sha}^3`]`：同上。
- `pathInIndex` 的 `cat-file -e :${path}`：字符串以 `:` 固定开头。
- `pathInTree(cwd, "HEAD", path)` 的 `cat-file -e HEAD:${path}`：字符串以 `HEAD:` 固定开头。
- `["reset", "-q", "--", path]`：`path` 位于 `--` 之后。

`sha` 的来源链：

1. `stash()` 通过比较 push 前后两次 `git stash list --format=%H` 的集合，只把“恰好新增的一个完整 40-hex”作为结果返回（`createdStash`，`worktree.ts:64-71, 86-108`）。
2. 所有恢复入口先经过 `stashIndexBySha`：只有 `read.shas.indexOf(sha) >= 0` 才返回 `{state:"at"}`，即 `sha` 必须与 `git stash list` 的某一条目逐字符相等（`worktree.ts:195-203`）。
3. `stashRestoreForAmend` 在列表不可读或条目不存在时直接拒绝，不会带着未验证的 `sha` 进入 `restoreUntrackedHalf`（`worktree.ts:389-407`）。

`path` 来自 `git ls-tree -r -z --name-only <sha>^3` 的 NUL 分隔输出，随后位于 `--` 之后，并配合 `LITERAL_PATHSPECS`，只能是 pathspec。设置、webview 输入、分支名都到不了这个 argv。

集成测试“restoreUntrackedHalf checks out `<stash>^3` without --end-of-options”在本轮 22 条目标测试中通过；该用例用 `setGitInvocationObserver` 精确断言 argv 为 `["checkout", "<sha>^3", "--", path]` 且不含标记，并验证文件确实被恢复。这比只看返回值更能防止标记被重新加回。

### 4.2 可执行约束与探测器击穿尝试

`END_OF_OPTIONS_DENIED_SUBCOMMANDS` 含两项：

```ts
checkout:    '... Put paths after a "--" separator instead.'
"stash store": '... Validate the commit as a full 40-hex sha instead.'
```

`subcommandOf` 会跳过带独立值的全局选项（`-c`、`-C`、`--git-dir`、`--work-tree`、`--namespace`、`--exec-path`、`--config-env`），再取子命令；`stash` 只把紧随其后的 `store` 识别为两词形式。`withPositionals` 在命中拒绝表时抛错，不再生成会到用户机器上才失败的 argv。

我用生产代码 `subcommandOf` / `withPositionals` 实测了以下形状：

```text
["checkout","abc^3","--end-of-options","x"]                  => "checkout"      -> THROW
["-c","protocol.version=2","checkout","abc^3","x"]            => "checkout"      -> THROW
["--git-dir","x","checkout","abc^3","x"]                      => "checkout"      -> THROW
["stash","store","-m","msg","sha"]                            => "stash store"   -> THROW
["-c","a=b","stash","store","sha"]                            => "stash store"   -> THROW
["--end-of-options","checkout","abc^3","x"]                   => "checkout"      -> THROW
["stash","--quiet","store","-m","msg","sha"]                  => "stash"         -> NO-THROW（缺口）
["stash","-m","msg","store","sha"]                            => "stash"         -> NO-THROW（缺口）
```

结论：

- 任务点名的 `-c protocol.version=2 checkout`、`--git-dir x checkout`、多行写法、以及 `withPositionals` 实际产生的所有形状都没有击穿运行时约束。
- 唯一缺口是 `stash` 与 `store` 之间插入 stash 选项的形状。当前 `src/` 中不存在这种调用：`stash` 只有 `list` / `push` / `apply` / `drop` / `pop` / `store`，其中 `store` 的唯一调用点是 `worktree.ts:928`，形状为 `["stash","store","-m",...,dropped]`，不含中间选项；`worktree.ts:64` 是 `stash push`，不是 store。因此**没有现有调用会穿透**。按任务标准这不构成阻塞，但作为守卫覆盖面问题列为 P4-1。

补充：`subcommandOf([])` 返回 `""`，这是 `pushGuard.pushRefspec` 故意传入的形状（`push` 已在前面的 argv 中），不会被误判为拒绝子命令，也没有放宽任何真实 `checkout` 路径。

### 4.3 静态守卫的非空转证明

`test/endOfOptionsGuard.test.ts` 用 TypeScript AST 扫描 `src/**/*.ts`，不是 grep：

- 识别 `withPositionals(...)` 的数组字面量首参；
- 识别直接 `runGit([...])` 且数组中出现 `END_OF_OPTIONS` 的调用；
- 使用生产 `subcommandOf`，因此 `-c protocol.version=2 checkout` 这种“全局选项带独立值”的形状不会被隐藏；
- 能跨行；注释或字符串里的伪调用不算；`checkout` 不带标记的直接调用是正确的受支持形状，不报。

非空转实测（本次评审前段执行，临时文件已删除）：在 `src/__guard_probe__.ts` 写入跨行的

```ts
withPositionals(
  ["-c", "protocol.version=2", "checkout"],
  [`${sha}^3`, "file.txt"]
)
```

以及直接携带标记的 `runGit(["stash", "store", END_OF_OPTIONS, ...])` 后，守卫用例失败并分别点名第 4 行、第 10 行的 `checkout` 与 `stash store`，退出码 1；删除该文件后恢复 3/3 绿。基线扫描没有发现任何真实违例。

诚实说明：本轮后半段为取得可粘贴的新输出，曾再次尝试注入同一个临时文件，被环境的写入保护策略拒绝（评审只允许写报告）。上面的红/绿证据来自同一评审前段的实际执行，不是推断；`git status` 已确认 `src/__guard_probe__.ts` 不存在。

守卫的覆盖边界：它只匹配标识符字面为 `withPositionals` 或 `runGit` 的调用，首参必须是数组字面量。以下形状不会被扫描：`git([...])` 辅助函数、`import { withPositionals as wp }` 之类的别名、首参是变量、以及 `...spread`。当前 `src/` 中带标记的调用都经过 `withPositionals` 的数组字面量，或位于 `capabilityProbe.ts` 的 `MARKER_CHECKS` 变量中（后者是必须带标记的只读探测命令，不属于拒绝子命令）。因此当前没有漏报的真实违例；但未来若改用 `git()` 或变量 argv，守卫会失去保护。列为 P4-2。

### 4.4 剩余标记站点审计

**去掉标记的站点，按 positional 来源分类：**

- 内部完整 40-hex：`cat-file <sha>^3`、`cat-file <rev>:<path>`、`cat-file :<path>`、`ls-tree <sha>^3`（`worktree.ts:251,263,301,316`）；`diff --name-only <internal sha>`、`rev-list <internal sha>`、`ls-tree <sha>`、`diff --cached/--quiet <sha>^2 -- <paths>`、`stash apply <full sha>`、`merge-base --is-ancestor <record.targetHash> HEAD`（`pendingRecovery.ts` 对应函数）；`show` / `diff-tree` 在 `commitDetail`、`patchId`、`getCommitDiff`、`openCommitDiff` 内先断言 `/^[0-9a-f]{40}$/i`（`commitLog.ts`、`messageGen.ts:25`、`rebaseViewProvider.ts:2876-2895`）；`rev-list <beforeTip>`（`rebaseViewProvider.ts:2026`）。
- 内部 ref：`update-ref <record.beforeRef> <record.beforeTip>`、`update-ref -d <item.beforeRef>`（`undo.ts`，ref 以 `refs/gitRebaseVisual/undo/` 开头，tip 为完整 hex）；`show-ref --verify --quiet <record.beforeRef>`、`reset --keep <record.beforeRef>`（`rebaseViewProvider.ts:1347` 附近）。
- 固定名称或内部槽位：`rev-parse --verify --quiet <slot>`，`slot` 由索引拼成 `stash@{n}`（`worktree.ts:671`）；`rev-parse @{upstream}`（固定文本）；`rebaseStoppedSha` 的裸 `rev-parse <stopped-sha 文件内容>`（`commitLog.ts:335`）——裸 `rev-parse` 只回显、不执行选项，且所有消费者只把它当字符串比较（`commitLog.ts:395-396`、`editStopCommit.ts`、`rebaseViewProvider.ts` 的相等判断）。
- `--` 之后的路径：`add/restore/reset/hash-object` 的 path 参数（`worktreeChanges.ts:192,229,236,262,276`、`pendingRecovery.ts:357`）。

没有发现“去掉了标记但 positional 可能是选项”的站点。特别检查了 `openCommitDiff`：调用方门禁之外，函数内再次断言 40-hex，因此三条 `show`/`diff-tree` positional 在进入 Git 前可证明是 16 进制串。

**保留标记的站点：**

`commitDetail` 的 `fullMessage`、`isAncestor`、`getCommits`、`resolveRange` 的 `mainBranch`/`upstream`，`withPositionals(["rev-parse","--verify","--quiet"], [cfg.mainBranch])`，pushGuard 的 `rev-list <upstream..tip>` 与 `push <remote> <refspec>`，`rebase -i <base>`，`log <sourceRev>`，`for-each-ref <branch>`，`rev-list <upstream...HEAD>`，push subject 的 `log`，以及 capabilityProbe 的四条只读命令。

按用户 2.34.1 日志，这些子命令（`rev-parse`、`rev-list`、`log`、`for-each-ref`、`show`、`diff`、`diff-tree`、`ls-tree`、`cat-file`、`update-ref`、`merge-base`、`show-ref`、`reset`、`rebase -i`、`stash apply`、`push`）在同一会话中全部可用，唯一报错是 `checkout` 的 `only one reference expected, 2 given`。0.8.3–0.8.5 已经在这些调用上带标记，用户能完成对应功能，说明这些子命令在 2.34.1 上接受标记。**这是从用户日志的推断，不是我亲自在 2.34 上跑出来的。** 没有发现“保留标记但该子命令未证明接受标记”的站点。

### 4.5 激活探测

接线与调用面：

```text
src/extension.ts:10   import { createActivationProbe } from "./git/capabilityProbe";
src/extension.ts:134  const activationProbe = createActivationProbe({...});
src/extension.ts:151  void activationProbe.run();
```

全仓库检索 `activationProbe` / `createActivationProbe` / `probeGitCapabilities`，只有 `extension.ts` 与 `capabilityProbe.ts` 两个文件命中；`rebaseViewProvider`、消息处理、`refresh()` 均无引用。测试“message handling and refresh cannot trigger the activation probe”也在源码层面断言了这一点。

一次性与不阻塞：

- `createActivationProbe` 用 `resultPromise` 缓存首次调用的 promise，后续 `run()` 直接返回同一个 promise；`runs` 只在首次递增。测试“the probe runs once per activation, however many callers ask”通过。
- `run()` 内部对探测、日志、通知分别 `try/catch`；`void activationProbe.run()` 不 await。即使 `probeGitCapabilities` 抛错，也只返回 `probe-error` 并告警，不会拒绝到扩展宿主。
- 探测实例在 `logger.start(...)` 之后创建（`extension.ts:27` 对 `:134`），日志器已就绪，不存在“通知/日志早于 logger”的窗口。

行为矩阵（`test/capabilityProbe.test.ts` 实际 10 条，本轮随 22 条目标测试一起通过）：

| 场景 | 期望 | 结果 |
| --- | --- | --- |
| 成功 | 恰好一条 info，文本精确为 `Git Rebase Visual <version> 已启用`，不含 probe/探测/自检/能力措辞；四条命令 argv 与 `LC_ALL=C` 精确匹配 | 通过 |
| 低于最低版本 | 一条 warning，无 info；不执行四条标记命令 | 通过 |
| 标记被拒（含 `only one reference expected`） | 一条 warning，无 info；不给“升级到 2.31+”的错误建议 | 通过 |
| 普通非零退出（如 unborn HEAD） | 视为标记已接受，不告警为能力失败 | 通过 |
| runner 抛错 | 归为 `probe-error`，不当成标记被拒 | 通过 |
| 非仓库 / 无工作区 | 只查版本，跳过标记检查，返回成功 | 通过 |
| 幂等 | 多次调用只跑一次 | 通过 |
| 版本可观测 | 日志头与 OutputChannel 含 Git 版本 | 通过 |

源码实现与声明一致：`MARKER_REJECTION_PATTERNS` 只匹配“标记本身不被接受”的文本；`result.code !== 0 && isMarkerRejection(result)` 才算失败，其余非零退出记为 `marker accepted (ordinary failure)`。成功分支只调用 `notifyInfo` 一次。

### 4.6 Git 版本可观测性

- 会话日志头：`extension.ts:25-34` 在 `logger.start([...])` 中写入 `git=${detectedGitVersion ?? "not-found"}`；`gitVersionSync()` 在 `logger.start` 之前同步执行，失败被 `try/catch` 吞掉。
- OutputChannel 第一行：`rebaseViewProvider.ts:207` 为
  `Git Rebase Visual <version> · git <knownGitVersion() ?? "unknown"> · <extensionPath> · vscode <version> · pid <pid>`。
- `test/capabilityProbe.test.ts` 用正则断言了 `git=${detectedGitVersion ?? "not-found"}` 与 OutputChannel 的版本行。

### 4.7 本轮是否引入新缺陷（重点排查）

- 重复通知：不会。`resultPromise` 缓存 + 仅 `activate()` 调用一次；VS Code 每次扩展宿主启动调用一次 `activate()`，因此每次激活恰好一条成功/告警。这符合任务规格，不是“每次点击/每次刷新”。
- 阻塞激活：探测本身不 await；但 `gitVersionSync()` 是同步 `execFileSync`，本机实测约 305–368 ms，最坏受 2000 ms 超时约束。它发生在 `activate()` 同步路径上，会让激活晚几百毫秒。功能上可接受，列为 P4-3。
- 通知早于 logger：不存在，探测在 logger 启动后创建。
- 探测 cwd：取 `workspaceFolders[0]?.uri.fsPath`。多根工作区只看第一个根；若第一个根不是 Git 仓库，探测会跳过标记检查并报成功，即使第二个根是需要检查的仓库。这是“漏报”而非“误报”，列为 P4-4。
- 凭据/网络：四条检查命令全部是本地只读（`rev-parse`、`log`、`rev-list`、`for-each-ref`），`rev-parse --show-toplevel` 也不访问远端；不会触发凭据提示。若 cwd 不存在或 Git 无法 spawn，探测归为 `probe-error` 并告警，不阻塞。
- 拒绝表误伤既有调用：枚举 `src/` 的 13 处 `withPositionals` 调用，子命令为 `rev-parse`、`log`、`merge-base`、`push`、`rev-list`、`rebase`、`show`，均不在拒绝表；运行时测试与集成测试均绿。
- `readVersion` 抛错归类：`probeGitCapabilities` 捕获后把 `version` 置空，返回 `git-not-found`，提示用户“未找到 Git”。如果 Git 存在但 `git --version` 因权限/包装脚本抛错，提示会指向错误原因。属诊断准确性问题，列为 P4-5；不影响“不误报成功”。
- `gitVersionSync` 失败时把 `cachedGitVersion` 设为 `undefined`，后续异步 `gitVersion` 仍会重试（缓存判断是 `!== undefined`），不会永久污染缓存。

### 4.8 计数、文档、VSIX、台账与杂项

- 测试：`test/*.test.ts` 52 个；顶层 `test(` 350 个。`RELEASE.md:128,144`、`docs/release-notes/0.8.3.md:44`、`docs/summary/summary.md:153`、`docs/improvement/improvement.md:396` 均为 350 项 / 52 个文件、pass 349 / fail 0 / skipped 1，互相一致。
- VSIX：12 个条目，白名单校验通过；包内 `extension/dist/extension.js` 的 sha256 与工作区 `dist/extension.js` 相同（`c525fa8a...19ebdb`）。`.vscodeignore` 新增 `.nvmrc` 与 `*.log`，与文档所述“allowlist 发现后补齐”一致。
- 台账：`docs/review/code-review-commit.md:11` 已有 `code-review-0-8-27.md` 行，状态为“待评审（pending）”，SHA 栏明确写“无 commit SHA，本行不写臆造 SHA”，基线为 `4e51d98`，并列出被评审范围。没有伪造的 40-hex。
- 仓库根目录没有 `.test-run.log` 或其他临时日志；`git status` 的未跟踪项只有三个新文件。
- `package.json` 仍为 `0.8.5`，与“本轮不改版本号”一致；但这意味着**当前工作树不能直接作为 0.8.6 发布**。

## 五、新发现（按严重度）

### P4-1 静态/运行时探测器不识别 `stash <option> store` 形状

`subcommandOf(["stash","--quiet","store",...])` 返回 `"stash"`，`withPositionals` 不会抛错；若未来有人写出这种形状，`--end-of-options` 会被追加到 `stash store` 之后，重新引入本轮修复的同类故障。当前代码没有这种调用（唯一的 `stash store` 是 `worktree.ts:928` 的直接 `runGit`，不带标记也不带中间选项），所以不影响本轮发布。建议后续让 `subcommandOf` 在 `stash` 后跳过 stash 自己的选项直到遇到 `store`，或在拒绝表匹配时对 `stash` 前缀做保守处理。

### P4-2 静态守卫只识别 `withPositionals` / `runGit` 的字面调用

守卫不扫描 `git([...])`、导入别名、变量 argv、spread。当前带标记的调用都在覆盖范围内，因此没有真实漏报；但 `git()` 是同一 runner 的合法入口，未来新增调用可能绕过守卫。建议把 `git` 加入被扫描的 callee 集合，并在测试里加一个 `git(["checkout", END_OF_OPTIONS, ...])` 的正例。

### P4-3 `gitVersionSync()` 在激活同步路径上阻塞约 0.3–0.4 秒

`execFileSync("git", ["--version"], { timeout: 2000 })` 在 `activate()` 内同步执行。本机实测 305–368 ms；慢磁盘、网络路径或安全软件扫描下可能接近 2 秒。它换来日志头与 OutputChannel 第一行的版本信息，诊断价值高，但可以改为异步播种后回填日志，或把超时降到更短。不阻塞。

### P4-4 多根工作区只探测第一个根；第一个根非仓库时跳过标记检查

`cwd` 取 `workspaceFolders[0]`。多根场景下第二个根可能是真实仓库，但不会被检查；第一个根不是仓库时，探测直接返回成功并跳过四条标记命令。没有误报失败，但有漏报。建议遍历所有根，或至少选择第一个 `rev-parse --show-toplevel` 成功的根。

### P4-5 `git --version` 读取异常被归类为“未找到 Git”，且缺失 Git 分支缺少持久测试

`readVersion` 抛错与“命令成功但没有版本号”都返回 `problem: "git-not-found"`，告警文案会让用户去安装 Git，而真实原因可能是权限、包装脚本或 spawn 失败。`test/capabilityProbe.test.ts` 覆盖了 runner 在标记检查阶段抛错，但没有覆盖 `readVersion` 抛错或缺失 Git 的告警分支。建议区分 `git-not-found` 与 `version-read-failed`，并补一条测试。

## 六、我没有验证的部分

1. **没有在 Git 2.31/2.34 上运行任何代码。** 本机是 2.53，任务也明确不允许安装旧版。兼容性结论来自用户 2.34.1 的日志（只有 `checkout` 报 `only one reference expected`，其余命令成功）以及“代码中不再有带标记的 `checkout` / `stash store`”这一静态事实。
2. **没有启动全量测试套件。** 只跑了三个关键文件共 22 条；文档的 350 / 52、349 pass / 1 skip 是计数核对与文档一致性核对，不是本次执行结果。
3. **本轮没有重新执行 `node esbuild.js`。** 只验证了 VSIX 包内产物与工作区现有 `dist/extension.js` 哈希一致；没有重新生成后再比较。
4. **没有在真实的 VS Code 扩展宿主里观察通知。** 探测行为由单元测试的假通知器与源码接线验证；没有手工触发一次真实激活来看弹窗次数。
5. **没有模拟多根工作区、远程工作区、需要凭据的仓库或 Git 包装脚本。** 这些场景只做了源码推理，未做端到端复现。
6. **静态守卫的非空转没有在最终状态下重新执行。** 评审后半段再次注入临时违规文件被环境写入保护拒绝；红/绿证据来自同一评审前段的实际执行，临时文件已清理，`git status` 无残留。
7. **没有验证 0.8.5 的旧 VSIX 在 2.34.1 上失败、以及新构建在 2.34.1 上成功。** 用户日志是旧行为的唯一现场证据。

## 七、裁决与覆盖范围

- **可以提交。** 本轮修复直接消除了用户 2.34.1 日志中的失败命令：全仓库唯一的 `checkout` 调用不再带 `--end-of-options`，其 `sha`/`path` 的不可能为选项有代码级证据；`withPositionals` 对 `checkout` / `stash store` 改为抛错，当前所有实际产生的 argv 形状都被拦住；静态守卫能在跨行和全局选项形状下报红；激活探测满足“一次、非阻塞、不抛错、成功一条通知、异常分支告警”的规格；版本可观测性与测试/文档/VSIX/台账均一致。
- **没有 P0/P1/P2/P3 阻塞项。** P4-1 至 P4-5 是守卫覆盖面、激活延迟、多根覆盖与诊断准确性问题，均不改变本轮对 2.34 回归的修复效果，可在提交后跟进。
- **作为 0.8.6 补丁发布前仍需：** 把 `package.json` 升到 0.8.6，重建并重新校验 VSIX，确认包内产物哈希更新。当前工作树版本号仍是 0.8.5，不能原样发布。
- 覆盖范围：基线 `4e51d98` 之上的未提交工作树内容（15 个修改文件 + 3 个新增文件）。本报告评审的是工作树，不是某个提交 SHA；提交后应由台账记录真实 SHA，并按项目约定在下一轮独立评审中覆盖该提交。台账本行目前为 pending，我没有编辑它。
