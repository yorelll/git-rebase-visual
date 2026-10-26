# code review 0.8.1 — Agent B 独立复审（round 7，增量）

> 独立评审代理 B。本轮是**窄范围增量复审**，不是全量重审。未修改任何产品代码、测试或发布说明；本轮唯一写入的评审产物是本文件。

## 一、评审基线

| 项目 | 值 |
|---|---|
| 仓库 | `D:\work\tools\git plugin` |
| 分支 | `main` |
| 基线 commit | `4a1e2088ee5c83202eab9e17ad83f5372dbf21e3`（`chore: release v0.7.1`） |
| 上一份评审 | `code-review-0-8-0.md`（2026-10-26 14:43:20，round 6，结论"批准发布"） |
| 本轮被测 | 0.8.0 的**未提交工作树**，重点为 14:43:20 之后发生变化的文件 + `review-response-0-8-0.md` + 台账 |
| 评审日期 | 2026-10-26 |
| 起始 / 结束 `git status --short` 条目数 | 47 / 47（本轮未改动工作树任何产品/测试/文档文件；本文件为新建，未在评审中途统计） |
| commit SHA | **0.8.0 改动仍未提交，暂无 commit SHA 可记录**；台账仍以基线 SHA 作为覆盖锚点 |

**为什么有本轮**：round 6 的放行结论附带了条件——"若该 agent 仍在改动，打 tag 前请再确认一次"。14:43:20 之后确有文件变动，本文件逐项复核这些变动。台账已由他人登记为 `code-review-0-8-0.md`，本文件**不**替它背书 14:43 之后的状态，只覆盖增量。

---

## 二、结论摘要

**增量判定：批准发布（Approve）。** 增量本身没有引入 P0/P1/P2。

**但 F-3 的修复不完整（新发现 N-1，P3）**：`docs/release-notes/0.8.0.md:30` 已改为"每一轮恢复检查时重新解析"，但同一处过度表述仍留存在 **`README.md:78`** 与 **`RELEASE.md:121`**，且 `README.md` **会进入 VSIX**（作为 `extension/readme.md`）。这与 round 6 F-3 的性质完全相同（措辞强于实现），只是位置不同。

| 严重级别 | 数量 |
|---|---|
| P0 | 0 |
| P1 | 0 |
| P2 | 0 |
| P3 | 2（N-1 已发布 README 过度表述；N-2 增量归属与测试注释不准确） |

---

## 三、逐项增量判定

### 3.1 `src/git/gitRunner.ts`（mtime 15:06:52）—— **接受；且该项其实是"伪增量"**

**这一项需要先纠正一个事实。** 增量表把 15:06:52 记为"`TASKKILL_TIMEOUT_MS` ordering"的内容改动，但取证表明 **该时间戳不是内容变更**：

- 实施者 session（`agent-ac9170b824a40eb69.jsonl`）在 `2026-10-26T07:06:25.871Z`（本地 15:06:25）执行 `cp src/git/gitRunner.ts /tmp/gitRunner.ts.bak2`，再用 python 插入一行 `if (process.platform === "win32") { directKill(); return Promise.resolve(); } // TEMP`，跑一次定向用例（该轮 `✖ the grandchild process was reaped`，符合预期），随后在 `07:06:49.401Z` 用 `cp /tmp/gitRunner.ts.bak2 src/git/gitRunner.ts` 还原。
- 因此 15:06:52 是**还原动作**留下的 mtime；文件内容回到实验前状态（当前 `grep -c "REBASE_VISUAL_REVERT_KILL\|TEMP"` → 0，无残留探针）。
- "先 `taskkill` 再直接 kill" 的实现与 `TASKKILL_TIMEOUT_MS = 5_000` 早在 `2026-10-26T04:08`（本地 12:08）就已存在，**包含在 round 6 的 14:43 快照内**，round 6 报告第 133、143-150 行已针对它做过回退实验。

