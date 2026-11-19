# Code Review 0-8-24 — 0.8.3 成功通知持有 mutation lock 的回归修复（P3-11）

- 评审日期：2026-11-19
- 评审角色：独立评审（Agent B，第十二轮）
- 基线 commit：`0ce377aa0662ac9da66ecbf131ed1484bcb2c21d`（`chore: close 0.8.3 P4 findings and upgrade release actions`）
- 被评审材料：基线之上的**未提交工作树**。`git diff --stat 0ce377a` = **7 files changed, 113 insertions(+), 32 deletions(-)**：`src/ui/rebaseViewProvider.ts`、`test/helpers/vscodeStub.ts`、`RELEASE.md`、`docs/improvement/improvement.md`、`docs/release-notes/0.8.3.md`、`docs/review/code-review-commit.md`、`docs/summary/summary.md`；untracked 仅 `test/reportRewriteNotification.integration.test.ts`。`git rev-list --count 0ce377a..HEAD` = **0**，基线之后没有新提交。
- 本轮任务：复核 P3-11（用户日志 `session-2026-11-17T03-20-59-712Z-327414.log` 暴露的真实阻塞缺陷）的修复。要求逐项验证：成功通知是否彻底 fire-and-forget、缺锁告警的 Undo 是否在新锁内且不阻塞、`runRebase` 是否无条件刷新、返回值语义变化的三个调用点、回归测试是否真能杀死旧实现、`pendingMessages` 是否削弱既有用例、以及 `src/` 全量非模态 await 审计。另要求主动寻找本轮**新引入**的缺陷。
- 顺序：先读 [`code-review-0-8-23.md`](code-review-0-8-23.md)（我自己的上一份报告），再读 `docs/improvement/improvement.md` 的 P3-11，再读 `docs/review/code-review-commit.md`。
- 环境：Windows 11 + MSYS Git `2.53.0.windows.2`，Node `v24.16.0`（`/d/Program Files/nodejs/node`），TypeScript `5.9.3`。
- **约束遵守**：我只写了本文件。没有改 `src/`、`test/`、`media/`、`.github/`、其它 `docs/` 文件或仓库根目录；没有提交、打 tag、push、`git add`、编辑账本。唯一重写过的构建产物是 `dist/extension.js`（按任务要求跑 `node esbuild.js` 验证可复现性，重建后 sha256 不变、`cmp` 相同；`dist/` 被 `.gitignore:3` 忽略）。
- **方法上的一处偏离（必须说明）**：任务要求把 `src/`+`test/` 复制到 `%TEMP%` 再变异。我第一次尝试复制时被沙箱拒绝（提示“Writes/deletes outside the trusted repo directory”），因此改用**不落盘的内存替换**完成同一验证：用 `git show 0ce377a:src/ui/rebaseViewProvider.ts` 取出旧实现字节，在进程内只对 `rebaseViewProvider.ts` 的 `readFileSync` 返回旧字节，再运行**同一个**新测试文件。旧源码加载成功（探针打印 `[probe] OLD provider served`），红/绿结果见 §四。第一次失败命令留下的 `%TEMP%/rv24copy` 已删除；没有留着探针进程。**工作树本体从未被变异。**

---

## 一、结论摘要

