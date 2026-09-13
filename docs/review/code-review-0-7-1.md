# Git Rebase Visual — 补充代码评审报告（0.7.1）

> **评审基线**：`f4045ea9163014389ef0406cae4d56bd527d9ddf`（v0.6.3）。
>
> **前序评审**：[`code-review-0-7-0.md`](code-review-0-7-0.md) 已覆盖初始实现 `40d5dd3ceda710ba253c9624cc827af99b462f49`，并列出 R70-1 至 R70-6。
>
> **本次独立复核覆盖提交**：`ed9c11c9f7b886b90908d41071a284a4dac3f704` — `fix: address 0.7 interaction review findings`。
>
> **范围**：只读复核该整改提交及其 `review-response-0-7-0.md` 声明，重点检查 deferred drag、右键 selection、stage/restore mutation allow-list、readonly generated Diff、连续多选 Diff UI/host gate，以及 LLM forbidden-port 测试稳定性。
>
> **结论**：R70-1 至 R70-5 的整改经本次源码、实际 webview DOM 回归和全量测试验证有效；但 R70-6 **未完全修复**。安全端口集合遗漏 Fetch forbidden ports `5060` 和 `5061`，随机端口仍可能触发 `bad port`。发现 1 项 **P1 发布阻止问题**，因此 `ed9c11c` **不批准发布**，需要 Agent A 继续整改并接受下一轮独立复核。

---

## 1. 发布结论

- [ ] **不批准 / 不可发布。** R71-1 保留了 R70-6 所针对的随机 LLM 测试失败机制。
- [x] **R70-1 至 R70-5 已通过本次复核。** 未发现这些路径的新 P0/P1 回归。
- [x] **未发现新的 P0。**
- [ ] **人工 VS Code 验收仍必需。** High Contrast/屏幕阅读器、真实 IME、指针设备和 SCM 实际操作仍不能由 Node/jsdom 替代；这不影响本报告对 R71-1 的发布阻止结论。

---

## 2. Finding

### R71-1 — P1：safe-port helper 漏掉 Fetch 明确禁止的 5060/5061，`listen(0)` 的 `bad port` 随机失败仍然存在

- [ ] **未修复；发布阻止。**

**位置**：`test/llmClient.test.ts` 的 `fetchForbiddenPorts`、`isFetchSafeTestPort()`、`listenOnFetchSafePort()`（约 10–45 行）。

**根因**：整改将共享测试 helper 改为“系统分配端口后检查、命中 forbidden port 则关闭并重试”，方向正确；但手写集合遗漏了 TCP ports **5060** 与 **5061**。当前 Node/Undici Fetch 会在请求发出前拒绝这两个端口，因此 helper 会把它们误判为 safe，并把 URL 交给 `fetch`。

本 reviewer 在目标环境（Node `v24.16.0`）独立执行：

```text
fetch("http://127.0.0.1:5060") → fetch failed; cause=bad port
fetch("http://127.0.0.1:5061") → fetch failed; cause=bad port
```

但当前回归仅断言 `6667` 和 `10080`，且源码中没有 `5060`/`5061`。Windows 先前已观测到的动态端口范围为 `1024–15000`，覆盖这两个端口；故 `server.listen(0)` 仍可能分配到其中之一。发生时所有通过 `withServer()` 的 LLM tests 都会在 HTTP handler 前以 `fetch failed: bad port` 失败，deadline case 也会再次失去其预期的 `timed out` 断言。

这不是理论上的非当前环境差异：本环境中已由 Fetch 的真实行为直接复现。20 次绿色 LLM 测试只说明本轮 OS 没有恰好分配 5060/5061，不能证明 retry gate 完整。

**复现**：

1. 在当前 helper 的 forbidden-port set 中检查 `5060` 和 `5061`，二者均不存在；`isFetchSafeTestPort(5060)`/`(5061)` 因而会返回 `true`。
2. 用系统 ephemeral allocation 获得 5060 或 5061（Windows dynamic range 可包含它们）。
3. `listenOnFetchSafePort()` 直接返回该端口，随后 LLM client 对 `http://127.0.0.1:<port>` 发起 Fetch。
4. Fetch 在联网前抛出 `bad port`；测试实际 HTTP handler 不会执行，预期 deadline/cancellation/SSE 行为都无法被验证。

**必须修复**：

