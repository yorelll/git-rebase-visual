# Code Review 0-8-20 — 0.8.3 第八轮复核（第七轮六项新发现是否真的修好、`...presentation` 是否只带真话、note 的边界形状、打包产物）

- 评审日期：2026-11-07
- 评审角色：独立评审（Agent B，第八轮）
- 基线 commit：`577ce8766a46707a60c471cf8090e9f63cd8d49c`（`test: run each file in its own process and split the slowest suite`）
- 被评审材料：基线之上的**未提交工作树**——`git status --short` 共 **38 行**（**25 个修改文件** + **13 个 untracked**）。25 个修改文件中包含 12 个 `src/`、4 个 `test/`、5 个 `docs/`、`media/main.js`、`README.md`、`RELEASE.md`、`package.json` 与 `package-lock.json`；13 个 untracked 为 `src/ui/pushNotification.ts`、`test/composeSessionGate.test.ts`、`test/pushIsolation.test.ts`、`test/pushNotification.test.ts`、`test/restoreFileProtocol.test.ts`、`docs/release-notes/0.8.3.md` 与 `docs/review/code-review-0-8-13/14/15/16/17/18/19.md`。数字取自**我写本报告之前**的 `git status`。
- 本轮任务：第七轮（[`code-review-0-8-19.md`](code-review-0-8-19.md)）**维持了对 0.8.3 与 `dist-vsix/git-rebase-visual-0.8.3.vsix` 的批准**，并留下六项 P3/P4（新发现 1–6）。本轮**只验证这六项是否真的修好、有没有引入新缺陷**——批准本身不是本轮议题，但结论里必须回答它是否仍然成立。
- 顺序：先读 `code-review-0-8-19.md`（我自己的上一份报告），再读 `code-review-0-8-18.md`，再读账本 `docs/review/code-review-commit.md`。账本中 `0-8-13`…`0-8-19` 均有独立行；**`0-8-19` 行已补上**（`code-review-commit.md:51`，SHA 为基线并注明"被评审材料为未提交工作树"，结论写"维持批准、0 个新增产品行为缺陷、另列 6 项（3×P3 覆盖缺口 + 1×P3 可达性/主张 + 2×P4，均已在本轮修正）"）。第七轮的流程遗留项已闭合。
- 环境：Windows 11 + MSYS Git `git version 2.53.0.windows.2`，Node `v24.16.0`。本 shell 里 `node`/`npm` 解析不到，命令一律直接调用 `/d/Program Files/nodejs/node` 与 `node node_modules/tsx/dist/cli.mjs`。
- 本报告**不修改**任何既有评审报告、不修改账本、不修改 `src/`、`test/`、`media/`、`docs/`（除本文件）与仓库根目录文件。所有变异实验都在 `%TEMP%` 的**副本**里做，工作树的四个关键文件 sha256 与本轮开始时逐字节相同（见 §二）。

> **一条与项目约定的冲突，需要由项目所有者决定**：项目 `CLAUDE.md` 要求评审者在完成评审后**更新账本**并写入 SHA/文件名/状态/日期；本轮任务明确禁止我编辑账本（"Do not edit the ledger"）。我遵循了任务约束，因此本报告的账本行仍需 A 或所有者补记。第七轮同样如此，而那条记录**已经被补上了**，说明这条分工在实践中可行。

---

## 一、结论摘要

