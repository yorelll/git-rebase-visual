# Code Review 0-8-10 — 0.8.2（第八轮）：R-1/R-2/R-3 修复的独立复核

> 独立评审代理 B。本轮**只读**产品代码、测试与既有文档；除本文件外未写入任何仓库文件；探针全部在 OS 临时目录执行并已删除。
> 按委托要求**未更新** `docs/review/code-review-commit.md`（被评审材料是未提交工作树，无 commit SHA 可入账；提交后须由后续独立评审按真实 SHA 覆盖）。

## 一、评审基线

| 项目 | 值 |
|---|---|
| 仓库 | `D:\work\tools\git plugin` |
| 分支 / HEAD | `main` / `eddca5642cb7dadb1645e24e2d6d074a39aedc26`（0.8.2 仍未提交） |
| 版本 | `0.8.2`（工作树 `package.json`、VSIX 内 `extension/package.json` 一致；`extension.vsixmanifest` 的 `Version("0.8.2")`） |
| 工作树 | 开始 `git status --short` 35 项；结束 36 项（仅 +1 为本文件；产品代码/测试/既有文档零改动，HEAD 仍 `eddca56`） |
| 方法 | 真实 Git `2.53.0.windows.2`、Node `v24.16.0`；探针只 import 真实产品模块（`src/git/worktree.ts`、`src/git/pendingRecovery.ts`、`src/git/gitRunner.ts`），在 `%TEMP%\grv-b-*` 建仓、结束前删除 |
| 本轮未做 | 完整 262 项套件（按委托禁止，约 25 分钟）。实现者报告的 262/262 **本轮未独立确认**；静态计数见下 |

## 二、结论

**R-1、R-2、R-3 三项修复均成立，且都改成了“按身份判断”而非“换一个更牢的英文正则”。**
未发现 P0/P1/P2 新问题；新发现两条 P3，其中一条的严重度取决于实现者的意图（见 §四）。

**发布裁决：批准 0.8.2，且该批准覆盖 `dist-vsix/git-rebase-visual-0.8.2.vsix`（12 项、`dist/extension.js` sha256 `8da5d31a…d77a`）。**

## 三、逐项裁决

