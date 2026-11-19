# Code Review 0-8-25 — AI 入口收敛、Compose 取消/Escape、推送确认三要素

- 评审日期：2026-11-19
- 评审角色：独立评审（Agent B，第十三轮）
- 基线 commit：`1e463f35dbf3b1874e5dcaa2abe8a11eb07235cd`（`docs: record the reviewed SHA for the notification-lock fix`）
- 被评审材料：基线之上的**未提交工作树**。`git diff --stat 1e463f3` = **13 files changed, 244 insertions(+), 213 deletions(-)**：`README.md`、`RELEASE.md`、`docs/improvement/improvement.md`、`docs/release-notes/0.8.3.md`、`docs/review/code-review-commit.md`、`docs/summary/summary.md`、`media/main.js`、`src/ui/composePanel.ts`、删除 `src/ui/composePolicy.ts`、`src/ui/rebaseViewProvider.ts`、删除 `test/composePolicy.test.ts`、`test/pushNotification.test.ts`、`test/webviewDom.test.ts`；untracked 只有 `test/composeAiFlow.test.ts`、`test/composePanelClose.test.ts`。`git rev-list --count 1e463f3..HEAD` = **0**，基线之后没有新提交。
- 本轮任务：复核两个维护者报告的问题。问题 1：AI 生成入口必须只剩 commit 右键与 Staged Changes 的 `✦` 两处，`messageOnly` 全链路删除，且取消/Escape 必须在任何草稿状态下关闭面板（根因是 webview 不支持 `window.confirm`）。问题 2：推送确认框必须与进度标题、结果 toast 一样携带“推送种类、commit 短标题、目的地”三要素，原始 refspec 只作精确细节。另要求检查 `composePolicy.ts` 删除是否卸掉了仍需要的安全闸、新的关闭路径是否会被旧 webview 用来关闭新目标、提前读取 subject 的 `git log` 是否阻塞确认框或锁、测试计数/文档/VSIX 是否一致，并主动寻找本轮新缺陷。
- 顺序：先读 [`code-review-0-8-24.md`](code-review-0-8-24.md)（我自己的上一份报告），再读 `docs/improvement/improvement.md` 的 P3-13，再读 `docs/review/code-review-commit.md`。
- 环境：Windows 11 + MSYS Git `2.53.0.windows.2`，Node `v24.16.0`（`/d/Program Files/nodejs/node`），TypeScript `5.9.3`。
- **约束遵守**：我只写了本文件。没有改 `src/`、`test/`、`media/`、`.github/`、其它 `docs/` 文件或仓库根目录；没有提交、打 tag、push、`git add`、编辑账本。为验证构建可复现性我运行了 `node esbuild.js`，重建前后 `dist/extension.js` 的 sha256 相同，`dist/` 被 `.gitignore` 忽略；此外只读打开过 VSIX。

---

## 一、结论摘要