| 复核项 | 结论 |
| --- | --- |
| **新发现 1**（P3）provider 的 `upstreamNote` 赋值有无用例 | **已修复，且用例非空转**。新增 `test/pushIsolation.test.ts:629` 的 `refresh shows the 'cannot compute' note instead of 0/0 when the count fails`，走真实 `RebaseViewProvider.refresh()` + 真实 bare 远端 + 真实损坏对象。我在副本 `m1` 里把 `rebaseViewProvider.ts:440` 的赋值换成注释，该用例**红**：`AssertionError: the note names the upstream it could not measure; saw undefined`。用例还带一条前置断言（`getUpstream` 仍返回 `origin/master`），防止滑到无关的"未配置 upstream"路径——这条前置断言是第七轮我点名要求的，A 按要求做了。 |
| **新发现 2**（P3）推送侧 `无法计算推送范围` 的 catch 有无用例 | **已修复，两个方向都可杀**。新增 `test/pushIsolation.test.ts:673` 的 `a push whose range cannot be computed reports that, and never reports success`，断言四件事：文案带 `无法计算推送范围（origin/master..HEAD）：`、带 Git 自己的失败、带 `未执行推送`、且**不出现** `/已推送/` 与 `/推送被拒绝/`。副本 `m2a`（`pushGuard.ts:128` 的 `if (res.code !== 0)` 改成 `if (false)`，即"失败范围当作空范围"）→ **红**，实测可见文案变成 `推送到 origin/master？（HEAD:refs/heads/master）\nrefspec 的源端 HEAD 不是可解析的 commit：…`（走了另一条分支）；副本 `m2b`（catch 文案换成 `MUTATED catch …`）→ **红**，`expected: /无法计算推送范围（origin\/master\.\.HEAD）：/`。 |
| **新发现 3**（P3）Compose 会话一致性闸有无用例 | **已修复，且有正向对照**。新增 `test/composeSessionGate.test.ts` 三条（3 条全部通过）：拒绝错 hash / **同一条消息在 hash 匹配时成功**（断言 `fetch` 被调用一次且打到 `/chat/completions`）/ 真正到达模型的请求体里是**会话的** commit 而不是消息里的。副本 `m3` 把 `rebaseViewProvider.ts:2560` 的 `if (!target \|\| target !== hash)` 改成 `if (false)`：拒绝用例**红**，`AssertionError: no AI request was sent; saw ["http://127.0.0.1:9/v1/chat/completions"]`（即闸被关掉后请求**真的发出去了**），而两条正向对照**仍然绿**——这正是"非空转"的判据。 |
| **新发现 4**（P3）`...presentation` 是否让 note 到达 webview、注释是否收窄 | **两件都做了，且我独立复现**。我**不用** A 的夹具，自己建仓库→损坏对象→观察 state→**修回原字节**→再刷新：损坏时 `STATE(corrupt)` 的 `upstreamNote` 是 `无法计算与 origin/master 的领先/落后（fatal: loose object 13f67ff1… is corrupt）`，9 个 presentation 键（`type/error/rebaseInProgress/branchName/upstreamRef/aheadCount/behindCount/upstreamNote/rangeLabel`）齐备；修好后 `STATE(repaired)` 的 `upstreamNote` 是 `undefined`、计数 `0/0`（真值），**没有残留**。副本 `m4a`（去掉 `...presentation`）→ 同一条用例**红**（`saw undefined`）。注释也收窄为"只覆盖'`getUpstream` 解析出了上游、但计数失败'"，并明确写出 pruned / never-fetched / dangling / symref-broken / 非 commit 跟踪 ref 都由 `[gone]` 吸收。**A 的"必要性"主张成立**：我另外构造了 6 类"上游不健康"形态，全部得到 `[gone]` → `getUpstream` 返回 `undefined`，`getCommits` 不会失败；反过来也找到了一个反向形状（分叉仓库 + 深处对象损坏时计数 `exit 0` 而 `git log -n 20 HEAD` `exit 128`），它**不**产生"有 note 却没 error"的新路径。 |
| **新发现 5**（P4）`gitRunner.ts` 裸 `rev-parse` 注释是否覆盖 `commitLog.ts` 站点 | **已修复，且改成了真正的不变式而不是再举一个例子**。现注释点名 `commitLog.ts` 里那个 `rev-parse <sha>`（sha 来自 `.git/rebase-merge/stopped-sha` 的**文件内容**），并把防护机制写成"裸 `rev-parse` 只**回显**、不**执行**选项形状的参数；每个调用方都把它当名字字符串；只有既传不可信输入、又解析名字以外输出的站点才必须用 `--verify`"。我复测 `git rev-parse --output=<path>` 仍然只在 stdout 回显、**不创建文件**，该不变式成立。 |
| **新发现 6**（P4）note 单行化与截断 | **已修复，但有两条残留（见下）**。`upstreamNoteDetail()` 取末条非空行、兼容 CRLF、按**码点**截断到 `NOTE_DETAIL_LIMIT = 140`、空 stderr 回退 `git rev-list 退出码 N`。我实测六种边界：CRLF 三行 → `fatal: the reason`；多字节路径 `中文目录/文件` 完整保留；纯 astral 200 个与 `a`+astral 混合都给出 141 个码点且**无孤立代理**；空 stderr → `git rev-list 退出码 137`；纯空白 stderr → `git rev-list 退出码 1`。副本 `m4b`（返回整段 stderr）→ 单测与 provider 用例**双红**。**但**：(a) `test/rebasePresentation.test.ts:73-75` 用的"emoji"是 `✨`（U+2728，BMP，UTF-16 长度 1），所以把实现改成 UTF-16 切片（副本 `m5`）后该文件 **4/4 全绿**——实现是对的，用例钉不住它（新发现 2）；(b) "取末条非空行"这个启发式对 `unknown revision` 形态取到的是 Git 的**用法提示**而不是 `fatal:` 行（新发现 1）。 |
| **测试计数** | **323 项 / 47 个文件**，独立枚举一致。`grep -rhoE '^\s{0,4}test\(' test/*.test.ts` = **323**，`ls test/*.test.ts \| wc -l` = **47**；`RELEASE.md:136`、`docs/summary/summary.md:150`、`docs/release-notes/0.8.3.md:44` 三处均为 **323**。`RELEASE.md:136` 还逐条列出了本轮新增的 6 条（provider note 1 条 + 推送范围失败 1 条 + Compose 闸 3 条 + note 单行化 1 条）。与第七轮的 317 相比 +6，差额能对上。 |
| **重建后的 VSIX** | **12 个条目、白名单通过、payload 逐字节相同**。`node scripts/package-vsix.js --verify-only` → `VSIX contents match the allowlist (12 entries).`；解压后 **10 个文件全部 IDENTICAL**：`readme.md`/`package.json`/`.gitignore`/`LICENSE.txt`/`media/{style.css,main.js,icon.svg,extension-icon.png}`/`dist/{seq-editor.js,extension.js}`（`LICENSE.txt`/`readme.md` 是 `vsce` 打包改名，源为 `LICENSE`/`README.md`，`LICENSE` 与包内 `extension/LICENSE.txt` 的 sha256 同为 `5b78c0db…`）。包内 `extension/dist/extension.js` 与**现场 `node esbuild.js` 重建结果同为** `d912c484d160371287d289285a6aeb062e2aa386a731de30d9db81b83ba90266`（287519 字节）。三次重建后 `dist/extension.js` 的 sha256 **都没有变**，说明构建是确定性的。包内代码确认含本轮修复：`upstreamNoteDetail` ×2、`NOTE_DETAIL_LIMIT` ×3，以及 `无法计算与 …`、`生成目标与 Compose 会话不一致`、`无法计算推送范围`、`未执行推送`（均为 esbuild 的 `\uXXXX` 大写转义形式）。 |
| **是否引入新缺陷** | **没有产品行为缺陷**，但有 **2 项 P3 + 2 项 P4** 的新发现，全部是"测试钉不住"或"注释说过头"，以及 1 项**本轮之前就存在**的 webview 渲染缺陷。`...presentation` 只带**真话**：它携带的 `branchName`/`upstreamRef`/`rangeLabel` 在该状态下都是真实解析出来的，`aheadCount`/`behindCount` 为 `0`，而 `upstreamNote` 存在时 webview 显示的是 `↑? ↓? · <原因>`，**不显示**这两个 0——所以不存在"显示误导性的 branch/upstream/计数"的情况。`upstreamNote` 不会残留（`state` 是整体替换，且我实测"损坏→修复"两步）。 |
| **第七轮的批准是否仍成立** | **成立**。六项逐项都有红/绿双方向的实测证据；两项残留（emoji 断言空转、`unknown revision` 取错行）都**没有改变今天任何可达路径下的用户可见行为**（`unknown revision` 形态当前一律先被 `[gone]` 吸收）。VSIX 可由当前工作树确定性重建且与工作树逐字节一致。 |