| 复核项 | 结论 |
| --- | --- |
| **1. `reportRewrite` 不再 await 用户面对象** | **通过**。`src/ui/rebaseViewProvider.ts:2105-2107` 现在是 `void vscode.window.showInformationMessage(单参数文案)`：**零 action item、零 await**。函数内其余 await 只有 `headTip`、`undo.complete`、`warnMissingLockedPatches`、`log`，没有等待用户输入。回归测试同时钉住“mutation 在 60 s 内 settle”与 `success.items === []`。 |
| **2. `warnMissingLockedPatches` 保留 Undo 但不阻塞** | **通过，且两个失败分支我用运行时探针实测**。点击回调走 `withMutationLock("undo", "撤销改写", "notify", …)`（`:2048`）；锁忙时 `withMutationLock` 返回 `undefined`、`work` 不执行、`undoing` 保持 `false`，于是走 `:2056` 记录 `Undo 未执行：操作锁仍被占用`；`undoLatest` 拒绝时由 `.then(onFulfilled, onRejected)` 的第二参数在 `:2060-2063` 记录 `Undo 失败`，**没有 unhandled rejection**。探针三条：锁忙 → 只出现“未执行”；`undoLatest` 抛 `probe-boom` → 只出现“失败：probe-boom”，`unhandledRejection` 捕获数 0；成功 → 两条日志都不出现且锁已释放。 |
| **3. `runRebase` 改写后无条件刷新** | **通过**。`src/ui/rebaseViewProvider.ts:2243-2253`：`await this.reportRewrite(...)` 的返回值**不再被接收**，紧随其后 `await this.refresh()` 在 `oldTip !== newTip` 分支内无条件执行。旧的 `if (undone) await this.refresh()` 已删除，不存在“警告替换成功通知后不刷新”的路径。`oldTip === newTip` 分支与旧版一样不刷新。 |
| **4. 返回值语义变化的三个调用点** | **通过**。三处调用点全部核对：`runRebase:2243` 忽略返回值并刷新；Continue 路径 `:1125` 忽略返回值，`:1138` 无条件刷新；`appendStagedToCommit:2410-2420` 用 `if (warned) return;` 跳过后面的 `toast("info", "已将暂存区文件追加到 …")`，`return` 仍会执行 `finally`（`:2453-2457`）里的 `refresh`。旧版在该处也是“点了 Undo 才跳过”，新版扩大到“只要告警就跳过”；见 §五 P4-3 的判断。 |
| **5. 回归测试不是空转** | **通过，且我独立复现了红/绿两侧**。真实工作树：`2/2` 绿（33 s）。把**完整基线旧实现**喂给同一测试：`2/2` 红，失败断言分别是 `:107` 的 `an ignored notification must not keep the mutation unsettled (the reported 156 s hang)`（`actual: undefined`, `expected: true`）与 `:170` 的 `the warning must settle even though the user ignores the non-modal notification`（同样 `actual: undefined`）。只把成功通知一处改回 `await … "Undo"`：测试 1 红、测试 2 仍绿（75 s / 9.9 s）。证明测试钉的正是“成功通知被 await”这一根因。 |
| **6. `pendingMessages` 不削弱既有用例** | **通过**。默认 `false`（`test/helpers/vscodeStub.ts:52`）、`resetStub` 复位（`:206`）；全仓库除新测试外**无人设置** `pendingMessages`；`false` 时 `settleMessage` 返回 `stub.choice`，与旧实现逐语义相同。我另跑了 4 个依赖 `stub.choice` / `stub.messages` 的既有套件：`recoveryProvider` 22/22、`pushNotification` 20/20、`pushIsolation` 17/17、`restoreFileProtocol` 1/1，全绿。 |
| **7. 不变量注释与 `src/` 非模态 await 审计** | **通过**。两处成功后通知站点（`warnMissingLockedPatches:2040-2043`、`reportRewrite:2099-2104`）都写了 INVARIANT 注释；`src/` 中 `await vscode.window.show*` 共 15 处，**全部**带 `{ modal: true }`（脚本逐块扫描）；剩余 await 的 3 处 `showQuickPick` + 1 处 `showInputBox` 都是用户主动打开的前台选择器（`showUndoHistory`、`openCommitDiff`、push 方式/refspec），`extension.ts:110` 的日志提示是 `void`。 |
| **是否引入新缺陷** | **没有阻塞性缺陷**。三条 P4 观察（Undo 被忙锁拒绝时只有日志、点击回调分支无持久测试、append 成功 toast 被告警抑制）均不改变正确性、不持锁、可恢复；另有三条 observation。见 §五。 |
| **测试计数与文档** | **一致**。静态枚举：`ls test/*.test.ts | wc -l` = **48**，`grep -rhcE '^test\('` 逐文件加总 = **326**（旧 324 + 新文件 2）。`RELEASE.md:136`、`docs/summary/summary.md:150`、`docs/release-notes/0.8.3.md:44`、`improvement.md:312` 均为 **326 项 / 48 个文件**；`improvement.md:264`/`:278` 保留 **324** 是历史段落，不矛盾。 |
| **VSIX** | **12 个条目、白名单通过、逐字节一致**。`node scripts/package-vsix.js --verify-only` → `VSIX contents match the allowlist (12 entries).`；包内 8 个 payload 与工作树逐个 sha256 **SAME**；包内 `extension/dist/extension.js` = `2cd9467…` = 现场 `node esbuild.js` 重建结果（重建前后 sha256 相同）。 |
| **账本** | **新行已存在且不声称已评审**：`code-review-commit.md:11` 的“已评审 Commit SHA”列写“（未提交工作树；无 commit SHA）”，正文两处写明“无 commit SHA 可记录”“尚待独立评审创建”，引用了本报告文件名。该行出现的 40 位十六进制串只有基线 `0ce377a…`，不是伪造的被评审 SHA。按任务约束我**没有编辑账本**。 |

