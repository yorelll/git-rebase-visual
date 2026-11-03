# code review 0.8.3 — Agent B 独立复审（0.8.2 增量）

> 独立评审代理 B。本轮只评审 0.8.2 的未提交工作树，未修改任何产品代码、测试、发布说明或既有评审文件；本轮唯一写入的评审产物是本文件。
> 按委托要求**未更新** `code-review-commit.md`（未提交工作树暂无 commit SHA 可入账；提交后必须由后续独立评审按真实 SHA 覆盖）。

## 一、评审基线

| 项目 | 值 |
|---|---|
| 仓库 | `D:\work\tools\git plugin` |
| 分支 / HEAD | `main` / `eddca5642cb7dadb1645e24e2d6d074a39aedc26`（`fix: release 0.8.1 — append false conflict and log location`） |
| 被测材料 | 0.8.2 未提交工作树：12 个修改文件 + 新增 `docs/release-notes/0.8.2.md` |
| 上一份评审 | `code-review-0-8-2.md`（覆盖 0.8.1 工作树） |
| 评审日期 | 2026-10-29 |
| 起始 / 结束 `git status --short` 条目数 | **12 / 15**（14 个产品/文档条目 + 本评审文件；评审期间实施者仍在编辑 `.gitignore`、`.github/workflows/release.yml`、`package.json` 等） |
| Git / Node | `git 2.53.0.windows.2` / `node v24.16.0` |
| 运行方式 | 临时目录抛掷仓库 + 真实 `git`；用仓库自带 `tsx` 直接调用 `stashApplyIndexBySha` / `reconcilePendingAppend`。未跑全量套件（委托要求只做定向运行） |

## 二、结论摘要

**不作为 0.8.2 的发布批准。** 三段式恢复的核心设计正确，静默放弃守卫在三条场景下均正确，提示死胡同已修好；但**路径枚举存在一个 P1 静默空转缺陷**（非 ASCII 文件名），并且新恢复流程留下了一个 **P2 Abort 死胡同**。两者都不丢 stash，但会让用户看到“追加成功”的错误结论，或按提示 Abort 却失败。

| 严重级别 | 数量 |
|---|---|
| P0 | 0 |
| P1 | 2（其中 1 项为既有缺陷，非 0.8.2 引入） |
| P2 | 2 |
| P3 | 2 |

## 三、三段式恢复（`src/git/worktree.ts:106`）逐项裁决

### 3.1 三份义务的来源树 —— 正确

`stash^1..stash` → `restore --source=<stash> --worktree`；`stash^1..stash^2` → `restore --source=<stash>^2 --staged`；`stash^3` → `checkout <stash>^3 -- path` + `reset -q -- path`。四类形状在抛掷仓库中逐一实测，暂存/未暂存/未跟踪的落位与 stash 前的分隔完全一致：

- 暂存修改 + 工作区残留：索引只含暂存路径，残留回到工作区；
- 暂存新文件 + 未跟踪文件：新文件入索引，未跟踪文件保持未跟踪；
- 同一文件既暂存又继续编辑（`MM`）：索引拿到 `<stash>^2` 版本，工作区拿到 `<stash>` 版本；
- 暂存删除：目标路径从索引与工作区一并移除（目标树中存在该路径时为真实恢复，目标树中不存在时为跳过分支）。

### 3.2 顺序依赖是真实且必要的

先做索引半会移除路径，随后 `restore --worktree` 报 `error: pathspec 'x.txt' did not match any file(s) known to git`；工作区在前则两步均 rc 0。`git checkout <stash> -- path` 同样在“索引先做”后失败，因此“工作区先于暂存区”是最小正确不变量，不是可以省掉的顺序。注释（`src/git/worktree.ts:100-104`）已写明，**判定充分**；建议补一条一句断言把这个顺序固定成回归（见 P3-1）。

### 3.3 暂存删除边界 —— 正确

目标树中没有该路径时（`cat-file -e :path` 与 `<stash>^2:path` 均不存在），跳过是“恢复本就不需要”而非“失败被读成成功”：期望状态（索引中不存在）已经成立，若仍执行 `restore --staged` 只会得到 pathspec 错误。目标树中存在该路径时走真实恢复并被现有用例钉住。