### 裁决：**维持批准**

**本评审确认 `code-review-0-8-19.md` 对 0.8.3 的批准仍然有效，并继续覆盖 `dist-vsix/git-rebase-visual-0.8.3.vsix`。**

理由，逐条对上证据：

1. **六项整改都不是"看起来修了"**。第七轮我点名的是"功能是好的，但没有用例会让它在被改坏时变红"。本轮我在**副本**上做了 6 个最小变异（删一行赋值、关一个 `if`、换一段文案、去掉一处展开、返回整段 stderr、改成 UTF-16 切片），前 5 个**都让对应的用例变红**，而且失败断言报的正是我预期的那一句。第 6 个（UTF-16 切片）**没有变红**，这本身是一条新发现，不是"整改失败"——因为实现用的是 `Array.from`，是真的按码点截断，只是用例选的字符钉不住它。
2. **没有回退**。第七轮关闭的 48 处 `withPositionals` 穷举审计没有重开，我也确认 `pushGuard.ts` 的 `[gone]` 判定、`commitLog.ts` 的四类 `RangeArgv` 分支、`pushIsolation.test.ts` 的 `-evil` 三条都还在原处。`build` 仍能被现场重建出同一个 sha256。
3. **`...presentation` 这个"最小改动"没有把错误信息变成谎话**。这是本轮要求里最尖的一问，我给了三重理由（协议层整体替换、note 与计数在同一 `if/else` 互斥、webview 在 note 存在时**替换**而非并列箭头计数），并实测了"损坏→修复"的完整往返。
4. **本轮新增的措辞有一处自己就是被第七轮撤回过的说法**（新发现 3）：`rebasePresentation.ts:51-53` 的 JSDoc 与 `improvement.md:205` 仍写"任何原因（上游被 prune、配置了但 ref 不解析、退出码非零）都填同一个字段"，而 `rebaseViewProvider.ts:429-439` 的注释和 `improvement.md:214`（新的 P3-7 段）已经改口。这是**文档自相矛盾**，不是产品缺陷。

四项新发现全部 P3/P4，**不含 P0/P1/P2**，也不含任何"用户会看到错的东西"的问题，因此不构成发布阻断。

---

## 二、我实际跑了什么（以及没有跑什么）

### 2.1 类型与定向用例

```text
node node_modules/typescript/bin/tsc --noEmit                          exit 0，零输出
node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit    exit 0，零输出

node node_modules/tsx/dist/cli.mjs --test --test-concurrency=3 \
     test/rebasePresentation.test.ts test/composeSessionGate.test.ts
  → tests 7 / pass 7 / fail 0

node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 \
     --test-name-pattern="cannot compute" test/pushIsolation.test.ts
  → tests 1 / pass 1 / fail 0

node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 \
     --test-name-pattern="upstreamNote|cannot compute|note" test/webviewDom.test.ts
  → tests 1 / pass 1 / fail 0

node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 test/pushNotification.test.ts
  → tests 20 / pass 20 / fail 0（136.6 s）
```

**完整 323 项套件不是我跑的**——按任务约束，另有一个全量进程在跑，我只跑定向文件。这三次定向合计 **29 项**，外加 6 个变异副本上的定向重跑。

### 2.2 变异副本（全部在 `%TEMP%` 下，工作树未动）

每个副本 = 当前 `src/` + `test/` 的全量拷贝 + 一个指向仓库 `node_modules` 的 **junction**。`mklink /J` 从 Git Bash 调用会静默失败（exit 2、无 junction），改用 `powershell -NoProfile -Command "New-Item -ItemType Junction …"` 并逐个验证 `tsx/dist/cli.mjs` 存在。

| 副本 | 变异 | 目标用例 | 结果 |
| --- | --- | --- | --- |
| `m1` | `rebaseViewProvider.ts:440` 的赋值 → 注释 | `refresh shows the 'cannot compute' note …` | **红**：`the note names the upstream it could not measure; saw undefined` |
| `m2a` | `pushGuard.ts:128` `if (res.code !== 0)` → `if (false)` | `a push whose range cannot be computed …` | **红**：走了 `refspec 的源端 HEAD 不是可解析的 commit` 分支，`expected: /无法计算推送范围（origin\/master\.\.HEAD）：/` |
| `m2b` | 推送 catch 文案 → `MUTATED catch …` | 同上 | **红**：`saw "MUTATED catch git rev-list origin/master..HEAD failed (128): …"` |
| `m3` | `:2560` `if (!target \|\| target !== hash)` → `if (false)` | `generate refuses a hash that is not the open Compose session's target` | **红**：`no AI request was sent; saw ["http://127.0.0.1:9/v1/chat/completions"]`；两条正向对照**仍绿** |
| `m4a` | `:468` 去掉 `...presentation` | `refresh shows the 'cannot compute' note …` | **红**：`saw undefined` |
| `m4b` | `upstreamNoteDetail` → `return counts.stderr` | 单测 + provider 用例 | **双红**：`the last non-empty, CRLF-trimmed line is the one shown` / `the note is one line, not Git's whole stderr` |
| `m5` | `Array.from`+`chars.slice` → `last.length`+`last.slice`（UTF-16） | `the count-failure detail is … bounded` | **绿 4/4** ← 这就是新发现 2 |
| `m6` | 旧基线快照（非本轮变异，留作对照） | — | — |