| 复核项 | 结论 |
| --- | --- |
| **1. AI 入口恰好两个** | **通过**。可执行入口只有两处：`media/main.js:635` 的单 commit 右键 `AI 生成 message…`（`sendCompose(c, true)`，`:642` 发 `mode:"commit", hash, ai:true, thenEdit:false`），以及 `media/main.js:204` Staged Changes 分组右侧、紧挨 `撤销全部暂存` 的 `✦ AI 生成 message 并提交暂存区`（`mode:"staged", ai:true, thenEdit:false`）。edit 停靠横幅无 AI 按钮，`更多提交选项` 无 draft-only 按钮；`media/main.js` 已无 `messageOnly`/“仅生成 message”/“不提交”字样。`webviewDom` 的矩阵用例在 idle/全暂存、无暂存、混合、rebase paused、paused 且仅工作区、conflict、edit stop 七种状态下断言 `#banner` 无 AI、`#changes` 的 `✦` 数量正确、单个 commit 菜单只有一个 AI 项。 |
| **2. `messageOnly` 与 `composePolicy` 删除** | **通过，且未卸掉安全闸**。`grep -rn "messageOnly" src test media` 只剩 `test/webviewDom.test.ts:402/417` 两条“不应再发送该字段”的负断言；`grep -rn "composePolicy" src test media scripts` 零命中。被删模块原本只表达“暂停 rebase 只允许 staged/working 的 draft-only 打开、冲突时拒绝 AI 生成”，新实现用等效的窄例外替代：`rebaseViewProvider.ts:856-874` 只放行 staged AI 的 `openCompose`/`generate`，`:2508-2535` 拒绝其它 AI 与普通 Compose，`:2621-2634` 在冲突时拒绝生成，`:2697-2699` 与 `mutationGate.ts` 的白名单拒绝所有暂停态 `apply`。 |
| **3. staged 入口端到端** | **通过**。`test/composeAiFlow.test.ts:100-151` 用真实 provider + 真实临时仓库 + mock SSE：点击 staged 入口的原始 payload 打开会话；`generate` 后 `HEAD` 不变、文件仍是 `A  feature.txt`；`apply` 提交的是用户编辑后的 subject/body，旧生成文本不出现，正文含 `Signed-off-by: Git Rebase Visual Test <test@example.com>`，`git status --porcelain` 为空，并收到 `applySucceeded`。 |
| **4. 生成与写入严格分离** | **通过**。`generate` 只向页面发 `genDelta`/`genResult`（`rebaseViewProvider.ts:2650/2670`），全仓库 `this.apply(` 唯一调用点是 `case "apply"`（`:1063`），没有生成后自动应用、关闭后自动应用或定时应用。commit 右键用例（`composeAiFlow:153-207`）同样证明生成不启动 rebase、不重写 commit，应用才使用编辑后的 message。 |
| **5. 取消/Escape（任务枚举的五态）** | **通过**。`test/composePanelClose.test.ts:135-186` 加载真实 `ComposePanel` HTML 与 inline script，并把 `window.confirm` 定义为返回 `false`（模拟不支持/拒绝），在 idle、edited、generated、generating 四态点击取消、再按 Escape：每个动作恰好发送一次 `closeCompose`，携带当前 `sessionId`/`revision` 与正确的 `dirty`。`:188-205` 证明关闭前发出的 `composeDraft` 在重开同一目标时被原样恢复。 |
| **6. 取消/Escape（新发现的第六态）** | **失败 → P2-1，阻塞提交**。“当前面板已有脏草稿，同时用户又打开了另一个 Compose 目标”时，宿主已把 active 会话切到新目标，页面按自己的防覆盖保护保留旧目标并只显示警告；此时取消/Escape 发送的是旧 `sessionId`，`closeCompose` 的会话校验（`rebaseViewProvider.ts:1034-1036`）直接 `return`，面板不关闭、无 toast、无任何反馈。可复现证据见 §3.5 与 §四 P2-1。原生标签页 `×` 仍可关闭，草稿也不丢，但“取消/Escape 无条件关闭”的承诺在这一可到达状态下不成立。 |
| **7. 推送确认框三要素** | **通过**。`rebaseViewProvider.ts:3230-3262` 在弹框前计算 `target`、删除判定、`pushSource` 与 subject，然后 `showWarningMessage(`${described}（refspec：${refspec}）`, {modal:true}, "Push")`；`describePush`（`src/ui/pushNotification.ts:153-155`）输出 `种类："短标题" → 目的地`，删除 refspec 用 `describeDeletion`（`:163`）。`test/pushNotification.test.ts` 对 normal/review/custom/`HEAD~1`/deletion 逐字断言完整文案（`:159/245/291/573/649`）。 |
| **8. subject 来自 refspec 源端** | **通过**。`pushSource`（`pushNotification.ts:79-87`）取第一个冒号前的源端；`HEAD~1:refs/heads/older` 的用例（`pushNotification:545-581`）断言对话框命名 `HEAD~1` 的标题而非 HEAD 的标题。 |
| **9. 失败在推送前可见中止** | **通过**。`subjectResult.code !== 0` 时发 error toast 并 `return`，此时既未弹确认框也未推送（`rebaseViewProvider.ts:3243-3249`）。`pushNotification:583-620` 断言无 confirm、无 progress、远端无新 ref。 |
| **10. 注入保护未削弱** | **通过**。`git log` 仍走 `withPositionals(["log","-1","--pretty=%s"], [sourceRev])`（`:3242`），即 `--end-of-options` 后才放源端。`pushIsolation` 17/17 全绿，含 `--output=<file>` 不能写文件/不能截断 `.git/config`、`--receive-pack=` 不执行、`--mirror` 不改写远端等。 |
| **11. 暂停 rebase 的拒绝语义** | **通过**。`composeAiFlow:215-266` 在真实 edit stop 中：staged AI 可生成、HEAD 不变；同一会话 `apply` 被拒绝并收到 `applyFailed`。`mutationGate` 的暂停白名单不含 `apply`/`openCompose`/`generate`；新例外只覆盖 `openCompose` staged AI 与 `generate` staged AI，未放宽任何写路径。 |
| **12. 测试计数与文档** | **一致**。`ls test/*.test.ts | wc -l` = **49**，`grep -rhoE '^test\(' test/*.test.ts | wc -l` = **333**；`RELEASE.md:136`、`docs/release-notes/0.8.3.md:44`、`docs/summary/summary.md:152`、`improvement.md:347` 均为 333/49。删除的 `composePolicy.test.ts` 有 2 条，新增 `composePanelClose` 2 条 + `composeAiFlow` 3 条 + push 源端失败 1 条，净增 4，与 329→333 自洽。 |
| **13. VSIX** | **12 个条目、白名单通过、逐字节一致**。`node scripts/package-vsix.js --verify-only` → `VSIX contents match the allowlist (12 entries).`；用 .NET `ZipFile` 逐个比对包内 10 个源码 payload 与工作树，全部 `True`（`LICENSE.txt` ↔ `LICENSE`）；包内 `extension/dist/extension.js` = `1fbeb461…` = 现场 `node esbuild.js` 重建前后 sha256。 |
| **14. 账本** | **待评审行存在且没有臆造 SHA**。`docs/review/code-review-commit.md:11` 的“已评审 Commit SHA”列是基线 `1e463f35…`，备注明确“尚未创建，待独立评审”“不写臆造 SHA”。按任务约束我**没有编辑账本**。 |
| **是否引入新缺陷** | **有一项阻塞（P2-1）**：脏草稿面板被新目标顶替后，取消/Escape 无法关闭。另有 1 项 P4 文档失真和 4 条观察。见 §四。 |

