# code review 0.8.2 — Agent B 独立复审（0.8.1 窄范围增量）

> 独立评审代理 B。本轮是**窄范围增量复审**，不是全量重审。未修改任何产品代码、测试或发布说明；本轮唯一写入的评审产物是本文件。
>
> 本轮核心任务是裁决实施者的一处**方案偏离**：批准方案是"`worktree == stash^2` 时**跳过**写入"，实施者改为"**写回**"。下面用真实 Git 逐条取证。

## 一、评审基线

| 项目 | 值 |
|---|---|
| 仓库 | `D:\work\tools\git plugin` |
| 分支 / HEAD | `main` / `b87011d586a7ca1ba0adf84d9f204b5653660379`（`test: keep the abort child alive so the cancel test is deterministic`） |
| 上一份评审 | `code-review-0-8-1.md` |
| 本轮被测 | 0.8.1 的**未提交工作树**（12 个修改文件 + 新增 `docs/release-notes/0.8.1.md`） |
| 评审日期 | 2026-10-29 |
| 起始 / 结束 `git status --short` 条目数 | 13 / 13（本轮未改动工作树任何产品/测试/文档文件） |
| commit SHA | **0.8.1 改动仍未提交，暂无 commit SHA 可记录**；台账仍以基线 SHA 作为覆盖锚点 |
| Git / Node | `git 2.53.0.windows.2` / `node v24.16.0` |

## 二、结论摘要

**批准发布（Approve）。** **实施者的"写回"偏离是正确决定，跳过方案确实会造成永久 `pending`。** 两个用户缺陷均已修复，两个 0.8.0 不变量（永不自动删除 stash、永不覆盖更新的用户内容）在实测中均成立。VSIX 也与当前工作树一致。

新发现 3 项，**全部为 P3**（一条代码注释的事实性错误、一条注释的过度断言、一处未覆盖的 Windows 大小写冲突分支）。无 P0/P1/P2。

| 严重级别 | 数量 |
|---|---|
| P0 / P1 / P2 | 0 / 0 / 0 |
| P3 | 3 |

## 三、核心裁决：写回（write）vs 跳过（skip）

### 3.1 实施者的说法成立 — 跳过会留下**永久** `pending`（实测）

在 HEAD 的独立副本上把守卫改成"跳过"（只 `continue`，不 `unstagedPaths.push`），用真实 Git 复现用户的形状：

```text
presence before reconcile {"listed":true,"index":"present","worktree":"missing","unstaged":"missing", ...}
OUTCOME  pending :: 快照中未提交的部分仍未恢复到工作区
         （listed=true index=present worktree=missing unstaged=missing untracked=present）
presence after reconcile ... worktree=missing unstaged=missing ...   ← 工作区没被写回
SECOND OUTCOME  pending :: 同上                                ← 第二次轮询仍然 pending
```

原因链与实施者描述完全一致：`restoreResidualSnapshot` 跳过 → 路径仍是 `stash^2` 内容 → `residualPresent()` 要求的 `unstaged === "present"` 永远不成立 → `reconcilePendingAppend:890-897` 每轮都返回 `pending`。**这是把一个假冲突换成了一个永不消失的假 `pending`，比原缺陷更糟**（横幅永久存在、每轮都写日志）。跳过方案的注释（`pendingRecovery.ts:338-345`）声称"两个安全分支在上方返回"，但跳过并不满足 `residualPresent` — 这正是被证伪的地方。

**写回方案实测（当前工作树代码）：**

```text
OUTCOME  restored :: 已补回快照中未提交的部分（residual.txt, first.txt）
presence after reconcile {"index":"present","worktree":"present","unstaged":"present","untracked":"present","complete":true}
SECOND OUTCOME  resolved :: 追加内容已在 工作区/索引 中，跳过恢复（...）
```

一次通过即 `restored`，第二次 `resolved`。**第 4 问（后置再探测是否满足）答：满足，既无永久 pending，也无新的假 resolved。**

### 3.2 写回的安全性 — 逐形状实测