**因此该文件不存在未被 round 6 覆盖的内容改动。** 但既然被点名，仍逐条给出本轮独立判断：

| 子项 | 结论 |
|---|---|
| (a) "改动前 `directKill()` 先跑、`taskkill /T /F` 以 128 退出、孙进程存活" 是否属实 | **属实**。round 6 的独立对照实验记录为 `mode=baseline … -> ALIVE (taskkill exit: 128)` / `mode=fixed … -> DEAD (taskkill exit: 0)`（`code-review-0-8-0.md:146-148`），本轮实施者的回退复现也复现了失败点 `✖ the grandchild process was reaped`。 |
| (b) 当前顺序正确且有界 | **是**。`killProcessTree`（`src/git/gitRunner.ts:119-149`）在 win32 上先 `spawn("taskkill", ["/pid", pid, "/T", "/F"])`，`guard = setTimeout(finish, TASKKILL_TIMEOUT_MS)` 兜底，`close`/`error` 二者任一 `finish()`，`finish` 幂等且 `clearTimeout(guard)`，最后 `.then(() => directKill())`。最坏 5 s 有界。`pid === undefined` 直接 `directKill()`。 |
| (c) 结算语义未变 | **未变**。`finalize` 仍由 `settled` 守卫，只结算一次；`killProcessTree(child).then(() => { if (!settled) finalize(exitCode); })`，`finalize` **不 await** 该 promise；`KILL_SETTLE_MS = 6_000` > `TASKKILL_TIMEOUT_MS = 5_000`，兜底不会先于树杀触发。`killSettleTimer` 与 `.then` 都走 `finalize`，重复调用被 `settled` 吞掉。 |
| (d) 无双重结算 / 悬挂 promise / POSIX 回归 | **无**。POSIX 分支（`:151-159`）保持 `process.kill(-pid, "SIGKILL")` + `directKill()` 后返回 `Promise.resolve()`，**不进入** win32 的 `.then(directKill)`，因此不会二次 kill；win32 的 promise 在 `guard`/`close`/`error` 任一命中时 `resolve`，不会悬挂（`spawn` 同步抛错也走 `finish()`）。定向用例断言 `observed.length === 1` 两次（含 600 ms 后复查），实测通过。 |
| (e) 是否属于 Round-5 Fix 3 的精神之内 | **属于，不反对。** 这不是范围扩张。Fix 3 的目标就是"超时/取消后真正回收进程树"，而"先杀根导致 taskkill 128、孙进程存活"正是该目标未达成的直接原因；round 6 已把它作为 R5-3 的一部分评审并在第 133-150 行做过回退验证。把它视为新增未评审项是误解。 |

**实测**（本轮）：

```text
✔ runGit returns a non-zero result rather than throwing for Git failures
✔ runGit enforces an output limit
✔ runGit tracks output bytes across stdout and stderr
✔ runGit honours an already-aborted signal
✔ runGit settles on exit even when a Git hook leaves a grandchild with open pipes
✔ a timeout settles exactly once and reaps the grandchild
✔ an abort settles exactly once and does not resolve twice
ℹ tests 7  ℹ pass 7  ℹ fail 0
```

判定：**接受（accepted）**；并注明该项 mtime 为实验还原所致，不是待评审的内容增量。

### 3.2 测试侧两处进程泄漏修复（`test/gitRunner.integration.test.ts`，15:04:32）—— **接受，附 P3 备注**

