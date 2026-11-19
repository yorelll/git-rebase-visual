# Code Review 0-8-26 — `composeRefused` 取消/Escape 修复复核、P4-1 与三项观察

- 评审日期：2026-11-19
- 评审角色：独立评审（Agent B，第十四轮）
- 基线 commit：`1e463f35dbf3b1874e5dcaa2abe8a11eb07235cd`（`docs: record the reviewed SHA for the notification-lock fix`）
- 被评审材料：基线之上的**未提交工作树**。`git diff --stat 1e463f3` = **13 files changed, 331 insertions(+), 213 deletions(-)**（`README.md`、`RELEASE.md`、`docs/improvement/improvement.md`、`docs/release-notes/0.8.3.md`、`docs/review/code-review-commit.md`、`docs/summary/summary.md`、`media/main.js`、`src/ui/composePanel.ts`、删除 `src/ui/composePolicy.ts`、`src/ui/rebaseViewProvider.ts`、删除 `test/composePolicy.test.ts`、`test/pushNotification.test.ts`、`test/webviewDom.test.ts`）；untracked 为 `docs/review/code-review-0-8-25.md`（上一轮评审报告）与 `test/composeAiFlow.test.ts`、`test/composePanelClose.test.ts`、新增 `test/composeTargetSwitch.test.ts`。`git rev-list --count 1e463f3..HEAD` = **0**，基线之后没有新提交。
- 本轮任务：复核上一份报告 `code-review-0-8-25.md` 的 P2-1（阻塞）、P4-1 与观察 1/3/4 是否真正整改且无回归；重点排查 `composeRefused` 是否会在相反方向造成宿主/页面失配、在面板销毁后或另一次 `open` 后到达时的行为，以及 `retainedSessions` 的清理；同时核对测试计数、文档、VSIX 与台账。任务明确不重新讨论上一轮已接受的入口收敛、staged 端到端流程、推送确认三要素、subject 排序与注入保护；观察 2（确认前读取 subject 在锁内）按任务不在本轮范围。
- 顺序：先读 [`code-review-0-8-25.md`](code-review-0-8-25.md)，再读 `docs/review/code-review-commit.md`，再读 `docs/improvement/improvement.md` 的 P3-14。
- 环境：Windows 11 + MSYS Git `2.53.0.windows.2`，Node `v24.16.0`（`/d/Program Files/nodejs/node`），TypeScript `5.9.3`。
- **约束遵守**：我只写了本文件。没有改 `src/`、`test/`、`media/`、`.github/`、其它 `docs/` 或仓库根目录；没有提交、打 tag、push、`git add`、编辑台账。为核对可复现性运行了 `node esbuild.js`（`dist/` 被 `.gitignore` 忽略，重建前后 sha256 相同）与 `node scripts/package-vsix.js --verify-only`。变异与探针都在 `%TEMP%` 的临时副本中执行（`node_modules` 用 junction 指向仓库），完成后已删除副本与探针进程。

---

## 一、结论摘要