### 裁决：**可以提交。被忽略的非模态通知不再可能持有 mutation lock。**

依据不是“文档这么写”，而是三条独立证据：

1. **代码层**：成功通知与缺锁告警都是 `void show*Message(...)`；`reportRewrite` 内部所有 await 都不再等待用户。审计确认 `src/` 中仅剩的 15 个 awaited `show*Message` 全是 `{ modal: true }`，4 个 awaited 选择器全是用户主动打开的前台流程。
2. **行为层**：真实工作树的新测试 2/2 绿；把旧实现喂进去 2/2 红；只回退成功通知一处则恰好测试 1 红、测试 2 绿。说明修复点与测试断言一一对应，测试不是“改完才写、怎么写都绿”的空转。
3. **运行时层**：我用探针实际触发了告警的 Undo 回调三条路径（忙锁 / `undoLatest` 拒绝 / 成功），日志与锁状态都符合声明，且没有 unhandled rejection。

---

## 二、我实际跑了什么（以及没有跑什么）

### 2.1 类型与定向用例（工作树本体）

```text
node node_modules/typescript/bin/tsc --noEmit                       → exit 0，零输出
node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit → exit 0，零输出

node node_modules/tsx/dist/cli.mjs --test --test-concurrency=3 test/reportRewriteNotification.integration.test.ts
ℹ tests 2   ℹ pass 2   ℹ fail 0   ℹ duration_ms 33427

node … test/recoveryProvider.test.ts      → tests 22  pass 22  fail 0
node … test/pushNotification.test.ts      → tests 20  pass 20  fail 0
node … test/pushIsolation.test.ts         → tests 17  pass 17  fail 0
node … test/restoreFileProtocol.test.ts   → tests 1   pass 1   fail 0
```

**完整 326 项套件不是我跑的**：另一进程正在跑，按约束我没有启动第二个（见 §六）。

### 2.2 旧实现红/绿探针（不落盘）

`%TEMP%` 复制被沙箱拒绝后，我用同一进程内的源码替换完成等价验证：

- 旧实现字节：`git show 0ce377a:src/ui/rebaseViewProvider.ts`（145,242 bytes）。
- 只拦截 `src/ui/rebaseViewProvider.ts` 的 `readFileSync` / `fs.promises.readFile`，返回旧字节；`test/` 与新 stub 保持工作树版本。
- 运行方式：`node --import tsx --import tsx/cjs -e '<探针>'`；探针把测试文件 `require` 进来。
- 证据：探针打印 `[probe] OLD provider served`；两次旧实现运行都得到与 `improvement.md:45` 声明的**同一失败断言与同一 actual/expected**。

### 2.3 工作树 sha256（本轮被评审字节）

```text
23bc2401…  src/ui/rebaseViewProvider.ts
1650305e…  test/helpers/vscodeStub.ts
1a88ac53…  test/reportRewriteNotification.integration.test.ts
270a740e…  docs/improvement/improvement.md
60b7f099…  docs/review/code-review-commit.md
af733395…  RELEASE.md
093edc51…  docs/release-notes/0.8.3.md
b1cac1be…  docs/summary/summary.md
2cd94674…  dist/extension.js（esbuild 重建前后不变）
```

变更范围复核：`git diff -U0 -- src/ui/rebaseViewProvider.ts` 只有 11 个 hunk，全部落在 `warnMissingLockedPatches`、`reportRewrite`、`runRebase`、Continue 路径、append 路径内；`git status --porcelain` 的 untracked 只有新测试文件。

---

## 三、逐项验证

### 3.1 第 1 项 — `reportRewrite` 不再 await 任何用户面对象

工作树 `reportRewrite`（`:2078-2109`）结尾：

```text
    const warned = await this.warnMissingLockedPatches(cwd, this.root!, oldTip, undoRecord);
    if (warned) { … return true; }
    // INVARIANT: … 非模态通知的 promise 只在用户 dismiss 时 settle …
    void vscode.window.showInformationMessage(
      `${operation} 已完成：…`
    );
    return false;
```