### 裁决：**不建议提交（阻塞）。入口收敛与推送确认已修好，但“取消/Escape 无条件关闭”仍有一个可复现状态失效。**

问题 1 的入口收敛、生成/应用分离、以及任务枚举的 idle/dirty/generating/generated/edited 五态都已修好并有测试证据；问题 2 的三要素确认框、源端 subject、失败中止、注入保护也全部通过。阻塞点不是文档措辞，而是一条可到达的真实路径：

1. 面板已打开目标 A 并输入草稿；
2. 用户从 webview 右键另一个 commit 打开目标 B；
3. 宿主 `compose.open` 已把 `active` 切成 B，页面防覆盖保护拒绝覆盖 A，显示“目标 commit 已变化”；
4. 用户按取消或 Escape，页面发送 A 的 `sessionId`；宿主以 `!acceptsActiveSession` 拒绝关闭，面板继续存在。

按任务给出的阻断条件（“如果取消仍可能无法关闭……就阻塞并指出确切位置”），本轮应阻塞。修复需要同时保住另一条已正确实现的保护：旧/保留的 webview 不得关闭较新的 Compose 目标。

---

## 二、我实际跑了什么（以及没有跑什么）

### 2.1 类型与定向用例（工作树本体）

```text
node node_modules/typescript/bin/tsc --noEmit                        → exit 0，零输出
node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit  → exit 0，零输出

node node_modules/tsx/dist/cli.mjs --test --test-concurrency=3 \
  test/composePanelClose.test.ts test/composeAiFlow.test.ts test/webviewDom.test.ts \
  test/pushNotification.test.ts test/pushIsolation.test.ts test/composePanelState.test.ts
ℹ tests 65   ℹ pass 65   ℹ fail 0   ℹ duration_ms 161063.8387
```

六个文件各自的静态用例数：`composePanelClose` 2、`composeAiFlow` 3、`webviewDom` 13、`pushNotification` 21、`pushIsolation` 17、`composePanelState` 9，合计 65，与 runner 的 `tests 65` 一致。

**完整 333 项套件不是我跑的**：按约束我没有启动第二个完整套件；以上只是六个定向文件。A 报告的 `pass 332 / fail 0 / skipped 1` 我未独立重跑，但静态 333/49 与文档一致。

### 2.2 脏草稿 + 新目标的宿主级复现

用真实 `RebaseViewProvider`、真实临时仓库（两个 commit）、真实 `ComposePanel` HTML + JSDOM，并把页面的 `composeReady`/`composeDraft`/`closeCompose` 真实送回宿主：

```text
session A: commit:60a3ec925828692da8e594f77d5cfbd1dbb5a835:apply:normal rev 1
host active B: commit:59a8f37874499326213e36e311e50a26d940e998:apply:normal rev 2
page warning: 目标 commit 已变化；当前草稿未被覆盖。请确认后重新打开目标。
close posted: [{"type":"closeCompose","dirty":true,
  "sessionId":"commit:60a3ec925828692da8e594f77d5cfbd1dbb5a835:apply:normal","revision":1}]
provider disposed panel: false | last toast: undefined
```

即：取消确实发送了 `closeCompose`，但宿主因为会话是 A 而当前 active 是 B，在 `rebaseViewProvider.ts:1034-1036` 提前返回；面板没有 dispose，也没有任何提示。

另有一次只加载 `ComposePanel` 的探针，得到同样结果：`accepts: false`、`host would close: false -> panel disposed: false`。

### 2.3 红/绿变异证据（验证测试确实钉住修复点）

- 把 `composePanel` 的 close handler 改回基线的 `if(dirty&&!confirm(...))return;…`（`confirm` 返回 false）后，`composePanelClose` 的 `edited: Cancel posts exactly one closeCompose` 变红（actual 0 / expected 1）；恢复后 2/2 绿。
- 在 `#changes` 里重新加回 draft-only 按钮后，`webviewDom` 的 `no draft-only entry in Changes/更多提交选项` 变红；恢复后 13/13 绿。
- 从 paused 例外中删掉 `stagedAiGeneration` 后，`composeAiFlow` 的 `generation is allowed because it writes no Git state` 变红（actual 0 / expected 1）；恢复后 3/3 绿。
- 推确认框我没有另做旧实现变异；本节只声明我实际做过的三条。

### 2.4 工作树 sha256（本轮被评审字节）