| 验收项 | 裁决 | 证据（均为真实 Git 实测） |
|---|---|---|
| 1 `createdStash` 各形状 | 通过 | 12 个纯形状 + 4 个真实仓库形状全绿：一个新增→该 sha；`before` 已含同一 sha / 重复 sha→`undefined`；零新增（干净树）→`undefined`；两个新增（并发）→`undefined`；非零退出→`undefined`；任一读失败→`undefined`；“建一条并删一条”仍只认新增的那条；`output` 传德文“Es gibt keine lokalen Änderungen…”不影响答案。前后两次读之间只有 `git stash push` 一条命令，无其他可改列表的调用（`worktree.ts:58-72`） |
| 2 本地化路径是否真正封闭 | 通过 | 真实干净树 push：`sha=undefined`、用户条目原样保留；纯函数用翻译文案仍 `undefined`；`stashShasForSet` 在“空 reflog + 活的 `refs/stash`”上返回 `undefined`（`worktree.ts:118-125`）。`stash()` 内**已无任何**文案读取：`createdStash` 的 `output` 参数被 `void output` 显式丢弃（`worktree.ts:92`）。`LC_ALL=C` 只剩“让 `git stash push` 的提示文本保持英文以便日志可读”这一装饰作用 |
| 3 `undoWrongDrop` 的坏 witness | 通过 | A 自己的 sha 消失→`ok/gone`；B 自己的仍在、恰好一个外来 sha 消失→`refused` + `stash store` 原样还原；C 两个外来 sha 同时消失→`refused`，**一个都不猜**、不写入（`stash list` 只剩自己的）；D witness `undefined` + 德文文案→`refused`（`无法确认删除了哪一条`），绝不 `ok:true`；E witness `undefined` + 英文文案点名外来 sha→仍还原；F 文案点名自己而自己仍在列表→`refused`“被重新加入”；G/H 列表不可读（删 `logs/refs/stash`）→无论文案能否解析一律 `refused`；I 真实 hook 在 drop 窗口内 push→`refused`、三方 sha 全在 |
| 3′ “外来条目被真删时绝不 `ok:true`” | **有条件通过（见 R-6）** | 只要“自己的 sha 已不在列表”这一条成立就返回 `ok/gone`（`worktree.ts:560-564`），**不再看 witness**。构造：`before=[ours,theirs]`，两者都在窗口内消失→返回 `ok:true`，外来条目未被还原。该形状需要同一个窗口里**两次**独立删除（我们的条目被第三方 drop + 我们这一 drop 又落在用户条目上） |
| 4 R-2 | 通过 | 复现原测：无 flag 时 `--name-only` 只给 `b.txt`，加 `--no-renames` 给 `a.txt,b.txt`；只还原目标时旧路径集 `b.txt` 的 `diff --cached --quiet` exit 0（`index:present`），新路径集 `a.txt b.txt` exit 1（`index:missing`）。实测 `stashPresence.index="missing"`、`complete=false`、`reconcilePendingAppend` 不 resolved、条目保留。`stagedSnapshotInHead` 同函数受益：只提交目标的 HEAD 报 `committed:false` |
| 4′ 其他 `--name-only` 站点 | 通过 | `commitLog.conflictedFiles`（`diff --diff-filter=U`）实测在 rename/rename、modify/delete-rename、add/add、content/content、rename-vs-modify 五种冲突上，加不加 `--no-renames` **输出完全相同**（未合并项按路径逐个列出，Git 不做折叠），不需要该 flag。`worktree.restoreUntrackedHalf` 用 `ls-tree`，无重命名概念。`rebaseViewProvider.openCommitDiff` 的 `--name-status -M` 由 `parseCommitChangedFiles` 按 `R100\0old\0new\0` 正确消费，仅用于选择 Diff 文件，属展示层且 `-M` 正是它想要的语义 |
| 5 R-3 | 通过 | 验证实现者前提：对**仍在列表顶层**的 sha 执行 `stash store` 确实 no-op（条目数 2→2）；把我们的条目挤到 `@{1}` 后再 store 才产生重复（2→3）。重复时 `stashRemoveBySha` 拒绝并点名 `stash@{0}`、`stash@{2}`，两个副本都保留；`stashNameForSha` 返回 `undefined`。`stashNameForSha` 的 5 个调用方逐一检查：`reconcilePendingAppend`→保留文案带 sha；`pendingWarningText`/`resetState`/`restoreAppendSnapshot`→回退 `sha <7>` 并打印 `git stash list` 提示；`announceSettled`→`drops` 为空，改为“槽位当前无法解析…自行删除”；`recoveryCommands`→apply 用 sha、**drop 步骤被撤下** |
| 6 `stash store` 文案 | 通过（措辞可再精确） | 实测：还原后条目回到 `stash@{0}`，`git stash list` 显示 `stash@{0}: git-rebase-visual restored 8f644a5`；`%s`（commit subject）仍是原 `On master: user entry`。消息写明“放回列表最上方”和“说明文字会变成 …”，两条断言都在测试里 |
| 7 stash 全生命周期 | 通过 | 成功 autostash、成功 append（`changeStash`+`unstagedStash` 残留）、`resolved` 分支、pop 冲突保留、占用检查前用户 `stash push`——五种形状都断言“用户原有条目的 sha 集合逐字节不变”，实测一致（前后 `deepEqual` 到排序后的 sha 数组）；`pendingRecovery.integration` 53/53、`recoveryProvider`+`pendingRecoveryPolicy` 26/26 |
| 8 审计表准确性 | 通过（4 行抽查 + 2 行延伸） | `describeStash` 数行数→结构；`patchId` 取 hex 首字段→结构；`gitVersion` 取版本数字→结构；`rebaseAtEditStop`/`parseTodoStep` 读 todo/done 文件语法→结构（非 gettext）；`parseWorktreeChanges` 读 porcelain v2 -z→结构；`commitDetail --shortstat`→确为 prose 且只作 `--numstat` 之后的 fallback，`C_LOCALE` 已带。表末“只有 `diffNames` 与 `changedPaths` 两处按路径枚举”与代码一致 |
| 类型检查 | 通过 | `node node_modules/typescript/bin/tsc --noEmit` → 0；`tsc -p tsconfig.test.json --noEmit` → 0（均零输出） |
| 受影响套件 | 通过 | `worktreeChanges.integration` 6/6；`worktree.integration` 8/8；`editStopCommit.integration`+`rebaseEngine` 17/17；`pendingRecovery.integration` 53/53；`recoveryProvider`+`pendingRecoveryPolicy` 26/26 |
| 262 项计数 | 静态一致（未实跑全量） | `test/` 下 41 个文件、`index.test.ts` 全量 import 41 个、顶层 `test(` 声明合计 **262**；`RELEASE.md`、`docs/summary/summary.md:146`、`docs/release-notes/0.8.2.md` 三处均写 262 |
| VSIX | 通过 | `node scripts/package-vsix.js --verify-only` → `VSIX contents match the allowlist (12 entries)`；包内 `extension/dist/extension.js` sha256 `8da5d31a1489a749e043854e7e80725a71363d1b99fe47c97069dfb95019d77a` 与工作树 `dist/extension.js` 逐字节相同；`extension/dist/seq-editor.js` 与 `src/git/seq-editor.js` 同哈希；`src/`、`media/` 下无文件比 `dist/extension.js` 新（打包在前、无更新源码）；包内不含 `docs/research`、`scripts`、`test`、`.vsix`/`dist-vsix` |
| 文档一致性 | 通过 | `README.md`、`RELEASE.md:167`、`docs/improvement/improvement.md:22`、`docs/release-notes/0.8.2.md:86-87` 已统一描述“sha 集合差 + 文案只作旁证 + `stash store` 回最上方并改写说明文字”；未发现仍在描述“用 `/No local changes to save/` 判断”或“永不自动删除”的现行为描述（0.8.0 的历史描述均已标注为历史） |