### 3.4 `--no-renames` 与重命名 —— 正确

`git restore` 不接受 `--no-renames`（实测 `error: unknown option`），因此只给 `git diff` 加该参数是唯一可行写法。`git mv old.txt new.txt` 快照在 `--no-renames` 下枚举出 `new.txt` + `old.txt` 两半，恢复后 `git status` 为 `R old.txt -> new-renamed.txt`，不会退化成只剩目标路径。

### 3.5 字面 pathspec —— 正确，但只覆盖了一部分

`GIT_LITERAL_PATHSPECS=1` 对三段恢复都生效。实测：文件名 `br[1].txt` 与诱饵 `br1.txt` 并存时，不带该变量会让 `restore` 同时改写两个文件（rc 0，静默数据破坏）；带上后只改目标，诱饵内容未变。**但枚举路径的 `-z` 缺失**，见 P1-1。

### 3.6 未跟踪半的覆盖保护 —— 正确

`checkout <stash>^3 -- u.txt` 在目标已存在未跟踪文件时 rc 1，用户内容保持不变；本函数的错误分支把该错误原样返回，不会被当成成功。

## 四、静默放弃守卫（`src/git/pendingRecovery.ts:949`）裁决

三条场景全部正确：

1. 用户序列（edit 停靠 → 恢复 → `git add` 冲突文件）→ `pending`，记录与 stash 均保留，`reason` 明确说明“尚未写入目标 commit”；
2. 之后 `git rebase --abort` → 不再有进行中的变基，同一状态判为真实放弃，`restored`/`resolved`，并**确实**把暂存半放回索引（实测 abort 后 `git diff --cached` 恢复出 `staged-new.txt`），不会永久告警；
3. 已落地的 amend（目标不再是祖先）→ `resolved`，无误报。

守卫本身没有发现问题。问题出在它保持 `pending` 时**横幅给出的命令不可执行**（P2-1）。

## 五、提示修复裁决

- `src/ui/rebaseViewProvider.ts:1690/1694`（恢复导航提示）与 `:2170`（追加失败 toast）已不再把 Continue 当作出路，文字明确说明“暂存内容尚未写入目标 commit，因此不能 Continue”，并给出 Abort/手动命令。**通过。**
- 全局 `Continue` 检索：剩余出现处均为**真实可用**的 Continue（冲突未解决、变基暂停、`amended: true` 的正常流程、只读/草稿模式限制），没有第二处“被拒绝却仍推荐 Continue”的死胡同。**通过。**
- **但新文案里的“请选择 Abort 以自动恢复”本身可能是死胡同**，见 P2-2。

## 六、测试逐条判断

| 用例 | 位置 | 撤掉修复会变红？ | 是否编码了原因 |
|---|---|---|---|
| 原始事务（既有） | `test/appendStaged.integration.test.ts:10` | 否（0.8.1 就通过） | 是：断言 amend 只带 `append.txt`、`untracked.txt` 内容保留、stash 为空（显式 drop） |
| 追加到最早 commit 不得拖入后续文件 | `:68` | **是**（`Index was not unstashed.`） | 是：文档块说明“每个 commit 只添加自己的文件、冲突不可能成立”，并断言每个 commit 只拥有自己的文件、`stagedDelta` 与 `worktreeOnly` 互补、无 unmerged、索引只含暂存文件、amend 只多这一个文件、两份 stash 都在 |
| 暂存新文件 + 后续文件 | `:201` | **是**（`Index was not unstashed.`） | 是：断言无冲突路径、索引等于预期的单一路径、amend 后 `HEAD` 不含后续路径 |
| 纯修改、无任何残留（最简形状） | `:259` | **是**（`later.txt: does not exist in index`） | 是：先断言快照前确无未跟踪/未暂存改动，再断言索引与 amend 内容，排除了“靠残留恰好对上”的可能 |
| 暂存删除（钉行为） | `:308` | 否（修复前后都通过，**这正是它的目的**） | 是：注释写明“朴素修复会把它改坏”，断言路径从索引与工作区消失、amend 记录删除 |
| 索引一致但追加未落地必须 pending | `test/pendingRecovery.integration.test.ts:366` | **是**（撤掉 `pendingRecovery.ts` 改动时 36/37，仅此例失败，`kind: resolved`） | 是：断言 `pending`、stash 仍在、`HEAD:target.txt` 仍是原内容（追加确实没发生），并在 Abort 后断言会结算 |