```text
db18a7d4e710862b0e2725f75112f918e949907a34e10b08d1d2d9d4d3cd9e4d  src/ui/composePanel.ts
a9f478712e74b6e0e4398b72de3c1c8e1defecbbb60dd5498675366b0941466a  src/ui/rebaseViewProvider.ts
6e3b355681bbcbd029758dae5a7a8d061ca22811cd146bdbb0863f557b96ffaf  media/main.js
788e2bc918fd62aff5f28940e6d566e275d6161a5fcff7e771362a66a89cb825  test/composePanelClose.test.ts
33089e2720727a02ee1e7dc7c4032eaddafbdcdcad8c17740a815b00dff52b45  test/composeAiFlow.test.ts
ba8bae35fc267105ca9da6974fd8e66499f654334d4d2b9c29e5dc115c0b14d9  test/webviewDom.test.ts
1eba34723e64fbe088d25951cb2b92cc8c58c2343d07ff8741f9c15efe4c045e  test/pushNotification.test.ts
b828a870addc2227638b0757cd27406242a7412588c89a99604b3c632f636e9a  docs/improvement/improvement.md
b0679301b30d02c65f3497a9e127de22635daff99c9987a17b3e6ff37c903afd  RELEASE.md
729c1c9c00b4ce5ae3196bad3277e53a9a55d64a9e6bfaa080a8a6048a8c7357  docs/release-notes/0.8.3.md
6113dd3abf2311f504c30099cf8a3750593b0dbff34f640667d12b65bd06d8f4  docs/summary/summary.md
6a675328876e4e9a6a5828a84f5dc8c748474fa84bb7e20715bd2771f7b12e89  docs/review/code-review-commit.md
1fbeb46100ff4b314b36f58b63fd3e8b6d473b7ed0c1e5be928525c1a7cff073  dist/extension.js（esbuild 重建前后不变）
```

---

## 三、逐项验证

### 3.1 第 1 项 — AI 入口只剩两个可执行位置

`media/main.js` 的实际渲染点：

```text
:204  changeAction("✦", "AI 生成 message 并提交暂存区",
        () => vscode.postMessage({ type:"openCompose", mode:"staged", ai:true, thenEdit:false }))
:635  menuItem({ icon:"✦", label:"AI 生成 message…", disabled:!state.llmConfigured,
        action: () => sendCompose(c, true) })
:642  function sendCompose(c, ai) { vscode.postMessage({ type:"openCompose", mode:"commit",
        hash:c.hash, ai, thenEdit:false }); }
```

- `:204` 的按钮是 staged 分组两个 action 的第二个，第一个仍是 `撤销全部暂存`；`webviewDom:394-395` 断言了索引与邻居。
- `#banner` 在 edit stop 只有“新建 commit…”（`media/main.js:160`，`ai:false, editKind:"new"`）与 Continue/Abort 等，不带 AI；`webviewDom:386` 断言 `#banner` 无 AI。
- `更多提交选项` 与 edit-stop 横幅不再有“仅生成 message（不提交）”；`grep` 在 `media/main.js` 找不到 `messageOnly`、`仅生成 message`、`不提交`。
- `webviewDom:339-422` 的七态矩阵在每种状态都断言：draft-only 按钮数为 0、staged `✦` 数量符合是否有暂存、staged payload 为 `mode:"staged", ai:true, thenEdit:false`、单个 commit 菜单恰有一个 AI 项且 payload 为 `mode:"commit", hash:a, ai:true, thenEdit:false`、两个 payload 都没有 `messageOnly`。

**一个不计入入口数的观察**：多选 commit 的菜单仍有 `AI 生成 message…` 的禁用占位项（`media/main.js:625`，`disabled:true`，无 action）。它不能打开面板，也不是第三个入口；`webviewDom` 的“单 commit 菜单”断言不受影响。见 §四观察 4。

### 3.2 第 2 项 — `messageOnly` 与 `composePolicy` 全链路删除

```text
$ grep -rn "messageOnly" src test media
test/webviewDom.test.ts:402: assert.equal("messageOnly" in posted, false, ...)
test/webviewDom.test.ts:417: assert.equal("messageOnly" in fromMenu, false, ...)

$ grep -rn "composePolicy" src test media scripts
（无输出）
```

`ComposePayload`（`composePanel.ts:8-24`）已无 `messageOnly`；会话身份 `:42` 只由 `mode`、`hash`、`thenEdit`、`editKind` 组成。被删 `src/ui/composePolicy.ts` 的原文只有两个函数：

```ts
isDraftOnlyComposeAllowedDuringRebase(mode, messageOnly)
  = messageOnly && (mode === "staged" || mode === "working")
isDraftOnlyAiGenerationAllowedDuringRebase(mode, messageOnly, hasConflicts)
  = !hasConflicts && isDraftOnlyComposeAllowedDuringRebase(...)
```

它们保证的是：暂停 rebase 只允许 staged/working 的**草稿/复制**面打开；AI 生成同样仅限 draft-only，且冲突时拒绝。随着 `messageOnly` 被整体删除，新实现的对应约束是：

- `openCompose` 暂停分支（`:2512-2519`）只允许 `ai && mode==="staged" && !thenEdit && !editKind` 的 AI 会话；任何 commit AI、working AI、带 `thenEdit`/`editKind` 的 AI 都被拒绝。非 AI 只保留经 `ensureEditStop` 校验的 amend/new。
- `generate` 暂停分支（`:2621-2634`）要求 active 会话必须是 staged AI；`conflictedFiles(cwd).length > 0` 时仍拒绝生成。
- `apply` 暂停分支（`:2697-2699`）无条件拒绝；`mutationGate` 的 `allowedPausedRebaseMutation` 不含 `apply`/`openCompose`/`generate`，新例外只由 `:874` 的 `pausedException` 提供，且 `stagedAiCompose`/`stagedAiGeneration` 都不含写路径。

