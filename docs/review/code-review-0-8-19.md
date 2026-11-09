# Code Review 0-8-19 — 0.8.3 第七轮复核（第六轮四.1–四.4 的整改是否真的修好、穷举审计是否补全、注入面是否有回退、打包产物）

- 评审日期：2026-11-07
- 评审角色：独立评审（Agent B，第七轮）
- 基线 commit：`577ce8766a46707a60c471cf8090e9f63cd8d49c`（`test: run each file in its own process and split the slowest suite`）
- 被评审材料：基线之上的**未提交工作树**——`git status --short` 共 **36 行**（**25 个修改文件** + **11 个 untracked**）。25 个修改文件中包含 12 个 `src/`、4 个 `test/`、4 个 `docs/`、`media/main.js`、`README.md`、`RELEASE.md`、`package.json` 与 `package-lock.json`；11 个 untracked 为 `src/ui/pushNotification.ts`、`test/pushIsolation.test.ts`、`test/pushNotification.test.ts`、`test/restoreFileProtocol.test.ts`、`docs/release-notes/0.8.3.md`、`docs/review/code-review-0-8-13/14/15/16/17/18.md`。数字取自**我写本报告之前**的 `git status`。
- 本轮任务：第六轮（[`code-review-0-8-18.md`](code-review-0-8-18.md)）已**批准** 0.8.3 与 `dist-vsix/git-rebase-visual-0.8.3.vsix`，并留下四项 P3；A 被要求"现在就修完这四项"。本轮**只验证这四项是否真的修好、有没有把别的东西弄坏**——我的批准本身不是本轮议题，但结论里必须回答它是否仍然成立。
- 顺序：先读 `code-review-0-8-18.md`（我自己的上一份报告），再读 `code-review-0-8-17.md`，再读账本 `docs/review/code-review-commit.md`。账本中 `0-8-13`…`0-8-18` 均有独立行，SHA 均为基线并注明"被评审材料为未提交工作树"；**没有 `0-8-19` 行**（`grep -c '0-8-19'` = 0）。
- 环境：Windows 11 + MSYS Git `git version 2.53.0.windows.2`，Node `v24.16.0`。本 shell 里 `node`/`npm` 解析不到，命令一律直接调用 `/d/Program Files/nodejs/node`。
- 本报告**不修改**任何既有评审报告、不修改账本、不修改 `src/`、`test/`、`media/`、`docs/`（除本文件）与仓库根目录文件。

> **一条与项目约定的冲突，需要由项目所有者决定**：项目 `CLAUDE.md` 要求评审者在完成评审后**更新账本**并写入 SHA/文件名/状态/日期；本轮任务明确禁止我编辑账本（"Do not edit the ledger"）。我遵循了任务约束，因此 `docs/review/code-review-commit.md` 里尚无 `0-8-19` 行，需要 A 或所有者按本报告补记。

---

## 一、结论摘要