| 形状 | 实测结果 | 判定 |
|---|---|---|
| **路径缺失 + 快照有内容**（用户实际形状：`first.txt` 被 `rebase --continue` 还原成 `stash^2` 字节，日志中的 3 个 `_fpga.c` 已从 `stash^2..stash` 中消失） | `concurrent === committedBlob` → 写回快照字节，`restored` | ✅ 安全，且与 `!snapshotBlob \|\| exists` 的旧"缺失即可写"分支等价（都是"路径缺失 → 可安全写入"） |
| **用户编辑恰好复现了已提交字节**（`worktree == stash^2`，但用户是"手动"写回的） | 写回快照字节（`restored`）。**但没有任何不可恢复的丢失**——覆盖掉的内容恰好等于 `stash^2`，而 `stash^2` 在 amend 后的 commit 里仍然存在 | ✅ 可接受（见 3.4 的缓解措施） |
| **`stash^2` 本身是删除**（`committedBlob === undefined`） | 真实 append 流程构造：`snapshot(sha)` 无 `first.txt`、`snapshot^2` 有 → `pending`（冲突），**文件仍在**，未被删除 | ✅ 安全，且注释里"快照中的删除保持冲突"成立 |
| **快照是删除 + 路径现存**（`snapshotBlob === undefined`） | 守卫被 `snapshotBlob !== undefined` 排除 → 走 `!snapshotBlob` → 冲突 | ✅ 安全 |
| **只有 mode 不同、内容相同**（`current === committedBlob`，但 worktree 的 +x 是用户刚加的） | **理论可达，但本机 Windows 无法构造**：`core.fileMode` 在此盘符为 false，`chmod` 不被 Git 记录，`git restore --source --worktree` 也不改 mode。代码层面成立；见 N-3 | ⚠️ 理论存在，影响为"丢失一个 chmod"（磁盘内容保留、可恢复），且 `stash^2` 的 mode 仍可从 commit 取回 |

**其它冲突路径未被放松**：未跟踪文件碰撞（`new.txt`）、快照删除、内容与 `stash^2` 不同 —— 实测均仍报 `pending`。**守卫只对"已跟踪 + 快照有内容 + 现存 + blob 等于 `stash^2`"开口，其余一律保持原语义。**

### 3.3 两个 0.8.0 不变量

| 不变量 | 结论 | 证据 |
|---|---|---|
| **永不自动删除 stash** | ✅ 未变 | 恢复全程只用 `git restore` / `git stash apply`；本轮新增两个形状的实测里 `stash list` 始终是 **2 条**（`changeStash` + `unstagedStash`）；`residualPresent`/`keptStash` 路径未改动任何 `drop/pop` |
| **永不覆盖更新的用户内容** | ✅ 未变（就"更新的内容"而言） | 写入前提是 `hash-object(worktree) == rev-parse(stash^2:path)`，即"自事务开始后无人写过"；任何不同字节 → 冲突。**唯一例外是 3.2 的 mode 单维（N-3）与"用户恰好写回相同字节"（可恢复，非丢失）** |

### 3.4 一条需要记录的缓解措施（非缺陷，不改代码）

3.2 第 2 行（用户恰好复现已提交字节，或 0.8.0 那句 `apply --index` 死循环建议已把路径写回）会被判定为"未动"而被再次写回。**这不是数据丢失**：被覆盖的内容等于 `stash^2`，而 amend 之后的 commit 永远持有它（`git checkout <amended> -- <path>` 可取回）。但如果想进一步收紧，可在代码注释里点明这一层（当前注释只说"nothing has been written since the transaction ran"，在 0.8.0 已污染的场景下这句偏强）。**不构成打回条件。**

## 四、逐项判定

### 4.1 第三信号审计（`worktree=missing unstaged=missing`） — **结论正确；注释有一处事实错误（N-1）**

实测三种形状：

| 注释里的断言 | 实测 |
|---|---|
| "replayed commit **不**拥有该路径时，工作区确实缺失，`restoreResidualSnapshot` 写回并报 `restored`" | ✅ 复现（`NOT-TOUCHED`：`worktree=missing` → `restored`） |
| "replayed commit **拥有**该路径时，探测是 `present`（worktree == `stash`），不写入" | ❌ **实测是 `missing`**。构造"edit-stop commit 自己改 `f.txt`"的形状后：`stash^2:f = v2`、`stash:f = WORKTREE`，`rebase --continue` 把工作区留在 `v2`，探测为 `worktree=missing unstaged=missing`，随后写回 `WORKTREE` 并报 `restored`。也就是说：**该信号本身完全不能区分"拥有/不拥有"，它只能区分"已有提交的字节 / 缺内容"，正是本次修复要处理的那一类**。见 N-1 |
| "后续 commit 改写该路径时 `rebase --continue` 先冲突，对账走不到" | ✅ 两个方向都复现：`apply --index` 阶段（`Index was not unstashed`，amend 失败）与 `rebase --continue` 阶段（`UU`，停在冲突）都会先失败；此时 `reconcilePendingAppend` 报 `pending` 且路径上是带冲突标记的用户内容，**未被覆盖** |
| "不存在假 `pending`/假 `resolved`" | ✅ 成立（复现的冲突形状都保留 pending 与 stash；未构造出假 resolved） |