- 破坏性验证（本会话内完成）：把 `src/git/worktree.ts` 还原为 HEAD 版本 → **恰好 3 个**新增/原有追加用例失败，钉行为用例与原始用例通过；把 `pendingRecovery.ts` 还原 → 仅新增对账用例失败。实施者“非空转”的说法属实。
- `test/helpers/gitTestRepo.ts` 的 `cleanupRepo` 是**纯 teardown**（先 abort，abort 失败则 `clean -fdq` 重试，再 `rebase --quit`，最后删目录），不会掩盖产品断言。**但它自身的注释恰好记录了本文 P2-2 的 Abort 拒绝状态**，说明实施者在测试里见到过该状态，却只按 teardown 处理、没有产品级断言。这一点值得作为 P2-2 的佐证。

## 七、新发现（按严重程度）

### P1-1 非 ASCII / 带空格路径：三段恢复静默空转，向用户报告“成功”

- 位置：`src/git/worktree.ts:59-62`（`diffNames` 无 `-z`，且 `.trim()`）、`:178`（`ls-tree -r --name-only` 无 `-z`）；同类写法在 `src/git/pendingRecovery.ts:178`（有 `-z` 但仍 `.trim()`）。
- 机理：`core.quotePath` 采用 Git 默认 `true` 时，`git diff --name-only` / `ls-tree --name-only` 会把非 ASCII 路径输出成 `"\346\232\202..."` 形式。该字符串随后既查不到 `<stash>^2:path`（`cat-file -e` rc 128），也查不到索引条目，于是**同时被两个“跳过”条件过滤掉**，`stashApplyIndexBySha` 返回 `{ok:true}` 而什么都没恢复。`trim()` 同理会让 ` lead.txt` 变成 `lead.txt` 而被过滤。
- 证据（真实 Git + 仓库自带 `tsx` 调用真实函数）：
  - 暂存 `新增模块说明.txt`，edit 停靠后调用 `stashApplyIndexBySha` → `{"ok":true}`，`git diff --cached` 为空，工作区无该文件，文件仅存在于 stash；随后 `commit --amend` 成功、`rebase --continue` rc 0，产品打出“已将暂存区文件追加到 …”。
  - 同一形状在 `core.quotePath=false` 下（本机全局配置恰好如此）恢复正常：索引得到该文件——**这台机器默认掩盖了该缺陷**。
  - **tip 目标也复现**：目标为 tip 时旧实现 `git stash apply --index` 能恢复该文件（实测 `A  新增模块说明.txt`），新实现返回 `ok:true` 而索引为空 → 与发布说明“目标恰好是 tip 时才总能成功”相矛盾，属**回归**。
  - `stash^3` 分支表现不同：`checkout` 用带引号的路径 → rc 1，函数返回 `ok:false`（`恢复未跟踪文件 "\346..." 失败：error: pathspec ... did not match`），属于**报错中断**而非静默，但同样恢复不出文件。
  - 带前导空格的暂存文件 ` lead.txt` → `{ok:true}`、索引为空（`trim()` 造成），同一类静默失败。**并且对账侧更危险**：`src/git/pendingRecovery.ts:180` 的 `changedPaths` 虽用了 `-z`，仍对每条路径 `.trim()`，于是 `lead.txt`（去掉空格后）在 `<stash>^2` 与索引中都不存在，`git diff --cached --quiet <stash>^2 -- lead.txt` 因“两边都没有差异”返回 0，被判为 `index: present`。实测：未恢复任何内容、变基已结束（`amended:false`）时 `reconcilePendingAppend` 返回 **`resolved`**，记录被清除，用户不会再看到横幅，而文件只存在于 stash。这正是本轮要修的“静默放弃”同一类失败，只是触发路径在路径枚举。