| 复核项 | 结论 |
| --- | --- |
| **1. P2-1 的稳定状态已修复** | **通过**。脏草稿目标 A 被新目标 B 顶替后，页面显示警告并发送 `composeRefused`（带仍显示的 A 与刚被拒的 B）；`ComposePanel.restoreRefusedSession` 只有在“被拒提议仍等于当前 active”且 A 确实在本面板投递过时才把 `active` 与 delivery 恢复为 A。此后取消/Escape 发送 A，宿主校验通过并 dispose。`test/composeTargetSwitch.test.ts:151` 真实 provider + 真实面板 + 两个 commit 目标，断言面板关闭且重开 A 恢复精确草稿。 |
| **2. Escape 在同一状态** | **通过**。页面 Escape 走同一个 `$('close').click()`。我在临时副本把该用例的取消点击替换为 `keydown Escape`，同一断言 1/1 通过。 |
| **3. 旧/保留文档保护仍在，且测试非空转** | **通过**。`rebaseViewProvider.ts:1037-1039` 的 `acceptsActiveSession` 校验原样保留。临时副本中删掉该校验后，`a stale retained document cannot close the newer Compose target` 变红（`the stale close must not dispose the panel: true !== false`），另一条仍绿；恢复后 2/2 绿。 |
| **4. 拒绝链路本身非空转** | **通过**。临时副本把 `restoreRefusedSession` 置为 no-op 后，第一条用例在“宿主跟随页面拒绝”处变红（active 为 B、期望 A），第二条仍绿；再把页面发送 `composeRefused` 的那一行删掉，第一条同样变红。 |
| **5. `restoreRefusedSession` 输入校验** | **通过**。sessionId/revision 类型、incoming 与当前 active 的精确匹配、retained 表存在性四道校验齐全。临时探针用数字/字符串/未知 revision/任意 sessionId/null/缺失字段/incoming 不匹配等 payload 均无法移动 active；只有合法拒绝才恢复 A，且只可能选中本面板投递过的会话。 |
| **6. 反向失配、销毁后到达、另一次 `open` 后到达** | **未发现阻塞缺陷**。脏页面不会接受新目标，页面消息同通道有序，旧拒绝的 `incoming*` 对不上新 active 时被忽略；面板销毁会清空 `active` 与 `retainedSessions`（探针断言 size=0），销毁后的拒绝不能复活会话。仅有一处无功能影响的小观察，见 §四。 |
| **7. P4-1 文档** | **通过**。`RELEASE.md:128` 与 `docs/release-notes/0.8.3.md:34` 已改为“只删除 draft-only 的复制 message 按钮/分支；commit 详情 tooltip 的复制完整 message 仍走 `copyText`”。宿主 `case "copyText"`（`rebaseViewProvider.ts:937`）、read 白名单（`media/main.js:9`）与 tooltip 调用（`:659`）均在。 |
| **8. 剩余 `copyText` 的测试** | **部分**。代码行为完整，但自动化只把该消息分类为 read（`test/webviewProtocolState.test.ts:68`），没有断言“点击复制完整 message → 写剪贴板 + toast”。这是本轮之前就存在的覆盖缺口，不阻塞，记为 P4-1。 |
| **9. 观察 1（右键 AI 暂停时禁用）** | **通过**。`media/main.js:634` 在 `!state.llmConfigured || state.rebaseInProgress` 时 disabled，暂停理由为“变基进行中；如需 AI message，请先暂存改动并使用暂存区的 ✦”。`webviewDom:415-423` 在普通暂停、冲突暂停、edit stop 三态断言 disabled、精确理由且点击不发送消息；空闲/混合态断言可用并发出正确 payload。 |
| **10. 观察 4（多选菜单占位项）** | **通过**。占位项已从 `media/main.js` 多选分支删除；`webviewDom:202` 断言 `menuText` 完全不含 `AI 生成 message`。 |
| **11. 观察 3（页面级“应用”测试）** | **通过**。`test/composePanelClose.test.ts:188` 在真实 ComposePanel HTML/JSDOM 中先 `genResult` 填两个字段，再手改 subject/body，点击应用，断言恰好一条 `apply`、message 精确为 `feat: edited subject\n\nedited body`、携带当前 session/revision 且不含生成文本。 |
| **12. 新缺陷扫描** | **无 P0/P1/P2/P3**。见 §3.3 与 §四；仅两项 P4 级观察（`copyText` 测试缺口、拒绝后警告文案残留）。 |
| **13. 测试计数与文档** | **一致**。`ls test/*.test.ts | wc -l` = **50**，`grep -rhoE '^test\(' test/*.test.ts | wc -l` = **336**；`RELEASE.md:136`、`docs/release-notes/0.8.3.md:44`、`docs/summary/summary.md:153`、`improvement.md:360` 均为 336/50。我定向跑 7 个受影响套件合计 **68/68** 绿。 |
| **14. VSIX** | **12 个条目、白名单通过、逐字节一致**。`--verify-only` → `VSIX contents match the allowlist (12 entries).`；包内 10 个源码 payload 与工作树逐字节相同；包内 `extension/dist/extension.js` = `483dc41c…` = 现场 `node esbuild.js` 重建产物。 |
| **15. 台账** | **准确、无臆造 SHA**。新增行以基线 `1e463f35…` 记录 `code-review-0-8-25.md` 的评审与整改状态，只出现基线这一个 40 位 SHA；我未编辑该文件。 |

### 裁决：**建议提交（无阻塞）。P2-1 已真正关闭，旧文档保护仍有效，四项跟进均完成且无回归。**

---

## 二、我实际跑了什么（以及没有跑什么）

### 2.1 类型与定向用例（工作树本体）

