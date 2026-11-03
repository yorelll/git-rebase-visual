# 测试性能分析（2026-10-30）

> **⚠️ 已被取代（superseded，2026-11-03）。** 本报告是实施**之前**的只读分析，其中的方案**不要照抄**。
> 实际实施的是：`package.json` 的 `test` / `test:coverage` 指向 `scripts/run-tests.js`，由该脚本在 Node 内**枚举** `test/*.test.ts` 后交给 `node:test` 按文件调度（`--test-concurrency=3`），**没有**采用本文 §候选 B 的 `tsx --test "test/**/*.test.ts"` glob 形式。原因：CI 固定 `node-version: 20`（`.github/workflows/release.yml`），而 `node --test` 接受 glob 参数是 Node 22 起才有的能力（Node 20 的 `doc/api/test.md` 完全没有 glob 语义，会把 `test/**/*.test.ts` 当字面路径）；另外 shell 对 `*`/`**` 的展开规则在 bash、cmd.exe 之间不一致。改回 glob 会让发布门禁在 CI 上失败。
> 另有两处数字已过时：本文的 217 个测试是旧树，当前为 **275 个测试 / 43 个文件**；`pendingRecovery.integration.test.ts` 已拆为 **3 个文件共 60 个测试**。
> 本文的**测量方法和结论**（进程启动是主要成本、拆分收益、并发取 3 而非 6）仍然有效，值得保留。

本文件记录一次只读的性能排查：为什么 `npm test`（`tsx --test test/index.test.ts`）在本机 Windows + MSYS Git 环境下需要约 21 分钟，以及哪些优化值得做、分别有多大风险。所有数字都来自本 worktree 内的实测，估算值已标注依据。

**结论先说：这不是 CPU 慢，也不是测试写得复杂，而是进程启动开销。** 217 个测试里 100 个需要真实 Git，合计产生 2,574 次子进程启动；在每次 Git 启动约 220–470 ms 的机器上，这部分就是墙钟时间的主体。测试本身的计算量（非子进程时间）只有 11.9 秒。

---

## 1. 结论摘要

1. **总耗时 1,438 s（串行逐文件求和），其中 1,200 s（83%）是等待 Git 子进程。** 两次 spawn 之间所有测试逻辑、断言、轮询相加只有 11.9 s。真实全量运行（聚合器单进程）TAP 记录的 `duration_ms` 为 1,269.7 s，与 1,438 s 同一量级；差值主要来自逐文件测量把 41 次进程启动重复计了一遍。
2. **2,574 次被计数的子进程启动全部是 `git`（打点器看到 0 次非 Git 调用）。** 打点器挂的是 `child_process.execFileSync/spawnSync/spawn`，会记录被测进程发起的任何子进程；结果里没有一条非 Git 记录，说明测试代码里唯一的外部进程就是 Git。作为标尺，`node -e "0"` 单次约 1.9–2.1 s，是这台机器上最贵的原语之一——但它只影响"进程数"，不影响"Git 调用数"。
3. **单个 Git 启动成本与本机仓库规模无关**：空仓库 `git version` 中位 231 ms，300 commit / 200 tag 的仓库 `git status` 中位 213 ms。这是 MSYS 进程创建开销，不是 I/O，因此"把 fixture 仓库做小"没有收益。
4. **耗时高度集中**：`pendingRecovery.integration.test.ts` 单文件 655 s（占逐文件串行和 1,438 s 的 45.5%，占真实全量运行 1,269.7 s 的 51.6%），加 `recoveryProvider.test.ts` 165 s 共 57%。**只改这两个文件的执行方式（不删任何测试）就能把总时间压到 37.5%**（实测 476.7 s / 1,269.7 s）。
5. **聚合器把 40 个文件塞进一个进程顺序执行**，这是当前最大的"白给"损失：26 个不碰 Git 的纯逻辑文件合计 117 个测试，真实测试时间只有 2.19 s，却消耗 161.8 s（每文件约 6.2 s 的 `tsx` 转译 + 进程启动）。仅把这一层改成共享进程，实测 53.1 s → 7.4 s。
6. **（本轮新增，洁净进程表实测）现状基线是 965.1 s，A+B 是 371.0 s。** 在外部测试进程数为 0 的条件下重测：`npm test` 同款入口 **965.1 s / 217 全绿**；拆分 `pendingRecovery` + 按文件交给 Node 并发 3 **371.0 s / 217 全绿**。这是本报告最可信的一组数字——§2–§8 的 1,269.7 s / 476.7 s 带有外部负载，偏悲观，两套数字不要混用（见 §8.10）。比值仍是 **2.6 倍**。
7. **（本轮新增）预建 fixture + 拷贝：能做，但不划算。** `createRepo()` 单次 **620–1,024 ms**，拷贝空模板 **68–74 ms**；但全量真实只执行 **106 次 `createRepo`、151 次 `commitFile`**，`commitFile` 拷贝替代不了。可省 **58–101 s（6–10%）**。实跑 217/217 全绿且**不破坏任何断言**，但需要每个使用点自己保证模板无残留 stash / 无 `rebase-merge`，维护成本高于收益。**判定：不建议做；等价的低风险替代是候选 D（约 39 s）。** 详见 §9。
8. **（本轮新增）候选 E 的真实上限约 29–34 s，且 §3.6 的"每次两个 node 进程"是错的。** 一次全量真实发生 **19 次 `executeRebase`、19 次 node 编辑器执行（18 sequence + 1 message）**，即普通 rebase 只有 **1 个**编辑器进程，改 message 时才是 2 个。换 `sh` 单行 `cp` 单次 2,888 → 1,105 ms，**19 次约省 34 s（3.5%）**；对真实用户是每次 rebase 少等约 1.8 s。`sh` 方案在 Windows 上实测可用（Git 会注入自带 `usr/bin`），但仍建议保留 `process.execPath` 作为兜底。详见 §10。

---

## 2. 测量方法与数据

### 2.1 环境与前提

| 项目 | 值 |
| --- | --- |
| OS | Windows（`C:\Users\lawrence_lv\...`） |
| CPU | 16 逻辑核（`os.availableParallelism() = 16`） |
| Node | v24.16.0 |
| tsx | v4.23.13 |
| Git | 2.53.0（PortableGit，MSYS） |
| 入口 | `package.json` → `"test": "tsx --test test/index.test.ts"` |

**进程表洁净性检查**：每个测量批次开始前用 `Get-CimInstance Win32_Process` 过滤 `node.exe`/`git.exe`，按 `ParentProcessId` 回溯到本 worktree 的 `scratch/*.mjs` 或 `node_modules/tsx` 祖先，确认没有前序批次遗留的 `git` 子进程在跑；测量批次结束后复查同一过滤条件，确认本批次进程树已完全退出。

过程中我自己制造并清理了 **2 项残留**：

1. 一次被中断的 run 留下 `git rev-list --parents -n 1 ...`（PID 41728，父进程已死，存活 13.8 分钟）。按 PID 精确 `Stop-Process` 后确认消失。
2. `%TEMP%\grv-test-x2fc5S`（19:08:50 创建，来自并发 6 那次失败的 run）。值得记录的是：**这个目录是空的，连 `.git` 都没有**。这说明 `createRepo()` 的 `mkdtemp` 成功后，第一次 `git init` 就没能完成，或者清理逻辑把内容删掉而留下了目录本身——与 §5.2 失败 116 的"目录已被删除"恰好是同一类时序问题的两面。

最终复查：本 worktree 相关的 `node`/`git`/`sh` 进程为 0，`%TEMP%` 下 `grv-*` 目录为 0。未清理任何非本批次创建的临时目录。

### 2.2 逐文件测量

脚本逐个文件串行启动（`node tsx/dist/cli.mjs --test --test-reporter=tap <file>`），每个文件一个独立进程；同时通过 `NODE_OPTIONS=--require scratch/spawn-preload.cjs` 把 `child_process` 打点注入到 `node --test` 实际执行测试的子进程里，记录每次 spawn 的命令、argv、`exit` 时刻耗时。墙钟取被测进程的 `close` 时刻。