- **两个循环确实有界**：`test/gitRunner.integration.test.ts:58` 的 `while [ ! -f "<marker>" ] && [ $i -lt 200 ]`（≤200 × `sleep 0.1` ≈ 20 s）；`:110` 的 `while [ $i -lt 300 ]; do sleep 0.1; …`（≤30 s）。均为有限次数。
- **`t.after` 不会挂住**：`:67-76` 先写 marker 让循环退出，读 pid，`await waitFor(() => !isProcessAlive(pid), 10_000, …)`——**有界且超时抛错**（失败而非挂起），随后才 `removeRepo(cwd)`；`:120-124` 的 `waitForRemoval` 也是 10 s 有界重试后抛错。
- **不会在存活子进程仍持有目录时删目录**：第一个用例先断言孙进程已死才删；第二个用例的 `waitForRemoval` 对 Windows 瞬时锁重试，超时抛错而不是静默删除。
- **实测存活**：从核对过的进程表出发，连续运行该文件 3 次，每次 `7/7 pass`，每次运行后 3 s 采样 `git.exe/sh.exe/sleep.exe/dash.exe` 均 **0 残留**（唯一命中的 `sleep.exe 400/540` 是用户环境里既有的无关进程，`CreationDate` 早于本轮且 `CommandLine` 不是测试 hook，未清理）。
- **P3 备注**：第二个用例的孙进程本体仍是 `( while :; do sleep 0.1; done ) &`（无限循环，`:103`）。这在设计上是必要的——它必须比超时活得更久，才能证明"回收"发生。只有当产品回收**回归**时它才会成为残留，而那种情况下 `:177` 的断言会先失败。本轮 3 次运行均未复现残留，故不阻塞；若担心 CI 在回归时遗留该进程，可在 `t.after` 里对该 pid 补一次 `taskkill`，属可选加固。

判定：**接受，附 P3 可选加固备注**。

### 3.3 F-2 修复与回归测试（`rebaseViewProvider.ts:1715`、`recoveryProvider.test.ts`）—— **接受**

- **消息插值真实短 sha**：`src/ui/rebaseViewProvider.ts:1715` 现为
  `${name ?? "（当前槽位无法解析）"}（sha ${sha.slice(0, 7)}）仍保留`，`name` 由 `stashNameForSha` 解析，`sha.slice(0, 7)` 是真实短 sha。全仓已无 `sha sha`。
- **VSIX 内也已修复**：esbuild 会把非 ASCII 转义，直接 grep 中文会漏。检查 `dist/extension.js:4826` 可见
  `\u5B89\u5168\u526F\u672C ${name ?? "…"}\uFF08sha ${sha.slice(0, 7)}\uFF09…`，即交付物包含该修复；`dist/extension.js` 与 VSIX 内 `extension/dist/extension.js` 的 MD5 一致（`68ce37e9…`）。
- **测试非空洞（本轮独立复现）**：在 OS 临时目录的独立副本中把该行改回字面量 `（sha sha）`，定向运行：

  ```text
  ✖ a conflicted restore names the recovery stash by slot and by sha
    AssertionError [ERR_ASSERTION]: no unfilled placeholder reaches the user
  ℹ tests 1  pass 0  fail 1
  ```

  在当前工作树上同一用例 `✔ pass 1 fail 0`（约 15.9 s）。临时副本已删除。
- **断言不脆**：用例只断言语义特征——`doesNotMatch(/sha sha/)`、`match(new RegExp(sha.slice(0,7)))`、`match(/stash@\{0\}/)`、`match(/git stash apply/)`、`refs/stash` 未变——没有整串字面量比对，**一处无害的措辞调整不会误报**。

判定：**接受**。

### 3.4 F-3 文档措辞（`docs/release-notes/0.8.0.md:30`）—— **接受，但修复不完整 → 见 N-1**

- `docs/release-notes/0.8.0.md:30` 现为"槽位名在**每一轮恢复检查时重新解析**"，并补"注意这是按恢复检查的节奏刷新，不是每次界面重绘都去查询 Git"。与实现一致：`applyPendingOutcome`（`rebaseViewProvider.ts:1564-1567`）每轮恢复 pass 调一次 `stashNameForSha`；`refresh()`（`:382`）只 `currentBannerText(this.pendingWarnings)`，**不查 Git**。
- **但"没有其它文档过度表述"这一条不成立**，见 N-1。