```text
node node_modules/typescript/bin/tsc --noEmit                        → exit 0，零输出
node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit  → exit 0，零输出

node node_modules/tsx/dist/cli.mjs --test --test-concurrency=3 \
  test/composeTargetSwitch.test.ts test/composePanelClose.test.ts \
  test/composeAiFlow.test.ts test/composePanelState.test.ts
ℹ tests 17   ℹ pass 17   ℹ fail 0   ℹ duration_ms 60042.9668

node node_modules/tsx/dist/cli.mjs --test --test-concurrency=2 \
  test/webviewDom.test.ts test/pushNotification.test.ts test/pushIsolation.test.ts
ℹ tests 51   ℹ pass 51   ℹ fail 0   ℹ duration_ms 155802.7205
```

七个文件的静态用例数：`composeTargetSwitch` 2、`composePanelClose` 3、`composeAiFlow` 3、`composePanelState` 9、`webviewDom` 13、`pushNotification` 21、`pushIsolation` 17，合计 **68**，与两次 runner 的 17 + 51 一致。

**完整 336 项套件不是我跑的**：按要求我没有启动第二个完整套件；评审期间进程表里存在评审开始前就在运行的 Node 进程（包括一个持续占用 CPU 的 10:04 启动进程），我未干预。A 报告的 `pass 336 / fail 0 / skipped 0` 我未独立重跑；静态 336/50 与三处文档一致。

### 2.2 红/绿变异证据（`%TEMP%` 独立副本）

把 `src/`、`test/` 与 `package.json`、两个 tsconfig、`esbuild.js` 复制到 `%TEMP%\grv-newreview`，`node_modules` 用 junction 指向仓库。基线 `composeTargetSwitch` 2/2 绿，然后分别施加最小变异：

1. **把 `composeRefused` 处理改为 no-op**：

   ```text
   ✖ Cancel closes a dirty panel whose target was superseded, and A's draft is recoverable
     AssertionError: the host follows the page's refusal instead of staying on B
     + actual   'commit:…:apply:normal'   (B)
     - expected 'commit:…:apply:normal'   (A)
   ✔ a stale retained document cannot close the newer Compose target
   ℹ tests 2  ℹ pass 1  ℹ fail 1
   ```

2. **删掉页面发送 `composeRefused` 的那一行**（保留宿主处理）：

   ```text
   ✖ Cancel closes a dirty panel whose target was superseded, and A's draft is recoverable
     AssertionError: the host follows the page's refusal instead of staying on B
   ℹ tests 1  ℹ pass 0  ℹ fail 1
   ```

3. **删掉 `closeCompose` 的 `acceptsActiveSession` 校验**（保护旧文档的那道闸）：

   ```text
   ✔ Cancel closes a dirty panel whose target was superseded, and A's draft is recoverable
   ✖ a stale retained document cannot close the newer Compose target
     AssertionError: the stale close must not dispose the panel
     true !== false
   ℹ tests 2  ℹ pass 1  ℹ fail 1
   ```

三个变异都在预期的那条用例上变红，另一条保持绿；恢复后均 2/2 绿。这证明新用例既钉住了“页面报告拒绝 + 宿主跟随”，也钉住了“旧保留文档不得关闭新目标”，不是空转。

### 2.3 输入校验与 Escape 探针（同一临时副本）

- **Escape 变体**：把第一条用例中的 `#close.click()` 替换为 `document` 上 `keydown Escape`，`--test-name-pattern` 运行：

  ```text
  ✔ Cancel closes a dirty panel whose target was superseded, and A's draft is recoverable
  ℹ tests 1  ℹ pass 1  ℹ fail 0
  ```

- **畸形 payload 探针**：直接实例化真实 `ComposePanel`，打开 A（rev 1）再打开 B（rev 2），通过真实消息监听器发送 `composeRefused`。以下 payload 全部被忽略、`active` 保持 B：
  `sessionId` 为数字、`revision` 为字符串、`revision` 为不存在的 999、任意未知 sessionId、`sessionId:null`、`incomingSessionId` 不等于 active、`incomingRevision` 为字符串、完全缺失字段。
  随后发送合法拒绝 `{sessionId:A, revision:1, incomingSessionId:B, incomingRevision:2}`，`active` 恢复 A；再发送“incoming 指向已被替换的 B”的迟到拒绝，仍保持 A；发送“未知 sessionId + 匹配的 incoming”，仍保持 A。
  最后 `panel.close()` 后断言 `active === undefined`、`retainedSessions.size === 0`，销毁后再送合法形状的拒绝也不会复活会话。探针 1/1 绿。