### 2.3 我自己的探针（不复用 A 的夹具）

- `note20.ts`：手建仓库 + bare 远端 → 让两端 tip 相同 → 损坏**倒数第二个** commit 的对象 → 调真实 `getUpstream` + 真实 `refresh()` → 读 state → **把对象原字节写回** → 再 `refresh()`。用来回答"note 到不到 webview"和"修好后会不会残留"。
- `mb20.ts`：直接喂 `upstreamNoteDetail` 六种边界（多字节路径 / 纯 astral / BMP+astral 混合 / CRLF 三行 / 空 stderr + 非零退出 / 纯空白 stderr），检测孤立代理。
- `domchk4.js`：JSDOM + 真实 `media/main.js`，分别加载**当前**与**基线 `577ce87` 版**的 `main.js`，投递一条**缺 `commits`** 的 state，捕获渲染异常。
- 六个手建 Git 形态仓库：`gone20`（prune）、`nores20`（配置了但 ref 不解析）、`blob20`（跟踪 ref 指向 blob）、`amb20`（短名歧义）、`miss20`（跟踪 ref 对象缺失）、`div`（分叉 + 深损坏），逐一测 `for-each-ref --format=%(upstream:track)` 与 `rev-list`。
- `shapes`：直接量 `git rev-list --left-right --count nosuchref...HEAD` 的 stderr 形状。

### 2.4 清理与进程

所有 junction **先删链接再删父目录**（用 `DirectoryInfo.Delete()`，避免 `Remove-Item -Recurse` 跟随链接把仓库的 `node_modules` 删掉）；删除后确认仓库 `node_modules` 仍有 **265** 个条目。整个 `%TEMP%\grv20` 已删除。`Get-Process node` 回到**基线 3 个**（`15596`/`35732` 起于 11-06 15:01，`28968` 起于 11-03 13:24），**没有**我启动的进程存活；所有探针脚本以 `process.exit(0)` 结尾。

工作树复核：`git status --short` 仍 **38** 行，`git stash list` 空，四个关键文件 sha256 与本轮开始时一致：

```text
99623ab8…  src/ui/rebaseViewProvider.ts
675db81c…  src/ui/rebasePresentation.ts
58f587aa…  src/git/gitRunner.ts
88fe8591…  media/main.js
```

（`dist/extension.js` 被 `node esbuild.js` 重写过，但它是 `.gitignore:3` 忽略的构建产物，sha256 与重写前、与包内一致，`git status` 不受影响。）

---

## 三、逐项复核（证据均为本轮实测输出）

### 1. 新发现 1：provider 的 `upstreamNote` 赋值现在有用例，且用例不可空转

第七轮的问题是"只有合成值喂给 presentation 层，没有一条从 provider 走到 webview"。现在的用例在 `test/pushIsolation.test.ts:629`，结构上有三处是我要的：

```ts
const up = await getUpstream(cwd, "master");
assert.ok(up, "the upstream still resolves, so the count is attempted at all");
assert.equal(up!.ref, "origin/master");
```

这条**前置断言**是关键：如果将来 `getUpstream` 开始对这个形状返回 `undefined`，用例不会"因为走了另一条路而通过"，而是先在 `assert.ok(up)` 上红。我特意确认过它的必要性——`gone20` 里 prune 之后 `for-each-ref` 给的是 `master|origin/master|[gone]`，`getUpstream` 返回 `undefined`；如果夹具滑到那个形状，`upstreamNote` 天然是 `undefined`，用例就什么也没钉住。

`m1` 的失败信息也确认了断言点在 note 上，不是在 error 上：

```text
✖ refresh shows the 'cannot compute' note instead of 0/0 when the count fails
  AssertionError [ERR_ASSERTION]: the note names the upstream it could not measure; saw undefined
```

**结论：已修复。**

### 2. 新发现 2：推送侧 catch 的文案与"不报成功"都被钉住

第七轮的论点是"原断言 `/推送被拒绝|无法计算推送范围/` 的首个分支恒真，所以零约束"。新用例换成了三条正向 + 两条**否定**断言：

```ts
assert.match(visible, /无法计算推送范围（origin\/master\.\.HEAD）：/, …);
assert.match(visible, /git rev-list origin\/master\.\.HEAD failed \(128\)/, …);
assert.match(visible, /未执行推送/, …);
assert.doesNotMatch(visible, /已推送/, …);
assert.doesNotMatch(visible, /推送被拒绝/, …);
assert.equal(harness.titles.length, 0, "the progress surface never opened");
```

两个方向我都实测了：

- `m2a`（"失败范围当作空范围"）——这条变异的语义是**根因**，不只是文案：`if (false)` 之后 `pushRange` 不再抛，`lockedInPush` 会把空数组读成"范围内没有锁定 commit"，于是走到真正的推送分支。用例**红**，且报出的 `visible` 是 `推送到 origin/master？（HEAD:refs/heads/master）\nrefspec 的源端 HEAD 不是可解析的 commit：error: inflate: data stream error …`——证明它确实换了分支，不是文案漂移。
- `m2b`（只换文案）——**红**，`saw "MUTATED catch git rev-list origin/master..HEAD failed (128): …"`。