| 复核项 | 结论 |
| --- | --- |
| **四.1** 两处 `rev-list` 的标记 | **已修复，且已实测生效**。真实 `RebaseViewProvider` + 真实 bare 远端（`git remote add -- -evil <url>`）：刷新得到 `ahead=2 behind=0 upstreamRef=-evil/master upstreamNote=undefined error=undefined`，与我自己直接跑 Git 的真值 `0 2` 一致（第六轮 provider 报的是 `0 0`）；推送路径给出可见的 `推送被拒绝：推送范围包含被锁定的 commit（57a6196）…`、`remote advanced? false`，**不再出现** `usage: git rev-list` / `failed (129)`。把两处标记同时去掉（副本 `mut19h`）后三条 `-evil` 用例**全红**，其中刷新那条的失败断言正是 `ahead is the one unpushed commit; saw 0`。最差形状（远端名 `-evil` **且** 上游分支名 `-foo`，即 `-evil/-foo`）有标记时 `0 0 / exit 0`，无标记时 `usage: … / exit 129`。 |
| **"无法计算范围"的可见性** | **推送侧确认真实可见**。用副本把 `pushRange` 强制改成返回退出码 42（`mut19c`），在**真实 provider** 上点推送，捕获到的可见文案是 `无法计算推送范围（origin/master..HEAD）：git rev-list origin/master..HEAD failed (42): simulated range failure。未执行推送。`——不是日志、不是空数组。**刷新侧的 `upstreamNote` 存在但实际不可达**（详见 §四 新发现 4）：`%(upstream:track)` 的 `[gone]` 吸收了几乎所有"上游不健康"形态，而唯一能强制到达的形态（HEAD 历史里对象损坏）里，它又被 `getCommits` 的 catch 丢掉。 |
| **A 的穷举审计** | **补全了，没有漏站点**。我把 `src/` 里全部 `withPositionals(` 调用点（48 处，含 `gitRunner` 定义与 8 处 import 之外的每个调用）与全部 `runGit([...])` / `git([...])` 字面量调用逐条比对：凡位置参数可能来自 Git 输出、设置或 webview 消息的都已加标记。**未被标记的只剩两类**：Git 内部常量（`rebase-merge/[...]`、`refs/stash`、`stash@{n}`、`--git-path` 的固定名）与代码里写死的 `"HEAD"`/`"@{upstream}"`，以及文档已说明的两条例外（`git stash store`、裸 `git rev-parse`）。我另逐条实测了标记在这些命令上的兼容性（`merge-base --is-ancestor`、`update-ref` / `update-ref -d`、`checkout --`、`show-ref --verify`、`ls-tree -r -z`、`cat-file -e`、`diff --cached --quiet`、`rev-list --parents -n 1`、`reset --keep`、`rebase -i`、`push`）——**全部 exit 0**，没有一处"加了标记反而不能用"。 |
| **四.2** 新用例是否非空转 | **是**。在**只去掉 `getCommits` 标记**、`resolveRange` 的 `rev-parse` 闸保持原样的副本（`mut19k`）上：新用例 `getCommits does not let an option-shaped positional write a file` **红**（断言 `Git must not have honoured --output=`），改名后的 `resolveRange rejects a mainBranch whose base is 'HEAD --output=<file>'` **绿**——这正是四.2 的论点。反向（只去掉 `rev-parse` 闸，副本 `mut19`）：改名后的用例红、新用例绿。原用例的名称已改为 `resolveRange rejects a mainBranch whose base is 'HEAD --output=<file>'`，并在前面写明它钉的是**范围解析闸**而不是 `getCommits` 的标记。 |
| **四.3** 文档自相矛盾 | **已消除**。`docs/improvement/improvement.md:169` 现在写"远端名**可以**以 `-` 开头……真正的不变式是'所有选项都写在它们之前，因此它们是构造上的位置参数'"，与 `:192`（"原注释称'远端名不以 `-` 开头'，实测不成立"）和 `:211`（"已修复"）一致；全文再搜"不以 `-` 开头"只剩 `:192` 与 `:211` 两处**历史陈述**，没有仍在主张它的段落。 |
| **四.4** 文档过期 | **已改写，且"杀死性变异"今天确实可杀**。`docs/release-notes/0.8.3.md:26` 与 `docs/summary/summary.md:142` 现在都描述 `for-each-ref` + `%(upstream:track)` 的 `[gone]` 判定，并把 `rev-parse --verify` 明确叙述为**已被取代**（release notes："同一轮的前一个版本曾用第二次……现已被读取 Git 自己报告的原子取代"；summary："`rev-parse --verify` 那次调用已在前一轮被同一次 `for-each-ref` 取代，删它不会让该用例变红"）。我把 A 声称的变异（去掉 `[gone]` 判定）在副本 `mut19g` 上重跑：`a pruned upstream in any namespace is still rejected` 与 `a pruned upstream reports a visible error instead of failing silently` **两条同时变红**，后者报的正是 `git rev-list origin/master..HEAD failed (128): … unknown revision`。 |
| **测试计数** | **317 项 / 46 个文件**，独立枚举一致。`grep -h '^test(' test/*.test.ts` = **317**，`ls test/*.test.ts | wc -l` = **46**；`docs/summary/summary.md:150`、`RELEASE.md:136`、`docs/release-notes/0.8.3.md:44` 三处均为 317。全量 `test(` 出现 **325** 次，多出的 **8** 次逐条看过，全部是断言里的正则字面量（`/…/.test(...)`），不是用例声明。`scripts/run-tests.js` 只枚举 `test/*.test.ts` 顶层文件，枚举口径与 317 一致。 |
| **重建后的 VSIX** | **12 个条目、白名单通过、payload 逐字节相同**。`node scripts/package-vsix.js --verify-only` → `VSIX contents match the allowlist (12 entries).`；解压后 `readme.md`/`package.json`/`.gitignore`/`LICENSE.txt`/`media/{style.css,main.js,icon.svg,extension-icon.png}`/`dist/{seq-editor.js,extension.js}` **10 个文件全部 IDENTICAL**（`LICENSE.txt`/`readme.md` 是打包改名，源为 `LICENSE`/`README.md`）。包内 `extension/dist/extension.js` 与现场 `node esbuild.js` 重建结果同为 `7b764af14be93d947eb271a227e170519ba1f3ed7a8cab746475b226ae2c1178`；VSIX 自身 sha256 `2474439e209b5bcce84b853af6e03cba9b4f023d37c2dfbf182e17965ad08e30`，mtime `03:15:50` 晚于最后一次 `src/` 改动（`02:39:18`）与 `media/main.js`（`02:24:48`）。包内代码里两处 `rev-list` 站点与结构化 `getCommits` 都在，`revRange.split` 出现 **0** 次。 |
| **是否引入新缺陷** | **没有产品行为缺陷**。`upstreamNote` 不会残留：webview 对 `state` 是**整体替换**（`state = m`），刷新后问题消失即自然消失，我另用真实 provider 走了"gone → healthy"两步，两步的 `upstreamNote` 都是 `undefined`、计数从 `0/0` 变成 `0/1`。`withPositionals` 没有改变任何合法范围的含义（11 种范围形状 + 大括号分支名 + dash 远端 + dash 分支 + 同名歧义全部实测）。新发现 6 项，全部 P3/P4，且**5 项是覆盖缺口或文档措辞，1 项是对"共享路径"这一主张的可达性修正**。 |
| **第六轮的批准是否仍成立** | **成立**。四.1–四.4 逐项都有红/绿双方向的实测证据，没有一项是"改了文案糊过去"；本轮没有引入任何改变用户可见正确行为的问题；VSIX 可由当前工作树确定性重建且与工作树逐字节一致。 |

### 裁决：**维持批准**

**本评审确认 `code-review-0-8-18.md` 对 0.8.3 的批准仍然有效，并继续覆盖 `dist-vsix/git-rebase-visual-0.8.3.vsix`。**

理由，逐条对上证据：

1. **四项整改都不是"看起来修了"**。四.1 的标记在**真实 provider + 真实 dash 远端**上改变了可观测结果（`0 0` → `0 2`，推送从无反馈 → 明确拒绝），且拿掉标记三条例用立即变红；四.2 的新用例在"只去掉 `getCommits` 标记"这一最小变异下变红、在"只去掉 `rev-parse` 闸"下不变红，说明它钉住的正是它声称钉住的东西；四.3 把一处**仍在主张错误结论**的段落改成了与实测一致的说法；四.4 把两处**指向已删除实现**的描述改写成现行实现，且它声称的变异我复现红了。
2. **没有回退**。上一轮那批注入修复（`pushRefspec`、`pushLog` 的 `sourceRev`、`getCommits`、`mainBranch`、`show`/`diff-tree`/`cat-file`/`ls-tree` 等）在穷举比对下都还在，且 `llm/messageGen.getCommitDiff` 这个 B 未点名的通道也一并加固了。我另外把标记撒在这些命令的**正常用法**上跑了一遍，没有一处误伤。
3. **本轮新增的"可见性"改动没有把别的东西弄坏**。`upstreamNote` 是**新增可选字段**，`BranchPresentation` 的既有字段全部保留，webview 只在它存在时替换箭头计数；`state` 消息整体替换的语义保证它不会残留。副作用是"刷新侧这条 note 实际不可达"（§四 新发现 4）——这是一条**主张过强**的问题，不是用户可见错误：在那种形态下用户看到的是一条带 Git 原文的错误横幅，不是静默的 `↑0 ↓0`。