- 临时副本、`.bak` 与 junction 已全部删除；无残留探针进程（另清理了一个此前 `du` 探针）。

### 2.4 VSIX

```text
node scripts/package-vsix.js --verify-only
→ VSIX contents match the allowlist (12 entries).   exit 0

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

用 .NET ZipFile 逐个比对包内 10 个源码 payload 与工作树：全部 True
extension/LICENSE.txt                True  5b78c0db…
extension/package.json               True  476ec721…
extension/readme.md                  True  d6e308b0…
extension/dist/extension.js          True  483dc41c…
extension/dist/seq-editor.js         True  3a242012…
extension/media/main.js              True  f86f463c…
extension/media/style.css            True  99726c3c…
extension/media/icon.svg             True  cbf7205f…
extension/media/extension-icon.png   True  397d298d…
extension/.gitignore                 True  34c65652…

node esbuild.js（现场重建）→ dist/extension.js = 483dc41c282c9e294f4775563d353b7fcbf70df0de4e28691b10afa376cb13f3
```

包内 `extension.js` 与现场重建逐字节相同，源码 payload 也与工作树逐字节相同。

### 2.5 工作树 sha256（本轮被评审字节）

```text
058b8d0af9a12210c8a7f48a50851d8e694b29e8dc7ec2eed4124d8939e0dcb4  src/ui/composePanel.ts
e6866f6550b26a8b3a6e6c534685d0d9329ae468ed04836e7f067de6333b32c3  src/ui/rebaseViewProvider.ts
f86f463cb14e2d3ff1f051ce9ff23b8942bed4d8237b5eb666f2dc04bc9b6ea6  media/main.js
6286dcd28de897db74b26535a8d0c6dfcd4e39d249bc3a0ce601f8076142303d  test/composeTargetSwitch.test.ts
84cd95a14cdbc696774bccb94e4fffdddd26a8a9676e8fffb206d0de1149aa59  test/composePanelClose.test.ts
481a9834cb2bf311327f6046c5dd7664ed6da96bd5cf19cd46e7e6613349e623  test/webviewDom.test.ts
33089e2720727a02ee1e7dc7c4032eaddafbdcdcad8c17740a815b00dff52b45  test/composeAiFlow.test.ts
1eba34723e64fbe088d25951cb2b92cc8c58c2343d07ff8741f9c15efe4c045e  test/pushNotification.test.ts
483dc41c282c9e294f4775563d353b7fcbf70df0de4e28691b10afa376cb13f3  dist/extension.js（重建前后不变）
```

---

## 三、逐项验证

### 3.1 P2-1 — 稳定状态下取消/Escape 关闭，草稿可恢复

修复链路（当前行号）：

- 页面在拒绝覆盖时报告拒绝（`src/ui/composePanel.ts:201` inline script）：

  ```js
  if(ctx&&key()!==incomingKey&&dirty){
    $('warning').textContent='目标 commit 已变化；当前草稿未被覆盖。请确认后重新打开目标。';
    $('warning').style.display='block';
    post('composeRefused',{sessionId:ctx.sessionId,revision:ctx.revision,
      incomingSessionId:m.sessionId,incomingRevision:m.revision});
    return
  }
  ```

- 宿主在 ComposePanel 的消息监听器中消费它（`:75-78`），不把它转发给 provider：

  ```ts
  if (message?.type === "composeRefused") {
    this.restoreRefusedSession(message);
    return;
  }
  ```

- `restoreRefusedSession`（`:153-177`）先要求当前 `active` 存在，`sessionId` 是字符串、`revision` 是数字，且 `incomingSessionId/incomingRevision` 精确等于当前 active；再从 `retainedSessions`（`:43`，每次 `open` 在 `:51` 记录）取页面仍显示的会话，恢复 `active`、tab 标题与 delivery。若被拒提议已经不是 active，直接忽略，因此迟到拒绝不会撤销更新的已接受目标。
- 宿主 `closeCompose`（`rebaseViewProvider.ts:1027-1044`）的会话校验仍在，但此时 active 已与页面一致，校验通过并 `this.compose.close()`；`dirty:true` 时仍发“草稿已保留”的 info toast。
- `test/composeTargetSwitch.test.ts:151-196` 的断言顺序：打开 A → 编辑 subject/body → 打开 B 时宿主确实向页面投递了 B → 页面显示“目标 commit 已变化” → **宿主 active 回到 A** → 点击取消 → `panel.dispose` 被调用 → 重开 A 时 `openCompose.draft` 精确等于 `feat: my unsaved draft\n\nbody I do not want to lose`。
- Escape 走 `document.addEventListener('keydown', … Escape → $('close').click())`，与取消同一个处理器；我在临时副本的 Escape 变体 1/1 通过。