- 没有第二个参数，**没有 `"Undo"`**：回归测试断言 `success.items` 深等于 `[]` 并实际通过。
- 没有 `.then`、没有 `await`：`void` 丢弃返回的 Thenable。
- 函数内其余 await：`headTip`（读 Git）、`undo.complete`（写状态）、`warnMissingLockedPatches`（只做 Git/patch-id 计算，内部通知也是 `void`）、`this.log`（同步）。**没有任何一处等待用户关闭窗口。**
- 旧实现对照（`git show 0ce377a:src/ui/rebaseViewProvider.ts`）确实是 `const choice = await vscode.window.showInformationMessage(…, "Undo"); if (choice === "Undo") { await this.undoLatest(...); return true; }`，与根因描述一致。

### 3.2 第 2 项 — 缺锁告警保留 Undo、不阻塞、可区分忙锁与失败

工作树 `:2040-2069`：

```text
    // INVARIANT: a non-modal notification's promise settles only when the user
    // dismisses it, so it must never be awaited while the mutation lock is held.
    let undoing = false;
    if (undoRecord) {
      void vscode.window.showWarningMessage(message, "Undo").then((choice) => {
        if (choice !== "Undo") return;
        void this.withMutationLock("undo", "撤销改写", "notify", async () => {
          undoing = true;
          await this.undoLatest(cwd, undoRecord.id);
        }).then(
          () => { if (!undoing) { this.log("mutation", "Undo 未执行：操作锁仍被占用（撤销改写）。"); } },
          (error) => { this.log("mutation", `Undo 失败：${String((error as any)?.message ?? error)}`); }
        );
      });
    } else {
      void vscode.window.showWarningMessage(message);
    }
    return true;
```

静态判断：

- `withMutationLock`（`:1574-1593`）在 `tryAcquire` 失败时**直接 `return undefined`，不调用 `work`**；成功时 `armWatchdog` → `await work()` → `finally` 里 `markSettled/release/disarmWatchdog`。
- `undoing = true` 是 `work` 的**第一条语句**，在任何 await 之前执行；因此“`withMutationLock` 完成且 `undoing === false`”当且仅当“`work` 从未运行（忙锁）”。`work` 一旦运行，即使 `undoLatest` 立刻抛错，`undoing` 也已为 true，不会被误报成忙锁。
- 失败分支由 `.then` 的第二个参数接住，`withMutationLock` 的拒绝不会逃逸成 unhandled rejection。

运行时探针（追加到新测试文件内存副本，真实 provider + 真实临时仓库，结果 `5/5` 绿）：

| 探针 | 断言 | 结果 |
| --- | --- | --- |
| 手工持锁后触发 Undo | `outputLines` 含 `Undo 未执行`，不含 `Undo 失败`，锁仍由测试释放 | 绿 |
| `undoLatest` 抛 `probe-boom` | `outputLines` 含 `Undo 失败：probe-boom`，`unhandledRejection` 捕获数 0，锁已释放 | 绿 |
| `undoLatest` 正常返回 | 两条日志都不出现，锁已释放 | 绿 |

### 3.3 第 3 项 — `runRebase` 无条件刷新

工作树 `:2241-2257`：

```text
      const newTip = await this.headTip(cwd);
      if (oldTip !== newTip) {
        await this.reportRewrite(…);
        // A rewrite changed history regardless of whether a warning replaced
        // the success notification, so always refresh. …
        await this.refresh();
      } else {
        await this.undo.mark(undoRecord, "aborted");
        this.log("rebase", `${plan.operation ?? "变基"} 未改变 HEAD；未报告历史改写。`);
      }
```

`reportRewrite` 的返回值在这里被丢弃，`refresh` 位于“HEAD 确实改变”的分支内、无条件执行。没有路径依赖“用户点了 Undo”才能刷新。

### 3.4 第 4 项 — 三个调用点的返回值语义

`grep -n "reportRewrite"` 只有定义 + 三个调用点：

| 调用点 | 旧语义 | 新语义 | 判断 |
| --- | --- | --- | --- |
| `runRebase:2243` | `const undone = …; if (undone) await refresh()` | 忽略返回值，`refresh` 无条件 | 正确：刷新不再依赖返回值。 |
| Continue `:1125` | `const undone = …`（**当时也忽略**） | 忽略返回值，`:1138` 无条件 `refresh` | 正确：旧版此处本就不靠返回值。 |
| append `:2410` | `const undone = …; if (undone) return;`（点了 Undo 才跳过成功 toast） | `const warned = …; if (warned) return;`（只要告警就跳过） | **可接受**：告警文本已报告“改写后…请确认结果”，再叠一条“追加成功”会与数据完整性告警互相矛盾；用户仍可从视图标题/命令 Undo。细化建议见 §五 P4-3。 |

