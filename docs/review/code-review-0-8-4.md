# code review 0.8.4 — Agent B 独立复审（0.8.2 第二轮）

> 独立评审代理 B，第二轮评审 0.8.2 的未提交工作树。本轮未修改任何产品代码、测试、发布说明或既有评审文件；本轮唯一写入的评审产物是本文件。
> 按委托要求**未更新** `docs/review/code-review-commit.md`（工作树尚无 commit SHA 可入账；提交后必须由后续独立评审按真实 SHA 覆盖）。

## 一、评审基线

| 项目 | 值 |
|---|---|
| 仓库 | `D:\work\tools\git plugin` |
| 分支 / HEAD | `main` / `eddca5642cb7dadb1645e24e2d6d074a39aedc26` |
| 被测材料 | 0.8.2 未提交工作树（20 个条目：18 个修改/新增产品与文档 + 上一轮评审文件） |
| 上一份评审 | `code-review-0-8-3.md`（第一轮，1×P1 新增 + 1×P1 既有 + 2×P2 + 2×P3） |
| 评审日期 | 2026-10-30 |
| 起始 / 结束 `git status --short` 条目数 | **20 / 20**（本文件为结束计数的第 21 项前，见末节；本轮未落盘任何其他文件） |
| Git / Node | `git 2.53.0.windows.2` / `node v24.16.0` |
| 运行方式 | 临时目录抛掷仓库 + 真实 `git`；用仓库自带 `tsx` 直接调用 `stashRestoreForAmend` / `stashApplyIndexBySha` / `reconcilePendingAppend` / `abortRebase`。**未跑全量套件**（委托要求只做定向运行） |

定向运行（本轮实际执行的命令）：

```text
node ./node_modules/tsx/dist/cli.mjs --test \
  test/appendStaged.integration.test.ts \
  test/pendingRecovery.integration.test.ts \
  test/editStopCommit.integration.test.ts
→ tests 52 / pass 52 / fail 0

node ./node_modules/typescript/bin/tsc --noEmit                      → rc 0
node ./node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit → rc 0
```

## 二、结论摘要

第一轮六项中 **3 项完全修复（P1-1、P1-2、P2-1）、2 项部分修复（P2-2、P3-2）、1 项修复（P3-1）**；五项争议中**实施者在四项上完全正确**，我也必须更正自己在争议 1 上的错误。

但 P2-2 的第二个修法（`abortRebase` 的“归属证明”）**本身不安全**：它用“路径存在于变基前 HEAD”当作“这不是用户内容”，实测会**静默删除用户写在同名文件里的内容**。因此本轮仍**不批准**发布；同时发现两处 literal pathspec 站点完全没有被测试钉住（发布说明“已实测非空转”在这一点上不成立）。

| 严重级别 | 数量 |
|---|---|
| P0 | 0 |
| P1 | 0 |
| P2 | 1（新：`abortRebase` 归属证明可删用户内容） |
| P3 | 3（literal pathspec 无测试钉住；`RELEASE.md` 陈旧表述与 0.8.3 自引用；`applyIndex` 只看 `presence.complete` 的既有观察） |

## 三、上一轮发现逐项裁决

### P1-1 非 ASCII / 前导空格 / 通配符路径静默空转 —— **已修复（实测）**