六项新发现都是 P3/P4，**不含 P0/P1/P2**，也不含任何"用户会看到错的东西"的问题，因此不构成发布阻断，但建议在 0.8.4 一并处理（其中新发现 1–3 是三条可以十几行内钉住的覆盖缺口）。

---

## 二、我实际跑了什么（以及没有跑什么）

**明确声明：完整套件（317 项）不是我跑的。** 按任务约束，另有一轮完整套件正在另一个进程里运行，我没有启动第二个全量运行。我跑的是**定向文件**、两个类型检查、以及真实仓库探针与**只在副本里**做的变异对照：

1. `node node_modules/typescript/bin/tsc --noEmit` → **exit 0、零输出**。
2. `node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit` → **exit 0、零输出**。
3. `test/pushIsolation.test.ts`（`--test-concurrency=3`）→ **15/15 全绿**，`113.7 s`。
4. `test/commitLog.integration.test.ts` → **13/13 全绿**，`51.8 s`。
5. `test/pushNotification.test.ts` + `test/pushGuard.integration.test.ts` → **22/22 全绿**，`119.8 s`。
6. `test/rebasePresentation.test.ts` + `test/webviewDom.test.ts` → **15/15 全绿**，`5.5 s`。

   （定向合计 **65 项**；`pendingRecovery*` 4 个文件、`recoveryProvider`、`appendStaged`、`rebaseSafety`、`llmClient` 等本轮一次都没跑。）

7. **我自己写的探针**（全部在 OS 临时目录，不属仓库，一律以 `process.exit(0)` 收尾，因为 provider 的 1.5 s 轮询会钉住事件循环）：
   - `r19probe/dash19.ts`：真实 `RebaseViewProvider` + `test/helpers` + 真实 bare 远端 `-evil`，复现第六轮那个形状（刷新计数、锁定后推送、gone→healthy 两步）。
   - `r19probe/corrupt19.ts` / `noteReach19.ts` / `noteReach2_19.ts` / `noteReach4_19.ts`：把 `.git/objects` 里一个可达对象改成垃圾字节，观察 `for-each-ref` / `rev-list` / `log` 的退出码与 provider 最终发出的 state。
   - `/tmp/probe_catch.ts`：把 `pushRange` 换成恒定退出码 42 的副本，在真实 provider 上点推送并捕获 `stub.messages` 与 `postInlineToast`。
8. **变体对照**：`src/`+`test/`+`media/`+`scripts/` 复制到 `%TEMP%\mut19{,b..l}`（`node_modules` 用 junction 指回工作树，用完先删 junction 再删目录），**只在副本里**改动后重跑同一组用例。共 12 个副本，逐一说明见 §三/§四。
9. **裸 Git 对照实验**：`rev-list` 的 11 种合法范围形状、`rev-parse` 六种形态的"标记回显"矩阵、`--end-of-options` 在 12 条命令上的兼容性、`stash store` / 裸 `rev-parse` 两条例外的再确认、远端名/分支名为 `-evil`/`-foo`/`feat{x}` 的形状。
10. **重建与打包**：`node esbuild.js`、`node scripts/package-vsix.js --verify-only`、手工解 zip 逐条比对 sha256、数 zip 本地文件头（12 个）。

**我修改过的文件**：只有本报告。评审结束时 `git status --short` 仍为 **36 行**（25 修改 + 11 untracked，本报告是新增的第 12 个 untracked），`git stash list` 为空，无 `git add` / commit / tag / push，账本未改。`dist/extension.js` 被 `node esbuild.js` 重写（任务明确要求的复现步骤），**重建前后 sha256 同为 `7b764af1…`**，内容不变（`dist/` 在 `.gitignore` 内）。

**临时目录清理**：12 个变异副本与数十个 scratch 仓库已删除；本轮的探针文件（`r19probe/*`、`/tmp/probe_catch.ts`）与 `mut*` 目录已清空，`%TEMP%` 下我造成的 `grv19*` 残留为 **0**（`ls | grep -c '^grv19'` = 0）。`%TEMP%` 里更早的 `grv-*` 目录不是本轮的产物（最新 mtime 为 02:30，早于本轮），我没有动它们。

> 一处如实说明：`corrupt19` 探针第一次跑时被 Windows 拒绝写入只读对象（`EPERM`）。加上 `chmodSync(obj, 0o644)` 后成功；该探针在结束时把原字节写回，并在自己的临时仓库里操作，从未触碰工作树。

---

## 三、逐项复核（证据均为本轮实测输出）

### 1. 四.1：两处 `rev-list` 的标记，在真实 provider 上确实改变结果

站点（行号为当前工作树）：

- `src/git/pushGuard.ts:124-127`：`withPositionals(["rev-list"], [`${upstreamRef}..${tip}`])`，非零退出**抛错**而不是返回 `[]`（注释写明：空数组在锁守卫眼里等于"范围内没有锁定 commit"）。
- `src/ui/rebaseViewProvider.ts:417-421`：`withPositionals(["rev-list", "--left-right", "--count"], [`${upstream.ref}...HEAD`])`。

**刷新侧实测**（`r19probe/dash19.ts`，真实 provider，远端 `-evil`）：

```
provider refresh: ahead= 2 behind= 0 upstreamRef= -evil/master upstreamNote= undefined error= undefined
```

直接跑 Git 的真值同一步为 `0 2`（`--left-right --count` 先列左/上游侧），第六轮 provider 报的是 `0 0`。**语义正确、且与真值一致。**

**推送侧实测**（同一探针，锁定一条待推 commit 后点推送）：