没有任何调用点把返回值当作“用户点了 Undo”使用；也没有调用点因返回值变化而丢失刷新（append 的 `return` 会进入 `finally` 的 `refresh`）。

### 3.5 第 5 项 — 回归测试确实杀死旧实现（红/绿证据）

**真实工作树（绿）**：

```text
✔ an ignored success notification does not keep the mutation lock (21157ms)
✔ an ignored missing-lock warning does not keep the mutation lock (10201ms)
ℹ tests 2  pass 2  fail 0
```

**完整基线旧实现（红，同一测试文件、同一 stub）**：

```text
✖ an ignored success notification does not keep the mutation lock (75604ms)
  AssertionError: an ignored notification must not keep the mutation unsettled (the reported 156 s hang)
  + actual: undefined
  - expected: true
      at test/reportRewriteNotification.integration.test.ts:107:10

✖ an ignored missing-lock warning does not keep the mutation lock (67600ms)
  AssertionError: the warning must settle even though the user ignores the non-modal notification
      at test/reportRewriteNotification.integration.test.ts:170:12
  actual: undefined  expected: true
```

**只回退成功通知一处（`await showInformationMessage(…, "Undo")`，告警仍用新实现）**：

```text
✖ an ignored success notification does not keep the mutation lock (75304ms)
  … :107  actual: undefined  expected: true
✔ an ignored missing-lock warning does not keep the mutation lock (9911ms)
ℹ tests 2  pass 1  fail 1
```

结论：失败不是环境噪声，也不是“旧文件整体不兼容”——只改成功通知这一行，恰好只有对应测试变红，另一条仍绿。**若用旧代码跑，这个测试会红**，所以它不是空转。

补充：`improvement.md:45` 声称的两条红色失败（均 `actual: undefined`, `expected: true`）与我的复现**逐字一致**；不是事后补写的说法。

### 3.6 第 6 项 — `pendingMessages` 不削弱其它测试

```text
grep -rn "pendingMessages" test/ src/
→ 只有 test/helpers/vscodeStub.ts 的定义/默认/复位/实现，以及
   test/reportRewriteNotification.integration.test.ts:89,158 的两处显式开启。
→ 没有任何既有测试设置它。
```

- 默认 `false`；`resetStub` 在 `:206` 复位。
- `settleMessage`（`:79-85`）：只有 `stub.pendingMessages && !modal` 才返回永不 settle 的 promise；否则 `return stub.choice`，与旧实现完全一致。
- 模态识别看的是 `items` 里是否有 `{ modal: true }` 对象；15 个模态确认框都这样传参，既有的 `stub.choice` 驱动逻辑不变。
- 行为验证：`recoveryProvider`（依赖模态确认 + `stub.messages`）22/22、`pushNotification` 20/20、`pushIsolation` 17/17、`restoreFileProtocol` 1/1，全部绿。

### 3.7 第 7 项 — 不变量注释位置与 `src/` await 审计

注释位置：

- `src/ui/rebaseViewProvider.ts:2040-2043`（缺锁告警）
- `src/ui/rebaseViewProvider.ts:2099-2104`（成功通知）
- `:2072-2077` 的 JSDoc 也明确“Neither notification is awaited”。

await 审计（脚本逐块扫描，不是肉眼）：

```text
15 × MODAL    await vscode.window.showWarningMessage(… { modal: true } …)
 1 × NONMODAL await vscode.window.showQuickPick  (showUndoHistory:1372，mutation 内的用户历史选择)
 1 × NONMODAL await vscode.window.showQuickPick  (openCommitDiff:2889，只读多文件选择)
 1 × NONMODAL await vscode.window.showQuickPick  (pushBranchInternal:3168，用户选择推送方式)
 1 × NONMODAL await vscode.window.showInputBox   (pushBranchInternal:3184，用户输入自定义 refspec)
 1 × NONMODAL await vscode.window.showTextDocument（:2944，打开文档，不是通知）
```