- 四个枚举站点已全部改为 NUL 分隔：`src/git/worktree.ts:69`（`diff --name-only -z --no-renames`）、`:121`（`ls-tree -r -z --name-only`）、`src/git/pendingRecovery.ts:198`（`changedPaths`）、`src/git/commitLog.ts:457`（`conflictedFiles`），共同走 `gitRunner.ts:50` 的 `splitNul`。
- `splitNul` 四种边界全部正确（真实单元调用）：`""`→`[]`；`"a"`→`["a"]`；`"a\0"`→`["a"]`（**无尾部空条目**）；`"a\0\0b\0"`→`["a","b"]`；`"\0"`→`[]`；路径内含真实 `\n` 时 `"dir/a\nb.txt\0 lead.txt\0"`→`["dir/a\nb.txt"," lead.txt"]`（**换行与前导空格都保留**，`trim()` 已从该路径移除）。
- 真实 Git 探针（暂存 `新增说明.txt` / ` lead.txt` / `br[1].txt`，edit 停靠后调 `stashRestoreForAmend`）：三者全部进入索引，`ok:true` 且不是空转。
- **测试确实触及 bug（已用破坏性验证确认）**：删掉 `diffNames` 的 `-z` → 该用例变红（`"新增说明.txt" must be staged for the amend`）；给 `splitNul` 加回 `trim()` → 变红（`" lead.txt" must be staged for the amend`）。
- 重新审计 `src/` 剩余的换行切分：`stash list --format=%H`、`--format=%gd%x1f%H`、`numstat`（只用于显示摘要）、rebase todo/done 文件、SSE 缓冲、`rev-parse` 的 sha 列表——**没有任何一处再被当作路径回传给 Git**。P1-1 的“还有别的路径穿过 line-split/trim”的担忧不成立。

### P1-2 残留恢复缺字面 pathspec、可覆盖用户新内容 —— **已修复（实测）**

- `restoreResidualSnapshot` 的两处 `restore` 均带 `env: LITERAL_PATHSPECS`（`pendingRecovery.ts:394`、`:409`）。
- 破坏性验证：把 `pendingRecovery.ts` 中 6 处 `LITERAL_PATHSPECS` 全部移除 → 新增用例变红（`the decoy must never be overwritten (outcome pending: …)`）。
- 独立复现危害（不依赖产品代码）：`git restore --source=<sha>^2 --staged -- 'br[1].txt'` 在 `br1.txt` 存在时 rc 0，并把**两个**文件都写进索引（`git ls-files -s` 两行均为新 blob）；加 `GIT_LITERAL_PATHSPECS=1` 后只写目标。
- 写回内容确实来自 `restoreResidualSnapshot` 的 unstaged 分支：破坏该函数环境变量后诱饵被改写，恢复后诱饵字节不变。

### P2-1 横幅首条命令必定失败 —— **已修复（实测）**

- 真实状态复现旧失败：`git stash apply --index stash@{0}` → `error: conflicts in index. Try without --index` / `already exists in index`，rc 1。
- 现在的第一条命令是 `git stash apply stash@{0}`，在**该状态**上执行 rc 0，并把未跟踪内容放回；`--index` 只在“暂存半为空（`indexPaths === 0`）”时保留。
- 两个方向都已钉住：
  - 破坏 `indexAlreadyThere = false` → 新增用例变红（列出旧的 `apply --index` 序列）；
  - 去掉 `indexPaths > 0` 细化（`presence?.index === "present"`）→ 既有用例 `reset refuses to drop a content-bearing stash and says why` 变红（`and an actionable next step`）。**因此它不会在“暂存半为空”时错误地丢掉 `--index`。**

### P2-2 Abort 死胡同 —— **部分修复：分阶段窗口已消失，但归属证明不安全（见新发现）**

- 分阶段顺序成立且被用例钉住：把工作区半改回 amend 之前 → `a rejecting pre-commit hook leaves the paused rebase abortable` 变红（`the snapshot's worktree half must not be written before the amend lands`）。探针也确认：amend 被 `pre-commit` 拒绝后工作区与变基开始时一致，`git rebase --abort` 直接 rc 0。
- 本地化 Git 已处理：`abortRebase` 用 `LC_ALL=C`（`ABORT_ENV`）并对 `stderr`/`stdout` 双向解析；实测中文名碰撞路径 `新增说明.txt` 被正确解析、删除并重试成功（`abortRebase: OK`，HEAD 回到 orig-head）。
- **但“归属证明”不成立**，见 P2 新发现。

### P3-1 顺序依赖缺少回归断言 —— **已修复（实测）**

- 在 `stashApplyIndexBySha` 里把索引半与工作区半调换 → 新用例变红（`the deleted path is gone from the worktree too`）。断言确实钉住了顺序，而不是被“absent-from-both”跳过掩盖。
- 争议 4 成立：我上一轮建议的“断言 rc≠0”确实会被跳过分支吃掉，用最终状态断言才是对的。