| 文件 | wall (s) | spawns | spawn 累计 (s) | wall−spawn (s) | tests | 说明 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| pendingRecovery.integration.test.ts | 655.0 | 1355 | 646.9 | 8.1 | 36 | 真实 Git |
| recoveryProvider.test.ts | 165.0 | 375 | 165.4 | **−0.4** | 11 | 真实 Git（provider 级，含并发子进程） |
| rebaseSafety.integration.test.ts | 70.8 | 128 | 66.4 | 4.4 | 5 | 真实 Git |
| commitLog.integration.test.ts | 65.7 | 144 | 59.9 | 5.8 | 12 | 真实 Git |
| editStopCommit.integration.test.ts | 52.8 | 111 | 53.2 | −0.4 | 4 | 真实 Git（含并发子进程） |
| worktreeChanges.integration.test.ts | 37.7 | 75 | 30.2 | 7.5 | 5 | 真实 Git |
| worktree.integration.test.ts | 31.3 | 51 | 25.5 | 5.9 | 4 | 真实 Git |
| undo.integration.test.ts | 30.7 | 66 | 24.4 | 6.3 | 4 | 真实 Git |
| pushGuard.integration.test.ts | 29.7 | 47 | 23.5 | 6.2 | 2 | 真实 Git（裸远端） |
| appendStaged.integration.test.ts | 28.1 | 38 | 22.3 | 5.9 | 1 | 真实 Git |
| squashFixup.integration.test.ts | 25.6 | 34 | 19.7 | 5.9 | 3 | 真实 Git |
| gitRunner.integration.test.ts | 23.5 | 35 | 20.9 | 2.6 | 7 | 真实 Git（回归主力，含并发子进程） |
| branchContext.integration.test.ts | 21.1 | 29 | 15.0 | 6.1 | 1 | 真实 Git |
| commitDiffState.integration.test.ts | 19.9 | 48 | 13.6 | 6.3 | 3 | 真实 Git |
| appendGuard.integration.test.ts | 19.4 | 38 | 13.2 | 6.2 | 2 | 真实 Git |
| webviewDom.test.ts | 7.8 | 0 | 0 | 7.8 | 8 | 纯逻辑 |
| llmClient.test.ts | 7.2 | 0 | 0 | 7.2 | 8 | 纯逻辑 |
| pendingRecoveryPolicy.test.ts | 7.0 | 0 | 0 | 7.0 | 10 | 纯逻辑 |
| webviewProtocolState.test.ts | 6.5 | 0 | 0 | 6.5 | 6 | 纯逻辑 |
| （其余 22 个纯逻辑文件） | 5.5–6.3 各 | 0 | 0 | ≈ wall | 各 1–19 | 纯逻辑 |

`wall−spawn` 为负值说明该文件里至少有两个 Git 子进程同时在跑（spawn 累计时间超过墙钟）。实测有 5 个文件出现这种情况，合计约 **19.9 s** 的重叠：`recoveryProvider` 7.2 s、`editStopCommit` 6.6 s、`gitRunner` 3.5 s、`rebaseSafety` 2.2 s、`appendStaged` 0.5 s。因此"spawn 占 83%"应理解为上限——真实串行等价占比略高于 83%，被重叠抵消的部分不到 1.5%。

汇总：

```
files 41（含 index.test.ts，不计入上表）
  纯逻辑 26 文件 / 117 tests：wall 161.8 s，真实测试时间 2.19 s，启动 + 转译 159.6 s（平均 6.22 s/文件）
  真实 Git 15 文件 / 100 tests：wall 1276.3 s，spawn 1200.0 s，测试时间 1183.8 s
  合计 217 tests：wall 1438.0 s，test 1186.0 s，spawn 1200.0 s
  spawns 2574，平均 466 ms/次（含测量期间外部负载；洁净时段约 220 ms）
```

成本分解（1,438 s）：

| 组成 | 时长 | 依据 |
| --- | ---: | --- |
| Git 子进程 | 1,200.0 s | 逐次 spawn 打点求和 |
| 26 个纯逻辑文件的进程启动 + tsx 转译 | 159.6 s | 161.8 s wall − 2.19 s 测试 |
| 15 个 Git 文件的进程启动 + tsx 转译 | ≈ 90 s（未直接测量） | 参照纯逻辑文件的 6.2 s/文件 × 15 |
| 被并发 Git 子进程抵消的重叠 | ≈ −20 s | 5 个文件的 spawn 累计超出墙钟之和 |
| 测试逻辑与轮询 | ≈ 10 s | 两次 spawn 之间的间隙求和 |

15 个 Git 文件的启动成本无法与 spawn 时间直接分离（两者在时间上交错），上表的 90 s 是按纯逻辑文件实测的每文件启动成本推算，**属估算**。

### 2.3 单次启动成本基准

同一台机器、无并发测试时测得：

| 操作 | min | median | max |
| --- | ---: | ---: | ---: |
| `git version`（无仓库） | 186 ms | 231 ms | 317 ms |
| `git rev-parse HEAD` | 145 ms | 240 ms | 357 ms |
| `git status --porcelain` | 178 ms | 252 ms | 383 ms |
| `git status --porcelain`（`GIT_OPTIONAL_LOCKS=0`） | 199 ms | 248 ms | 404 ms |
| `git rev-parse HEAD`（300 commit / 200 tag 仓库） | 154 ms | 196 ms | 267 ms |
| `git log -n 20`（300 commit / 200 tag 仓库） | 170 ms | 226 ms | 263 ms |
| `git status`（300 commit / 200 tag 仓库） | 178 ms | 213 ms | 248 ms |
| `node -e "0"` | 1532 ms | 2128 ms | 2390 ms |

**关键读数**：仓库规模从 0 涨到 300 commit + 200 tag，Git 启动时间没有变化（196–213 ms vs 231–252 ms，差异在噪声内）。所以这是进程创建 + DLL 加载的固定成本，任何"精简 fixture 内容"的做法都不会有收益，只有"减少进程数"才有。

### 2.4 真实全量运行的交叉验证

用与 `npm test` 完全相同的命令（带 spawn 打点）跑一次完整入口，TAP 尾部为：

```
# tests 217
# pass 217
# fail 0
# duration_ms 1269742.6059      ← 21.2 分钟
```

对 TAP 中 217 条 `duration_ms` 求和为 1,158 s。两者之差约 112 s，就是聚合器那一个进程的启动 + 整条 import 图的 `tsx` 转译成本（§3.5）。

注意真实运行（1,269.7 s）**比逐文件串行求和（1,438.0 s）少 168 s**，原因是前者只付一次进程启动 + 转译，后者付了 41 次。这正是候选 C 的收益来源：启动成本与"文件数"成正比，与"测试数"无关。

### 2.5 单次 spawn 的构成（以 `pendingRecovery` 为例）

1355 次 spawn 按动词聚合：

| 动词 | 次数 | 总时长 | 平均 |
| --- | ---: | ---: | ---: |
| `stash` | 219 | 195.8 s | 894 ms |
| `diff` | 364 | 140.1 s | 385 ms |
| `rev-parse` | 204 | 60.4 s | 296 ms |
| `commit` | 79 | 41.0 s | 519 ms |
| `ls-tree` | 97 | 37.4 s | 385 ms |
| `rev-list` | 74 | 29.2 s | 395 ms |
| `add` | 107 | 27.7 s | 259 ms |
| `rebase` | 12 | 19.4 s | 1617 ms |
| `config` | 82 | 18.8 s | 229 ms |
| `hash-object` | 44 | 16.6 s | 377 ms |
| `init` | 41 | 11.3 s | 277 ms |

出现频次最高的几条：`git stash list` 141 次（78.4 s）、`git rev-parse HEAD` 67 次（17.6 s）、`git rev-parse stash@{0}` 46 次（18.2 s）、`git config user.name/email` 各 41 次（18.8 s，纯为 fixture 铺垫）。

`stash` 类平均 894 ms，显著高于普通命令的 220–390 ms，因为它要写 reflog 并做一次 index/worktree 操作；`rebase` 平均 1.6 s。这两类是"每次都要付一次"的结构性成本。

---

## 3. 耗时构成分析

### 3.1 spawn（83%）

2,574 次 × 约 466 ms = 1,200 s。这是唯一的主体。把每个文件里"两次 spawn 之间的时间"加起来只有 11.9 s，说明测试代码本身没有任何一处在做长计算或轮询等待。

### 3.2 等待与轮询

`recoveryProvider.test.ts` 里有两个显式轮询：`settleRecovery`（50 ms 轮询、20 s 上限）和 `waitForRecoveryIdle`（50 ms 轮询、30 s、quietMs=500）。测量显示该文件 165.0 s 墙钟里，spawn 累计 165.4 s（略超墙钟，说明该文件内有并发 Git 子进程，重叠约 0.4 s），两次 spawn 之间的纯间隙只有 3.56 s。

**结论：轮询不是成本。** 50 ms 的轮询粒度在 165 s 里最多浪费几次 tick。它等待的是 provider 内部的真实 Git 调用，每次 200–900 ms，所以"把轮询改成事件驱动"最多省掉那 3.56 s 的间隙，收益可忽略。真正的原因是 `refresh()` 每调一次都要顺序跑 `repoRoot` → `checkGitFeature` → `isRebaseInProgress` → `rebasingBranch`/`currentBranch` → `getUpstream` → `rev-list --left-right --count`，是 6 次以上 spawn。

### 3.3 teardown

`removeRepo` 就是 `fs.rmSync(recursive)`，实测 10 次共 810 ms（约 81 ms/仓库），在 1,438 s 里可忽略。`t.after` 里的 `git rebase --abort`、`git remote remove` 等清理命令计入 spawn，但数量与测试数同阶，不是主因。

### 3.4 串行化

`test/index.test.ts` 把 40 个文件 `import` 进同一个进程，Node 的 test runner 在这一个文件内顺序执行所有 `test()`。所以真实运行时**没有任何文件级并行**：一个 53 s 的测试跑的时候，其余核是空的。

（旁证：本 worktree 之外对同一套测试的观测记录显示，21 分钟的墙钟内进程只用了约 54 s CPU，即约 4% 利用率。这一条**不是我在本 worktree 内测的**，作为量级参考引用。）