### 3.2 旧/保留文档保护仍有效

`test/composeTargetSwitch.test.ts:198-223`：干净页面接受 B（宿主 active 确为 B），随后用 A 的旧 `sessionId/revision` 发送 `closeCompose`；断言面板未 dispose、`visible()` 仍为 true、active 仍是 B。§2.2 的变异 3 证明该用例确实钉住 `acceptsActiveSession` 校验：删掉校验后它立刻变红，而修复用例仍绿。

### 3.3 新方向失配、销毁后/另次 `open` 后到达、`retainedSessions` 清理

- **相反方向（宿主回到 A，而页面已接受 B）**：真实页面只有在 `dirty` 时才发送拒绝，并且发送后立即 `return`，不设置 `ctx`；页面不可能在同一条提议上既拒绝又接受。页面消息按通道有序，若拒绝晚于一次新 `open` 到达，其 `incoming*` 对不上新 active，会被忽略；随后页面会对新提议再发一次拒绝，宿主再跟随页面。代码与测试都没有发现可让宿主单方面回到 A 的路径。
- **另一次 `open` 后到达**：`active` 已变，`incoming` 不匹配即忽略；探针里“迟到拒绝指向已被替换的提议”保持 A。
- **面板销毁后到达**：`onDidDispose` 清空 `active`、`retainedSessions`、delivery；`restoreRefusedSession` 第一道 `!active` 直接返回。探针断言销毁后 map size=0、拒绝不能复活会话。
- **清理**：`retainedSessions` 在 `onDidDispose`（`:94`）清空，随面板一次性销毁；面板存活期间每个“目标 + revision”保留一条（含完整 original message），不做淘汰。注释明确“页面可拒绝任意多个新目标，驱逐不安全”。这是有界于一次面板生命周期的内存占用，不是跨面板泄漏；见 §四的说明。
- **标题与重载投递**：恢复后同步改回 `panel.title` 并 `delivery.update(retained)`，所以重载后的 `composeReady` 仍会收到 A 及 A 的恢复草稿。

### 3.4 P4-1 — 文档准确，剩余 `copyText` 完好

`RELEASE.md:128`：

> 被删除的只是 draft-only 的“复制 message”按钮及其分支；commit 详情 tooltip 里“复制完整 message”仍走 `copyText`，`media/main.js` 的 read 白名单与宿主 `case "copyText"` 都保留，该功能没有删除。

`docs/release-notes/0.8.3.md:34` 措辞相同。代码侧：

```text
media/main.js:9     read 白名单含 "copyText"
media/main.js:659   tooltip 按钮 post({ type: "copyText", text: d.message })
src/ui/rebaseViewProvider.ts:937  case "copyText": await vscode.env.clipboard.writeText(m.text ?? ""); toast(...)
```

**测试情况（P4-1）**：`test/webviewProtocolState.test.ts:68` 只断言 `copyText` 的 intent 是 `read`；没有测试点击 tooltip 后剪贴板收到 message、或 `case "copyText"` 的 toast。这是既有缺口，不是本轮引入，且不影响本轮文档结论；建议后续补一条行为用例。

### 3.5 观察 1 — 暂停时右键 AI 项禁用并说明理由

`media/main.js:634`：

```js
menuItem({ icon:"✦", label:"AI 生成 message…",
  disabled: !state.llmConfigured || state.rebaseInProgress,
  disabledReason: state.rebaseInProgress
    ? "变基进行中；如需 AI message，请先暂存改动并使用暂存区的 ✦"
    : "请先配置 LLM。",
  action: () => sendCompose(c, true) })
```

`test/webviewDom.test.ts:415-423` 在普通暂停、冲突暂停、edit stop 三种状态断言 `disabled` class、精确 title 文案，并清空消息后点击，断言 `view.messages` 仍为空；空闲与混合状态走 `:425-435`，断言可用且发出 `mode:"commit"`、正确 hash、`ai:true`、`thenEdit:false`、无 `messageOnly`。