```
push visible messages: [
 "[error] 推送被拒绝：推送范围包含被锁定的 commit（57a6196）。请将其移出推送范围（拖到你要推送的提交之后，或先 drop）再推送。"
]
remote advanced? false
```

没有 `usage: git rev-list`、没有 `failed (129)`、没有"什么都没发生"。

**变异方向**（副本 `mut19h`：把两处同时改回字符串形态，其余一字不动）：

```
✖ pushRange computes the range for a remote named '-evil' instead of throwing
✖ a locked commit is still blocked when the remote is named '-evil'
✖ refresh reports ahead/behind for a remote named '-evil' instead of 0/0
  AssertionError: ahead is the one unpushed commit; saw 0
ℹ tests 3  pass 0  fail 3
```

**最差形状**（`$TEMP/dashall`：远端 `-evil` **且** 上游分支 `-foo`，即 `-evil/-foo`）：

```
track=[-evil/-foo|-evil|refs/heads/-foo]
--- with marker ---    0	0    exit=0
--- without marker --- usage: git rev-list [<options>] <commit>... [--] [<path>...]   exit=129
```

即标记既**修好**了这个形状，也正是让它可用的东西。

**"visible message for 'cannot compute the range'"有没有真的出现**——分两处回答，因为这是两个不同的出口：

- **推送侧（可达、已实测）**：`rebaseViewProvider.ts:3082-3090` 的 `catch` 把 `pushRange` 的抛出变成 `无法计算推送范围（${up.ref}..HEAD）：…。未执行推送。`。我用 `mut19c`（把 `pushRange` 换成 `{code:42, stdout:"", stderr:"simulated range failure"}`）在**真实 provider** 上点推送，捕获到的可见文案是：

  ```
  无法计算推送范围（origin/master..HEAD）：git rev-list origin/master..HEAD failed (42): simulated range failure。未执行推送。
  ```

  所以这条路径**不是**"只写日志"。
- **刷新侧（存在但不可达，见 §四 新发现 4）**：`rebaseViewProvider.ts:426-431` 的 `else` 把原因写进 `upstreamNote`，webview 用它替换箭头计数（`media/main.js:87-92`：`↑? ↓? · <原因>`）。这条路径本身是好的，但我构造不出任何能让它执行的 Git 状态。

### 2. A 的穷举审计：逐条比对后没有漏站点

我把 `src/` 的调用面按"位置参数是否可能来自 Git 输出 / 设置 / webview 消息"分了三类。

**已加标记（48 处调用点）**，覆盖：`log`、`rev-list`、`rev-parse --verify`、`rev-parse --abbrev-ref --symbolic-full-name`、`show`、`show-ref --verify`、`diff`、`diff-tree`、`cat-file -e`、`ls-tree`、`checkout`、`reset --keep`、`update-ref`、`rebase -i`、`merge-base --is-ancestor`、`stash apply`、`push`、`for-each-ref`。

**仍未加标记，且我确认不需要**：

| 站点 | 位置参数来源 | 为什么不加 |
| --- | --- | --- |
| `commitLog.ts:250,274` `rev-parse --path-format=absolute --git-path` | 代码里的字面量（`rebase-merge`、`rebase-apply`、`…/head-name`、`…/stopped-sha`） | 不是用户数据 |
| `commitLog.ts:295` 裸 `rev-parse <sha>` | `.git/rebase-merge/stopped-sha` 的**文件内容** | 所有权在仓库里，但值只可能是 sha；即使写入 `--output=…`，裸 `rev-parse` 也只是把它**回显**到 stdout（实测，见下），不写文件、不改仓库。见 §四 新发现 5 的注释措辞 |
| `commitLog.ts:364` `rev-parse --show-toplevel`、`rebaseViewProvider.ts:1960` `rev-parse HEAD` | 常量 | 同上 |
| `worktree.ts:149` `rev-parse --verify --quiet refs/stash` | 常量 | 同上 |
| `worktree.ts:64` `stash push …options` | 代码里的常量数组（`--include-untracked` / `--keep-index`） | 不是用户数据；`stash push` 自带解析 |
| `worktree.ts:646` `stash drop <slot>` | 由内部索引构造的 `stash@{n}` | 不是用户数据（注释写明 Git 拒绝裸 sha） |
| `worktreeChanges.ts` 的三类 `add/restore -- <path>` | 工作区状态里的路径 | 已用 `--` + `GIT_LITERAL_PATHSPECS`，与 `--end-of-options` 是同一层防护 |
| `stash store` / 裸 `rev-parse` | — | 文档化的两条例外，我本轮**重新实测**确认 |

两条例外的再实测（`$TEMP/mtx`、`$TEMP/range19`）：

```
git stash store --end-of-options <sha>  → "git stash store" requires one <commit> argument
git stash store <sha>                   → 正常
git rev-parse --end-of-options HEAD     → "--end-of-options" + sha      （回显，污染 stdout）
git rev-parse --verify --quiet --end-of-options HEAD → sha             （干净）
```

标记兼容性我按命令逐个跑了一遍（`$TEMP/spot19`，全部 `exit 0`）：`merge-base --is-ancestor`、`update-ref`、`update-ref -d`、`checkout --`、`show-ref --verify`、`ls-tree -r -z`、`cat-file -e`、`diff --name-only`、`diff --cached --quiet`、`log -1 --pretty=format:%B`、`reset --keep`、`rev-list --parents -n 1`、`rebase -i`、`push`。**没有一处因为标记而失效。**

**结论**：审计是完整的；A 还额外加固了 `llm/messageGen.getCommitDiff` 的 `show <hash>`（我上一轮没点名的一个真实 webview 通道），这一处经标记后 `git show --no-color --format= --end-of-options <hash>` 正常返回。

### 3. 四.2：新用例在最小变异下变红，且旧用例的新名字名副其实