**修复后的行为是安全且正确的**；问题只在注释把"拥有路径 → 探测为 present"写成了事实，而实测是 `missing`。这会让未来维护者误以为该信号能区分两种形状。

### 4.2 新回归测试 `test/pendingRecovery.integration.test.ts:1007` — **有效，且忠实复现用户形状**

- **回退敏感性**：把 `pendingRecovery.ts` 还原成 HEAD 版本后，该用例 **失败**（`AssertionError: the residual was restorable, so no warning is warranted`，实际 `pending`）。✅ 非空转。
- **忠实度**：`edit 停靠 → stashApplyIndexBySha → commit --amend --no-edit → stashPushKeepIndex → continueRebase → reconcilePendingAppend`，与日志时间线 `09:52:48` → `09:52:53` 的调用序列逐步对应；断言"残留回到工作区 + 结论非 pending + 两份 stash 均在"，与用户症状一致。
- 唯一的**测试成本**注记：单次用例在本机约 **27-33 s**（全量 39 min 的主因是这类 pause/continue 真实 Git 流程）。不算缺陷，但若将来要压时间，优先看这一组。
- 实测：`✔ a keep-index stash rebased after the amend restores its residual instead of reporting a false conflict`。

### 4.3 日志路径 — **正确**

- `logDirectory(version, home = os.homedir())` → `<home>/tmp/log/git-rebase-visual-<version>`；`legacyLogRoot(tmpdir = os.tmpdir())` → `<tmpdir>/log`。本机实测：`C:\Users\lawrence_lv\tmp\log\git-rebase-visual-0.8.1`（新，尚未创建）与 `...\Temp\log\git-rebase-visual-0.8.0`（旧，确实存在）。
- 测试**全部注入 home**（`C:\Users\someone` / `/home/someone` / `/tmp`），无开发机路径依赖；`test/fileLogger.test.ts` 19 项全绿。
- **hint 不会刷屏**：`legacyLogHintShown` 是模块级 `let`，只在 `openLogs` 回调内翻转，每次扩展宿主会话最多一行；不弹通知（`noteLogLocation` → `provider.log` → OutputChannel + 文件日志）。
- **hint 不会抛**：`provider` 在 `activate` 内 `logger.start()` 之前构造，`log()` 只做 `output.appendLine` + `logDiagnostic`（后者对 `logger` 可选），整段无 `try/catch` 也不会中断 `openLogs` 后续的 `ensureDirectory()`。
- **hint 指向真实存在的位置**：它命名的是**根** `<tmpdir>/log`（不是版本子目录），0.8.0 用户那里确实存在；新路径由 `ensureDirectory()` 在提示之后立即创建，信息成了自证。✅
- `README.md` / `RELEASE.md` / `docs/summary/summary.md` 均已改为新路径，旧临时目录只作为**明确标注的历史记录**（"0.8.0 及更早为 `<tmp>/log/...`"、"0.8.1 之前…仍留在原临时目录"）。VSIX 内 `extension/readme.md` 与仓库 `README.md` 逐字节一致。

### 4.4 `test/llmClient.test.ts` 重写 — **非空转、有界、且 `src/llm/client.ts` 与 HEAD 逐字节一致**

- `git diff --quiet -- src/llm/client.ts` → 与 HEAD 一致。✅
- **非空转（sabotage 实测）**：只把"abort 分支的 throw"改成 `return full` → 用例变红（`Missing expected rejection`）。把 **fetch signal 转发 + 读取 race + `reader.cancel` 三处一起**中和（真正的"取消失效"）→ 用例变红，且**约 6 s 结束**（不是挂住）。✅
- **有界，不会挂住套件**：服务端 `late++ >= 20` 后 `res.end()`，加 `res.on("close")` 清理 interval；即使客户端完全忽略取消，流也会自行结束。实测 `6 s`。✅
- `src/llm/client.ts:205-219` 的 per-read race 确实存在（`read` vs `abortOrTimeout`），取消由"首个 delta 到达"触发是确定性事件，不再与 5 ms 定时器竞速。✅
- 定向运行：`streamChat yields…` / `streamChat mid-stream cancellation…` / `streamChat honours the deadline…` 3/3 通过。

### 4.5 发布完整性 — **通过**

