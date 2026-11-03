# Code Review 0-8-9 — 0.8.2（第七轮）：插件是否只删除自己创建的 stash 条目

> 独立评审代理 B。本轮**只读**产品代码、测试与文档；除本文件外未写入任何仓库文件。
> 按委托要求**未更新** `docs/review/code-review-commit.md`（被评审材料是未提交工作树，暂无 commit SHA 可入账；提交后必须由后续独立评审按真实 SHA 覆盖，且不得改写既有 `code-review-*.md`）。

## 一、评审基线

| 项目 | 值 |
|---|---|
| 仓库 | `D:\work\tools\git plugin` |
| 分支 / HEAD | `main` / `eddca5642cb7dadb1645e24e2d6d074a39aedc26` |
| 被测材料 | 0.8.2 未提交工作树（`git status --short` 34 项；评审结束后仍为 34 项） |
| 版本 | 0.8.2（`package.json` / VSIX 内 `extension/package.json` 一致） |
| 方法 | 真实 Git `2.53.0.windows.2`、Node `v24.16.0`；探针只导入**真实产品模块**，全部在 OS 临时目录执行，结束前已删除（`/tmp/grv-probe-b`、`%TEMP%\grv-b-*` 残留 0） |
| 本轮未运行 | 完整套件（受规则限制）。实现者报告的 256/256 **未独立确认** |

## 二、结论

本轮的核心问题是“插件是否只删除自己创建的 stash 条目”。**结论：语义正确，主路径安全，未发现 P0/P1。** 剩余风险集中在两处“解析 Git 英文输出”的旁路（R-1）与 `changedPaths` 缺少 `--no-renames` 导致的 `complete` 假阳性（R-2），二者都需要额外条件才可能造成后果。

**发布裁决：批准 0.8.2，且该批准覆盖已产出的 VSIX。**

## 三、逐项裁决

| 验收项 | 裁决 | 证据 |
|---|---|---|
| 1. 成功恢复后 `git stash list` 与用户原状一致 | 通过 | 真实 Git：autostash+完成 rebase、autostash+abort、追加（`changeStash`+`unstagedStash`）、keep-index 残留、`resolved` 分支，恢复后用户 stash 的 sha 集合逐字节不变，只有插件自己的条目消失（`status:"removed"`，名称 `stash@{0}`/`stash@{1}`） |
| 2. 不会删除非自己创建的条目 | 基本通过（见 R-1/R-3） | 占用检查前并发 `stash push` → 拒绝、零删除；检查与 drop 之间插入 → 该条目被 drop，随后 `git stash store` 还原，`git stash show -p` 与还原前一致且重新出现在列表中；两条内容完全相同的 stash 互不影响；用户 `git stash store` 造成的重复 sha 见 R-3 |
| 3. `git stash store` 失败/异常 | 通过 | 无 reflog、`core.logAllRefUpdates=false`、两父 stash 均可 store；非 stash 提交被 Git 拒绝（“not a stash-like commit”），失败分支保留可恢复的 sha 文案 |
| 4. `complete` 门是否恰当 | 基本通过（见 R-2、R-4） | 普通 `git stash apply`（无 `--index`）→ `contentPresent:true, complete:false` → 记录结算但条目保留，文案要求先核对；构造 `complete:true` 的情形（重命名折叠）见 R-2 |
| 5. `treeBlobs` 修复 | 通过 | `ls-tree -r -z` 记录为 `<mode> SP <type> SP <object> TAB <path> NUL`，取第三段即 object id；修复前取到字面量 `blob`，未跟踪比较永不匹配、`complete` 不可达。实测 CRLF、clean filter、可执行位被剥落的未跟踪文件均正确 `present` |
| 6. `pending` 不会到达 `stashRemoveBySha` | 通过 | `removeOwnStash` 仅出现在 `resolved`/`restored` 返回点；所有 `pending` 分支在它之前 return |
| 7. 传参来源 | 通过（见 R-1 的狭义例外） | `reconcilePendingStash`/`reconcilePendingAppend`/`reconcileWorktreeStash` 的 sha 全部来自 `stashPush`/`stashPushKeepIndex` 的返回值，且只经 `setPendingStash`/`setPendingAppend` 持久化；`stashRemoveBySha` 唯一导入方是 `pendingRecovery.ts` |
| 8. 文案 | 通过 | 成功提示明确“插件自己的临时 stash 已删除”；保留提示要求“先核对…再决定是否删除”，并声明“你自己压入的 stash 从头到尾没有被改动”，不再出现“删除它不会丢失任何改动” |
| 旧策略残留 | 通过 | 无 `keptStash`/`stashKept`/“永不自删”代码或注释；`rebaseEngine.ts` 的“never deletes anything”指 `abortRebase`，语义正确；`summary.md` 已改为“按 sha 集合一致” |
| Abort 行为 | 未变 | `abortRebase` 仍不删除任何文件，未识别的失败原样抛出 |
| 类型检查 | 通过 | `tsc --noEmit`（src）与 `tsc -p tsconfig.test.json --noEmit` 均 exit 0 |
| 受影响套件 | 通过 | `pendingRecovery.integration` 47/47；`worktree.integration`+`recoveryProvider`+`pendingRecoveryPolicy` 34/34；`editStopCommit.integration`+`worktreeChanges.integration`+`rebaseEngine` 23/23 |
| VSIX | 通过 | `git-rebase-visual-0.8.2.vsix` 恰含 allowlist 的 12 项；内嵌 `dist/extension.js` sha256 `1f5e2a01…e0fa` 与工作树 `dist/extension.js` 及重新 esbuild 的产物一致；未打包 `docs/research`、`scripts`、`test`；无条目比源码新 |