作为对照实验，把 40 个文件作为 40 个参数传给一次 `node --test`（让 Node 按文件调度）：

| 方式 | 墙钟 | 通过 | 失败 |
| --- | ---: | ---: | ---: |
| 当前入口 `test/index.test.ts`（单进程） | 1,269.7 s | 217 | 0 |
| 40 个文件参数，`--test-concurrency=3` | 700.4 s | 217 | 0 |
| 40 个文件参数，`--test-concurrency=6`（第 1 次） | 686.9 s | 215 | **2** |
| 40 个文件参数，`--test-concurrency=6`（第 2 次） | 684.9 s | 217 | 0 |

两点必须一起看：

1. **并发 6 比并发 3 只快 2%。** 原因很直接：`pendingRecovery.integration.test.ts` 单文件就有 655 s，它是硬下限，加多少个核都压不下去。**所以"提高并发"这条路的收益上限约 15 s**，与它带来的风险完全不成比例。
2. **并发 6 的第 1 次跑出了 2 个失败，第 2 次全绿。** 这两个失败**不可稳定复现**，属于并发下的 flaky，而不是确定性 bug（详见 §5.2）。这比"每次都失败"更危险：它会以偶发红灯的形式出现在 CI 里。

### 3.5 转译 / 启动

`tsx` 每个进程都要转译整条 import 图。纯逻辑文件在独立进程里平均 6.22 s，而这 26 个文件合计的真实测试时间只有 2.19 s，也就是说 **159.6 s 全是进程启动 + 转译**。如果把 26 个文件放进同一个进程（`--test-isolation=none`），实测：

```
isolated processes (default)                     wall=53.1s pass=117 fail=0
single process (--test-isolation=none)           wall=7.4s  pass=117 fail=0
```

注意这里的 53.1 s 是"26 个文件各自独立进程"的并发结果（不是 161.8 s 的串行和），说明即使有 Node 的文件级调度，26 次 `tsx` 冷启动仍要 53 s。共享进程后降到 7.4 s，**约 7 倍**。

`node --experimental-strip-types` 在本仓库不可用：源码使用无扩展名 import（如 `../src/git/message`），Node 原生类型剥离要求显式扩展名，会直接 `ERR_MODULE_NOT_FOUND`。这一点已实测确认，不是猜测。

`esbuild` 已在 devDependencies 里（`compile` 脚本用它打包扩展）。因此"预编译测试"是可行路径（见 §4 候选 F），但需要额外脚本和产物目录。

### 3.6 `executeRebase` 的额外 node 启动

`src/git/rebaseEngine.ts` 把 `GIT_SEQUENCE_EDITOR` / `GIT_EDITOR` 设成 `"<process.execPath>" "<seq-editor.js>"`，也就是**每次交互式 rebase 都由 Git 再拉起 node 进程**。而 `continueRebase` 用的是 `GIT_SEQUENCE_EDITOR: "true"`。

> **本节已被 §10 实测修正。** 下面这段"每次两个 node 进程"的表述**不准确**：普通 rebase 只拉起 **1 个** sequence editor；message editor 仅在 `plan.newMessage` 存在时才被调用（改 message 时才是 2 个）。真实次数是一次全量 **19 次 rebase / 19 次编辑器执行（18 seq + 1 msg）**。保留本节原文是为了让修正可追溯，**引用数字时请用 §10.2 的 29–34 s，不要用本节的 20–30 s**。

用同一个 edit-stop 场景测三种编辑器：

| 编辑器 | 中位耗时 |
| --- | ---: |
| `node seq-editor.js`（当前实现） | 2,629 ms |
| `sh` 脚本 copy（等价行为） | 1,206 ms |
| `true`（空操作，仅作下界参照） | 475 ms |

即每次 `executeRebase` 因 node 编辑器多付约 1.4 s。测试中 `executeRebase` **静态调用点**共 16 处（`pendingRecovery` 6、`rebaseSafety` 5、`editStopCommit` 2、`squashFixup` 2、`appendStaged` 1）。**实测真实执行次数是 19（不是 16）**，且每次只有 1 个编辑器进程——见 §10.1。按 19 × 1.5–2.0 s 修正后为 **约 29–34 s**。

> 注意：这是**产品代码**的性能问题，不只是测试问题。"每次 rebase 多拉起两个 node 进程"对真实用户同样是 1.4 s 的等待。但改它属于产品改动，本轮不建议直接改（见 §6）。

### 3.7 fixture 成本

`createRepo()` = `git init` + 2× `git config` = 3 次 spawn；`commitFile()` = `add` + `commit` + `rev-parse` = 3 次 spawn。按源码静态调用点统计：

| 文件 | createRepo | commitFile | fixture spawns | 实测 spawns | 占比 |
| --- | ---: | ---: | ---: | ---: | ---: |
| pendingRecovery.integration.test.ts | 37 | 52 | 267 | 1355 | 20% |
| commitLog.integration.test.ts | 12 | 17 | 87 | 144 | 60% |
| rebaseSafety.integration.test.ts | 5 | 14 | 57 | 128 | 45% |
| worktreeChanges.integration.test.ts | 5 | 9 | 42 | 75 | 56% |
| recoveryProvider.test.ts | 1 | 10 | 33 | 375 | 9% |
| （其余 10 个 Git 文件） | | | 213 | 600 | 36% |
| **合计** | | | **699** | **2574** | **27%** |

即 fixture 铺垫占全部 spawn 的 27%（699 次）。其中 `git config` 82 次（18.8 s）是纯浪费：实测用 `GIT_AUTHOR_*` / `GIT_COMMITTER_*` 环境变量可以完全替代这两条 `git config`，commit 成功且作者信息正确。每次 `createRepo` 因此可省 2 次 spawn（约 0.46 s）。41 次 `createRepo` → **约省 19 s**。

`commitFile` 的 `rev-parse HEAD` 也可以省：`git commit` 本身不输出 sha，但可以改用 `git commit -q` 后一次性 `rev-parse`，或让 fixture 直接返回已知内容。收益小于 `config`，因为有些测试确实需要 sha。

---

## 4. 优化候选（按收益/风险排序）

| 编号 | 措施 | 预计节省 | 风险 | 覆盖影响 | 建议 |
| --- | --- | ---: | --- | --- | --- |
| A | 拆分 `pendingRecovery.integration.test.ts` 为 3 个文件 | ~430 s（655 → 225.6 s，实测） | 低 | 无（36/36） | **采纳** |
| B | 去掉聚合器，按文件交给 Node 调度（并发 3） | 单独 1,270 → 700.4 s（实测） | 中 | 无（实测 217/217） | **采纳** |
| C | 纯逻辑层单独聚合 / `--test-isolation=none` | 53.1 → 7.4 s（实测） | 低 | 无（117/117） | **采纳** |
| D | `createRepo` 改用 `GIT_AUTHOR_*`/`GIT_COMMITTER_*` | **约 39 s**（实测次数 106 × 2 spawn × 182 ms） | 低 | 无 | **采纳** |
| E | 把 `executeRebase` 的 node 编辑器换成轻量脚本 | **约 29–34 s**（实测 19 次 × 1.5–2.0 s） | 中 | 需保留 message 编辑路径 | 先评估（产品改动） |
| F | 预编译测试（esbuild bundle，替代每进程 tsx 转译） | 估 40–60 s | 中 | 无 | 二期 |
| G | 并发提到 6+ | 仅 ~15 s（700.4 → 684.9 s，实测） | **高** | 2 次运行中有 1 次出现 2 个 flaky 失败 | **不采纳**（见 §5.2） |
| H | fixture 跨测试复用 | 估 100–150 s | 高 | 可能掩盖顺序/污染 bug | 不建议 |
| I | （本轮新增）预建 fixture + 每测试拷贝 | **58–101 s**（实测单次差 × 实测次数） | 中 | 当前无（实测 217/217 全绿），但需每处保证模板干净 | **不建议**（见 §9.6） |

**A+B 的组合效果实测**：把 `pendingRecovery` 拆成 3 个文件、其余 39 个文件一起交给 `node --test`：

| 布局 | 并发 | 墙钟 | 结果 |
| --- | ---: | ---: | --- |
| 当前（单进程聚合器） | 1 | 1,269.7 s（有外部负载） | 217/217 |
| 拆分 + 按文件调度 | 3 | **476.7 s**（有外部负载） | 217/217 |
| 拆分 + 按文件调度 | 6 | **308.0 s**（有外部负载） | 217/217 |
| **当前（洁净进程表）** | 1 | **965.1 s** | 217/217 |
| **拆分 + 按文件调度（洁净进程表）** | 3 | **371.0 s** | 217/217 |

最后两行是本轮在外部测试进程数为 0 的条件下重测的，**应以此为准**：**1,269.7 s → 476.7 s（2.66 倍，有负载）与 965.1 s → 371.0 s（2.60 倍，洁净）两种负载下比值一致**，说明 A+B 的相对提速是稳健的，只是绝对秒数受机器状态影响。洁净条件下并发 6 未重测。