判定：**该行本身接受**；F-3 整体视为未完全闭环。

### 3.5 计数与打包一致性 —— **接受**

| 检查项 | 结果 |
|---|---|
| 静态用例声明数 | `grep -rhoE "^\s*test\(" test/*.test.ts \| wc -l` → **214**；`it(` → 0；缩进嵌套 `test(` → 0 |
| 文档计数 | `docs/summary/summary.md:141`、`RELEASE.md:121`、`docs/release-notes/0.8.0.md:45` 均为 **214**；`213` 不再出现 |
| 全量套件 | 实施后在 `2026-10-26T08:28:21Z` 的 `full-suite-r6` 结果为 `ℹ tests 214 / pass 214 / fail 0 / EXIT=0`（`duration_ms 999785`，即约 16 分 40 秒）。该次运行启动于 `08:09:35Z`（本地 16:09:35），**晚于**两处源码改动（15:06 / 15:38），因此对当前工作树有效 |
| VSIX 新鲜度 | `git-rebase-visual-0.8.0.vsix` mtime **15:57:36**；`dist/extension.js` **15:57:14**；最新被发布的源码 `src/ui/rebaseViewProvider.ts` **15:38:48**、`src/git/gitRunner.ts` 15:06:52（内容更早）——全部早于 `dist`，`dist` 早于 VSIX |
| 15:57:36 之后是否还有 `src/`/`media/`/`package.json` 改动 | **没有**。逐目录 `find -newermt "2026-10-26 15:57:36"` 只命中 `git-rebase-visual-0.8.0.vsix` 本身、`docs/release-notes/0.8.0.md`(16:03)、`docs/review/review-response-0-8-0.md`(16:28)、`docs/review/code-review-commit.md`(16:29) |
| `docs/release-notes/0.8.0.md` 是否被排除出包 | **是**。`.vscodeignore` 含 `docs/`；`unzip -Z1` 共 **12** 个文件，无 `docs/`、`src/`、`test/`、`node_modules`、`tsconfig*`、`.map`（越界计数为 0） |
| `README.md` 是否进包 | **是**（`extension/readme.md`，与工作树 `README.md` 的 MD5 均为 `fcf2c5c7…`）。这正是 N-1 的影响面 |

判定：**接受**（计数、新鲜度、排除项全部一致）。

### 3.6 回复文档 `docs/review/review-response-0-8-0.md` —— **接受，附 N-2**

对照 `CLAUDE.md` 逐条：

| 要求 | 结果 |
|---|---|
| 恰好一个顶级章节、名称精确 | 是。`grep -c "^## "` → 1；`grep -c "^# "` → 0；标题为 `## 0-8-0 回复（对应 \`code-review-0-8-0.md\`）` |
| 写明 baseline（含"暂无 commit SHA"） | 是（第 5-6 行） |
| 每条 finding 都有决定 | 是（F-1/F-2/F-3 表格 + 第 59 行"无延后/拒绝项"） |
| 已修复项有实现与测试证据 | 是（第 23-55 行，含回退实验输出与定向用例输出） |
| 延后/拒绝项给出具体理由 | 无此类项，已说明"无" |
| 最终验证命令与结果 | 是（第 63-70 行：两个 `tsc --noEmit` 退出 0、全量 214/214、静态计数 214、VSIX 12 文件） |
| `[x]` 只用于真正修复并验证的项目 | 是（F-1 复核、F-2 已修复并验证、F-3 已修复） |
| 是否夸大（例如声称 B 批准了 14:43 之后的工作树） | **没有**。第 74-84 行明确列出"14:43:20 之后仍有改动、现有 `code-review-0-8-0.md` 未覆盖它们，需由下一份独立 review 复核"——这份自觉正是本轮存在的前提，应予肯定 |

**不准确之处（N-2，不影响结论）**：