### P3-2 发布说明表述 —— **部分修复**

- `docs/release-notes/0.8.2.md:11` 已纠正“目标是 tip 就不安全”的方向（并给出了正确的原因）。
- 但 `RELEASE.md:111` **仍原句保留**“目标为 tip 时总能成功”——这正是上一轮要求改的那一句。
- `docs/release-notes/0.8.2.md:11` 新增的“详见下方 0.8.3 的路径解析修复”是**悬空引用**：该文件没有 0.8.3 小节，且 0.8.3 是评审报告版本号，不是发布版本。

## 四、五项争议逐条裁决

| # | 争议 | 裁决 |
|---|---|---|
| 1 | 我引用的 `pendingRecovery.ts:178` 不是“正确先例”，且 `cat-file`/`rev-parse` 不会 glob | **实施者在两半上都对，我错了。** HEAD 的 `changedPaths` 是 `-z` **加** `.trim()`（`git show HEAD:src/git/pendingRecovery.ts` 第 178 行），trim 才是缺陷本身，不是先例。`cat-file -e` / `rev-parse --verify` 对 `br[1].txt`、`br?.txt`、`br*.txt` 在只有 `br1.txt` 时**全部 rc≠0**（不 glob）；我上一轮看到的“rc 0”是 `git rev-parse`（**不带 `--verify`**）在解析失败时**原样回显参数**的行为，不是匹配成功。同时实施者“`restore`/`checkout`/`add` 需要单独修”也正确：实测无环境变量时 `git add -- 'br[1].txt'` 会顺带暂存 `br1.txt`，`git restore --worktree -- 'br[1].txt'` 会改写诱饵。 |
| 2 | “目标为 tip 是回归”混淆了两个缺陷 | **实施者正确。** tip 形状对**假冲突**机制是安全的（`apply --index` 单命令、工作区半路径都在 tip 树里），我上一轮把“路径解析缺陷”的影响算进了“假冲突”的回归判定。 |
| 3 | `git clean -fd` 不能作为推荐修法 | **实施者正确。** 它违反“永不删除用户内容”的模块承诺，不应出现在提示里。但其替代方案（删除“存在于 orig-head”的路径）本身不安全，见新发现 P2。 |
| 4 | rc≠0 断言会被跳过分支掩盖 | **实施者正确**，已由调换顺序的破坏性验证证明。 |
| 5 | 测试声明数是 228 不是 222 | **实施者正确。** `grep -rnE '^\s*test(\.(skip\|only\|todo))?\(' test/*.ts | wc -l` = **228**，`test.skip` = 0；HEAD 为 217，增量 11。我上一轮的 222 是错的。 |

## 五、新发现（按严重程度）

### P2 `abortRebase` 的归属证明会静默删除用户内容