因此删除模块没有留下“暂停时可写”的洞；working 模式的草稿/生成在暂停时不再可用，这是本轮入口收敛的有意结果，不是安全闸缺失。

### 3.3 第 3 项 — staged 入口端到端

`test/composeAiFlow.test.ts:100-151` 的断言链（真实仓库）：

```text
generate → HEAD 不变；status 仍为 "A  feature.txt"；页面收到 genResult "feat: generated only"
apply(edited) → HEAD 变化；git log -1 --pretty=%B 的 subject/body 精确等于用户编辑值；
                不含 "generated only"；包含 Signed-off-by: Git Rebase Visual Test <test@example.com>；
                git status --porcelain 为空；页面收到 applySucceeded
```

`apply` 的 staged 实现是 `await commitIndex(cwd, message.replace(/\s+$/, "") + "\n")`（`:2743`），`commitIndex` 走 `git commit -s`，所以签名 trailer 不是测试伪造。commit 右键用例（`:153-207`）还断言生成阶段没有 `rebase-merge` 目录、HEAD 不变，应用后旧 subject 与生成文本都不出现。

生成不写 Git 的另一个静态证据：`generate` 内只 `post` `genDelta`/`genResult`（`:2650/2670`）；`this.apply(` 唯一调用点在 `case "apply"`（`:1063`）。

### 3.4 第 4 项 — 取消/Escape 的五态

`test/composePanelClose.test.ts` 直接执行 `ComposePanel` 生成的 inline script，并把 `window.confirm` 定义为 `() => false`（`:106`），因此基线“dirty 时 confirm 返回 false 而不 post”的 bug 会让测试红。五态结果：

- idle：`clickClose` 恰好一条 `closeCompose`，`dirty:false`；
- edited：输入 subject 后 `dirty:true`；
- generated：收到 `genResult` 后 `dirty:true`；
- generating：点击生成后仍能关闭，`dirty:true`；
- Escape：`keydown` 走同一个 `$('close').click()`，恰好一条，`dirty:true`。

第二例（`:188-205`）先发 `composeDraft`，`panel.close()` 后重开，`composeReady` 后重新收到 `openCompose` 且 `draft === "feat: long message"`。`ComposePanel.onDidDispose`（`composePanel.ts:73-82`）不再按 dirty 丢弃 `recoveredDraft`；`close()`（`:94-96`）只是 `panel.dispose()`。宿主 `dirty` toast（`rebaseViewProvider.ts:1037-1039`）说明草稿已保留。

### 3.5 第 5 项 — 第六态失败（P2-1）

任务枚举的五态通过，但下面这条同样可到达的状态没有覆盖：

1. 打开目标 A（`rebaseViewProvider.ts:2569-2580` → `ComposePanel.open` 设 `active=A`，并在 `composeReady` 后下发 A）。
2. 页面输入草稿，`setDirty(true)` 并把草稿通过 `composeDraft` 送到宿主。
3. 用户在 webview 右键另一个 commit，provider 校验 B 后再次 `compose.open(B)`，`composePanel.ts:45` 无条件 `this.active = session`，宿主 active 变成 B。
4. 页面收到 B 的 `openCompose`，inline script 的页面级保护命中：

   ```js
   if(ctx && key()!==incomingKey && dirty){
     $('warning').textContent='目标 commit 已变化；当前草稿未被覆盖。请确认后重新打开目标。';
     $('warning').style.display='block';
     return
   }
   ```

   页面保留 `ctx=A`，只显示警告，不向宿主报告“我拒绝切换”。
5. 用户点击取消或 Escape，页面发送：

   ```json
   {"type":"closeCompose","dirty":true,
    "sessionId":"commit:60a3…:apply:normal","revision":1}
   ```

6. 宿主：

   ```ts
   case "closeCompose":
     if (m.sessionId !== undefined && !this.compose.acceptsActiveSession(m.sessionId, m.revision)) {
       return;
     }
     ...
     this.compose.close();
   ```

   `m.sessionId` 是字符串（不是 `undefined`），`acceptsActiveSession` 要求与 `active`（B）完全一致，返回 false，于是 `return`：不关闭、不 toast、不通知页面。

实测输出已在 §2.2。影响：取消/Escape 在该状态完全无效，只能点原生标签页 `×`；草稿没有丢（`recoveredDraft` 仍可按 A 恢复），但“无条件关闭”的契约和文档承诺不成立。这个状态没有被 `composePanelClose`（只开一个目标）或 `composeAiFlow`（不打开第二个目标）覆盖，是本轮修复遗漏的测试缺口。

修复时必须同时保住已经正确的保护：旧/保留的 webview 不能关闭较新的目标。可考虑的方向（不代替实现）：

- 让 `closeCompose` 区分“当前唯一文档”与“旧保留文档”（例如文档 incarnation token），当前文档即使目标已前进也允许关闭；或
- 目标变化时先不要切换宿主 `active`，等页面确认保留/放弃草稿后再切换；或
- 页面在显示“目标已变化”后进入一个明确的只读/选择态，取消仍按当前宿主 active 关闭，同时把 A 的草稿继续按 A 键保存。