- 第 79 行把 `src/git/gitRunner.ts` 的 15:06:52 描述为一次内容改动（"`TASKKILL_TIMEOUT_MS`：Windows 上先让 `taskkill /T /F` 走完树再直接 kill"）。如 3.1 所述，该 mtime 实际来自"临时回退 → 跑红 → 还原"的还原动作，内容早于 round 6 快照。描述本身对**代码行为**是准确的，只是**归属到该时间戳**不准确。
- 第 88 行"两者都已在定向用例与全量套件中通过"——结论成立（214/214、exit 0，16:28 完成），仅归属措辞需要修正。

判定：**接受**；建议把 15:06 那一行改写为"（该 mtime 为回退实验后的还原，非内容变更；实现于 12:08 已存在并被 round 6 覆盖）"。

### 3.7 台账 `code-review-commit.md` —— **接受**

`git diff docs/review/code-review-commit.md` 为**纯新增**：只在"已评审 Commit"表追加一行 `4a1e208…`，正文与"待评审 Commit"表的历史条目**未删除、未改写**。新行内容准确：完整 SHA、commit 说明、评审文件、回复文件、状态（"0.8.0 未提交工作树通过，批准发布（0 P0 / 0 P1 / 0 P2 / 2 P3）"）、日期、以及"暂无 commit SHA 可记录"的备注。

判定：**接受**。

---

## 四、新发现

### N-1（P3，文档：已发布 README 与 RELEASE.md 仍过度表述槽位重解析时机）

**位置**：

- `README.md:78`：`stash@{n}` 只是**位置**而不是名字：**横幅每次渲染都重新解析它**……
- `RELEASE.md:121`：……槽位名**每次渲染重新解析**；……

**实现**：`rebaseViewProvider.ts:1564-1567` 在**每轮恢复 pass** 解析，`refresh()`（`:382`）仅 `currentBannerText(this.pendingWarnings)` 读取持久化文本，不查 Git。另注意 `:387-389` 仅在 `!rebaseInProgress` 时调度恢复 pass，因此"每次渲染"在任何情况下都不成立。

**为何是本轮问题**：round 6 的 F-3 指出的是**同一句过度表述**，只是当时定位在 `docs/release-notes/0.8.0.md:30`。该行已修，但同义表述在两处仍在，其中 `README.md` **会进入发布物**（`extension/readme.md`），比发布说明更显眼。

**失败场景**：用户/维护者据此认为"横幅文本随每次界面重绘而更新"。实际上若没有恢复 pass（记录已非 pending，或 rebase 进行中），横幅文本不会刷新。用户可见结果无害（此时通常没有横幅），但这是发布物中与实现不符的陈述，且属于 F-3 未闭环。

**建议**（一处措辞，两行）：把 `README.md:78` 的"横幅每次渲染都重新解析它"改为"横幅在每轮恢复检查时重新解析它"；把 `RELEASE.md:121` 的"槽位名每次渲染重新解析"改为"槽位名每轮恢复检查重新解析"。**注意 `README.md` 在包内**，改完必须重新 `npm run compile && npm run package` 并重新校验 VSIX。

**是否阻塞发布**：不阻塞（与 F-3 同级，纯文档措辞；功能、不变量、安全均不受影响）。可与 0.8.0 一起修，或留给 0.8.1。

### N-2（P3，过程记录准确性）

`review-response-0-8-0.md:79` 与 15:06:52 的归属（详见 3.1、3.6）。另有一处测试注释过度声明：

- `test/recoveryProvider.test.ts:396-400` 的注释称该用例"pins the user-visible text whenever the slot resolves **and whenever it does not (the corrupted-reflog shape)**"，但用例（`:402-417`）只覆盖**槽位可解析**的分支；全文没有构造 reflog 损坏来让 `stashNameForSha` 返回 `undefined`。未解析分支由其它用例（`:166-169` 的 reset 场景）间接覆盖，但**不是**本用例。
- 影响：仅误导后续维护者以为已有覆盖。建议把注释改为只声明"槽位可解析时"，或补一条未解析分支的断言。不阻塞。