另外，用例注释里那段"检查了锁是否真的存进去"（`assert.equal(store.lockedHashes(root).size, 1)`）也不是装饰：没有锁时 `lockedInPush` 在查范围之前就返回了，用例会走"无锁快路径"而什么都没测。

**结论：已修复。**

### 3. 新发现 3：Compose 会话闸有三条用例，其中两条是正向对照

这条第七轮只是"发现零覆盖"，A 的做法比我要求的更完整——不只加了一条拒绝用例，还加了"同一个消息在 hash 匹配时**应该**成功"和"真正到达模型的请求体里是**会话的** commit"。

`m3` 的失败信息正是"闸被关掉后 AI 请求真的发出去了"：

```text
✖ generate refuses a hash that is not the open Compose session's target
  AssertionError [ERR_ASSERTION]: no AI request was sent; saw ["http://127.0.0.1:9/v1/chat/completions"]
```

而同一副本里两条正向对照**仍然是绿的**——这排除了"用例其实是因为别的原因红"的可能。

用例还需要 `gitRebaseVisual.commitRange = "all"`（夹具没有远端），这个设置是必要的，否则 `resolveRange` 会先在第一道门失败、闸根本没被走到。

**结论：已修复。**

### 4. 新发现 4：`...presentation` 让 note 到达 webview，且只带真话

这是本轮要求里"最该盯"的一处，我做了两件事：**不用 A 的夹具自己复现**，以及**逐字段审查 `...presentation` 会不会带误导值**。

#### 4.1 独立复现（`note20.ts`）

```text
tips identical? true
getUpstream healthy:        {"remote":"origin","branch":"master","ref":"origin/master"}
corrupted:                  13f67ff10af7f19d329e08f5a6e85b298e405cb5
getUpstream after corrupt:  {"remote":"origin","branch":"master","ref":"origin/master"}
rev-list count exit:        128
STATE(corrupt): {
  "upstreamRef":"origin/master","ahead":0,"behind":0,
  "note":"无法计算与 origin/master 的领先/落后（fatal: loose object 13f67ff1… is corrupt）",
  "error":"git log --date=short … HEAD failed (128): …",
  "keys":["type","error","rebaseInProgress","branchName","upstreamRef",
          "aheadCount","behindCount","upstreamNote","rangeLabel"]
}
rev-list count exit after repair: 0
STATE(repaired): {"upstreamRef":"origin/master","ahead":0,"behind":0}
```

三点结论：

1. **note 确实到得了 webview**——`upstreamNote` 在 state 里，且 9 个 presentation 键齐备。
2. **修好后不残留**——`STATE(repaired)` 里 `upstreamNote` 是 `undefined`，计数是真值 `0/0`（这个仓库两端 tip 相同，所以 `0/0` 是真话，不是第七轮那种"假 0/0"）。
3. **`m4a` 证明展开是承重的**：去掉 `...presentation` 后同一条用例红在 `saw undefined`。

#### 4.2 `...presentation` 会不会显示误导性的 branch / upstream / ahead-behind？

逐字段：

| 字段 | 这个状态下是否为真 | 依据 |
| --- | --- | --- |
| `branchName` | **真**。`currentBranch(root)` 成功取到了 `master`。 | `note20` 的 STATE 显示 `branchName` 有值 |
| `upstreamRef` | **真**。`getUpstream` 用一次 `for-each-ref` 读到 `origin/master`，且 `[gone]` 判定未触发。 | `getUpstream after corrupt` 返回同一个 ref |
| `rangeLabel` | **真**。`rangeLabel(rangeConfig)` 只依赖设置，不依赖 Git 状态。 | `rebasePresentation.ts` 纯函数 |
| `aheadCount` / `behindCount` | **是 `0`，且不可信** | 见下 |
| `upstreamNote` | **真**，且它存在的目的就是否掉上面那两个 0 | 主渲染逻辑 |

关键是最后两行。**这两个 `0` 不可信，但用户看不到它们**：`media/main.js:89-92` 是

```js
const counters = state.upstreamNote
  ? `↑? ↓? · ${state.upstreamNote}`
  : `↑${state.aheadCount || 0} ↓${state.behindCount || 0}`;
```

note 存在时**替换**而不是并列。我的 `domchk4.js` 用真实 `media/main.js` 验证了这一点：

```text
CURRENT  | thrown=null | errs=[…] | ctx="main · origin/main · ↑? ↓? · NOTE-abc · "
BASELINE | thrown=null | errs=[…] | ctx="main · origin/main · ↑0 ↓0 · "
```

所以"显示误导性的 ahead/behind"这条路径**不成立**。我也确认了 `media/main.js` 里 `aheadCount`/`behindCount` 的**唯一**消费者就是这一行（`grep -n` 只命中 `:92`），没有第二处会绕过 note 去渲染这两个数。

#### 4.3 A 的"必要性"主张：有 note 时 `getCommits` 一定失败吗？

这是第七轮我质疑的地方（"`[gone]` 吸收了几乎所有形态"）。A 现在的说法是"唯一实测可达的形状是 HEAD 历史里的损坏对象 `getCommits` 会一起失败"，我做了双向检验：

- **正向**：prune / 配置了但 ref 不解析 / 跟踪 ref 指向 blob / 短名歧义 / 跟踪 ref 对象缺失 —— 五类全部落在 `[gone]` 或"没有 upstream"，`getUpstream` 返回 `undefined`，note 分支不进入。其中 `nores20` 我特意验证了 JSDoc 里点名的那个形状：

  ```text
  master|origin/does-not-exist|refs/heads/does-not-exist|[gone]
  ```

  也就是说"配置了但 ref 不解析"同样被 `[gone]` 吸收，**不会**进入 note 分支。