### 3.6 观察 4 — 多选菜单不再有 AI 占位项

`media/main.js` 的多选分支（`~:618-630`）已无 `AI 生成 message` 项，其它 disabled 占位（打开变更、编辑 message、停靠、squash、fixup）保留。`test/webviewDom.test.ts:202`：

```js
assert.doesNotMatch(menuText, /AI 生成 message/, "the batch menu has no AI entry");
```

同时 `:197-199` 仍断言多选菜单应有的三条文案，说明测试不是只删断言。

### 3.7 观察 3 — 页面级“应用”测试

`test/composePanelClose.test.ts:188-225` 加载真实 ComposePanel 生成的 HTML 与 inline script：

1. 收到 `genResult`，两个字段被模型文本填充；
2. 手写 `subject = "feat: edited subject"`、`body = "edited body"`；
3. 点击 `#apply`；
4. 断言恰好一条 `apply`，`message === "feat: edited subject\n\nedited body"`，session/revision 等于当前值，且 `doesNotMatch(message, /generated/)`。

这覆盖了此前只有宿主层证据的页面按钮绑定。

### 3.8 测试计数与文档

```text
ls test/*.test.ts | wc -l                    → 50
grep -rhoE '^test\(' test/*.test.ts | wc -l  → 336
```

- `RELEASE.md:136`、`docs/release-notes/0.8.3.md:44`、`docs/summary/summary.md:153`、`improvement.md:360`（P3-14）均为 **336 项 / 50 个文件**。
- `improvement.md:347` 仍保留上一轮 P3-13 的 **333/49、pass 332/skip 1**；那是上一轮的历史验证记录，不是当前计数，与 P3-14 的 336/50 不矛盾。
- 本轮新增 3 条：`composeTargetSwitch` 2 + `composePanelClose` 新增 1（应用按钮）；上一轮 333 + 3 = 336，文件 49 + 1 = 50，自洽。
- 我定向运行的 7 个受影响套件 68/68 全绿（§2.1）。完整套件未由我重跑。

### 3.9 VSIX

12 个条目、白名单校验 exit 0；10 个源码 payload 与工作树逐字节相同；包内 `dist/extension.js` sha256 `483dc41c…` 与现场 `node esbuild.js` 重建产物相同；`media/main.js`（`f86f463c…`）也与工作树一致。§2.4 有完整输出。

### 3.10 台账

`docs/review/code-review-commit.md:11` 新增行：

- “已评审 Commit SHA”是基线 `1e463f35dbf3b1874e5dcaa2abe8a11eb07235cd`；
- 评审文件为 `code-review-0-8-25.md`（第十三轮，不批准：P2-1 阻塞）；
- 状态“已评审；P2-1 阻塞，已按报告整改，待复核提交”；
- 备注明确“仍无 commit SHA 可记录，本行不写臆造 SHA”，并准确列出整改项（P2-1 的 `composeRefused` 握手、P4-1、观察 1/3/4、双目标用例、旧文档校验保留）。

整行只出现基线这一个 40 位十六进制串，没有把未提交工作树伪装成已评审 commit。按约束我未编辑该文件；本报告结论应由维护者在同一变更中补入。

---

## 四、新发现（按严重度）

**没有 P0 / P1 / P2 / P3 级缺陷。** 以下两项为 P4，均不阻塞提交，也不由本轮引入。

### P4-1（测试覆盖，既有）剩余 `copyText` 只有协议分类断言

- 位置：`test/webviewProtocolState.test.ts:68`；行为实现 `src/ui/rebaseViewProvider.ts:937`、调用点 `media/main.js:659`。
- 现状：只断言 `copyText` 是 `read` intent；没有测试点击“复制完整 message”后 `vscode.env.clipboard.writeText` 收到完整 message、并弹出 toast。
- 影响：文档现在正确地说该功能保留，代码也确实保留；但若未来误删 handler 或 tooltip 调用，现有测试不会变红。
- 建议：下一轮补一条宿主级用例（stub 记录 `clipboard.writeText` 入参）或 webview DOM 用例（断言 tooltip 按钮 post 的 `copyText.text === d.message`）。

### P4-2（交互文案，新路径的残留）宿主跟随拒绝后，页面警告仍显示