- 15 个模态确认框全部保留：删除、Abort、批量删除、squash/fixup、Skip、Undo、重排、已推送改写确认、追加、恢复全部、撤销暂存、删除未跟踪、单文件恢复、Pop、Push。它们本来就是“写操作开始前必须取得用户决定”的模态，不是成功后的被动通知。
- 4 个选择器都是用户主动打开的前台流程：`showUndoHistory` 是用户点“操作历史”，QuickPick 可按 Esc/失焦结算；`openCommitDiff` 只读；push 的两种选择发生在用户点推送之后。与本次缺陷（成功后自动弹出的非模态通知）不是一类。
- `src/extension.ts:110` 是 `void vscode.window.showInformationMessage(...)`；`toast()`（`:3384-3398`）三种级别全部 fire-and-forget，包含 JSDoc 解释。
- 结论：**`src/` 中已经没有被 await 的非模态成功通知/告警**。

---

## 四、新发现（按严重度）

本轮**没有 P0/P1/P2/P3**。以下三条 P4 都不改变“不会持锁挂起”的结论，且都可恢复。

### P4-1（新，不阻塞）告警的 Undo 被忙锁拒绝时只有日志，用户看不到反馈

- 现象：用户在通知中心较晚点击告警的 Undo 时，如果另一个 mutation 正在运行（或该告警出现后、原 mutation 尚未释放锁的 `refresh` 窗口内就点击），`withMutationLock` 返回 `undefined`，只写一条 `Undo 未执行：操作锁仍被占用` 到 Output/日志文件。通知已被点击关闭，界面上没有“这次 Undo 没执行”的提示。
- 与要求的关系：维护者明确要求“a busy lock is logged rather than silently dropped”——这条**已满足**，且比静默丢弃好。
- 影响：无数据损坏；Undo 仍可从视图标题按钮与 `gitRebaseVisual.undo` 重做。只是用户可能误以为历史已回退。
- 建议（可不改）：在 `!undoing` 分支加一条 `toast("warn", "撤销未执行：另一个操作正在进行，请稍后从视图标题撤销。")`，或把 Undo 入队。**不阻塞本轮提交。**

### P4-2（新，不阻塞）点击回调的三条分支没有进入持久测试

- 新的集成测试在 `pendingMessages = true` 下让告警永不 settle，因此**从未点击 Undo**；全仓库 `grep` 也没有任何测试设置 `choice = "Undo"` 并走 `withMutationLock`。`undoing` 的忙锁/失败/成功区分目前只有本报告的临时探针覆盖，不在 `npm test` 里。
- 风险：将来有人把 `undoing = true` 移到 await 之后、或去掉 rejection 分支，现有测试不会红。
- 建议：把 §三.2 的三条探针固化进测试（可复用 `warningProbeSetup` 的写法），成本约 3 条用例。**不阻塞。**

### P4-3（新，不阻塞）append 路径在告警时连“追加成功”toast 一起抑制

- 现象：`:2417-2420` 的 `if (warned) return;` 会让 `:2422` 的 `已将暂存区文件追加到 xxx` 不再显示。旧版只有用户真点 Undo 才跳过，新版“只要告警就跳过”。
- 判断：**这个取舍是合理的**——缺锁告警已经说明“改写后未找到锁定 patch，请确认结果”，再弹“追加成功”会让用户同时看到“成功”和“数据完整性异常”两条相反信号；视图在 `finally` 里刷新，结果可见。
- 唯一小缺口：告警文本没有点名是“追加”还是 drop/reorder。若想更清楚，可把 operation 拼进告警文案。**不阻塞。**

### 观察 1（不计入清单）外层 `.then` 没有 rejection 处理

`void vscode.window.showWarningMessage(message, "Undo").then((choice) => …)` 只注册了 onFulfilled。若 VS Code 的通知 API 拒绝（实际不会），会成为 unhandled rejection。内层 `withMutationLock(...).then(onFulfilled, onRejected)` 已正确处理。这与既有 `toast`/watchdog 的 `void show*Message` 写法一致，属于可接受的 API 假设。

### 观察 2（不计入清单，基线已存在）命令路径的 Undo 不取 mutation lock

`undoLastRewrite()`（`:2968-2974`，视图标题与 `gitRebaseVisual.undo` 都走它）直接 `await this.undoLatest(cwd)`，**不经过** `withMutationLock`；本次修复反而给通知里的 Undo 加了锁。这是基线就有的行为，不是本轮引入，也不在本轮范围；记录在此，供 0.9.0 评估是否统一。