- 位置：`src/git/rebaseEngine.ts:219-231`（`owned` 收集与 `fs.promises.rm` 删除循环）。
- 现状逻辑：`git rebase --abort` 被未跟踪文件阻断后，只删除 `git cat-file -e <orig-head>:<path>` 返回 0 的路径，注释与发布说明都称这“证明它不是用户原有内容”。
- 反例（真实 Git，`/tmp/abx`）：变基前 HEAD 含 `later.txt`（由**后续** commit 引入）；变基停靠在更早的 `target`，此时 `later.txt` 在工作区是未跟踪文件；用户在其中写入 `MY IRREPLACEABLE 3 HOURS OF NOTES`；`git rebase --abort` 被阻断（rc 128，错误里列出 `later.txt`）；调用 `abortRebase` → **返回成功**，HEAD 回到 orig-head，`later.txt` 内容变成提交里的 `later committed`。用户的三小时内容**不在任何 commit 或 stash 中**。
- 对照：`mine.txt`（不在 orig-head 中）被正确保留，所以现有用例 `abort removes an untracked path the rebase created and keeps the user's own untracked file` 通过——**它没有覆盖这个形状**。破坏性验证：把归属证明整个去掉（无条件删除 `blocked` 全部路径）后该用例**仍然通过**，说明这条守卫本身也未被钉住。
- 关键点：“路径曾在变基前 HEAD 出现”只证明它**曾经被跟踪**，不证明**当前磁盘上的字节**是变基写的。变基把该路径写回工作区后会变成未跟踪文件，用户完全可能在暂停期间编辑它（甚至正是因为看到文件被恢复才去编辑）。
- 影响：静默数据丢失；与 `rebaseEngine.ts:190-200` 的注释、`docs/release-notes/0.8.2.md:35` 的“真正未跟踪的用户文件永不删除”都矛盾。
- 建议修法（不指定实现细节）：删除前必须同时证明**磁盘内容**也来自本次变基——例如与该碰撞发生前 Git 即将写入的 blob（orig-head 中的 blob）逐字节比较，只有完全一致才删；否则保留并如实抛错，让用户自己处理。另加一条用例：碰撞路径在 orig-head 中、但用户改过内容 → 抛错且文件内容不变。

### P3 `worktree.ts` / `worktreeChanges.ts` 的字面 pathspec 没有任何测试钉住

- 位置：`src/git/worktree.ts:104`、`:128`、`:134`、`:159`；`src/git/worktreeChanges.ts:192`、`:229`、`:236`、`:262`、`:276`。
- 破坏性验证：把 `worktree.ts` 的 4 处 `env: LITERAL_PATHSPECS` 全部移除 → P1-1 用例**仍然全绿**（`sab10` 副本，1/1 pass）；把 `worktreeChanges.ts` 的 5 处全部移除 → `worktreeChanges.integration.test.ts` 5/5、`worktree.integration.test.ts` 4/4 **全绿**。
- 危害不是理论的（真实 Git，`/tmp/lit3`）：只有 `br[1].txt` 被暂存，诱饵 `br1.txt` 用户未改动；去掉环境变量后 `stashRestoreForAmend` 返回 `ok:true`，索引变成 `M br1.txt | A br[1].txt`，`br1.txt` 的索引 blob 变成 `DECOY-V2-FROM-LATER`（tip 版本），而目标 commit 里是 `DECOY-V1`——**随后 `commit --amend` 会把这个与目标无关的文件内容一起提交**。带环境变量时索引只有 `A br[1].txt`。
- 现有诱饵断言（`test/appendStaged.integration.test.ts:452`）之所以“空转”：诱饵 `br1.txt` 在 **target 之前**提交，错误 glob 写入的字节与 amend 后的 HEAD 相同，`rev-parse HEAD:br1.txt` 看不出差别。
- 影响：发布说明 `docs/release-notes/0.8.2.md:50` 的“已实测非空转……字面 pathspec……相应用例确实变红”在这一点上不成立；这些站点一旦回归，测试不会报警。
- 建议修法：把诱饵改成“在 target 之后被修改”（或让用户先暂存一个不同的诱饵版本），使索引中的诱饵 blob 与目标树不同；`worktreeChanges` 的三个操作（单文件 stage / restore / 批量）各补一条 glob 用例。

### P3 `applyIndex` 只认 `presence.complete`，会留下未解决的 unmerged 索引却报告“已恢复”（既有观察，非 0.8.2 引入）

- 位置：`src/git/pendingRecovery.ts:709-716`（`applyIndex` 忽略 `res.code`，只看 `stashPresence(...).complete`）。
- 探针（`/tmp/rx2`、`/tmp/rx3`）：停靠在 target、记录 `amended:false`；调用 `reconcilePendingAppend` → `apply --index` 实际 rc 1（`CONFLICT (modify/delete): later.txt … Index was not unstashed.`），但 `stashPresence` 报告 `index/worktree/unstaged/untracked` 全 `present`、`complete:true`，于是返回 **`restored`**，记录被清除。此时真实状态是 `A append.txt` + `DU later.txt`，`git rebase --continue` 直接失败（`later.txt: needs merge`），而横幅已经消失。
- HEAD 版本同样如此（用 `git archive HEAD src` 的副本跑同一形状，输出一致）→ **既有缺陷，不是本轮引入**。
- 可达性有限：1.5s 轮询在 `rebaseInProgress` 时跳过恢复，但 `resetState` → `reconcilePendingState` 不受该条件限制，可在暂停期间触发。
- 影响：无数据丢失（内容在工作区、stash 仍在，Abort 可回退），但会让“已恢复”与“变基无法继续”同时成立，且记录已清、无提示。建议把 `res.code !== 0` 也当作失败（或在 `complete` 中加入“索引无 unmerged 条目”这一条件）。