单纯删掉 `closeCompose` 的会话校验会重新打开“旧 webview 关闭新目标”的洞，不可取。

### 3.6 第 6 项 — 推送确认框三要素

`pushBranchInternal` 的顺序现在是：

```ts
const deletion = isDeletionRefspec(refspec);
const sourceRev = pushSource(refspec);
const subjectResult = deletion || !sourceRev ? undefined
  : await runGit(withPositionals(["log","-1","--pretty=%s"], [sourceRev]), { cwd });
if (subjectResult && subjectResult.code !== 0) { toast("error", …未执行推送); return; }
const subject = subjectResult?.stdout.trim() ?? "";
const described = deletion ? describeDeletion(kind, target) : describePush(kind, subject, target);
const confirm = await vscode.window.showWarningMessage(`${described}（refspec：${refspec}）`, { modal:true }, "Push");
if (confirm !== "Push") return;
```

`describePush` 的格式是 `${pushKindLabel(kind)}："${短标题}" → ${target}`；空标题回退到 `PUSH_SUBJECT_UNKNOWN`，`shortenSubject` 按码点截断不劈开字符。`test/pushNotification.test.ts` 逐字断言：

```text
:159  ${expected}（refspec：HEAD:refs/heads/master）
:245  ${expected}（refspec：HEAD:refs/for/master）
:291  ${expected}（refspec：HEAD:refs/heads/hotfix）
:573  ${expected}（refspec：HEAD~1:refs/heads/older）
:649  ${expected}（refspec：:refs/heads/obsolete）
```

五类分别覆盖 normal、review、custom、源端不是 HEAD、deletion。deletion 用 `describeDeletion`，不会凭空声称一个未发布的 commit。`HEAD~1` 用例钉住“标题来自源端”而不是永远 HEAD。

### 3.7 第 7 项 — 失败中止与注入保护

失败用例（`pushNotification:583-620`）使用不可解析的源端，断言：

- 不出现 `Push` 确认框；
- 不进入 `withProgress`；
- 远端没有新 ref；
- 至少一条可见 error toast。

注入保护：`sourceRev` 是用户数据，`withPositionals` 在位置参数前插入 `--end-of-options`，所以 `--output=.git/config` 不会被 `git log` 当成选项。`pushIsolation` 的 17 条全部通过，其中 `:87`、`:125` 直接覆盖 `--output=<file>` 不能写文件/不能截断 `.git/config`，`:154` 覆盖 `--receive-pack=` 不执行。这个顺序调整没有削弱保护。

### 3.8 第 8 项 — 提前读 subject 是否阻塞确认框或锁

**会占住 mutation lock，且发生在确认框之前，但这是基线的既有结构，且读取有 120 s 上限，不是新的死锁。**

- `pushBranch()` 在 `tryAcquire` 和 `armWatchdog` 之后才调用 `pushBranchInternal`（`:3091-3103`）；`runGit` 默认 `DEFAULT_TIMEOUT = 120_000`（`src/git/gitRunner.ts:156`）。
- 基线在确认框之后才读 subject，但同样是在持有锁的 `pushBranchInternal` 内等待用户确认；所以“锁跨用户确认”不是本轮引入的。
- 新增的是“确认前多一次本地 `git log -1`”。正常仓库是一次毫秒级读取；若源端极慢或不可解析，最多等超时/立即失败，失败路径会 `return`，`finally` 释放锁并 `markSettled`。
- 结论：确认框在最坏情况下被一次有界读取推迟；不会永久阻塞，失败也不会推送。若要进一步优化，可把 subject 读取移到取锁前，但这不是本轮阻塞项。

### 3.9 第 9 项 — 暂停 rebase 路径仍拒绝该拒绝的

- `mutationGate`（`src/ui/mutationGate.ts`）对 `intent === "mutation"` 且 `pausedRebase` 时，只有 `allowedPausedRebaseMutation` 或 `pausedException` 才放行；`apply`、`openCompose`、`generate` 都不在静态白名单（`webviewProtocolState.ts:77-82`）。
- `pausedException`（`rebaseViewProvider.ts:856-874`）只包含：`openCompose` edit-stop amend、`openCompose` edit-stop new（非 AI）、`openCompose` staged AI、`generate` staged AI。没有 `apply`，没有 commit AI，没有 `thenEdit` 的 staged AI。
- `openCompose`（`:2508-2535`）在暂停时对 `ai && !aiStaged` 直接抛错；edit-stop amend 还要求 `hash === rebaseStoppedSha`；edit-stop new 要求能确认停靠目标。
- `generate`（`:2621-2634`）要求 active 会话是 staged AI，并在冲突时拒绝。
- `apply`（`:2697-2699`）无条件抛“变基进行中：不能应用 Compose message”。

`composeAiFlow:215-266` 用真实 edit stop 验证：staged AI 生成成功且 HEAD 不变；apply 被拒绝并收到 `applyFailed`。删除 `composePolicy.ts` 没有放宽这些路径。

### 3.10 第 10 项 — 测试计数、文档、VSIX