- 新用例：`test/pushIsolation.test.ts:417` `getCommits does not let an option-shaped positional write a file`（直接以 `RangeArgv` 调 `getCommits`，断言 `--output=<target>..HEAD` **没有被创建**）。
- 改名的旧用例：`test/pushIsolation.test.ts:370` `resolveRange rejects a mainBranch whose base is 'HEAD --output=<file>'`，前面（364-369 行）写明"这条钉的是范围**解析**闸，不是 `git log` 的标记……旧的名称说的不是这回事"。

两个方向，各用只动一处的副本：

| 副本 | 改动 | 结果 |
| --- | --- | --- |
| `mut19k` | 只把 `getCommits` 的 `withPositionals(["log", …, ...range.options], range.positionals)` 改回 `[..., ...range.options, ...range.positionals]`；`rev-parse --verify` 闸**原样保留** | `✖ getCommits does not let an option-shaped positional write a file`；`✔ resolveRange rejects a mainBranch whose base is …` |
| `mut19` | 只删掉 `resolveRange` 里的 `rev-parse --verify --quiet` 闸；`getCommits` 标记原样保留 | `✖ resolveRange rejects a mainBranch whose base is …`（`invalid object name 'HEAD --output=<file>'`）；`✔ getCommits does not let an option-shaped positional write a file` |

两条互不代偿，说明覆盖是**两条**而不是一条。旧用例的名字现在描述它实际钉住的东西。

### 4. 四.3：`improvement.md` 不再自相矛盾

- `:169`（P3-4 四.2，本轮改写处）："远端名**可以**以 `-` 开头（`git remote add -- -evil …` 被接受，`git remote` 原样打印 `-evil`）……真正的不变式是'所有选项都写在它们之前，因此它们是构造上的位置参数'。"
- `:192`（P3-5 四.2）："原注释称'远端名不以 `-` 开头'，实测不成立……"——历史陈述，与 `:169` 同向。
- `:211`（P3-6 四.3）："按要求把前者改成与后者一致"——说明性历史。
- 全文搜"不以 `-` 开头"只剩 `:192`、`:211` 两处**引用旧说法**的句子，没有仍在主张旧结论的段落。

### 5. 四.4：两处文档描述现行实现，且"杀死性变异"今天可杀

- `docs/release-notes/0.8.3.md:26`：`getUpstream` 用**同一次** `for-each-ref` 里的 `%(upstream:track)`，`[gone]` 即视为没有可用上游；并明确写"同一轮的前一个版本曾用第二次 `git rev-parse --verify refs/remotes/<remote>/<branch>` 做存在性检查……现已被读取 Git 自己报告的原子取代"。
- `docs/summary/summary.md:142`：同一描述，并把变异写成"把 `%(upstream:track)` 的 `[gone]` 判定去掉后该用例变红……`rev-parse --verify` 那次调用已在前一轮被同一次 `for-each-ref` 取代，删它不会让该用例变红"。
- **变异复现**（副本 `mut19g`，删掉 `pushGuard.ts:91-93` 的 `[gone]` 判定）：

  ```
  ✖ a pruned upstream in any namespace is still rejected
  ✖ a pruned upstream reports a visible error instead of failing silently
    AssertionError: the user is told the upstream is unusable; saw
      ["无法计算推送范围（origin/master..HEAD）：git rev-list origin/master..HEAD failed (128):
        fatal: ambiguous argument 'origin/master..HEAD': unknown revision … 。未执行推送。"]
  ```

  两条红、报错形状与文档描述一致。A 声称的这条变异**今天确实存在**（`rev-parse --verify` 那次调用已经不在代码里，删它当然不可能变红，文档现在也承认这一点）。

### 6. 计数、文档、打包（独立复算）

- 静态枚举：`46` 个 `test/*.test.ts`、`317` 个顶层 `test(`；**一个都不在子目录**（`grep '^  test('` = 0），与 `scripts/run-tests.js` 的枚举口径一致。`docs/summary/summary.md:150`、`RELEASE.md:136`、`docs/release-notes/0.8.3.md:44` 均为 **317**。
- 账本：`0-8-13`…`0-8-18` 每份报告都有独立行，无历史条目被删；`0-8-19` 尚无（本轮任务禁止我改账本）。
- VSIX：12 个条目（zip 本地文件头计数 12，`--verify-only` 通过），10 个 payload 逐字节相同，包内 `extension/dist/extension.js` 与现场重建 sha256 相同（`7b764af1…`），包内含 `withPositionals(["rev-list"], …)`（`pushRange` 与 provider 两处 HEAD/`beforeTip` 站点）与 `withPositionals(["rev-list", "--left-right", "--count"], …)`，不含 `revRange.split`。

---

## 四、新发现（按严重度）

### 新发现 1（P3，覆盖缺口）**provider 层对 `upstreamNote` 的赋值没有任何用例钉住**

`src/ui/rebaseViewProvider.ts:430` 是唯一一处真正产生 note 的赋值。我用**干净副本**（`mut19j`：只把这一行换成注释，其余一字不动）跑了两组用例：

- `test/rebasePresentation.test.ts` + `test/webviewDom.test.ts` → **15/15 全绿**
- `pushIsolation` 的 `refresh reports ahead/behind for a remote named '-evil'` + `a locked commit is still blocked …` → **2/2 全绿**

另一方向（`mut19i`：把 `if (counts.code === 0 && Number.isFinite(ahead) && Number.isFinite(before))` 改成 `if (true)`，让 `else` 永不可达）同样全绿。

也就是说：`rebasePresentation.test.ts` 的两条 note 用例与 `webviewDom` 的一条渲染用例都是**合成的**（直接喂 `upstreamNote` 字段），**没有一条从 provider 走到 webview**。`RELEASE.md:136` 声称的"webview 的 `upstreamNote` 一条、`branchContext` 的 note 一条"是准确的，但缺了最关键的一环。把 provider 里那行删掉，用户可见的行为会**静默回退到 `↑0 ↓0`**，而整套用例不会察觉。