- **反向**：`div` 里分叉仓库 + 深处对象损坏，`rev-list --left-right --count` 给 `0 3`（`exit 0`），而 `git log -n 20 HEAD` 是 `exit 128`。这产生的是"有 error 没有 note"，而不是"有 note 没有 error"——**没有**给 `...presentation` 的必要性造成反例。

**结论：已修复；注释也收到了实测可达的范围。**

### 5. 新发现 5：裸 `rev-parse` 的注释现在写的是不变式

第七轮的批评是"只举了两个例子，漏了 `commitLog.ts` 里那个来自 `.git/rebase-merge/stopped-sha` 的 sha"。现在的注释：

- 点名了这个站点与它的来源（**文件内容**，不是用户输入）；
- 把防护机制从"举例"改成可检验的命题：裸 `rev-parse` **只回显、不执行**选项形状的参数，且每个调用方都把它当**名字字符串**；
- 给出判据：只有"既传不可信输入、**又**解析名字以外的 stdout"的站点才必须 `--verify`。

我复测了这条不变式：`git rev-parse --output=<path>` 仍然只在 stdout 回显、**不创建文件**。这条比原来"列两个例子"的写法好，因为它是**可判定的**——将来新增站点时可以用那三条判据去套。

**结论：已修复。**

### 6. 新发现 6：单行化、有界、按码点截断——都对，但两条残留

#### 6.1 六种边界形状（`mb20.ts`）

```text
multi-byte path        | cp= 67 | lone=false | "fatal: loose object abc (stored in .git/objects/中文目录/文件"
astral only            | cp=141 | lone=false | "🌟…🌟\ud83c"（141 码点 = 140 + 省略号）
bmp+astral mixed       | cp=141 | lone=false | "a🌟…🌟"
crlf 3 lines           | cp= 17 | lone=false | "fatal: the reason"
empty stderr nonzero   | cp= 20 | lone=false | "git rev-list 退出码 137"
whitespace only        | cp= 18 | lone=false | "git rev-list 退出码 1"
limit=140
```

第六项（纯空白 stderr）第七轮没要求，是我加的：`.filter(Boolean)` 在 `trim()` 之后过滤，所以纯空白也走回退分支，得到 `退出码 1` 而不是一个空的 `（）`。

#### 6.2 残留 A（P3）：`✨` 是 BMP 字符，那条防孤立代理的断言是空转

`test/rebasePresentation.test.ts:73-75`：

```ts
const emoji = "✨".repeat(NOTE_DETAIL_LIMIT + 5);
assert.equal(Array.from(upstreamNoteDetail({ … stderr: emoji })).length, NOTE_DETAIL_LIMIT + 1);
assert.equal(upstreamNoteDetail({ … stderr: emoji }).includes("�"), false);
```

`✨` 是 **U+2728**，UTF-16 长度 **1**、码点长度 **1**——它根本不是代理对。所以把实现改成 UTF-16 切片（`m5`）之后，该文件 **4/4 全绿**：

```text
✔ branch context exposes branch, upstream and divergence
✔ branch context carries the reason when the counts could not be computed
✔ the count-failure detail is the last stderr line, on one line, and bounded
✔ branch context gives explicit detached and no-upstream labels
ℹ tests 4 / pass 4 / fail 0
```

我另外证明了这个变异**真的会**产生孤立代理，只是只有真 astral 字符才暴露：`a` + 200 个 U+1F31F 时，UTF-16 切片（`m5`）得到 `utf16len=141, cp=72, loneSurrogate=true`、结尾是 `"🌟\ud83c…"`；而正确实现得到 `utf16len=280, cp=141, loneSurrogate=false`、结尾是 `"\udf1f🌟…"`。

**实现是对的**（`Array.from` + `chars.slice`），**用例钉不住它**。这是测试质量问题，不是产品问题。

#### 6.3 残留 B（P4）：`unknown revision` 形态下"末条非空行"取到的是 Git 的用法提示

`upstreamNoteDetail` 的 JSDoc 声称末条非空行"is both the most specific and **the line Git guarantees to print**"。这个断言对 `unknown revision` 形态是可测地不成立的：

```text
$ git rev-list --left-right --count nosuchref...HEAD   # exit=128
fatal: ambiguous argument 'nosuchref...HEAD': unknown revision or path not in the working tree.
Use '--' to separate paths from revisions, like this:
'git <command> [<revision>...] -- [<file>...]'
```

三行，**最后一行是用法提示**。实测 `upstreamNoteDetail` 对这一形状返回：

```text
UNKNOWN_REVISION -> "'git <command> [<revision>...] -- [<file>...]'"
```

——用户会看到 `↑? ↓? · 无法计算与 X 的领先/落后（'git <command> [<revision>...] -- [<file>...]'）`，真正的原因（`fatal: ambiguous argument …`）被丢掉了。

严重度是 **P4**，因为这条分支**今天不可达**：`nores20` 证明"配置了但 ref 不解析"会被 `[gone]` 吸收，`blob20` 证明非 commit 跟踪 ref 也会，短名歧义（`amb20`）连 upstream 都不报。唯一能走到这里的是损坏对象形态，而它的 stderr 末行确实是 `fatal:` 行。所以这是**潜伏的**缺陷，不是用户今天能看到的问题。

A 的 JSDoc 里"Git guarantees to print"这半句应当改掉——第七轮我刚因为同类"说过头"提过一条，这次又出现了。

**结论：实现正确，用例与注释各有一条残留。**

---

## 四、新发现（按严重度）

### 新发现 1（P4，呈现/correctness，潜伏）`upstreamNoteDetail` 的"末条非空行"启发式对 `unknown revision` 形态取到用法提示