即 **16.1 分钟 → 6.2 分钟（洁净，并发 3）**；有负载时是 21.2 → 7.9 分钟。217 个测试全部保留。注意并发 6 在拆分后那一次没有出现 flaky——因为拖慢时序的那 655 s 单文件消失了，但这只是"窗口变小"，不等于根因消除，而且只跑了一次。

上表的 A+B 结果里，26 个纯逻辑文件仍是各自独立进程；叠加候选 C 后应再降约 40 s（估）。

### 候选 A：拆分 `pendingRecovery.integration.test.ts`

**依据**：该文件 655 s，是第二名的 4 倍（`recoveryProvider` 165 s），占逐文件串行和的 45.5%。它内部 36 个测试完全顺序执行，每个都自建 fixture。把它按测试切成 3 个文件后，让 Node 并发跑：

```
# tests 36 / pass 36 / fail 0
# duration_ms 225629.4        ← 225.6 s（vs 655 s）
```

省约 430 s。切分是纯机械的：imports + 4 个 helper 定义进每个 shard，36 个 `test()` 轮流分配。没有共享可变状态（每个测试自己 `createRepo()`），所以切分不改语义。

**覆盖影响**：零。36 个测试原样保留，只是分布在 3 个进程里。

**风险**：低。唯一需要注意的是 `setGitInvocationObserver` 是进程级全局（`pendingRecovery` 里有用到），但每个测试自己 `t.after(() => setGitInvocationObserver(undefined))`，跨进程反而更隔离。

### 候选 B：去掉聚合器，让 Node 按文件调度

> **已实施，但命令不是下面这条。** 实际实现见 `scripts/run-tests.js`：枚举文件后调用 `node:test`，不向 `tsx`/`node` 传 glob。**不要**把 `package.json` 改回 `tsx --test "test/**/*.test.ts"`——CI 是 Node 20，不把 glob 参数当模式，发布门禁会失败。详见文首横幅。

**依据**：见 §3.4 的对照表，700.4 s（并发 3，全绿）。当前 1,269.7 s。

`test/index.test.ts` 的存在理由看起来是"一次 `tsx` 调用"，但它把并行度压成了 1。改成 `"test": "tsx --test --test-concurrency=3 test/**/*.test.ts"` 即可。**必须保留 `npm run test:release` 跑全量**（CI 用它，见 `.github/workflows/release.yml` 的 `npm run test:release`），所以不要把 release 门禁拆成子集。

**覆盖影响**：无，实测 217/217 通过。但并发 6 有 1 次运行出现 2 个 flaky 失败，说明并发上限需要保守取 3（见 §5.2 和候选 G）。

**风险**：中。Windows 上并发跑 Git 会加剧 §3.1 的 spawn 争用（§2.2 表里的 466 ms 平均值就是在 38/41 个采样点都有外部并发测试进程时测到的，洁净时段约 220 ms），所以并发数不是越大越好。另外候选 B 单独实施（不拆文件）时，655 s 的单文件决定了总时间不会低于 700 s 太多，**必须与候选 A 一起做才有意义**。

### 候选 C：纯逻辑层共享进程

**依据**：53.1 s → 7.4 s，117/117 通过。26 个文件、117 个测试的真实测试时间只有 2.19 s，剩下全是 `tsx` 冷启动。

两种实现：

1. 单独提供一个 `test/unit.test.ts` 聚合器（只 import 那 26 个文件），`npm run test:unit` 用它，`npm test` 先跑它再跑 Git 层；
2. 或者直接给 `node --test` 加 `--test-isolation=none`，但这会让所有文件（包括 Git 文件）共享一个进程，风险更大，不推荐混用。

推荐方案 1：**分层但不减覆盖**——`npm run test:release` 仍然跑全部 217 个测试，只是纯逻辑层更快。

**覆盖影响**：无。

**风险**：低。需要注意的是纯逻辑文件里有 `webviewDom.test.ts`（用 jsdom）和 `fileLogger.test.ts`（写文件），共享进程时要确认它们不互相污染全局。实测 117/117 通过，说明当前没有污染，但这属于"现在恰好没有"而不是"结构上不可能"，需要保留一次独立进程的校验开关。

### 候选 D：`createRepo` 用环境变量替代 `git config`

**依据**：`git config user.name/email` 各 41 次，合计 18.8 s。实测环境变量方式 commit 成功、作者正确：

```
env-identity commit exit: 0 stderr: (none)
committed author: T <t@e.com>
```

改法：`createRepo` 里删掉两条 `git config`，改为在 `git()` helper 的 `execFileSync` 里默认带上 `GIT_AUTHOR_NAME/EMAIL` + `GIT_COMMITTER_NAME/EMAIL`。

**覆盖影响**：无。但要注意 `createRepo()` 返回值被很多测试直接当 cwd 用，改 helper 内部不影响调用方。

**风险**：低。一个细节：如果某个测试**故意**依赖仓库里持久化的 `user.name`（例如断言 `git config user.name` 的返回值），会失效。grep 未发现这种测试。

### 候选 E：`executeRebase` 的编辑器

**依据（已被 §10 修正）**：2,629 ms（node）vs 1,206 ms（sh）vs 475 ms（true）。每次省约 1.4 s；真实执行 19 次，**约省 29–34 s**。注意"每次两个 node 进程"的说法不成立（普通 rebase 只有 1 个），详见 §10.1–§10.2。

改法：把 `seq-editor.js` 的逻辑用一个不依赖 node 的等价实现替换（Windows 上 `cmd /c copy` 或 Git 自带的 `sh` 脚本），或者用一个极小的静态二进制。必须保留 `GRV_MSG_FILE`（message 编辑）分支，因为 `editStopCommit` 和 `squashFixup` 依赖它。

**覆盖影响**：`gitRunner` 的超时/回收测试不碰编辑器；`editStopCommit` / `squashFixup` / `rebaseSafety` 依赖"message 被正确替换"这一行为，改后必须全绿。

**风险**：中。这是产品运行时路径，跨平台（Windows `cmd`、macOS/Linux `sh`、vscode-server）都要验证；`process.execPath` 的存在本来就是为了解决"远端没有 `node` 在 PATH"的问题，换成 `sh` 会引入新的可用性假设（Windows 上 `sh` 来自 Git for Windows，VSCode 扩展不能假设它在 PATH）。**因此建议只作为产品性能议题评估，不在测试优化里强行推进。**

### 候选 F：预编译测试

**依据**：每个进程 6.22 s 的启动里，`tsx` 转译占大头（真实测试 2.19 s）。`esbuild` 已在 devDependencies。

做法：`esbuild` 把 `test/**/*.test.ts` 打成若干 bundle，`node --test` 直接跑 JS 产物。

**覆盖影响**：无，但需要保证 bundle 的 sourcemap 正确，否则失败时的堆栈会指向 bundle 而不是源文件——这对本项目"回归测试要能定位"的诉求是实质损失。

**风险**：中。多一个构建步骤、多一份产物目录要保证不进 VSIX（`.vscodeignore` 检查），CI 也要同步。

**收益估算**：纯逻辑层已被候选 C 覆盖，剩下的 Git 层转译占比小，估 40–60 s（依据：15 个 Git 文件各约 6 s 启动，其中转译约占一半）。

### 候选 G：提高并发

**明确不建议**，收益上限只有约 15 s（并发 3 的 700.4 s → 并发 6 的 684.9 s），因为 655 s 的单文件是硬下限。

而且并发 6 的第 1 次运行出现 2 个失败、第 2 次全绿：

```
not ok 113 - reset clears orphaned bookkeeping but keeps a stash that still holds content
   'keep' !== 'clear'
not ok 116 - a stash whose base commit cannot be read keeps the record and warns
   Command failed: git stash list
   fatal: not a git repository (or any of the parent directories): .git
```

第二个失败是关键信号：`git stash list` 在一个**已经被删除的目录**里执行。这说明测试之间存在对临时目录的隐式依赖——`%TEMP%` 是共享的，`fs.rmSync` 与另一个进程里仍在跑的 Git 子进程竞争。"第二次没复现"不能当作它不是问题，恰恰相反：**偶发失败比稳定失败更难排查，也更伤 CI 可信度。** 详见 §5.2。

### 候选 H：fixture 跨测试复用

**不建议**。fixture 只占 27% 的 spawn，收益上限有限；而共享仓库会让"某个测试的残留状态污染下一个测试"成为可能，本项目恰恰有一批测试是围绕"stash 不能被误删""记录不能被误清"的，共享 fixture 会直接削弱这些测试的可信度。

---

## 5. 覆盖风险的量化

### 5.1 绝对不能删的测试

这些测试各自守着一个已经发生过的真实缺陷，删除或改写会留下无保护的行为：