**建议**（0.8.4，约十行）：在 `test/pushIsolation.test.ts` 里加一条以 `mut19i` 的逆操作为形状的用例——直接调用 provider 内部的计数段并断言 `upstreamNote` 非空，或（更好）让 `getUpstream` 返回一个 `rev-list` 解析不了而 `for-each-ref` 仍然报告的 ref。若第二条构造不出来，见新发现 4：那就说明这条分支应当删除或改写，而不是留着"看起来覆盖了"。

### 新发现 2（P3，覆盖缺口）**推送侧 `无法计算推送范围` 的 catch 分支没有用例钉住**

`rebaseViewProvider.ts:3082-3090`。我做了两个方向的变异：

| 副本 | 改动 | 结果 |
| --- | --- | --- |
| `mut19d` | 把 `pushRange` 里的 `if (res.code !== 0)` 改成 `if (false)`（即恢复成"范围算不出来 = 没有要推的"） | `pushNotification` + `pushIsolation` **35/35 全绿** |
| `mut19e` | 只把 catch 里的文案换成 `MUTATED catch` | 同上 **35/35 全绿**；单跑 `a locked commit is still blocked when the remote is named '-evil'` 也**绿** |

第二条尤其说明问题：`pushIsolation.test.ts:494` 的断言是 `assert.match(reported, /推送被拒绝|无法计算推送范围/)`，第一个分支永远成立，所以这条用例对 catch 文案**零约束**。而这一条 catch 正是本轮"silence is actually gone"的唯一可达实现（§三.1 已用 `mut19c` 证明它会渲染）。

**建议**：加一条断言 `pushRange` 抛错时**不出现成功提示**、且提示以 `无法计算推送范围` 开头（把 `mut19e` 与 `mut19d` 都钉住）。

### 新发现 3（P3，覆盖缺口）**`generate` 的 Compose 会话一致性闸没有用例钉住**

`rebaseViewProvider.ts:2540-2549`（`mode === "commit"` 时要求 `activeSession()?.hash === hash`，否则可见拒绝且不发 AI 请求）。这是本轮为 `getCommitDiff` 注入面加的第二道闸，注释明确写了"接受一个会话只证明面板是我们开的，不证明这条消息里的 hash 是面板的目标"。副本 `mut19f` 把 `if (!target || target !== hash)` 改成 `if (false)` 后，`composeDraft` + `webviewProtocolState` + `webviewDom` **20/20 全绿**——零覆盖。

**建议**：一条用例即可（把 `openCompose` 的会话 hash 与 `generate` 消息里的 hash 设成不同值，断言 `genError` 且 `llmClient` 未被调用）。

### 新发现 4（P3，主张/可达性）**`upstreamNote` 的 `else` 分支在我构造的所有 Git 形态下不可达；唯一能强制到达的形态里它又被丢掉**

`rebaseViewProvider.ts:426-431` 的注释说"One shared note covers every reason the range could not be computed, so a new shape cannot reintroduce the silent zeroes"。我按"上游不健康"的每一种形态构造真实仓库，实测结果：

| 形态 | `for-each-ref`（扩展的精确格式） | `getUpstream` | `rev-list --left-right --count` | 结果 |
| --- | --- | --- | --- | --- |
| 上游分支被 `fetch --prune` 清掉 | `…\t[gone]` | `undefined` | 不执行 | 走"未配置 upstream" |
| 配置了但从未 fetch | `[gone]` | `undefined` | 不执行 | 同上 |
| 跟踪 ref 是个 blob / tree / annotated tag | `[gone]` | `undefined` | 不执行 | 同上 |
| 跟踪 ref 是悬空 sha（对象不存在） | `[gone]` | `undefined` | 128 | 同上 |
| 跟踪 ref 是坏掉的 symref | `[gone]`（`warning: ignoring dangling symref`） | `undefined` | 128 | 同上 |
| 短名歧义（本地存在名为 `origin/master` 的分支） | `remotes/origin/master` | 有值 | **0**（只在 stderr 给 `warning: refname … is ambiguous`） | 计数正确，无 note |
| `HEAD` 历史里一个中间对象损坏 | `origin/master\torigin\trefs/heads/master`（**exit 0**，track 为空） | **有值** | **128** | **走到 note 分支**，但见下 |
| `git replace` 造假父提交 | exit 0 | 有值 | 0 | 无 note |

只有最后一类能到达 `else`。而这一类里，`getCommits` 读的是同一份历史，必然也失败：

```
真实构建（range=upstream 与 range=recentN 都试过）：
  state: {"error":"git log --date=short --pretty=format:… --end-of-options HEAD@{upstream}..HEAD failed (128): … is corrupt"}
  state keys: ["type","error","rebaseInProgress"]        ← 没有 upstreamRef/aheadCount/upstreamNote
```

原因是 `rebaseViewProvider.ts:447-451` 的 `catch` 以 `{ type, error, rebaseInProgress }` 提前返回，**没有展开 `...presentation`**。为了确认 note 确实被算出来了、只是被丢掉，我在副本 `mut19l` 里给这个 catch 加上 `...presentation`，同一个仓库立刻给出：

```
state: {"upstreamRef":"origin/master","aheadCount":0,"behindCount":0,
        "upstreamNote":"无法计算与 origin/master 的领先/落后（error: inflate: data stream error … is corrupt）",
        "error":"git log … failed (128): …"}
```

**这条不是用户可见的错误**：那种形态下用户看到的是带 Git 原文的错误横幅（`media/main.js:114`），而不是误导的 `↑0 ↓0`；注释的主张在"不会重新出现静默的 0/0"这个窄义上仍然成立。问题在于**两处**：
1. 注释/文档的说法比实现强——"任何原因都填同一个字段"在实现里只覆盖"`getUpstream` 有值且 `getCommits` 成功"的那一小块；
2. 这条分支实际上没有可达的真实形态，所以它现在的价值主要是"以后某个新形态出现时兜底"，而这个兜底本身在最需要它的时候（`getCommits` 也失败）会被丢掉。