---

## 五、发布判定

**批准发布。** 本轮增量未引入 P0/P1/P2；两个 P3 均为文档/记录准确性问题，不影响功能、安全、`stash` 不变量或产物完整性。

**该批准覆盖 15:57:36 的 VSIX 吗？覆盖。** 依据：

1. VSIX 内 `extension/dist/extension.js` 与当前 `dist/extension.js` MD5 相同（`68ce37e9410b3a17e0361f0c20fb296a`），且该 bundle 含 15:38:48 的 F-2 修复（`dist/extension.js:4826` 的 `sha ${sha.slice(0, 7)}`）与 12:08 起的 `TASKKILL_TIMEOUT_MS`/`taskkill /T /F`。
2. 打包后没有任何 `src/`、`media/`、`package.json`、`esbuild.js`、`.vscodeignore` 改动（逐目录 mtime 取证）；15:57:36 之后只动了 `docs/release-notes/0.8.0.md`（不进包）与两份评审文档。
3. 包内 12 个文件，无 `.map`、无 `src/`、`test/`、`docs/`、`node_modules`、`tsconfig*`。

**若在打 tag 前处理 N-1，则必须重建，顺序为**：

```text
编辑 README.md:78 与 RELEASE.md:121
npm run compile && npm run package
确认 dist/extension.js 晚于所有 src/ 文件、VSIX 晚于 dist/ 且 README 已进包
```

`RELEASE.md` 不进包，改它无需重建；**改 `README.md` 则必须重建**，否则新 VSIX 会继续携带旧 readme。

**不需要重建**的情形：把 N-1 留到 0.8.1。此时当前 15:57:36 的 VSIX 可直接用于打 tag——它的功能代码与已验证的源码一致。

---

## 六、本轮实际执行的验证

| 命令 / 动作 | 结果 |
|---|---|
| 起始 / 结束 `git status --short \| wc -l` | 47 / 47 |
| `tsx --test test/gitRunner.integration.test.ts`（1 次 + 连续 3 次） | 每次 `7 pass / 0 fail`；3 次运行后进程表无本套件残留 |
| `tsx --test --test-name-pattern="a conflicted restore names the recovery stash" test/recoveryProvider.test.ts`（当前树） | `✔ 1 pass / 0 fail`（约 15.9 s） |
| 同上，在 OS 临时副本中把 `（sha ${sha.slice(0, 7)}）` 改回 `（sha sha）` | `✖ 1 fail`，`AssertionError: no unfilled placeholder reaches the user` → 用例非空洞 |
| `node ./node_modules/typescript/bin/tsc --noEmit` | 退出 0，无输出 |
| `node ./node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit` | 退出 0，无输出 |
| 静态用例计数 | 214（与文档、全量套件一致） |
| `unzip -Z1` / MD5 比对 | 12 文件；包内 bundle 与 `dist` 一致；无禁止内容 |
| 进程表 | 每项涉及进程的结论前都查过；只清理了本轮临时副本，未触碰既有的无关 `sleep.exe` |
| 全量套件 | **未重跑**（按指示）。引用的 214/214 来自 16:09:35–16:28 的实施者运行记录；本轮只独立确认了"启动晚于两处源码改动"与"静态计数为 214" |

**方法学限制**：本轮不重跑 17 分钟全量套件，故不对 214/214 做独立背书；但已确认该次运行的启动时刻晚于所有源码改动，因此对当前工作树的结论成立。增量取证依赖 session 记录（`~/.claude/projects/D--work-tools-git-plugin/…jsonl`），已交叉核对 `cp` 命令、回退实验输出与当前文件内容（无 `TEMP`/`REBASE_VISUAL_REVERT_KILL` 残留）。