| 测试 | 文件 | 守护的缺陷 |
| --- | --- | --- |
| `a timeout settles exactly once and reaps the grandchild` | gitRunner.integration.test.ts | `runGit` 超时后孙进程泄漏。测试里有一条**非空断言**（`assert.equal(isProcessAlive(grandchild), true, "pid ... was not a live process, so the reap check would be vacuous")`），确保回收检查不是空转 |
| `runGit settles on exit even when a Git hook leaves a grandchild with open pipes` | gitRunner.integration.test.ts | 0.8.1 修的就是"等管道关闭导致卡死"，改成等 `exit` + flush grace |
| `an abort settles exactly once` | gitRunner.integration.test.ts | abort 与 exit 竞争导致 resolve 两次 |
| `every command the banner offers actually runs against a real repository` | pendingRecovery.integration.test.ts | 曾经输出 `git stash apply --index stash:<sha7>` 这种**永远失败**的命令。测试真的去执行每条命令，而不是断言字符串 |
| `a full recovery pass removes only its own entries, never the user's` | pendingRecovery.integration.test.ts | 恢复只删插件自己的条目：Git 调用观察器断言从不出现 `stash pop`/`stash clear`、`drop` 恰好两次（本事务自己的两条），结算后列表只剩用户那条 |
| `pushRefspec enforces --force-with-lease against a real bare remote` | pushGuard.integration.test.ts | 真实裸远端的 `--force-with-lease` 拒绝路径，用 mock 无法覆盖 |

这 6 个测试合计约 100–130 s（估：`gitRunner` 7 个测试共 20.9 s，`pendingRecovery` 的 2 个约 57 s，`pushGuard` 的第 1 个约 25 s；按 TAP 单项时长推算）。**没有任何一项优化建议需要改动它们**——所有建议都是"换一种执行方式"，不是"少跑一个测试"。

### 5.2 并发暴露的真实风险（不是测试的错）

并发 6 的 2 个失败**不可稳定复现**（第 2 次同参数全绿），因此不能当作"某个测试写坏了"来处理，而是要按 flaky 的根因来分析：

- 失败 116：`git stash list` 在已删除目录里执行。可能是 `t.after` 的 `removeRepo` 与另一个进程里仍在跑的 Git 子进程竞争——但如果是**跨进程**竞争，那需要两个不同测试的临时目录互相干扰，而 `mkdtemp` 保证目录唯一。因此更可能的解释是**同一个测试进程内**：`removeRepo` 删掉目录后，该测试自己启动的某个异步 Git 调用（`reconcilePendingStash` 内部的 `runGit`）才真正执行到 `cwd` 上。这不需要并发就能发生，只是并发提高了时序窗口命中的概率。
- 失败 113：`resetDecision` 返回 `keep` 而不是 `clear`。该测试在同一个 fixture 上依次断言 keep/orphan/resolved 三种情形，中间用 `git stash drop` 和 `stashApplyIndexBySha` 改变状态。如果并发下 `git stash drop` 的执行或 reflog 写入出现延迟，`stashPresence` 就会读到旧的列表。

**这两种解释都指向同一类问题：测试对自己的异步 Git 操作缺少"确认已完成"的同步点，而不是共享了某个全局变量。** 这类问题在串行执行时被 `await` 的天然顺序掩盖，一旦改变执行时序就可能暴露。

落实到决策上：**如果采纳候选 B（按文件并发），并发度应保守取 3，并且验收条件不能是"跑通一次"**。建议对 `pendingRecovery` + `recoveryProvider` 两个文件在目标并发度下连跑 10 次全绿；同时要知道，并发 3 的 700.4 s 与并发 6 的 684.9 s 只差 15 s，所以**没有理由为了这 15 s 去冒 flaky 的险**。真正的收益在候选 A（拆文件，655 s → 225.6 s），它把硬下限降下来了，与并发度无关。

### 5.3 疑似重复的测试：实际不重复

**说明：本节是源码静态审阅的结论，不是"revert 验证"的结论。** 我没有逐个把源码改回旧实现再跑测试（那需要 41 次改动 × 一次运行，成本远超本轮预算），所以"某个测试是否 vacuous"只能给出**判断**而非**证明**。

审阅下来，几组"看起来重复"的文件实际是分层而非冗余：

- `pendingRecoveryPolicy.test.ts`（10 个测试，总计 0.006 s）测 `resetDecision` 等**纯函数**的分支；`pendingRecovery.integration.test.ts` 测这些函数在**真实 stash** 上的结果。前者能在毫秒级覆盖组合分支，后者验证真实 Git 行为。两者都在，是正确的分层 — 删掉前者不会省时间，删掉后者会失去唯一能发现"propose 正确但执行失败"的测试。
- `pushGuard.test.ts`（纯逻辑，0.001 s）与 `pushGuard.integration.test.ts`（真实裸远端，23.5 s）同理。前者校验 refspec 字符串的构造，后者验证 Git 真的按这个 refspec 拒绝。**不能因为后者更"真实"就删前者**：前者覆盖的分支组合多得多，且几乎免费。

唯一可考虑合并的是 `composeDraft.test.ts` / `composePanelState.test.ts` / `composePolicy.test.ts` 三个文件（合计 0.006 s）。但它们的总耗时已经接近 0，合并零收益，**不建议动**。

因此：**本轮没有找到"删掉能明显省时间且不损失覆盖"的测试。** 时间全都花在真实 Git 进程上，而每个真实 Git 测试都在验证 mock 无法验证的行为。

---

## 6. 不建议改动的部分

1. **`pendingRecovery` 的 36 个测试不删任何一个。** 这个模块的整个存在理由就是"宁可留着 stash 也不能误删"，而这恰恰是最难在 code review 里看出来、只能靠真实 Git 场景验证的行为。它贵（655 s），但每一秒都对应一个具体的失败模式（误删唯一副本、把"读不到"当成"没有"、把 reflog 损坏当成 stash 不存在）。
2. **`gitRunner` 的 7 个测试不删。** 见 §5.1，其中 3 个是 0.8.0/0.8.1 的回归测试，附带进程存活性的非空断言。
3. **`pushGuard` 的真实裸远端测试不删。** `--force-with-lease` 的行为无法用本地 mock 表达。
4. **不把 `test:release` 拆成"快速子集"。** CI 的 `npm run test:release` 是唯一的发布门禁，任何优化都必须让它仍然跑全部 217 个测试。可以改变"怎么跑"，不能改变"跑多少"。
5. **不引入 `--test-isolation=none` 到全量入口。** 它让 Git 测试共享进程，`setGitInvocationObserver` 是进程级全局，`MUTATION_LOCK` 也是进程级，混在一起会制造假阳性/假阴性。只用于纯逻辑层。
6. **不改 `runGit` 的超时/回收参数来"加速"。** `EXIT_FLUSH_QUIET_MS`/`KILL_SETTLE_MS` 是 0.8.1 卡死问题的修复，调小会重新引入那个 bug（在 Linux CI 上不一定复现，正是它当初漏掉的原因）。

---

## 7. 建议的实施顺序

### 阶段 1：零风险，立刻做

1. 拆分 `pendingRecovery.integration.test.ts` 为 3 个文件（候选 A）。实测 655 s → 225.6 s，36/36 通过。
2. 去掉聚合器，改成按文件传给 `node --test`，`--test-concurrency=3`（候选 B）。
3. 纯逻辑层单独聚合，`npm run test:unit`（候选 C）。
4. `createRepo` 改用环境变量（候选 D）。
5. `npm run test:release` 保持跑全量。

**已实测的中间结果**（只有 A+B，纯逻辑文件仍各自独立进程）：

| 布局 | 并发 | 墙钟 |
| --- | ---: | ---: |
| 现状 | 1 | 1,269.7 s |
| 仅 A+B | 3 | 476.7 s |
| 仅 A+B | 6 | 308.0 s |

**C 和 D 没有做端到端实测**，只做了各自的独立测量（C：53.1 → 7.4 s；D：省 2 次 spawn/仓库）。按这两项各自的数据推算，A+B+C+D 合计应在 **420–450 s** 区间（估算：476.7 s − 候选 C 可省的约 40 s − 候选 D 的约 19 s）。

**验收标准**：
- `npm run test:release` 全绿，217 个测试一个不少（拆分只能增加文件数，不能减少测试数）；
- 墙钟 ≤ 8 分钟（480 s + 余量）；
- 连续跑 3 次无 flaky；
- Windows 与 ubuntu-latest CI 都通过（CI 的 spawn 成本远低于 Windows，收益主要在本地，但并发引入的隔离问题两边都要验证）。

> 拆分后是否可以把并发提到 6（实测 308.0 s）？可以，但要单独确认：拆分后的 6 并发只跑过一次全绿。鉴于 §5.2 的 flaky 根因（测试对自己的异步 Git 操作缺少确认点）并未修复，建议先以并发 3 稳定一段时间，再考虑提高。

### 阶段 2：需要产品侧决策（预计再省 **约 29–34 s**，见 §10.2）

6. 评估候选 E（`executeRebase` 编辑器），先把"每次 rebase 多两个 node 进程"作为产品性能问题记录到 `docs/improvement/improvement.md`，再决定是否实现。

### 阶段 3：可选

7. 候选 F（预编译），只有在阶段 1 后仍然觉得慢时才做。
8. 若确实需要再压时间，再考虑"把并发提到 6"（实测 308.0 s），前提是先按 §5.2 的验收条件证明稳定。

### 不建议做

- 候选 H（fixture 复用）：收益上限有限，且会削弱"stash 不被误删"这类测试的可信度。

---

## 8. 限制与未验证项