## 四、新发现（按严重度）

### R-6（P3）`undoWrongDrop` 的“自己的 sha 消失”短路会掩盖同窗口内的外来删除

- `src/git/worktree.ts:560-564`：`after` 可读且 `!after.includes(sha)` 时立即 `return { ok:true, gone:true }`，**不再检查 witness**。构造（真实 Git 实测）：`before=[ours,theirs]`，在 drop 窗口里我们的条目被第三方 drop、我们自己的 `git stash drop stash@{0}` 又落在用户条目上，`after=[]` → 返回 `ok:true, gone:true, message:""`，用户条目未被 `stash store` 还原。
- 前置条件是同一个亚毫秒窗口里发生**两次独立删除**（一次外部 drop/`stash clear`，一次我们的 drop）。相比之下，R-1 修的正是这个窗口内的单次误删；这里是它的退化情形，概率更低。无字节丢失（commit 仍可通过 reflog/fsck 找回），但它是本轮委托问题“never `ok:true` when a foreign entry was actually removed”的一个字面反例。
- 建议（可选，不阻塞发布）：`after` 可读时若存在 `before`，先算 `vanished`；当 `vanished` 里含有非本 sha 的条目而本 sha 也不在 `after`，说明不止一条消失，应走 `refused` 而不是 `ok/gone`。

### R-7（P3）`stashRemoveBySha` 与 `pendingRecovery.stashShas` 对“reflog 不可读”的判断不一致