见 §三.6.3。三行 stderr 的末行是 `'git <command> [<revision>...] -- [<file>...]'`，`upstreamNoteDetail` 会把它当成原因显示，真正的原因在**第一行**。

**可达性**：今天不可达（`[gone]` 吸收了所有"上游不健康"形态，见 §三.4.3）；唯一可达的损坏对象形态末行确实是 `fatal:`。**但如果将来放宽 `[gone]` 判定、或 Git 改变 `[gone]` 的适用范围，这条会立刻变成用户可见的错信息。**

**建议**（0.8.4，一行）：优先取匹配 `/^(fatal|error):/` 的**最后一条**，没有才回退到末条非空行；或直接取**首条**非空行（对损坏对象形态是 `error: inflate: data stream error`，不如现在的 `fatal:` 精确，所以第一种更好）。同时把 JSDoc 的"the line Git guarantees to print"改成实测结论。

### 新发现 2（P3，测试质量）`test/rebasePresentation.test.ts` 用 `✨` 冒充代理对，防孤立代理的断言是空转

见 §三.6.2。`✨` = U+2728，UTF-16 长度 1。把实现改成 UTF-16 切片后 4/4 全绿。

**注意这不是 A 一个人的问题**：第七轮我提"按码点截断"时也没有说要配一个真 astral 字符的用例，A 写了，只是选错了字符。

**建议**（0.8.4，两行）：把 `"✨"` 换成 `"\u{1F31F}"`（或任何一种 BMP + astral 的**混合**串，因为纯 astral 串在偶数边界上仍可能"碰巧"不产生孤立代理——我实测纯 astral 在 `m5` 下 `loneSurrogate=false`，只有 `a`+astral 才暴露）。用例应断言 `Array.from(...).length === NOTE_DETAIL_LIMIT + 1` 且不含孤立代理正则。

### 新发现 3（P4，文档/注释一致性）被第七轮撤回的"任何原因"说法，仍活在两处

`rebaseViewProvider.ts:429-439` 的注释已经收窄成"只覆盖'`getUpstream` 解析出了上游、但计数失败'"，`improvement.md:214`（新的 P3-7 段）也写了同样的收窄。但：

- `src/ui/rebasePresentation.ts:51-53`（`BranchContextInput.upstreamNote` 的 JSDoc）仍写："This is one shared slot on purpose. **Two shapes leave the counts unknown (a pruned/absent upstream, and a configured upstream whose ref does not resolve)**"。
- `docs/improvement/improvement.md:205` 仍写："任何原因（**上游被 prune、配置了但 ref 不解析**、退出码非零）都填同一个字段"。

而这两处声称的形状**实测都不会进入 note 分支**——`gone20` 的 `master|origin/master|[gone]` 与 `nores20` 的 `master|origin/does-not-exist|refs/heads/does-not-exist|[gone]` 都让 `getUpstream` 返回 `undefined`。

这是**同一个文件里 28 行之外就自我推翻**的情况（`improvement.md:205` 在 `:214` 之上），与第六轮四.3 的形状完全一样。

**建议**（0.8.4，两处措辞）：把这两处也改成"上游可解析但计数失败时"。

### 新发现 4（P3，既有缺陷，非本轮引入）缺 `commits` 的 state 会抛在 `renderList`，横幅与上下文已渲染

我按任务要求检查 `upstreamNote` 的 DOM 呈现时发现的：`media/main.js:348` 的 `state.commits.map(...)` 没有守卫。我用 `domchk4.js` 分别加载**当前**与**基线 `577ce87`** 的 `main.js`，投递一条缺 `commits` 的 state：

```text
CURRENT  | jsdomError: Uncaught [TypeError: Cannot read properties of undefined (reading 'map')] | ctx="main · origin/main · ↑? ↓? · NOTE-abc · "
BASELINE | jsdomError: Uncaught [TypeError: Cannot read properties of undefined (reading 'map')] | ctx="main · origin/main · ↑0 ↓0 · "
```

**两边完全一样，因此不是本轮引入的。** 渲染顺序是 `renderBanner(); renderContext(); renderChanges(); renderList();`，所以横幅（`error`）与上下文（含 `↑? ↓? · <note>`）**已经画出来了**才抛——用户能看到错误横幅和 note，只是 commit 列表空着。

provider 里有四个 `{type:"state", error}` 且不带 `commits` 的站点（`:352`、`:356`、`:454`、`:468`）。第七轮新发现 4 让 `:468` 展开 `...presentation`，**没有**扩大这个缺陷（`...presentation` 不含 `commits`），只是它现在多带几个字段。

**这条我列出来是因为它是我在检查 note 呈现时撞到的，且它与 `...presentation` 的行为同屏**；但它**属于既有问题**，不应记在本轮账上。建议 0.8.4 顺手给 `renderList` 加 `state.commits ?? []`（一行）。

---

## 五、我没有验证的部分