1. **所有逐文件数字都在有外部负载的情况下测量**：41 个采样点里 38 个检测到本 worktree 之外还有别的 `node`/`tsx` 测试进程在跑（同一台机器上其他 agent 的工作）。因此 §2.2 表格里的墙钟和 spawn 平均耗时（466 ms）**高于**洁净时段（约 220 ms）。这对结论方向没有影响（spawn 仍然是主体），但绝对数字偏悲观。真实干净环境下全量时间应低于 1,269 s。
2. **并发曲线只测了 3 和 6，没有测 1/2/4/8**，也没有验证 Node 在 Windows 上是否严格按 N 个进程调度。"并发 6 只比并发 3 快 2%"的**原因**已确认是单文件 655 s 的下限（这是可算的），但 Git spawn 争用随并发上升的程度未单独量化。
3. **并发 6 的 2 个失败只复现了 1 次**（2 次运行中 1 次失败）。因此 §5.2 给出的根因是**推断而非证明**：我根据失败信息（`git stash list` 在已删除目录执行、`resetDecision` 读到旧 reflog）和 fixture 的唯一性（`mkdtemp`）排除了"跨测试目录冲突"，指向"测试缺少异步完成确认点"，但没有插桩验证这个时序假设。要证实需要在 `removeRepo` 和 `stashPresence` 上打点复现。
4. **`--test-concurrency=0` 的来源未确定**：在子进程 argv 里观察到 `--test-concurrency=0 --test-timeout=0`，不确定是 `tsx` 注入还是 Node 默认值展开。这不影响结论（都表示"默认并发"），但没法据此判断改 flag 的确切优先级。
5. **候选 E/F 的节省是估算**，依据分别是"16 个静态调用点 × 1.4 s"和"15 个文件 × 6 s 启动的一半"，没有端到端实测。
6. **15 个 Git 文件的启动/转译成本（约 90 s）是推算**，因为启动时间与 spawn 时间在时间上交错，无法从 wall 里干净地分离出来。依据是"纯逻辑文件实测 6.2 s/文件"这一同构假设。
7. **没有在 Linux 上复测**。CI 是 ubuntu-latest，其进程创建成本比 Windows 低一个量级，所以本报告的时间数字**不适用于 CI**；但"减少 Git 调用次数"和"拆分单文件"的优化在两边都成立，而"提高进程并发"在 CI 上的收益可能更小（因为单次 spawn 本来就更便宜）。
8. **`recoveryProvider.test.ts` 的 165 s 是否可结构性降低未完成评估**。已确认它的成本是 `refresh()` 顺序发出的 6+ 次 Git 调用（`repoRoot` → `checkGitFeature` → `isRebaseInProgress` → `rebasingBranch`/`currentBranch` → `getUpstream` → `rev-list --left-right --count`），但"把这些合并成一次调用"属于产品改动，本轮没有验证可行性和收益。
9. **进程表洁净性**：每个批次前后都做了父子回溯检查，但无法排除测量期间有短命的 Git 进程瞬时创建/退出而未被采样到。另外 41 个逐文件采样中有 38 个检测到外部 `node`/`tsx` 测试进程，绝对墙钟数字偏悲观。
10. **§9 与 §10 的测量发生在本轮（2026-10-31）**，与 §2–§8 不在同一时段。§9.1 / §10.2 的关键数字（全量基线 965.1 s、A+B 371.0 s、`createRepo` 620 ms / 拷贝 74 ms、单次 `git rev-parse` 182 ms）**都是在洁净进程表上测的**（批次前后外部 `node`/`tsx` 测试进程数均为 0）；§2–§8 的旧数字仍带有 §8.1 所述的外部负载，两套数字不要混用。标注为"有外部负载"的新数字只有 §9.4 的 365 s 那一次（外部进程 4，已单独说明）。
11. **§10 的两类计数是"测量"而非"静态统计"**：`executeRebase` 的执行次数用 `NODE_OPTIONS=--require` 预加载脚本记录（不是数调用点），编辑器执行次数由 `seq-editor.js` 自身在被 Git 拉起的进程里写一行日志得到。前者能看到测试进程的直接子进程，后者能看到 Git 的孙进程——两者合计才覆盖"node 编辑器到底被拉起了几次"。`NODE_OPTIONS` 会被 Git 传给编辑器进程，这是本测量能成立的前提；若未来 Git 或 Node 改成不透传该变量，这个方法需要重做。
12. **§9 的"拷贝 fixture"结论只在本机 Windows 上实测**。`.git` 里没有绝对路径、`core.autocrlf` 等写入 `.git/config`、`mkdtemp` 唯一性这些都是平台相关的，Linux/macOS 上的行为在 §9.3 里是"应然推断"，没有实测。
13. **§10 的 `sh` 编辑器可用性结论只验证了 Windows**（Git for Windows 自带 `cp`/`sh` 并注入 PATH）。macOS/Linux 与 vscode-server 是推断。
14. **§9 的 `createRepo` 执行次数（106）与 `commitFile`（151）是用 opt-in 打点测的**：在 `test/helpers/gitTestRepo.ts` 里加了一行"仅当 `Q1_FIXTURE_LOG` 设置时写日志"的调用，测完已还原（用 `diff` 确认与备份逐字节一致）。不设置该环境变量时行为与原来完全相同，所以它不影响任何已有结论。

---

## 9. 追问一：预建 fixture 仓库 + 每个测试拷贝一份，是否值得

**问题**：把测试仓库一次性建好（生成脚本生成，或直接放在仓库里），每个测试不再 `createRepo()` + 若干 `commitFile()`，而是**拷贝**一份现成的。能省多少？安不安全？

**先说结论：拷贝在技术上完全可行，实跑 217 个测试全绿，也不改变任何测试断言的语义；但收益只是总量的 6–10%（58–101 s / 965 s），而且需要每个使用点自己保证模板干净。属于"能做，但性价比不如候选 A+B"，不建议为它改动测试基础设施。** 四个维度都实测了：

1. **单次成本差得很悬殊**：`createRepo()` 两次洁净批次分别中位 **620 ms / 1024 ms**，`fs.cpSync` 空模板 **74 ms / 68 ms**。单次省 **0.55–0.96 s**。
2. **可省的总量有限**：全量跑一次真实执行 **106 次 `createRepo`、151 次 `commitFile`**（打点实测）。可省 = 106 × 0.55–0.96 s ≈ **58–101 s**，占洁净基线 965.1 s 的 **6–10%**。`commitFile` 每次都写入该测试特有的文件内容与 commit message，**拷贝模板替代不了它**，151 次 spawn 一次都省不掉。
3. **端到端实测**：把 `createRepo` 换成"拷贝空模板"跑完整入口，**217/217 全绿**，但那次测到 **928.7 s**，且早晚各有 3 个外部测试进程（洁净基线是 0/0），两次不同负载不可直接相减。因此 36.4 s 的差值**不能当作节省量**——它是被外部负载压过的下限，真实值以 §9.1 的单次差分为准。
4. **它不会破坏"历史改写"类断言**：我原本担心模板会让各仓库 SHA 相同从而让 `notEqual(HEAD, target)` 失效，实查后**这个担心不成立**——全仓库**没有任何一处跨两个仓库比较 SHA**，那些断言都是同一仓库内"改写前 vs 改写后"的比较（详见 §9.3 第 2 项）。

### 9.1 成本实测（两次洁净批次）

方法：同一进程内交替重复 N 次，每次 `rmSync` 掉刚建的目录，取中位数；模板在计时区外建好。批次前后用 `Get-CimInstance Win32_Process` 确认外部 `node`/`tsx` 测试进程数为 0。

| 操作 | 批次 A 中位（n=9） | 批次 B 中位（n=15） |
| --- | ---: | ---: |
| `createRepo()`（`mkdtemp` + `init` + 2×`config`，3 spawn） | **620 ms** | **1,024 ms** |
| `fs.cpSync` 空模板（18 个文件） | **74 ms** | **68 ms** |
| 单次差额 | **546 ms** | **957 ms** |
| `fs.cpSync` 5-commit 模板（43 文件 / 29.1 KiB） | 124 ms | 未重测 |

两批 `createRepo` 差了 400 ms，说明这台机器上"3 次 Git spawn 的绝对成本"本身波动很大（杀毒/文件缓存/系统状态）。**因此单次差额应报区间（0.55–0.96 s），不要报单值。** 两批的拷贝耗时反而很稳定（68–74 ms），因为它只有一次 `mkdtemp` + 一次文件树写入。

补充基准：洁净批次里单次 `git rev-parse` 中位 **182 ms**（min 168 / max 209，n=25）。§3.7 的 699 次 fixture spawn 若全部换算成墙钟是 699 × 0.182 ≈ **128 s**，但其中大部分是 `commitFile`，拷贝吃不掉，**128 s 是虚高上限**，真实可及值是 58–101 s。

### 9.2 真实执行次数

静态调用点不能代替真实执行次数（有循环、有提前 return、有分支没走到）。本轮在 `test/helpers/gitTestRepo.ts` 里加了一个**受环境变量控制、默认完全无副作用**的计数器（`Q1_FIXTURE_LOG` 未设置时不写任何东西），跑一次洁净全量测得：

```
createRepo executions: 106
commitFile executions: 151
```