```text
ls test/*.test.ts | wc -l                    → 49
grep -rhoE '^test\(' test/*.test.ts | wc -l  → 333
```

文档四处一致：`RELEASE.md:136`、`docs/release-notes/0.8.3.md:44`、`docs/summary/summary.md:152`、`docs/improvement/improvement.md:347` 都写 333/49（A 报告 pass 332 / skip 1；完整套件不是我跑的）。`test/webviewDom.test.ts` 的新矩阵是 1 条 test、内部 7 个状态循环，所以静态 `^test\(` 计数不会把它算成 7，文档的计数口径与文件一致。

VSIX：

```text
node scripts/package-vsix.js --verify-only
→ VSIX contents match the allowlist (12 entries).

[Content_Types].xml
extension.vsixmanifest
extension/.gitignore
extension/LICENSE.txt
extension/dist/extension.js
extension/dist/seq-editor.js
extension/media/extension-icon.png
extension/media/icon.svg
extension/media/main.js
extension/media/style.css
extension/package.json
extension/readme.md
```

包内 10 个源码 payload 与工作树逐一 sha256 相同（`LICENSE.txt` 对应仓库的 `LICENSE`）：

```text
extension/LICENSE.txt                True  5b78c0db…
extension/package.json               True  476ec721…
extension/readme.md                  True  d6e308b0…
extension/dist/extension.js           True  1fbeb461…
extension/dist/seq-editor.js          True  3a242012…
extension/media/main.js              True  6e3b3556…
extension/media/style.css            True  99726c3c…
extension/media/icon.svg             True  cbf7205f…
extension/media/extension-icon.png   True  397d298d…
extension/.gitignore                 True  34c65652…
```

`node esbuild.js` 前后 `dist/extension.js` 都是 `1fbeb46100ff4b314b36f58b63fd3e8b6d473b7ed0c1e5be928525c1a7cff073`，与包内一致。

### 3.11 第 11 项 — 账本

`docs/review/code-review-commit.md:11` 的新行：

- 已评审 Commit SHA 列是 **基线** `1e463f35dbf3b1874e5dcaa2abe8a11eb07235cd`；
- 评审文件列写 `code-review-0-8-25.md`（尚未创建，待独立评审）；
- 状态 `待评审；尚无评审结论`；
- 备注明确“不写臆造 SHA”“提交后由后续独立评审按真实 SHA 覆盖”。

行内出现的 40 位十六进制串只有基线 SHA，没有把未提交工作树伪装成已评审 commit。按约束我没有编辑该文件；待维护者按本报告结论更新。

---

## 四、新发现（按严重度）

### P2-1（新，阻塞）脏草稿面板被新目标顶替后，取消/Escape 无法关闭

- **位置**：`src/ui/rebaseViewProvider.ts:1027-1040`（`case "closeCompose"` 的会话校验），配合 `src/ui/composePanel.ts:45`（`open` 无条件切换 `active`）、`:109-111`（`acceptsActiveSession`）与 `:147` inline script 的页面保护/关闭 handler。
- **触发**：Compose 已打开目标 A 且有脏草稿 → 用户从 webview 打开目标 B → 宿主 active 变 B，页面保留 A 并显示“目标 commit 已变化” → 按取消或 Escape。
- **结果**：`closeCompose` 带 A 的 `sessionId` 到达宿主，`acceptsActiveSession` 对 B 返回 false，宿主 `return`；面板不关闭、无 toast、页面也不知道被拒。原生标签 `×` 仍可关闭，草稿未丢。
- **为什么阻塞**：任务明确把“取消仍可能无法关闭”列为阻断条件；代码注释与 `RELEASE.md:128`、`release-notes:34` 都声称“无条件关闭”，实际存在可复现反例。
- **是否本轮回归**：**不是**。基线 `HEAD` 的 `closeCompose` 同样在 `discardActiveDraft` 返回 false 时 `return`；这个状态在基线也关不掉（而且基线的 `window.confirm` 还会先吞掉 dirty 状态的 post）。本轮修复了枚举五态并承诺“无条件”，但这个既有洞没有被覆盖，测试也没有补上。
- **为什么不能简单删校验**：该校验同时保护“旧/保留 webview 不能关闭较新的 Compose 目标”，删掉会把这个已修好的洞重新打开。需要按“当前文档 vs 旧文档”区分，或让页面/宿主在目标切换时保持一致。
- **测试缺口**：`composePanelClose` 只打开一个目标；`composeAiFlow` 不打开第二个目标。建议新增一条真实 provider + 单面板 + 两目标的用例，断言取消后 `panel.dispose` 被调用且 A 的草稿仍可按 A 重开恢复。

### P4-1（新，不阻塞）文档声称删除了 `copyText` 路径，但该路径仍在

- `RELEASE.md:128` 与 `docs/release-notes/0.8.3.md:34` 写“**复制 message** 分支与 `copyText` 路径一并删除”。
- 实际仍有：`src/ui/rebaseViewProvider.ts:937` 的 `case "copyText"`；`media/main.js:9` 的 read 白名单包含 `"copyText"`；`media/main.js:660` 的 commit 详情 tooltip 仍用 `copyText` 复制完整 message。
- 被删除的是 draft-only 的“复制 message”按钮/分支，不是 commit 详情的复制动作。建议把文档改成“draft-only 复制分支删除；commit 详情的复制 message 保留”，避免下一轮按文档误删真实功能。