**建议（择一）**：要么把 `getCommits` 的 catch 也展开 `...presentation`（一行，让 note 真的到达 webview），要么把注释改写成"当上游可解析但计数失败时"这一限定。前者更符合注释的原意，成本是一行。

### 新发现 5（P4，注释准确性）`gitRunner.ts` 对裸 `rev-parse` 的描述只覆盖了两个例子，还有一个真实站点不在其中

`src/git/gitRunner.ts:120-124`："the unsuffixed form is only used where the answer is a fixed ref name (`HEAD`, `--show-toplevel`)"。实际还有 `src/git/commitLog.ts:295` 的 `runGit(["rev-parse", sha])`，其 `<sha>` 来自 `.git/rebase-merge/stopped-sha` 的**文件内容**，不是固定 ref 名。

这一处的**防护是有效的**，只是不是"固定 ref 名"：裸 `rev-parse` 把选项原样回显而不执行（实测 `--output=<path>` 不落盘、`--git-dir=/tmp` 只打印 `--git-dir=…`、`--show-toplevel` 正常返回路径），且结果只被当作 sha 字符串使用。建议把这句改成"unsuffixed 形式用于固定 ref 名与来自仓库内部文件/索引的 sha——它不会执行选项，只会把选项回显到 stdout"，以免下一个人照抄时以为裸 `rev-parse` 只该出现在 `HEAD` 上。

### 新发现 6（P4，呈现）`upstreamNote` 直接拼接 Git stderr，而上下文栏是单行 `nowrap + ellipsis`

`rebaseViewProvider.ts:430` 把 `counts.stderr.trim()` 原样放进 note；`media/style.css:24-36` 的 `.branch-context` 是 `height: 29px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`。多行 stderr（我实测的损坏对象形态给了三行）会被压成一行再截断，用户很可能只看到"无法计算与 origin/master 的领先/落后（error: inflate…" 而看不到真正的原因 `fatal: … is corrupt`。

建议：取 stderr 的最后一行（`fatal:`/`error:` 通常在最前、`fatal` 在最后）或首行 + 省略号，并保持单行长度可控。低优先级，因为这条分支目前不可达（新发现 4）。

---

## 五、本轮要求额外检查的两件事

### 1. `upstreamNote` 会不会显示过期/误导的 note、问题消失后会不会残留

**不会。** 两个独立理由：

- **协议层**：`media/main.js:690` 对 `state` 是**整体替换**（`state = m`），不是合并；只有 `recoveryNotice` 那条消息用 `{ ...state, … }`。我在真实 provider 上走了"gone（计数 0/0、note `undefined`）→ healthy（计数 0/1、note `undefined`）"两步（`dash19.ts` 的 stale-check 段），两步都没有 note。也就是说：note 是每条 state 的派生量，不可能跨刷新残留。
- **构造层**：note 与计数在同一个 `if/else` 里互斥赋值（`rebaseViewProvider.ts:422-431`），不存在"note 存在而计数也是真值"的时刻；`branchContext` 还会对空白做 `trim() || undefined`（`rebasePresentation.ts:50`），空串不会变成一条空 note。`webviewDom.test.ts:580-590` 断言 note 存在时 `↑0 ↓0` 必须消失，这条我本轮重跑仍是绿。

唯一的"误导"风险不是残留，而是**不显示**（新发现 4）：note 被 `getCommits` 的 catch 丢掉时，用户看到的是原始 Git 错误而不是中文原因。这是信息形态问题，不是过期信息。

### 2. `withPositionals` 有没有改变任何**合法**范围的含义

我把 `rev-list` 的合法范围形状逐个在真实仓库上跑了一遍（`$TEMP/range19`、`$TEMP/brace19`、`$TEMP/dashall`、`$TEMP/amb19b`），全部带 `--end-of-options`：

```
origin/master...HEAD              exit=0  0	0
refs/remotes/origin/master..HEAD   exit=0  0	0
t1..HEAD                          exit=0  0	2
feat/x..HEAD                      exit=0  0	1
HEAD~1..HEAD                      exit=0  0	1
<40-hex>..HEAD                    exit=0  0	1
HEAD                              exit=0  0	3
origin/nested/master...HEAD       exit=0  0	0
v1..HEAD（annotated tag）          exit=0  0	2
light..HEAD（lightweight tag）     exit=0  0	1
master..HEAD                      exit=0  0	0
origin/feat{x}...HEAD（大括号）     exit=0  0	0
refs/remotes/origin/-foo2...HEAD  exit=0  0	0
- evil/-foo...HEAD（远端与分支都带 -） exit=0  0	0
```

以及一个**应当**失败的形状，用来确认标记没有把"真错误"变成"假成功"：

```
HEAD~10..HEAD   with marker: exit=128  fatal: ambiguous argument … unknown revision
                without marker: exit=128  同上
```

也就是说，标记之后仍然由 Git 判断范围是否合法；`128` 的原因与无标记时逐字相同（只有 `-evil` 这种**选项形状**从 129 变成 0，这正是想要的变化）。标记对 `--left-right --count` 的数值语义没有影响（`0 2`、`0 1`、`0 3` 都与我单独跑的同一条命令一致）。

---

## 六、我没有验证的部分