1. 将 `5060` 和 `5061` 加入 shared Fetch forbidden-port 策略；同时逐项复核集合与当前 Fetch/URL 标准的完整 forbidden-port 集，不能只按已发生的 `6667` 做局部补丁。
2. 在 `isFetchSafeTestPort()` 的回归中明确断言 `5060`、`5061` 均为 `false`，保留已有 `6667`、`10080` 覆盖；测试应保护完整 helper，而不是仅保护 deadline 单例。
3. 保留“listen → inspect → close/retry”的资源清理语义，并重新运行全量测试和多轮 LLM tests。修复后须由独立 reviewer 复核。

---

## 3. 已验证的整改

### R70-1 — deferred drag session

- [x] `media/main.js` 的 pointer/native drop 现在在 `applyDeferredState()` 前以 captured `sourceHash`、`revision`、`canonicalOrder` 调用 `postReorderFromSession()`；host 继续以完整 canonical order 和 refresh generation 在确认前、Git 写入前复验。
- [x] `test/webviewDom.test.ts` 实际执行 webview 脚本，覆盖 pointer 和 native drag：deferred refresh 后发出的 payload 仍使用旧 session（分别验证 revision 7/11 与旧 canonical order），然后才应用 deferred state。

### R70-2 — right-click target consistency

- [x] contextmenu 与 keyboard Context Menu/Shift+F10 共用 `selectContextTarget()`：右击未选行会清空旧 selection 并以指针目标建立单项 context；右击已选行保留 batch。
- [x] 实际 DOM 回归覆盖 A+B 后右击 C、保留已选 batch、单项/批量 Diff payload，以及空白 context menu 清选。

### R70-3 — stage/restore mutation policy

- [x] `stageFile`、`restoreFile` 已被分类为 `mutation`，`RebaseViewProvider.onMessage()` 在实际入口使用 busy gate 将写入串行化；paused branch 复用明确 allow-list，而 scroll/pointer/selection/IME/refresh/read actions 不会产生暂停写入告警。
- [x] stage/restore 仍在各自 handler 中重新读取 porcelain status；restore 的 destructive 分支保持确认和 path validation。

### R70-4 — readonly generated Diff

- [x] 生成 Diff 改为私有 `git-rebase-visual-generated-diff:` `TextDocumentContentProvider` URI，而非可编辑的 `untitled:` document。URI query 仅为 opaque random snapshot token，不编码 repository、Git ref、path 或 command。
- [x] snapshot store 复制生成时的 content，并有 repository invalidation、10 分钟 TTL、64-entry LRU 和 extension disposal cleanup；后续普通 refresh 不会改变已打开的 snapshot。

### R70-5 — continuous multi-select Diff gate

- [x] webview 对 canonical order 判定 selection 连续性；非连续 batch 的“生成 Diff…”为 disabled，且提供“仅支持连续 commit；请取消未连续选择或使用单项 Diff。”的可访问原因。
- [x] host 独立以 current newest-first snapshot 验证 full unique hashes、request revision 及无空洞连续区间；无序但连续 payload canonicalize 为 oldest-first，gapped/unknown/duplicate/stale payload 在 Git read/document opening 前拒绝。
- [x] `generatedDiffState` 和 jsdom tests 覆盖单选、连续选择、无序连续 payload、1/3 空洞、unknown/duplicate、revision 改变和 UI disabled 状态。

---

## 4. 独立验证证据

所有命令均在 Agent A target worktree `D:\work\tools\git plugin\.claude\worktrees\agent-a6fea5ad466242226`、提交 `ed9c11c9f7b886b90908d41071a284a4dac3f704` 上执行；代码未被本 reviewer 修改。

| 命令 / 方法 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `node --check media/main.js` | 通过 |
| `npm run compile` | 通过 |
| `npm test` | **119/119 通过**，约 372 秒 |
| `npx tsx --test test/llmClient.test.ts` 连续 20 次 | 每次 **7/7 通过**；不覆盖遗漏的 5060/5061 分配情形 |
| `git diff --check 40d5dd3..ed9c11c` | 通过，无空白错误 |
| target worktree `git status --short` | 无输出，干净 |
| Node `fetch` 对 `127.0.0.1:5060` 与 `:5061` | 两者均在请求前 `cause=bad port`，确认 R71-1 |
| 源码 + `test/webviewDom.test.ts` + generated-Diff/mutation tests | 确认 R70-1 至 R70-5 的实际实现路径与 targeted regression |

---

## 5. 后续要求

1. Agent A 不得修改 [`code-review-0-7-0.md`](code-review-0-7-0.md) 或本报告；应在新的整改提交中修复 R71-1。
2. Agent A 应创建 `review-response-0-7-1.md`，逐项记录 R71-1 的决定、修改、精确测试证据和最终验证结果。
3. 整改 commit 需要下一份独立版本化 code review 覆盖后，才可解除 0.7 的发布阻止状态。