## 四、新发现（按严重度）

### R-1（P2）依赖本地化 Git 消息的两处解析

- `src/git/worktree.ts` 的 `stash()` 用 `/No local changes to save/i` 判定“没有东西可存”。该消息是可翻译的（Git 的 `git.pot` 含此 msgid）。在非英语 locale 下正则不匹配，函数会走到 `rev-parse stash@{0}` 并把它当作“刚创建的条目”返回。`reconcilePendingAppend` 的调用点（`rebaseViewProvider.appendToCommit`）**没有**先做 dirty 检查，因此干净工作树 + 本地化 Git 时，记录里会写入**用户自己的** stash sha。后续若该条目内容恰好可被 `complete` 证明，`removeOwnStash` 就可能删掉它。本机 Git 无翻译目录，未能实测本地化分支；英文环境下已实测返回 `undefined`（不误认）。
- `src/git/worktree.ts` 的 `undoWrongDrop` 用 `/Dropped\s+…/` 解析 `git stash drop` 的输出（`Dropped %s (%s)` 同样是可翻译 msgid）。解析失败时函数**不会**恢复任何东西，直接返回 `ok/gone`。实测：把 drop 输出换成非英文文本后，被误删的用户条目**不会**被 `git stash store` 还原。这是“可能删除非自己条目且不还原”的唯一残留路径，仍需先发生槽位竞态。
- 对照：`rebaseEngine.ts` 已为此把 `ABORT_ENV = { LC_ALL: "C" }` 传给 `rebase --abort` 与 `stash list`。同样的处理没有应用到 `stash push` / `stash drop` / `stash store`。
- 建议：`stash()`、`stashRemoveBySha` 的 `drop`、`undoWrongDrop` 的 `store` 统一带 `LC_ALL: "C"`（或改用不依赖文案的判据，例如 push 后用 `git stash list` 比对条目集合）。

### R-2（P2，需手动中间态）`changedPaths` 缺 `--no-renames`，`complete` 可假阳性

- `pendingRecovery.ts` 的 `changedPaths` 使用 `git diff --name-only -z`，而 `worktree.ts` 的 `diffNames` 明确带 `--no-renames`。Git 默认开启 rename 检测，`--name-only` 会把重命名折叠为只剩目标路径。
- 实测（真实 Git）：快照为暂存重命名 `a.txt → b.txt`；用户只把目标路径放回索引（源路径仍留在索引中，删除未恢复）时，`stashPresence` 报 `index:"present"`、`complete:true`，`reconcilePendingStash` 判 `resolved` 并**删除**条目——但快照里“删除 a.txt”的暂存意图从未回到索引。字节没丢（a.txt 内容仍在），丢的是暂存/未暂存的区分，这正是 `complete` 门声称要保护的东西。
- 同一根因影响 `stagedSnapshotInHead`：实测 HEAD 同时保留 `a.txt` 且目标路径 blob 相同，函数仍返回 `committed:true`（“1 个路径的内容与权限已与 HEAD 完全一致”），少算了源路径。
- 触发需要用户在恢复过程中手动只 stage 目标路径，属低概率路径；方向是“误判为可结算”，因此列为 P2 而非 P1。
- 建议：`changedPaths` 增加 `--no-renames`（与 `diffNames` 对齐，注释里已写明理由）。