## 六、发布完整性

| 检查 | 结果 |
|---|---|
| `package.json` / `package-lock.json`（root 与 `packages[""]`） | 均 0.8.2 ✔ |
| `docs/release-notes/0.8.2.md` 标题与占位符 | `## Git Rebase Visual 0.8.2`，无 `{{…}}` ✔ |
| 发布说明与代码一致性 | “tip 时总能成功”已纠正 ✔；但第 11 行“详见下方 0.8.3”为悬空引用 ✘；“真正未跟踪的用户文件永不删除”在 P2 反例下不成立 ✘ |
| `RELEASE.md` `- **0.8.2** —` | 存在 ✔；但第 111 行仍写“目标为 tip 时总能成功” ✘ |
| VSIX 文件数 / 内容 | 12 个文件；无 `.map`、`sourcesContent`（计数 0）、`src/`、`test/`、`docs/`、`node_modules`、`tsconfig*` ✔ |
| VSIX 版本 | 清单与 `extension/package.json` 均 0.8.2 ✔ |
| 打包 bundle 与 `dist/extension.js` | SHA-256 均 `69325dd01a046f3745f9b0e5cbaadf2b2fc4c0940390e2fd6337ef7e829bcb18` ✔ |
| VSIX 内 `readme.md` / `package.json` 与工作树 | 字节一致（`f470c175…` / `8bb54ca3…`）✔ |
| 是否有比 VSIX/dist 更新的源码 | `src/` 无文件比 `dist/extension.js` 新；VSIX 比 dist 新 ✔ |
| `dist-vsix/` 打包迁移 | `package` 脚本 `--out dist-vsix/`、`.gitignore:7`、`release.yml:49-51/84`、`RELEASE.md:43-45/58` 一致，未回退 ✔ |
| 定向测试 / 类型检查 | 52/52；两个 `tsc --noEmit` 零输出 ✔ |

**发布裁决：当前工作树状态仍不批准发布 0.8.2。** 产物本身是自洽的（12 个文件、0.8.2、bundle 哈希与 `dist/extension.js` 相同、无禁用内容、无更新的源码），也就是说“工作树批准”与“VSIX”目前是同一个东西；但该 VSIX 携带 P2（`abortRebase` 会删用户内容），因此不批准。

修复后必须重新执行：

1. 修改 `src/git/rebaseEngine.ts` 的归属证明，并补一条“碰撞路径在 orig-head 中但内容被用户改过”的用例；
2. 补 `worktree.ts` / `worktreeChanges.ts` 的字面 pathspec 用例（P3），并修正 `RELEASE.md:111` 与发布说明第 11 行的悬空引用；
3. `npm run compile`（`npm run package` 会经 `vscode:prepublish` 重新编译）；
4. 定向跑 `test/appendStaged.integration.test.ts`、`test/pendingRecovery.integration.test.ts`、`test/editStopCommit.integration.test.ts` 与两个 `tsc --noEmit`；
5. **重新生成并替换** `dist-vsix/git-rebase-visual-0.8.2.vsix`，重新校验 12 个文件、清单 0.8.2、bundle 与 `dist/extension.js` 哈希一致。

只有 P2 一项会阻止发布；两处 P3 测试/文案项建议同批修掉（尤其 P3 的诱饵空转，它使“字面 pathspec”这条修复在追加路径上处于无保护状态）。