- 影响：追加“成功”但内容没进目标 commit；暂存意图只剩 stash 里一份（**没有数据丢失**，但用户被告知成功）。与模块“失败即保守”的原则相反：这里是“失败被报告成成功”。
- 修法：枚举统一改为 `-z` + 以 `\0` 切分（仓库内已有正确先例 `src/git/pendingRecovery.ts:178` 与 `treeBlobs` 的 `ls-tree -r -z`），并去掉 `trim()`；补一条含中文/空格/`[` 的回归用例。

### P1-2（既有缺陷，非 0.8.2 引入）残留恢复未使用字面 pathspec，会覆盖更新的用户内容

- 位置：`src/git/pendingRecovery.ts:369`、`:384`（`git restore --source=… --worktree -- …` 未带 `GIT_LITERAL_PATHSPECS`）。
- 证据：快照含工作区改动 `e[1].txt`，用户在诱饵路径 `e1.txt` 写入 `USER-NEWER` 后调用 `reconcilePendingAppend` → 返回 `restored`，`e1.txt` 被改写为提交里的旧内容，`USER-NEWER` 在任何 commit/stash 中都不存在（不可恢复）。这正是模块头部承诺“永不覆盖更新的用户内容”的反例。
- 说明：该函数不是 0.8.2 改动的代码，属既有缺陷；但 0.8.2 已经引入 `LITERAL_PATHSPECS` 这一正确先例，顺手统一即可，且新恢复流程的失败会把它带进同一条路径（P1-1 静默失败后由对账补写）。
- 修法：与 `worktree.ts` 共用同一个 `LITERAL_PATHSPECS` 环境，并加一条 glob 诱饵回归。

### P2-1 记录保持 `pending` 时，横幅首条命令 `git stash apply --index` 必然失败

- 位置：`src/git/pendingRecovery.ts:1070`（`recoveryCommands`）与 `src/ui/rebaseViewProvider.ts:1614-1627`（横幅文案）。
- 场景：新守卫让“索引已与快照一致、但追加未落地”的记录保持 `pending`；此时索引半已经在位，横幅仍把 `git stash apply --index <name>` 列为第一条“恢复暂存区与工作区改动”。
- 证据：该状态下执行该命令 → `error: staged-new.txt: already exists in index` / `error: conflicts in index. Try without --index.` rc 1；第二条 `git stash apply` rc 0 但什么也没改变；再次对账仍为 `pending`（`reason` 正确）。用户按横幅操作无法脱困，只能依赖“Abort”。
- 修法：`pending` 且 `index: present` 时不要把 `apply --index` 放在首位（或先说明“索引已就绪，只需 Abort 或重新执行追加”），文案按 `presence` 分支生成。

### P2-2 新恢复流程留下的工作区状态会让 `git rebase --abort` 失败（Abort 死胡同）

- 位置：`src/git/worktree.ts:131`（工作区半先写）配合 `src/git/rebaseEngine.ts:179-181`（`abortRebase` 用会抛错的 `git()`）与 `src/ui/rebaseViewProvider.ts:1109-1113`（`abortRebase` 抛出后 `restorePendingAppend(..., true)` 不会执行）。
- 场景：恢复在 amend 之前失败（例如用户 `pre-commit` 钩子拒绝 `commit --amend`，或未跟踪半失败），此时工作区半已把后续 commit 的文件写成未跟踪文件；toast 让用户“选择 Abort 以自动恢复”。
- 证据：`git rebase --abort` → `error: The following untracked working tree files would be overwritten by reset: later.txt`，`fatal: could not move back …`，**rc 128，可无限重试**；同一形状在旧实现（`apply --index`）下 abort rc 0。手工可脱困的路径存在（`rm` 掉未跟踪文件后 abort rc 0；或 `git rebase --quit` rc 0），但两者都没有出现在任何提示里。
- 佐证：`test/helpers/gitTestRepo.ts:53-67` 的注释明确写下“That is exactly the state these append tests leave behind”，即为该状态做的 teardown 兜底。
- 修法：`abortRebase` 失败时不要直接抛给通用 catch——捕获 128、提示可行的手工命令（`git clean -fd` 指定路径 / `git rebase --quit`），并继续执行原 stash 恢复；或在恢复前先判断工作区半是否会与 abort 冲突。