### R-3（P3）重复 sha：会删掉用户用 `git stash store` 复制出的那条

- `git stash store` 可以把插件条目的 sha 再挂一条 reflog 记录，列表中同一 sha 出现两次。`indexOf` / `stashNameForSha` 取**第一个**匹配槽位。实测：用户在 `stash@{0}` 复制、插件原条目在 `stash@{2}` 时，删除发生在 `stash@{0}`——即用户创建的那条 reflog 记录被删。两条指向同一个 commit，内容完全相同且仍保留一条，无字节损失；但它确实是“用户创建的条目被删”。
- 建议（可选）：当同一 sha 出现多次时拒绝自动删除（`refused`），交给用户处理。

### R-4（P3）`complete` 门使 `apply`（不带 `--index`）永远无法满足

- 用户若只执行提示里的第二条命令 `git stash apply <sha>`，索引半永远 `missing`，`complete` 不可能为真，插件条目只能保留。实测该状态会正常结算记录并给出“已保留 + 先核对再删除”的提示（不会无限告警），因此可接受；只是条目会长期留在列表里，需要用户自行核对后删除。

### R-5（P3）纯模式变更的工作区可执行位不会被恢复

- 快照只有 `chmod +x`（暂存）时，`restoreWorktreeHalf` 的 `^1..stash` 路径集为空，工作区可执行位不会被写回，而 `worktree:"present"` 是空集上的真空判定；索引侧恢复正确。字节无损失、索引仍记录 `100755`，用户提交或 `git checkout -- .` 即可复原。未跟踪文件的 `100755` 丢失是 Git `^3` 本身不记录模式所致，不是本插件的问题。

## 五、直接回答

1. **插件现在删除自己创建的条目是正确的吗？** 是。这是 autostash 的语义要求（stash → rebase → pop），留下自己的 `-u` 条目会让用户的 `git stash pop` 先撞上它并失败。删除被 `complete`（listed + index + worktree + untracked 四项均为**正向**探测）严格门控，失败探测永不提升任何部分，因此不会在有疑问时删。
2. **是否还有路径会删除“不是自己创建的”条目？** 主路径没有。残留的是 R-1（本地化 Git 的两处英文解析：一处可能把用户条目误记为“自己刚创建的”，一处会让误删无法还原）与 R-3（用户用 `stash store` 复制同一 sha 时可能删掉用户那份 reflog，内容仍有副本）。R-1 需要非英语 locale，R-3 需要用户主动造出重复 sha；两者都不丢字节，但都属于“删了不是自己创建的那一条”的字面情形，建议按 R-1 的 `LC_ALL=C` 修复优先处理。

## 六、复验命令

- `node ./node_modules/typescript/bin/tsc --noEmit` → exit 0
- `node ./node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit` → exit 0
- `tsx --test test/pendingRecovery.integration.test.ts` → 47 pass / 0 fail
- `tsx --test test/worktree.integration.test.ts test/recoveryProvider.test.ts test/pendingRecoveryPolicy.test.ts` → 34 pass / 0 fail
- `tsx --test test/editStopCommit.integration.test.ts test/worktreeChanges.integration.test.ts test/rebaseEngine.test.ts` → 23 pass / 0 fail
- `node scripts/package-vsix.js --verify-only` → `VSIX contents match the allowlist (12 entries)`
- `git status --short | wc -l` → 开始 34，结束 34（含本文件，见下）

> 计数说明：本文件写入后工作树为 35 项（新增本文件）。除此之外未修改任何产品代码、测试或既有文档。