### 观察 1（不计入清单）暂停 rebase/edit 时 commit 右键 AI 项仍可见，但被宿主拒绝

`media/main.js:635` 的右键 AI 项在任何状态都渲染；`webviewDom` 矩阵在 edit stop 也断言它存在（这是任务要求的两个入口之一）。暂停时点击它，`openCompose` 的 `ai && !aiStaged` 分支（`:2513-2515`）抛错，宿主发可见 error toast，不打开面板、不写 Git。它不是第三个入口，也不会在暂停时生成；若希望 UI 更早表达不可用，可在 `state.rebaseInProgress` 时把该项 disabled，但这不是本轮阻塞项。

### 观察 2（不计入清单）确认前的 subject 读取在 mutation lock 内

已在 §3.8 说明：有 120 s 上限，失败即中止并释放；基线本就在锁内等待模态确认。不是新死锁，但若未来要求确认框尽快出现，可把 `git log` 移到取锁前。

### 观察 3（不计入清单）没有 JSDOM 用例点击真实“应用”按钮

`composeAiFlow` 直接向 provider 发 `type:"apply"`，覆盖了宿主写入语义；页面 `$('apply').onclick` 读取 `subject`/`body` 并发送 `message` 的行为目前靠静态检查，没有一条“在 JSDOM 里编辑两个字段后点击应用，断言发出的 message 是编辑值”的用例。现有证据足以证明 apply 使用编辑后的 message（宿主测试 + inline script 可读），但页面层的按钮绑定没有持久测试。

### 观察 4（不计入清单）多选菜单的禁用 AI 占位项

`media/main.js:625` 在多选菜单渲染 `AI 生成 message…` 但 `disabled:true`、无 action。它不是可执行入口，任务要求的“恰好两个”按可执行路径成立；若按字面“任何位置都不出现 AI 文案”理解，则它仍是可见文案。建议后续要么移除，要么在测试中明确它只是 disabled 占位。

---

## 五、我没有验证的部分

- **完整 333 项套件**：按约束没有启动第二个完整套件；A 报告的 `pass 332 / fail 0 / skipped 1` 我没有独立重跑。我跑的是六个定向文件（65/65）。
- **真实 VS Code 宿主**：Compose 使用 JSDOM + fake panel 执行真实 HTML/脚本，没有在真实 VS Code webview 中点击过取消/Escape；原点“webview 不支持 `window.confirm`”的结论来自代码与 JSDOM 模拟，不是真实宿主日志。
- **真实 LLM 端点**：`composeAiFlow` 用 mock SSE；没有验证真实网络超时/流式分片/取消在真实端点下的表现。
- **真实远端推送**：`pushNotification`/`pushIsolation` 用本地临时仓库与 bare remote；没有对真实 HTTPS/SSH 远端、凭证提示、网络中断做端到端验证。
- **原生标签 `×` 的真实 dispose 时序**：我验证了 `onDidDispose` 保留 `recoveredDraft` 的单元行为，没有在真实 VS Code 中测量 `×` 与 `closeCompose` 的竞态。
- **跨平台**：只在 Windows 11 + MSYS Git 上运行；没有 macOS/Linux。
- **P2-1 的修复**：本轮只评审，没有实现修复；修复后需要重新验证“旧 webview 不能关闭新目标”仍成立。

---

## 六、裁决与覆盖范围

### 裁决：**阻塞提交。P2-1 修复并通过回归后再提交。**

**已确认修好的部分**：

- AI 可执行入口恰为两个；`messageOnly` 与 `composePolicy` 全链路移除，且暂停 rebase 的写拒绝没有被放宽；staged 端到端生成只写草稿、应用才用编辑后的 message 提交并带 `Signed-off-by`。
- 推送确认框具备种类、commit 短标题、目的地三要素，subject 来自 refspec 源端，失败在弹框/推送前可见中止，`withPositionals` 注入保护未削弱。
- 测试计数 333/49 与文档一致；VSIX 12 项白名单、payload 逐字节一致、esbuild 可复现；账本行存在且没有臆造 SHA。

**阻塞项**：P2-1。任务枚举的五态（idle/dirty/generating/generated/edited）都通过，但“脏草稿 + 用户打开另一个 Compose 目标”是真实可到达的第六态；此状态下取消/Escape 因宿主 `closeCompose` 会话校验直接返回而失效。它不丢草稿、可用原生 `×` 绕过，但违反“无条件关闭”的核心用户承诺，且与 `RELEASE.md`/release notes 的文案直接矛盾。按任务给出的阻断条件，本轮不能给出“可以提交”。

**覆盖范围**：基线 `1e463f35dbf3b1874e5dcaa2abe8a11eb07235cd`；被评审内容为该基线之上的未提交工作树（13 个 tracked 变更 + 2 个 untracked 测试文件），没有新 commit 可记录，故本报告不写被评审 commit SHA；账本由维护者在同一变更中按真实结论更新。