### P3-1 顺序依赖缺少回归断言

注释足够，但没有一条测试会在顺序被调换时变红（调换后只有集成路径失败，缺少定点断言）。建议在 `test/appendStaged.integration.test.ts` 的暂存删除形状里补一句：先做索引半后 `restore --worktree` 必须 rc≠0，用用例钉住“工作区先于暂存区”。

### P3-2 发布说明的两处表述需要收紧

- “目标恰好是 tip 时才总能成功”在 P1-1 的非 ASCII 形状下已不成立（新实现 tip 也静默失败，旧实现成功）。
- “已实测非空转……3 个新增/原有追加用例失败”准确；“npm run test 全绿”本轮未复跑（按委托只做定向运行），无法独立确认 222 项，只能确认 `test(` 声明计数为 222。

## 八、发布完整性

| 检查 | 结果 |
|---|---|
| `package.json` / `package-lock.json`（root 与 `packages[""]`） | 均 0.8.2 ✔ |
| `docs/release-notes/0.8.2.md` 标题 `## Git Rebase Visual 0.8.2`、无 `{{…}}` | ✔ |
| `RELEASE.md` `- **0.8.2** —` | ✔ |
| 发布说明事实性（影响范围、无数据丢失、Continue 是死胡同、`read-tree`/`--staged` 不可用） | 与实测一致 ✔（`restore --no-renames` → `unknown option`；`stash push --staged --include-untracked` 被拒绝；`read-tree <stash>^2` 替换整个索引） |
| `dist/extension.js` 中 2 处 `0.8.1` | 均为日志目录迁移提示，非陈旧版本戳 ✔ |
| VSIX 文件数 / 内容 | 12 个文件；无 `.map`、`sourcesContent`、`src/`、`test/`、`docs/`、`node_modules`、`tsconfig*` ✔ |
| VSIX 版本 / 与 `dist/extension.js` 一致性 | 清单与 `extension/package.json` 均 0.8.2；bundle 与 `dist/extension.js` SHA-256 相同 ✔ |
| 是否有比 VSIX 更新的源码 | 无 ✔ |
| bundle 是否含 0.8.2 修复与文案 | 含 `GIT_LITERAL_PATHSPECS`、新守卫与新提示（转义形式）✔；但同时含**未修**的 `diffNames`/`ls-tree --name-only` 写法 → **该 VSIX 携带 P1-1** |

**发布裁决：当前工作树状态不予批准发布 0.8.2。** 修复 P1-1（至少）后必须重新执行：`npm run compile`（`npm run package` 会自动经 `vscode:prepublish` 重新编译）→ 定向跑 `test/appendStaged.integration.test.ts` 与 `test/pendingRecovery.integration.test.ts` → 两个类型检查 → 重新生成并**替换** `dist-vsix/git-rebase-visual-0.8.2.vsix` → 重新校验 12 个文件、清单 0.8.2、bundle 与 `dist/extension.js` 哈希一致。现有 VSIX 与当前工作树一致，但它的内容本身含有 P1-1，因此“工作树批准”也不覆盖它。

## 九、验证命令

```bash
# 真实 Git 抛掷仓库（OS 临时目录），用仓库自带 tsx 直接调用被测函数
node ./node_modules/tsx/dist/cli.mjs <probe>/run.ts <temp-repo> <stash-sha>       # stashApplyIndexBySha
node ./node_modules/tsx/dist/cli.mjs <probe>/reconcile.ts <temp-repo> <sha> <target>
node ./node_modules/tsx/dist/cli.mjs <probe>/resid.ts <temp-repo> <sha>

# 定向测试（实现者已跑通；本轮未复跑全量）
node ./node_modules/tsx/dist/cli.mjs --test test/appendStaged.integration.test.ts

# 发布包
node -e "..."                     # 版本一致性
unzip -l dist-vsix/git-rebase-visual-0.8.2.vsix
sha256sum <unzipped>/extension/dist/extension.js dist/extension.js
```

所有抛掷仓库与探针已删除；`git status --short`：**起始 12 / 结束 15**（含本文件）；未在仓库内执行 commit/tag/checkout/stash/reset。