| 检查 | 结果 |
|---|---|
| `package.json` version | `0.8.1` ✅ |
| `package-lock.json` 根 + `packages[""].version` | 均为 `0.8.1` ✅（其余 `0.8.0` 命中都是依赖的 `node: >=0.8.0` / `rrweb-cssom@0.8.0`，无关） |
| `docs/release-notes/0.8.1.md` 标题 | 第 1 行 `## Git Rebase Visual 0.8.1` ✅，与 CI 的 `grep -Fq` 模式一致 |
| 无 `{{…}}` | CI 的 `! grep -Eq '\{\{[A-Z_]+\}\}'` 通过（实测无命中）✅ |
| `RELEASE.md` 有 `**0.8.1**` | ✅（`**0.8.1** — 修复追加到 commit 时的误报冲突…`） |
| 文档测试数 = 真实套件 | 文档写 **217**；`grep -cE '^\s*(test\|it)\('` = **217**，且无 `.skip`/`.todo`/`.only` ✅ |
| 0.8.1 说明是否如实写"未丢失用户数据" | ✅ 明确写"没有丢失任何用户数据…两份 stash 都仍在 `git stash list`" |
| 是否如实写"旧 `apply --index` 是死循环" | ✅ 明确写"旧提示是个死循环…无论试多少次都不会自行恢复" |
| 是否还有文档声称日志在临时目录 | ✅ 除作为**已标注的历史记录**外无残留 |

`npm run typecheck`（`tsc --noEmit` + `tsc -p tsconfig.test.json --noEmit`）**两处均零输出**。本轮**未跑全量套件**（约 39 min），只跑了：新回归用例（`pendingRecovery.integration.test.ts` 单名称过滤）、`fileLogger.test.ts` 全文件、`llmClient.test.ts` 的 `streamChat` 三项、以及 `pendingRecovery.integration.test.ts` 在 HEAD 副本上的全文件对照（36/36）。

### 4.6 VSIX — **通过，且与当前工作树一致**

- `git-rebase-visual-0.8.1.vsix`，**12 个条目**：`extension.vsixmanifest`、`[Content_Types].xml`、`extension/{readme.md, package.json, LICENSE.txt, .gitignore}`、`extension/media/{style.css, main.js, icon.svg, extension-icon.png}`、`extension/dist/{seq-editor.js, extension.js}`。
- **无** `.map` / `sourcesContent` / `src/` / `test/` / `docs/` / `node_modules` / `tsconfig*`。✅
- 打包版本：`extension/package.json` = `0.8.1`，`extension.vsixmanifest` 的 `Version="0.8.1"`。✅
- **重要正面证据**：我用 `esbuild` 从当前工作树重新构建 `src/extension.ts`，与 VSIX 内 `extension/dist/extension.js` **逐字节相同**（247847 bytes，`a === b`）。同时 `find src test docs … -newer <vsix>` **无输出**。✅
- 包内含新逻辑与迁移提示（UTF-8 转义后的 `日志目录自 0.8.1 起位于…`、`legacyLogRoot`、`committedBlob` 守卫）均已确认存在。

## 五、新发现（按严重度）

### N-1（P3）`src/git/pendingRecovery.ts:396-400` 审计注释与实测不符

- **位置**：`residualPresent` 上方审计注释第 4-6 行："When the replayed commit *does* own the path, the probe is `present` (worktree == `stash`) and nothing is written."
- **错误**：构造"edit-stop commit 自己修改 `f.txt`"的形状后实测 `stash^2:f = v2`、`stash:f = WORKTREE`，`rebase --continue` 把工作区留在 `v2`，`stashPresence` 返回 `worktree=missing unstaged=missing`（**不是 present**），随后被新守卫写回 `WORKTREE` 并报 `restored`。
- **影响**：仅注释失真，**代码行为安全**（写回正是期望结果）。但它会让下一位维护者误信"该信号能区分 commit 是否拥有路径"，从而可能在别处以 `worktree === "present"` 做安全判据。建议改写为"无论 commit 是否拥有该路径，`rebase --continue` 都会把已提交的字节留在工作区，探测都是 `missing`；写回总是落在 `stash^2` 的字节即事务自己的内容上"。

### N-2（P3）`src/git/pendingRecovery.ts:314-327` 守卫注释过度断言"proves nothing has been written"

- **场景**：0.8.0 那句 `apply --index` 死循环建议，恰恰会把用户工作区写成 `stash` / `stash^2` 的字节；用户按提示操作几次后，`worktree == stash^2` 已经不能证明"自事务开始后无人写过"。同理，用户手动把内容改回已提交字节也算"写过"。
- **影响**：会把这些字节换回快照字节，但被覆盖的内容等于 `stash^2`，在 amend 后的 commit 中永久可取回，**不构成数据丢失**。
- **建议**（非必须）：把 "proves nothing has been written" 降级为 "is byte-identical to the transaction's own committed tree, so replacing it with the snapshot loses nothing that HEAD does not still hold"。

