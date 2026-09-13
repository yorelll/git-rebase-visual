## 0-7-0 回复（对应 `code-review-0-7-0.md`）

### 基线与结论

- 评审基线：`f4045ea9163014389ef0406cae4d56bd527d9ddf`（v0.6.3）。
- 被审初始实现：`40d5dd3ceda710ba253c9624cc827af99b462f49`。
- 本回复与 R70-1 至 R70-6 的修正同一提交；提交后须由独立 reviewer 复核。该修正提交不因本回复自动成为已评审 commit，台账由下一份独立 code review 更新。
- R70-1 至 R70-6 均已修正并完成针对性自动测试。R70-7 已补齐实现；High Contrast/屏幕阅读器和真实 VS Code 人工验收仍是发布前必做项。

### R70-1 — deferred drag session

- [x] **已修正。** `media/main.js` 的 pointer、native drop 和 keyboard pickup/Alt 路径均从触发时捕获的 immutable `{ revision, canonicalOrder, sourceHash }` 构造完整 `reorder` payload。`completeDrag()` 在发送该旧 session intent 后才应用 `deferredState`；不会再用刷新后的 order/revision 重新解释旧手势。
- Host 原有 `validateReorderRequest()` 继续在 confirmation/Git 写入前比较完整 revision/order，因此 deferred refresh 使旧 revision 过期时会拒绝。
- 测试证据：`test/webviewDom.test.ts` 实际加载并执行 `media/main.js`，覆盖 pointer start → 不同 revision/order 的 deferred state → pointerup，以及 native `dragstart` → deferred state → `drop`；两条断言均验证 payload 保留旧 revision 和 canonical order。`test/rebaseReorderState.test.ts` 继续覆盖 host stale/partial/locked rejection。

### R70-2 — 右击选择一致性

- [x] **已修正。** `selectContextTarget()` 在构造菜单前执行：右击未选行会清空旧 selection 并设置该行 active/single target；右击已选行则保留当前 multi-selection。键盘 ContextMenu/Shift+F10 也走相同选择协调。
- 测试证据：`test/webviewDom.test.ts` 覆盖 Ctrl/Cmd 选择 A+B 后右击未选 C（single menu，旧 selection 清除）、右击已选 A（保留 A+B batch menu）、单项动作 disabled 状态，以及空白区域 contextmenu 清选。

### R70-3 — stage/restore mutation 分类与 paused 策略

- [x] **已修正。** `src/ui/webviewProtocolState.ts` 将 `stageFile`、`restoreFile` 明确归类为 `mutation`；webview source 也标为 `webview:worktree-mutation`。因此它们先经过 `RebaseViewProvider.onMessage()` 的 `busy` 串行化，而非作为 read/ui 并发穿透。
- [x] **已修正。** `allowedPausedRebaseMutation()` 明确允许 edit stop 的 `stageFile`/`restoreFile`；`mutationGateDecision()` 被 host busy 和 paused 路径共同调用。该策略保留已声明的 edit-stop SCM 能力，同时非 allow-list history-write（例如 reorder）仍在 paused rebase 被阻止。
- 测试证据：`test/webviewProtocolState.test.ts` 断言分类和 paused allow-list；`test/mutationGate.test.ts` 断言 stage/restore 在 paused 下可处理但 busy 时返回 serialized/busy，unsafe reorder 被阻止；refresh/scroll/pointer/selection/composition/toast/open Diff 保持非 warning 流量。

### R70-4 — 只读非 untitled generated Diff

- [x] **已修正。** 新增 `GeneratedDiffProvider`，并在 `src/extension.ts` 注册扩展私有 `git-rebase-visual-generated-diff:` `TextDocumentContentProvider`。`generateCommitDiffDocument()` 不再调用 `openTextDocument({ content })`；它打开 opaque virtual snapshot URI，因此不是 `untitled:`，由 provider 提供只读内容。
- [x] **已修正。** `GeneratedDiffSnapshotStore` 使用不含 repository/ref/path/Git 参数的 opaque token，具备 repository invalidation、TTL、LRU 和 dispose cleanup。生成时 string 被冻结；后续 Git refresh 不会重算或改变已打开快照。
- 测试证据：`test/generatedDiffState.test.ts` 断言 URI scheme 非 `untitled`、snapshot、stale/short/duplicate selection 与 stale revision rejection、binary/truncation 注记；`test/generatedDiffDocument.test.ts` 断言 snapshot 冻结、opaque store 的 repository scope/TTL/LRU/cleanup。

### R70-5 — 连续区间生成 Diff

- [x] **已修正。** 多选 `generatedDiffCommits()` 仅接受完整当前 hash 构成的无空洞连续区间，并始终返回 oldest-first canonical order；single selection 仍可用。无序 payload 会规范为 timeline 顺序，gapped/stale/unknown/duplicate payload 在任何 `git show` 或文档打开前被 host 拒绝。
- [x] **已修正。** `media/main.js` 对非连续多选禁用“生成 Diff…”，并给出“仅支持连续 commit”的原因。连续 output 显示首末 commit 的明确范围标题，不再将离散 patch 串接伪装为 range Diff。
- 测试证据：`test/generatedDiffState.test.ts` 覆盖 single、连续两项、无序连续 payload、gapped 1/3 拒绝、stale/unknown/duplicate 和 revision 变化；`test/webviewDom.test.ts` 实际执行菜单 handler，断言非连续 batch 的按钮 disabled 且不会发送 `bulkGenerateDiff`，连续 batch 保留精确 payload。

### R70-6 — LLM forbidden-port flaky

- [x] **已修正。** `test/llmClient.test.ts` 的共享 `withServer()` 改用 `listenOnFetchSafePort()`：仍可请求系统 ephemeral port，但每次在将 URL 交给 Undici 前检查 Fetch forbidden-port set；若命中则 close 并重试。六个共享 LLM client 测试均使用此 helper。
- [x] **已加入回归。** `isFetchSafeTestPort()` 明确拒绝 `6667`、`10080` 等禁用端口，并在测试中断言；deadline case 因此不可能在 HTTP 请求前以 `fetch failed: bad port` 失败。
- 测试证据：最终完整 `npm test` 为 119/119 通过；`npx tsx --test test/llmClient.test.ts` 连续 8 次均 7/7 通过。

### R70-7 / R70-8 后续项

- [x] **R70-7 已修正实现。** `authorLabel()` 对任一同 initial 的可见作者按身份生成最短唯一文本前缀（不少于两个字符），不再依赖 palette key；forced-colors 将 palette 折叠为同色时，dot 内仍提供文本区分。`test/webviewDom.test.ts` 覆盖不同 palette key 的同 initial author labels。High Contrast Dark/Light 和屏幕阅读器的真实 VS Code 人工验收仍待发布前完成，不能由 Node 测试替代。
- [x] **R70-8 对 P1 所需部分已落实。** 为 R70-1/R70-2/R70-5 加入实际 jsdom webview handler regression；为 R70-3 加入 host gate/protocol regression；为 R70-4 加入 generated-Diff URI/snapshot/selection regression。更广泛的 webview end-to-end harness 仍可作为 P2 演进项，但不是本次 P1 闭环的未覆盖理由。

### 最终验证

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 119/119 通过，约 377 秒 |
| `npm run compile` | 通过 |
| `git diff --check` | 通过，无空白错误 |
| `node --check media/main.js` | 通过 |
| `npx tsx --test test/llmClient.test.ts` 连续 8 次 | 每次 7/7 通过 |

尚待独立 reviewer 对修正提交、该回复和真实 VS Code 人工验收边界进行二次复核。