- `worktree.ts:447-467` 只判 `list.code !== 0` 就 `refused`；`stash list` 在 reflog 损坏时**退出 0 且输出为空**，于是落到 `indices.length === 0` → `{ ok:false, gone:true }`（实测：删掉 `logs/refs/stash` 后调用返回 `gone:true`）。`pendingRecovery.stashShas` 的同名语义把这一形状正确判为 `undefined`（不可读）。
- 影响受限于调用方：唯一调用方 `removeOwnStash` 在 `presence.listed !== true` 时根本不进入（`pendingRecovery.ts:673`），而 `presence.listed` 用的是 `stashShas` 的保守版本；`stashRemoveBySha` 在列表上的“读失败”分支本身也只在 `removeOwnStash` 走不到的情况下才有意义。因此当前**不可达为事故**，但两个同义函数对同一状态给出相反答案，是下一次改动的陷阱。
- 建议：把 `stashShasForSet` 的“空 reflog + 活 `refs/stash` → 不可读”逻辑抽成共享函数，`stashRemoveBySha` 复用之。

### R-8（P3，文档措辞）`stash store` 改写的是 reflog 的说明（`%gs`），不是 commit subject

- 实测 `git stash list` 显示 `git-rebase-visual restored <sha7>`（即 `%gs`），而该 stash commit 的 `%s` 仍是 `On master: <原说明>`。代码注释与用户消息说“它的**说明文字**会变成 …”，对 `git stash list` 的读者是正确的；若有人按 `--format=%s` 去核对就会对不上。当前措辞没有错，只是不精确；无需改动，除非后续要写进面向用户的排查文档。

## 五、直接回答

1. **R-1 是否修好？** 是。`stash()` 的创建判定已完全脱离文案（`output` 参数被显式丢弃），干净树/并发/读失败/非零退出全部 `undefined`；`undoWrongDrop` 在文案不可解析时的默认答案是 `refused`，只有“自己的 sha 已不在列表”这一条身份判据能给出 `ok`。残留的 R-6 是同一判据的退化形状，概率更低，不改变“本地化不再破坏解析”的结论。
2. **R-2 是否修好？** 是，且 `stagedSnapshotInHead` 一并修好。其余 `--name-only` 站点经实测不需要该 flag；`--name-status -M` 属展示层，`-M` 是它想要的语义。
3. **R-3 是否修好？** 是。重复 sha 一律拒绝并点名每个槽位；`stashNameForSha` 的 `undefined` 会让所有调用方降级到 sha 寻址，并撤下不可执行的 `git stash drop`。
4. **0.8.2 可否发布？** 可以。**批准覆盖已产出的 VSIX**（12 项、包内 `dist/extension.js` 与工作树逐字节一致、版本 0.8.2、无更新源码未进包）。R-6/R-7/R-8 均为 P3，可留作 0.8.3 或 `docs/improvement/improvement.md` 的后续项，不阻塞本次发布。

## 六、复验命令与结果

- `node node_modules/typescript/bin/tsc --noEmit` → exit 0
- `node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit` → exit 0
- `tsx --test test/worktreeChanges.integration.test.ts` → 6 pass / 0 fail
- `tsx --test test/worktree.integration.test.ts` → 8 pass / 0 fail
- `tsx --test test/editStopCommit.integration.test.ts test/rebaseEngine.test.ts` → 17 pass / 0 fail
- `tsx --test test/pendingRecovery.integration.test.ts` → 53 pass / 0 fail
- `tsx --test test/recoveryProvider.test.ts test/pendingRecoveryPolicy.test.ts` → 26 pass / 0 fail
- `node scripts/package-vsix.js --verify-only` → `VSIX contents match the allowlist (12 entries)`
- 静态计数：41 个测试文件、41 个 import、262 个顶层 `test(`（未实跑全量，按委托要求）
- `git status --short | wc -l` → 开始 35，结束 36（仅新增本文件；`git log -1` 仍 `eddca5642cb7dadb1645e24e2d6d074a39aedc26`）