对照静态调用点（`createRepo` 114 处、`commitFile` 194 处）：**实际执行少于静态调用点**，说明没有"一个调用点循环建很多仓库"的量级放大，也有分支没有走到。**旧报告里"41 次 createRepo"（按文件数估）不准确，106 才是真实值。**

| 方案 | 每次省 | 次数 | 合计 | 占洁净基线 965.1 s |
| --- | ---: | ---: | ---: | ---: |
| `createRepo` → 拷贝空模板 | 546–957 ms | 106 | **58–101 s** | **6–10%** |
| 只把 `init`+`config` 换成 env 身份（候选 D） | 2 × 182 = 364 ms | 106 | ≈ 39 s | 4% |
| `commitFile` → 拷贝 | 不可行（内容因测试而异） | 151 | 0 | 0% |

> 候选 D 与"拷贝模板"**不能叠加**：两者省掉的是同一批 `init`+`config` spawn。取拷贝能比 D 多省约 20–60 s。

### 9.3 正确性风险（逐项实测）

本节结论均在本机 Windows 实测；未实测的明确标注为推断。

**（1）`.git` 里有没有绝对路径？——没有。**
对 `createRepo` + 5×`commitFile` 的仓库，遍历 `.git` 下全部 46 个文件，用正斜杠、反斜杠、目录 basename 三种形式搜索模板自身路径：**命中 0 次**。`core.worktree` 未设置，`logs/HEAD` 里没有仓库路径。**拷贝到新路径后 Git 不会指回旧目录**——这是"拷贝可行"的关键前提，且成立。

**（2）`mkdtemp` 唯一性假设是否被破坏？——目录层面没有，SHA 层面有但不影响当前测试。**
目录层面：拷贝仍走 `mkdtemp` 得到新目录，两个副本 realpath 不同，测试之间不会互相覆盖（实测确认）。**内容层面**：同一模板拷出的两个仓库，`git rev-parse HEAD` 返回**完全相同的 SHA**（实测确认）。

这一项我一开始判断过重，实查后必须说准确：

- **全仓库没有任何一处跨两个仓库比较 SHA**（`grep rev-parse HEAD` 逐条核对）。`notEqual(HEAD, target)` 都是**同一仓库内改写前 vs 改写后**，`commit-tree`/`--amend` 仍会产出新 SHA，模板不影响它们。
- 因此"模板会让 SHA 断言失效"**在本仓库当前测试里不成立**。我也不把"会削弱覆盖"当作理由——没有证据就不写。
- 唯一残留的弱影响：多个测试拿到相同初始历史，若将来某个测试**依赖**"我的 fixture 与别人不同"，模板会埋下隐患。当前没有这种依赖。

**（3）机器级 Git 配置被写死进 `.git/config`。**
`git init` 会把当时机器的 `core.autocrlf=true`、`core.fileMode=false`、`core.ignorecase=true`、`core.symlinks=false`、`core.fscache=true` 写进 `.git/config`（实测存在于模板中）。后果：

- 同机拷贝：无影响（值相同）。
- **跨机器/跨 CI**：在 `autocrlf=false` 的 Linux 上生成模板、在 `autocrlf=true` 的 Windows 上使用，工作区换行会与"现场 `git init`"不同。本仓库**部分**有防御：4 个文件共 **15 处** `.replace(/\r\n/g, "\n")` 归一化（`appendStaged` 1、`pendingRecovery` 8、`recoveryProvider` 1、`worktreeChanges` 5），但 22 处 `readFileSync` 里仍有 **7 处未归一化**。实测：commit 后 blob 恒为 LF；`autocrlf=true` 下**只有重新 checkout 的工作区**才出现 CRLF。所以"拷贝 + 不 checkout"通常没事，一旦测试里 `git checkout`/`reset --hard` 就会碰到。
- **`core.symlinks=false`**：本机实测创建符号链接直接 `EPERM`，模板里**不可能包含**真实符号链接。需要符号链接的测试在 Windows 上本来就不成立（环境限制，不是拷贝的错）。
- **可执行位**：实测拷贝后 `100755` 变成 `100644`（`core.fileMode=false` 本来就忽略执行位）。没有更差，也没有更好。

**（4）残留状态会被一起拷走——这是最容易真出问题的一项。**
实测：在故意留下 `stash@{0}` 和 `refs/gitRebaseVisual/checkpoint` 的仓库上做 `cpSync`，副本**完整继承**了 stash 和自定义 ref。更严重的是 `.git/rebase-merge/`：副本里的残留 `rebase-merge` **仍能被 Git 识别**，`git status` 会报告"rebase 进行中"，即一个**幻影暂停变基**。
这对本仓库尤其危险，因为 `pendingRecovery` 的整个职责就是判断"stash / 暂停变基 / reflog 是否可信"。带残留的模板会让其中相当一部分测试在**错误前提**下运行——绿，但绿的理由是模板脏。
> 缓解：模板只保留 `init` 后的干净空仓库，拷贝前断言 `git status --porcelain` 为空、无 `rebase-merge`、无 `stash`。§9.4 的端到端实验就是这么做的，所以全绿；代价是模板退化为"刚 `init` 的仓库"，**每个使用点都要自己保证模板干净**。

**（5）跨文件系统**：`%TEMP%` 与仓库目录通常同卷；若模板在另一卷，`cpSync` 退化为复制+删除（更慢，仍正确）。实测本机同卷（`C:`），未测跨卷。

**（6）Linux/macOS 上会有什么不同（推断，未实测）**：单次 `git init` 便宜得多，620/1024 ms → 68 ms 的差距会缩得很小，**收益在 CI 上接近 0**。macOS 默认大小写不敏感、Linux 可创建真实符号链接，会让"模板在 A 机器生成、B 机器使用"多出新的平台差异。

### 9.4 端到端验证

把 `createRepo()` 换成"拷贝进程内建好的空模板"，跑完整入口（与 `npm test` 同一入口 `test/index.test.ts`）：

| 布局 | 墙钟 | 结果 | 外部测试进程（开始/结束） |
| --- | ---: | --- | --- |
| 现状（每次现场 `git init` + 2×`config`） | **965.1 s** | 217/217 | 0 / 0 |
| `createRepo` → 拷贝空模板 | **928.7 s** | 217/217 | 3 / 3 |

**没有任何测试失败**，说明"拷贝一个 `init` 后的空仓库"在功能上是安全的（前提是模板干净）。但两次**外部负载不同（0 vs 3）**，36.4 s 的差值不能当作节省量，只能说明"没有变慢"。真正的节省量以 §9.1 的单次差额 × §9.2 的次数为准（58–101 s）。

### 9.5 放在哪里、怎么忽略

| 位置 | git 能否追踪 | VSIX 是否打进去 | 评价 |
| --- | --- | --- | --- |
| `test/fixtures/prebuilt/`（提交进仓库） | **不能**——目录里有 `.git`，`git add` 会**静默跳过**（实测 `add` 退出码 0，但 `ls-files` 里没有模板文件） | 不会：`.vscodeignore` 已有 `test/` 规则，实测命中 | 不可行 |
| `test/.fixtures/`（gitignore，脚本生成） | 需往 `.gitignore` 加一行 | 不会（被 `test/` 覆盖） | 可行，但每个新克隆/CI 都要先跑生成脚本 |
| 仓库根的 `fixtures/` | 可追踪 | **会**——实测 `.vscodeignore` 里**没有**规则命中 `fixtures/...` | 必须新增 `.vscodeignore` 规则 |

**关于"打包产物用 `dist-vsix/` 排除"这个约束**：本仓库**没有** `dist-vsix/` 目录，打包产物是 `dist/`（`esbuild.js` 的 outfile 是 `dist/extension.js`，`package.json` 的 `"package": "vsce package --no-dependencies"`）。实测 `.vscodeignore` **不忽略 `dist/`**，这是正确的——`dist/` 正是要发布的扩展代码。所以"把 fixture 放进 `dist-vsix/` 以排除"在本仓库不成立；fixture 必须靠 `test/` 或新增 `.vscodeignore` 规则挡在 VSIX 之外。`release.yml` 已断言 `extension/test/` 不存在，所以"fixture 放 `test/` 下"是被 CI 反向验证过的位置。

### 9.6 判定

**不建议做。** 按重要性排序：

1. **收益 58–101 s，占洁净基线 6–10%**；同一洁净条件下候选 A+B 能把 965 s 压到 371 s。为 6–10% 引入"所有 fixture 共享同一份初始内容"的全局假设，性价比不成立。
2. **它要求每个使用点自己保证模板干净**（无 stash、无 `rebase-merge`），否则 `pendingRecovery` 会在错误前提下运行（§9.3 第 4 项）。这是**持续的维护负担**，不是一次性改动。
3. **跨平台引入 `core.autocrlf` / `core.symlinks` / 执行位差异**，而 CI 上收益接近 0。
4. **它不会破坏当前任何测试**（§9.4 实测 217/217 全绿），所以如果就是想要这几十秒，它是**可以做**的——只是要知道自己在买什么。