1. **完整 317 项套件是否全绿**——按约束没有跑（另有一轮在跑）。我用 **65 项定向用例** + 两个类型检查 + 独立静态计数 + 12 个变异副本替代，**不能等同**。本轮完全没执行的文件包括：`pendingRecoveryPolicy/` `pendingRecovery.settle` / `.append` / `.residual`（合计约 60 项）、`recoveryProvider.test.ts`（22 项）、`appendStaged` / `appendGuard` / `rebaseSafety` / `editStopCommit` / `worktree` / `llmClient` / `composeDraft`（整文件）等。
2. **`generate` 的会话闸是否真的能挡住一次 AI 请求**——我证明了它**没有用例**（`mut19f` 绿），但没有构造真实 LLM mock 去验证"打错 hash 时请求数确为 0"。`isLlmConfigured()` 依赖 `llmBaseUrl`/`apiKey` 两个设置同时非空，测试默认未配置，这也解释了为什么它天然没有覆盖。
3. **非 Git 2.53.0.windows.2 的版本**：`--end-of-options`（2.24+）、`%(upstream:track)`、`%(upstream:remotename/remoteref)` 在项目声明下限 **2.31.0** 上的行为没有实测。`stash store` / 裸 `rev-parse` 两条例外同样是 2.53 上的结论。
4. **非 C locale**：`getUpstream` 的 `[gone]` 与 `pushRefspec` 的英文散文判定都依赖 `LC_ALL=C`，我只在 C locale 下验证过。
5. **真实 VS Code GUI / Restricted Mode / 真实 webview 消息往返**：所有 provider 断言跑在 `test/helpers/vscodeStub.ts` 上（我另加了 `postInlineToast` 捕获），没有真实 webview。
6. **Linux/macOS**：路径分隔符、大小写敏感文件系统、`process.kill(-pid)` 的进程组行为未验证；本机全部是 Windows。
7. **真实远端服务器**：只对本地 bare 远端与 `file://` 验证过；没有对 GitLab/Gerrit 实测。
8. **性能**：本轮没有做任何计时对比；上一轮"`getUpstream` 单次 spawn、带 ref 模式"的结论沿用，未复测。
9. **`package-lock.json` 的 `0.8.2 → 0.8.3` 变更**：只确认版本号一致，没有审计依赖树。
10. **新发现 4 中"不可达"的范围**：我说"所有形态"只覆盖我构造出的 8 类 Git 状态。理论上仍存在一条我没构造出来的路径——例如**上游范围查询超时**（`DEFAULT_TIMEOUT = 120 s`）而 `getCommits` 不超时（`recentN` 只读 `-n 20`）。在超大仓库上这是可能的，我没有那样的夹具，也没有实测。

---

## 七、给 A 的清单（全部 P3/P4，不阻塞发布）

1. **（0.8.4，P3）** 给 `rebaseViewProvider.ts:430` 的 `upstreamNote` 赋值补一条**从 provider 出发**的用例——现在把这一行删掉，15 + 2 条相关用例全绿（`mut19j` / `mut19i`）。
2. **（0.8.4，P3）** 把 `rebaseViewProvider.ts:3082-3090` 的 catch 文案钉住，并断言 `pushRange` 抛错时**不出现成功提示**——现在吞掉抛出（`mut19d`）或换掉文案（`mut19e`）都是 35/35 绿。
3. **（0.8.4，P3）** 给 `generate` 的会话一致性闸补一条用例（`rebaseViewProvider.ts:2540-2549`），现在删掉它 20 条 compose/protocol/webview 用例全绿。
4. **（0.8.4，P3，一行）** 要么让 `getCommits` 的 catch 也展开 `...presentation`，让 note 真的到达 webview；要么把 `:426-431` 的注释与 `improvement.md` 的"任何原因"改写成"上游可解析但计数失败时"。注意这条分支目前**没有可达的真实形态**（`[gone]` 吸收了所有"上游不健康"），所以第一种做法要有对应夹具才有意义。
5. **（P4，注释）** `gitRunner.ts:120-124` 关于裸 `rev-parse` 的描述补上 `commitLog.ts:295` 这一类"来自仓库内部文件的 sha"，并把防护机制写成"裸形式只回显、不执行选项"。
6. **（P4，呈现）** `upstreamNote` 拼接 stderr 时取末行或首行 + 截断，避免单行 `ellipsis` 把真正原因挤掉。
7. **（流程）** 账本缺 `0-8-19` 行。本轮任务禁止我编辑账本，请 A 或所有者按本报告补记（基线 `577ce8766a46707a60c471cf8090e9f63cd8d49c`、被评审材料为未提交工作树、结论为维持批准）。

---

## 八、裁决与覆盖范围（重述）

**维持批准。** 本评审覆盖基线 `577ce87` 之上的未提交工作树（25 修改 + 11 untracked），以及由它构建的 **`dist-vsix/git-rebase-visual-0.8.3.vsix`**（12 条目、白名单通过、10 个 payload 与工作树逐字节相同、包内 `extension/dist/extension.js` 与现场重建 sha256 同为 `7b764af1…`）。

第六轮留下的四项，逐项闭合：

- **四.1**：两处 `rev-list` 都已带标记；真实 provider + 真实 `-evil` 远端上刷新得 `0 2`（真值一致）、推送得可见拒绝；去掉标记三条例用全红；`-evil/-foo` 这种最差形状有标记可用、无标记 exit 129。推送侧"无法计算推送范围"的可见文案我用真实 provider 捕获到了；刷新侧的 note 存在但不可达（新发现 4）。
- **四.2**：新用例在"只去掉 `getCommits` 标记"下变红、在"只去掉 `rev-parse` 闸"下不变红；旧用例改名后描述的正是它实际钉住的东西。
- **四.3**：`improvement.md` 关于 dash 远端的说法三处一致，不再自相矛盾。
- **四.4**：release notes 与 summary 都改为 `for-each-ref` + `%(upstream:track)` 的 `[gone]`，并把 `rev-parse --verify` 明确写为已取代；它声称的杀死性变异（去掉 `[gone]`）我复现出两条红。

没有回退：穷举比对了 48 处 `withPositionals` 调用点，未被标记的只剩 Git 内部常量、代码常量与两条文档化例外；标记在 14 条命令的正常用法上全部 `exit 0`；合法范围 14 种形状全部给出与真值一致的结果。

新发现 6 项全部 P3/P4，其中 3 项是覆盖缺口（新发现 1–3）、1 项是对"共享路径"主张的可达性修正（新发现 4）、2 项是注释/呈现措辞（新发现 5–6）。没有一项改变用户可见的正确行为，也没有一项落在发布阻断面上。

**结论：0.8.3 与 `dist-vsix/git-rebase-visual-0.8.3.vsix` 的批准继续有效；四.1–四.4 已按第六轮的要求真正修好。**