1. **完整 323 项套件是否全绿**——按约束没有跑（另有一轮在跑）。我用 **29 项定向用例** + 两个类型检查 + 独立静态计数 + 8 个变异副本替代，**不能等同**。本轮完全没执行的文件包括：`pendingRecoveryPolicy/`、`recoveryProvider.test.ts`、`appendStaged` / `appendGuard` / `rebaseSafety` / `editStopCommit` / `worktree` / `llmClient` / `composeDraft`、`restoreFileProtocol.test.ts` 等。`pushNotification.test.ts` 我跑了（20/20 绿），但那是**我自己的**进程，不是那个全量进程的。
2. **真实 VS Code GUI / Restricted Mode / 真实 webview 消息往返**：所有 provider 断言跑在 `test/helpers/vscodeStub.ts` 上，webview 断言跑在 JSDOM 上。`domchk4.js` 用的是真实 `media/main.js`，但没有真实 VS Code 的 `acquireVsCodeApi`。
3. **`...presentation` 的必要性在"超时"形态下是否仍成立**：我构造了 6 类 Git 状态，全部不支持"有 note 但 `getCommits` 成功"。理论上仍有一条我没构造的路径——**上游范围查询超时**（`DEFAULT_TIMEOUT = 120 s`）而 `getCommits`（只读 `-n 20`）不超时。超大仓库上这是可能的，我没有那样的夹具。第七轮我提过同样一条，本轮仍未验证。
4. **非 Git 2.53.0.windows.2**：`%(upstream:track)` 的 `[gone]` 语义、`--end-of-options`、`unknown revision` 的三行 stderr 形状在项目声明下限 **2.31.0** 上没实测。新发现 1 的 stderr 形状**尤其**依赖 Git 版本——不同版本的用法提示措辞可能不同。
5. **非 C locale**：`getUpstream` 的 `[gone]` 与 `pushRefspec` 的英文散文判定都依赖 `LC_ALL=C`，我只在 C locale 下验证过。新发现 1 的分支匹配（`/^(fatal|error):/`）在非英文 locale 下也会有不同的前缀。
6. **Linux/macOS**：路径分隔符、大小写敏感、CRLF 行为未验证。§三.6.1 的 CRLF 用例是**构造**的 stderr，不是真在 Windows 管道上采集的。
7. **真实远端服务器**：只对本地 bare 远端与 `file://` 验证过。
8. **`package-lock.json` 的依赖树**：只确认版本号与 `package.json` 一致，没有审计。
9. **`dist/extension.js` 的源码映射**：我只确认 sha256 与重建结果一致、且包内含有本轮的字符串与符号，没有逐行核对 bundle 与源码的对应关系。
10. **新发现 4 的影响面**：我只用一条**缺 `commits`** 的 state 复现，没有穷举所有 provider 可能发出的 state 形状。

---

## 六、给 A 的清单（全部 P3/P4，不阻塞发布）

1. **（0.8.4，P4）** `upstreamNoteDetail` 优先取匹配 `/^(fatal|error):/` 的最后一行，没有才回退末条非空行；并把 JSDoc 里"the line Git guarantees to print"改成实测结论（新发现 1）。
2. **（0.8.4，P3）** `test/rebasePresentation.test.ts:73-75` 的 `"✨"` 换成真 astral 字符，且用 BMP + astral 的**混合**串（纯 astral 串在偶数边界上碰巧不暴露问题）（新发现 2）。
3. **（0.8.4，P4）** `src/ui/rebasePresentation.ts:51-53` 与 `docs/improvement/improvement.md:205` 的"任何原因 / Two shapes"改成"上游可解析但计数失败时"，与 `rebaseViewProvider.ts:429-439` 和 `improvement.md:214` 一致（新发现 3）。
4. **（0.8.4，P3，一行，既有缺陷）** `media/main.js:348` 的 `state.commits.map` 加 `(state.commits ?? [])` 守卫；基线 `577ce87` 同样复现，不是本轮引入（新发现 4）。
5. **（流程）** 账本缺 `0-8-20` 行。本轮任务禁止我编辑账本，请 A 或所有者按本报告补记（基线 `577ce8766a46707a60c471cf8090e9f63cd8d49c`、被评审材料为未提交工作树、结论为**维持批准**）。第七轮的 `0-8-19` 行已补，可照抄格式。
6. **（沿用第七轮未闭合项）** §五.3 的"超时形态下 `...presentation` 是否仍必要"仍无夹具；如果 0.8.4 要动这块，建议先造一个超时夹具再改。

---

## 七、裁决与覆盖范围（重述）

**维持批准。** 本评审覆盖基线 `577ce87` 之上的未提交工作树（25 修改 + 13 untracked），以及由它构建的 **`dist-vsix/git-rebase-visual-0.8.3.vsix`**（12 条目、白名单通过、10 个 payload 与工作树逐字节相同、包内 `extension/dist/extension.js` 与现场重建 sha256 同为 `d912c484…`）。

第七轮留下的六项，逐项闭合：

- **新发现 1**（provider 的 note 赋值）：有用例，前置断言防止滑路径，删赋值即红（`m1`）。
- **新发现 2**（推送侧 catch）：有用例，两个方向（关掉 `res.code` 门 / 换文案）都实测红（`m2a` / `m2b`）。
- **新发现 3**（Compose 会话闸）：三条用例，关掉闸后请求真的发出去、两条正向对照仍绿（`m3`）。
- **新发现 4**（`...presentation`）：note 到达 webview、修好后不残留、只带真话；去掉展开即红（`m4a`）；"必要性"主张的两个方向我都检验过，没有反例。
- **新发现 5**（裸 `rev-parse` 注释）：改成可检验的不变式并点名了站点；`--output=` 仍只回显。
- **新发现 6**（note 单行化）：六种边界形状都正确，无孤立代理；**两条残留**——`✨` 用例空转（新发现 2）、`unknown revision` 取错行（新发现 1）。

本轮新发现四项：2×P3（`✨` 空转、缺 `commits` 的既有渲染崩溃，**最后一项不是本轮引入**）+ 2×P4（`unknown revision` 取错行、被撤回的"任何原因"仍在两处）。没有一项改变**今天可达路径**下的用户可见正确行为，也没有一项落在发布阻断面上。

**结论：0.8.3 与 `dist-vsix/git-rebase-visual-0.8.3.vsix` 的批准继续有效；第七轮六项已按要求真正修好，两处残留建议在 0.8.4 一并处理。**