### N-3（P3）`src/git/pendingRecovery.ts:331-337` 守卫是 mode-blind；Windows 大小写不敏感分支未覆盖测试

- 守卫只比较 blob（`hash-object` vs `rev-parse stash^2:path`），**不比较 mode**。理论上"用户只 chmod、内容恰好等于 `stash^2`"会被写回并丢失那次 chmod。
- **本机无法构造**：该盘符 `core.fileMode` 为 false，Git 不记录 `chmod`，`git restore --source --worktree` 也不改 mode（实测）；因此当前测试矩阵无法证明或否定该分支。
- 影响为"丢失一个 chmod"，磁盘内容仍在、commit 里仍有该 mode，可恢复。若要比照 `stagedSnapshotInHead` 的"mode + object"严格度，可用 `git ls-tree` 同时比较 mode 与 object，代价是每路径多一次 Git 调用。
- 附：`worktreePathExists`（`pendingRecovery.ts:259-265`）用 `fs.existsSync`，在 **Windows 大小写不敏感**文件系统上，`Foo.c` 与 `foo.c` 会互相命中，可能把"另一个文件"判为"该路径存在"。属既有实现（非本轮引入），本轮只提醒它同时决定"写/冲突"两支，值得后续补一条大小写测试。

## 六、发布裁决

**0.8.1 在当前工作树状态下可以批准发布；该批准同时覆盖已产出的 `git-rebase-visual-0.8.1.vsix`，无需重新构建或重新验证。**

依据：
1. 两个用户缺陷均已修复，核心偏离（写回）经真实 Git 证明是**正确决定**，跳过方案会造成永久 `pending`。
2. 两个 0.8.0 不变量（永不自动删除 stash、永不覆盖更新内容）在实测中成立。
3. 新回归测试在回退后变红，忠实复现用户形状。
4. `package.json` / `package-lock.json` / `RELEASE.md` / `docs/release-notes/0.8.1.md` 与 CI 门禁逐条对齐；测试数 217 与真实套件一致；typecheck 零输出。
5. VSIX 12 文件、无禁止内容、版本 0.8.1，且**其 `dist/extension.js` 与从当前工作树重新构建的产物逐字节相同**，无"源码比 VSIX 新"的问题。

发布前唯一建议（**不阻塞**）：执行 `npm run test:release` 跑一次全量（含覆盖率），因为本轮按指示未跑全量；本轮已用定向用例 + HEAD 副本 36/36 对照 + 双 typecheck 覆盖了所有改动面。N-1 的注释修正在下一次触及该文件时一并完成即可。

## 七、本轮运行的命令（全部只读或临时目录）

```text
node ./node_modules/tsx/dist/cli.mjs --test --test-name-pattern="keep-index stash rebased after the amend" test/pendingRecovery.integration.test.ts   # 当前代码：通过
（HEAD 副本）同上 → 失败（回退敏感性）
（HEAD 副本 + 跳过方案）probe → 永久 pending（两次轮询）
（当前代码）probe 用户形状 / 冲突形状 / 删除形状 / mode 形状 / 拥有路径形状
node ./node_modules/tsx/dist/cli.mjs --test test/fileLogger.test.ts                       # 19/19
node ./node_modules/tsx/dist/cli.mjs --test --test-name-pattern="streamChat" test/llmClient.test.ts   # 3/3
（sabotage：abort throw → return）→ 变红；(fetch+race+cancel 全中和) → 变红，6s 结束
node ./node_modules/typescript/bin/tsc --noEmit                     # 零输出
node ./node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit  # 零输出
node ./node_modules/esbuild/bin/esbuild src/extension.ts --bundle --format=cjs --platform=node --target=node18 --external:vscode --outfile=<tmp>  # 与 VSIX 内 extension.js 逐字节相同
unzip -l / -Z1 git-rebase-visual-0.8.1.vsix
grep -cE '^\s*(test|it)\(' test/*.ts → 217（无 skip/todo/only）
```

临时探针目录（`grv-review-*`、`grv-vsix-*`）已删除；进程表只余评审开始前就存在的 `node`（8:41-8:57 启动，非本轮）；`git status --short` 起始/结束均为 **13**，HEAD 仍为 `b87011d`。