### 观察 3（不计入清单，基线已存在）`showUndoHistory` 的 QuickPick 在 mutation lock 内等待

它被 `webviewProtocolState.ts:22` 归为 mutation，`handleMessage` 持锁后 `await showQuickPick`。用户不选时锁会一直持有到 Esc/失焦或看门狗告警。这是用户主动打开的前台选择器、且看门狗仍会兜底，与本次“成功后自动通知”不是同一缺陷；记录但不视为本轮问题。

---

## 五、我没有验证的部分

1. **完整 326 项套件不是我跑的。** 另一进程正在跑全量，我按要求没有启动第二个。我独立复核的是静态计数 326/48、文档四处一致、新文件 2/2，以及 4 个相关既有套件共 60 项（全绿）。
2. **没有在磁盘上的 `%TEMP%` 副本里跑红/绿。** 复制被沙箱拒绝，我改用同一进程内“只替换 provider 源文件字节”的等价方法；旧源码字节、同一测试文件、同一 stub，结果与 `improvement.md` 声明的失败逐字一致。没有第二个 Node 进程被留下。
3. **`improvement.md:312` 的“受影响 8 个套件 80/80”没有独立复跑**。我跑的是其中与新 stub/通知最相关的 4 个套件（60 项）。
4. **真实 VS Code 窗口里的通知生命周期没有手工复验**。结论依赖 VS Code API 的既知语义：非模态 `showInformationMessage/showWarningMessage` 的 promise 在用户 dismiss 前不 settle。测试 stub 正是按这个语义建模的。
5. **看门狗与长时间打开的模态/QuickPick 的端到端组合没有真实 UI 验证**。代码上 `withMutationLock` 的 `armWatchdog`/`disarmWatchdog` 使用 owner id 匹配，晚到的清理不会清掉新 owner 的看门狗；但它们与“强制解除”同时发生时的真实时序没有实测。
6. **VSIX 的“从删除后的 dist-vsix 重建”过程没有重放**。我验证的是当前包：12 条目、白名单、8 个 payload 与工作树逐字节相同、包内 bundle 等于现场重建哈希。
7. **账本没有按项目规则在评审后编辑。** 按本轮任务约束不动账本；`code-review-commit.md:11` 已有 0-8-24 的“待评审”行（无 commit SHA），维护者提交后需把它更新为真实 SHA 与最终状态，并为本报告保留独立复核记录。这不是我能代做的动作。
8. **没有验证 `reportRewrite` 的调用方在“告警已显示但用户永不点击”时的长期内存占用**。通知 promise 永不 settle 但不持有定时器/句柄，测试进程能正常退出（green run 33 s 结束），没有观察到句柄泄漏。

---

## 六、裁决与覆盖范围

- **裁决：批准提交。** 修复直接消除了用户日志里的根因：成功通知不再被 await、没有 Undo 按钮；缺锁告警保留 Undo 但只在自己的回调里重新取锁；`runRebase` 无条件刷新；三个调用点都没有继续依赖旧的“用户点了 Undo”语义。
- **明确回答任务问题：被忽略的通知还能不能持有 mutation lock？**
  - **非模态的成功/告警通知：不能。** 两处都是 `void`，`reportRewrite` 不再等待用户；回归测试在“用户永不 dismiss”的 stub 下 2/2 绿，且旧实现 2/2 红。
  - **模态确认框：会，且这是设计要求。** 15 个 `{ modal: true }` 仍在写操作前等待用户决定；用户不答，操作本来也不应继续。看门狗仍会对超时锁告警并提供“强制解除并刷新”。
  - **用户主动打开的 QuickPick/InputBox：会短暂持有。** `showUndoHistory`、push 方式/refspec、`openCommitDiff` 都是用户自己发起的流程，可按 Esc/失焦结算；不是“成功后自动弹出、忽略即挂起”的通知。
- **回归测试有效性**：旧实现 2/2 红、只回退成功通知一处则 1 红 1 绿、真实工作树 2/2 绿。测试不是空转。
- **覆盖范围**：基线 `0ce377aa0662ac9da66ecbf131ed1484bcb2c21d` 之上的未提交工作树（sha256 见 §二.3）与 `dist-vsix/git-rebase-visual-0.8.3.vsix` 的当前内容。提交之后，仍需由后续独立评审按**真实 SHA**覆盖这次提交；本报告不能替代那一步。