**如果只是想省这部分而不想引入模板假设**：候选 D（env 身份替代两条 `git config`）省约 39 s，**完全不改变仓库内容**，不触碰 SHA/残留/换行假设，是风险最低的等价选择。

---

## 10. 追问二：候选 E（替换 node 编辑器）的真实上限

**问题**：把 `GIT_SEQUENCE_EDITOR` / `GIT_EDITOR` 从"node 跑 `seq-editor.js`"换成更轻的脚本，到底能省多少？§3.6 的"每次 rebase 两个 node 进程、约省 20–30 s"对不对？

**先说结论：§3.6 的"两个 node 进程"不成立——普通 rebase 只拉起 1 个编辑器进程。真实次数是 19 次 rebase、19 次编辑器执行（18 次 sequence + 1 次 message）。换成 `sh` 单行 `cp` 后可省约 34 s（占洁净基线 3.5%）。但更重要的是：这对真实用户是每次 rebase 少等约 1.8 s，比它对测试套件的价值更高。**

### 10.1 执行次数是测出来的，不是数出来的

方法分两层，缺一不可：

1. **测试进程侧**：`NODE_OPTIONS=--require <preload>` 注入 `node --test` 的子进程，monkey-patch `child_process.execFileSync/spawnSync/spawn`，记录每次 `git rebase -i` / `git rebase --continue` / 其他 git 调用。
2. **编辑器进程侧**：`seq-editor.js` 是**Git** 拉起的孙进程，测试进程的 monkey-patch **看不到它**。好在 `NODE_OPTIONS` 会被 Git 原样传给编辑器，同一个 preload 在"自己就是编辑器进程"时（`argv[1]` 以 `seq-editor.js` 结尾）写一行 JSON 日志。

一次洁净全量（217/217，`duration_ms 909.3 s`，带 instrumentation）的结果：

| 计数项 | 实测值 |
| --- | ---: |
| `git rebase -i`（= `executeRebase` 真实执行次数） | **19** |
| `git rebase --continue` | 6 |
| node 编辑器执行总数 | **19** |
| 其中 sequence editor（目标 `git-rebase-todo`） | **18** |
| 其中 message editor（目标 `COMMIT_EDITMSG`） | **1** |
| 不同编辑器 PID 数 | 18（有一个 PID 被复用，先做 seq 后做 msg） |
| 测试进程直接拉起的 node | 1（`commitLog` 测试自己的 `editor.js`） |

**关键修正**：

- §3.6 说"每次交互式 rebase 都由 Git 再拉起**两个** node 进程（sequence editor + commit message editor）"——**错**。19 次 rebase 只有 19 次编辑器执行，平均**每次 1 个**。message editor 只在 `plan.newMessage !== undefined` 时才真正被调用，而测试里**没有任何一处 `executeRebase` 传 `newMessage`**（`grep` 确认）；那唯一一次 message 编辑来自 `commitLog` 测试自己写的脚本，不是 `executeRebase`。
- §3.6 用"16 个静态调用点"估算——偏小。真实执行 **19 次**（`git rebase -i` 计数），因为有个别测试用了循环/多路径。
- 如果只做第 1 层打点，会看到"测试进程直接拉起 node 只有 1 次"，从而得出"node 编辑器几乎不跑"的**相反错误结论**。两层都做才拿到 19。

### 10.2 真实节省

单次编辑器成本（同一 edit-stop 场景，n=5，中位，同一会话内测量以避免跨批次波动）：

| 编辑器 | 中位 | min / max |
| --- | ---: | --- |
| `node seq-editor.js`（现状） | **2,888 ms** | 2,795 / 2,908 |
| `sh` 单行 `cp "$GRV_TODO_FILE"` | **1,105 ms** | 1,077 / 1,109 |
| `true`（空操作，下界参照） | **915 ms** | 808 / 1,072 |

按 `executions × (2629 − X)` 的形式给出真实节省（这里用本轮实测的 2,888 而不是旧的 2,629，二者差异来自不同批次的机器状态；两个都列出以便对照）：

| 替换方案 | 单次 | 19 次节省（用 2,888） | 19 次节省（用旧 2,629） |
| --- | ---: | ---: | ---: |
| `sh` 单行 `cp` | 1,105 ms | **33.9 s** | 28.9 s |
| `true`（不可实现，仅下界） | 915 ms | 37.5 s | 32.6 s |

**即"约 29–34 s"是 `sh` 方案的真实上限**，取决于采用哪批单次基准。§3.6 的"20–30 s"量级接近，但推理里"×2 个进程"是错的，"16 个调用点"也偏小——两个错误方向相反，恰好互相抵消，所以结论碰巧落在正确区间。

### 10.3 产品影响：一次 rebase 对真实用户值多少

一次 `executeRebase` 对真实用户只多付**一个**编辑器的成本，不是两个：

- **sequence editor 必然执行 1 次**（`git rebase -i` 总要读 todo）。
- **message editor 只在 `plan.newMessage` 存在时执行**。`src/ui/rebaseViewProvider.ts:2400` 的"编辑 commit message"路径会传 `newMessage`；普通拖动重排/丢弃不传。
- 所以：**拖动排序/丢弃 = 1 次 node 编辑器（约 2.9 s）**；**改一条 commit message = 2 次（约 5.8 s）**。换成 `sh` 后分别约 1.1 s / 2.2 s。
- 净效果：**普通 rebase 每次少等约 1.8 s，改 message 每次少等约 3.6 s**。这是真实交互延迟，不只是测试问题。

§3.6 的"每次 rebase 多两个 node 进程"若写进 issue 会误导实现者，应改为"每次 1 个（改 message 时 2 个）"。

### 10.4 `process.execPath` 为什么被选中，换成 `sh` 会破坏什么

代码依据（`src/git/rebaseEngine.ts:40–50`）：

```ts
/**
 * The editor command git should invoke for the todo / commit message. Uses the
 * running process's node/electron binary (process.execPath) instead of a bare
 * `node`, because `node` is frequently absent from PATH — notably on
 * vscode-server / remote hosts. On desktop VSCode, process.execPath is the
 * Electron binary, which runs as node when ELECTRON_RUN_AS_NODE=1 is set (done
 * in the child env below).
 */
function editorCommand(): string {
  return `"${process.execPath}" "${seqEditorPath()}"`;
}
```

即 `process.execPath` 是**为了消除"PATH 上有没有 node"这个假设**：远端主机上 `node` 往往不在 PATH，但 VS Code 自己的二进制一定存在。换成 `sh` 会把"node 在不在 PATH"换成"`sh`/`cp` 在不在 PATH"——**引入一个新的可用性假设**。

本轮把这个假设**实测清楚了，结论比预期乐观**：

- 先用 `where.exe` 确认：从 PowerShell 看，`sh` 和 `cp` **都不在 PATH**（本机 PATH 里的 Git 条目是 `TortoiseGit\bin`、`Git\cmd`，都不含 `usr/bin`）。
- 再把子进程 PATH 里 8 条 git-bash 入口**全部剔除**（60 → 52 条，确认 `cleanedPathStillHasGitBash=false`），然后跑 `GIT_SEQUENCE_EDITOR='cp "$GRV_TODO_FILE"'` 的 `git rebase -i`：**退出码 0，历史正确变为 `c3, c1`**（`drop` 生效），与 node 版结果完全一致。
- 原因：**Git for Windows 在拉起 editor 时会把它自己的 `usr/bin` 注入子进程 PATH**，所以 `cp` 能解析到 `PortableGit\usr\bin\cp.exe`。这是实测结论，不是推断。

| 平台 | `sh`/`cp` 是否可用 | 依据 |
| --- | --- | --- |
| Windows + Git for Windows | **可用**，即使调用进程的 PATH 里没有 | **实测** |
| Windows（Git 以其他形式安装、不带 `cp`） | 未验证 | 推断 |
| macOS | 可用（`/bin/sh` 恒在） | 推断 |
| Linux | 可用 | 推断 |
| vscode-server / SSH remote | 概率高（git 自带 `sh`），但远端是否带 `cp` 未测 | 推断，未测 |

**所以 §3.6"换成 `sh` 会引入新的可用性假设"这个判断对，但"Windows 上 `sh` 不可用"这个具体担忧被实测推翻了**——只要 Git for Windows 在，`cp` 就在。剩余风险是"某个用户的 Git 发行版不带 `cp`"，以及 message editor 分支仍需能覆盖文件（`cp` 可以，它同样是整文件覆盖）。

### 10.5 判定

- **真实上限约 29–34 s（`sh` 方案），占洁净基线 3.5%**，远小于候选 A+B，但**对真实用户是每次交互 1.8 s 的实打实等待**——这比它对测试套件的价值更值得做。
- **它是产品代码改动**，不是测试改动。本轮按约定**没有改任何产品代码**，只做了测量。
- 若要推进：先在 `docs/improvement/improvement.md` 记为"产品性能议题"，实现时**按平台分支**并保留 node 版本作为**兜底**（`sh` 调用失败时回退到 `process.execPath`），这样既拿到 34 s，又不丢失 `process.execPath` 当初解决的"远端没有 node"的保障。
- **不要**把"每次 rebase 两个 node 进程"写进任何 issue——按 §10.1 的实测，普通 rebase 只有 1 个。