- 位置：`src/ui/composePanel.ts:201` 的 `#warning`。
- 现状：宿主已把 active 恢复为页面仍显示的 A，随后取消/Escape 可正常关闭；但页面上的“目标 commit 已变化；当前草稿未被覆盖。请确认后重新打开目标。”不会被清除，也不会收到“宿主已跟随”的确认。
- 影响：不影响任何功能（应用/取消都针对 A），只是文案会让人误以为仍需重开目标。
- 建议：将来可在宿主恢复后回发一条确认消息清除/改写警告；不是本轮阻塞项。

**另外两点说明（不计入发现）**：

- `retainedSessions` 在面板存活期间每个“目标 + revision”保留一条完整 payload，不做淘汰；`onDidDispose` 会整体清空（探针已断言）。注释给出的“页面可拒绝任意多个新目标、无法安全驱逐”是成立的，因此这是设计取舍而非泄漏。若未来担心长会话内存，可保留“当前显示 + 当前 active + 最近 N 个”并配合测试，但不建议在本轮改动。
- 我在静态推理与临时探针中没有发现“宿主回到 A 而页面已接受 B”的可达路径：脏页面拒绝后不会接受新目标，页面消息有序，旧拒绝的 `incoming*` 不匹配新 active 会被忽略。真实 VS Code 的跨 webview 时序我未做端到端测量（见 §五）。

---

## 五、我没有验证的部分

- **完整 336 项套件**：按要求没有启动第二个完整套件；A 报告的 `pass 336 / fail 0 / skipped 0` 我未独立重跑。我跑的是 7 个受影响文件（68/68）与两个类型检查。
- **真实 VS Code 宿主**：Compose 用真实 HTML + inline script + JSDOM 与 fake panel，没有在真实 VS Code webview 中实际按 Escape/取消；主侧栏打开新目标与 Compose 面板之间的跨 webview 消息时序是代码推理 + 探针模拟，不是真实宿主日志。
- **真实 LLM 端点**：`composeAiFlow` 用 mock SSE；未验证真实网络超时/流式分片/取消。
- **真实远端推送**：`pushNotification`/`pushIsolation` 用本地临时仓库与 bare remote；未对真实 HTTPS/SSH 远端、凭证提示、网络中断做端到端验证（本轮未改动这些路径）。
- **真实剪贴板**：没有在 VS Code 中实际点击“复制完整 message”验证系统剪贴板，只核对了代码路径与协议分类。
- **跨平台**：只在 Windows 11 + MSYS Git 上运行；没有 macOS/Linux。
- **观察 2**（确认框前读取 subject 在 mutation lock 内）：按任务不在本轮范围，未重新评估。
- **提交/打 tag/发布门禁**：按约束未提交、未打 tag、未 push，未运行 `npm run test:release` 全量门禁。

---

## 六、裁决与覆盖范围

### 裁决：**建议提交。P2-1 阻塞已关闭；旧文档保护仍有效；P4-1 与观察 1/3/4 均完成且无回归；未发现新的阻塞或中高严重度缺陷。**

- **P2-1 的判定依据**：稳定状态下宿主与页面在 `composeRefused` 后重新一致，取消与 Escape 均 dispose 面板，A 的草稿在重开时精确恢复；两个关键保护（拒绝链路、旧文档不得关闭新目标）都做了最小变异并各自打红对应用例，恢复后全绿。
- **输入校验**：畸形/迟到/销毁后拒绝都无法把 active 指向任意或未知会话，只可能在本面板投递过的会话之间恢复。
- **跟进项**：P4-1 文档已收窄到“draft-only 复制分支删除、commit 详情复制保留”，且剩余 `copyText` 代码完整；观察 1 的禁用理由、观察 4 的占位项删除、观察 3 的页面级应用测试均按描述落地。
- **一致性**：静态 336/50 与三处当前文档一致；VSIX 12 项白名单、逐字节一致、esbuild 可复现；台账以真实基线 SHA 记录且无臆造。
- **两项 P4**（`copyText` 行为测试缺口、拒绝后警告文案残留）不阻塞本次提交，可留待 0.8.4 清理。
- **覆盖范围**：基线 `1e463f35dbf3b1874e5dcaa2abe8a11eb07235cd`；被评审内容为该基线之上的未提交工作树（13 个 tracked 变更 + 4 个 untracked 文件），没有新 commit 可记录，故本报告不写被评审 commit SHA。提交后应由后续独立评审按真实 SHA 覆盖台账行；本报告不代替提交动作。
