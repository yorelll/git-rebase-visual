## 0-7-0 回复（对应 `code-review-0-7-0.md`）

### 基线、范围与最终决定

- 评审基线：已发布 v0.6.3 `f4045ea9163014389ef0406cae4d56bd527d9ddf`。
- 最终候选范围：`499dfc1053f69a392bbf0da72b7fe2df2dab37fc`、`2711b66681ca20e530a94651a1dca702234de12f`、`ee85a85c208a44a491e6b228415362bd45c4025c`、`715234af9794d369fae724620e299a371741dd41`。
- 四个候选**功能实现**提交分别与独立审查中使用的 `40d5dd3`、`ed9c11c`、`147f76b`、`371aafb` 逐字节一致；新的 SHA 仅来自以已发布 `origin/main` 为基线的线性重建。发布准备另包含版本/归档文档、generated-Diff 注释准确性修正和一条 staged-restore 回归断言，均由本次本地门禁与最终独立审查覆盖。
- 内部补充审查轮次原先使用的 0-7-1 / 0-7-2 文件名不代表发布版本。本回复将所有发现、整改和最终独立复核统一归档到 **0-7-0**；不会发布或创建 0.7.1 / 0.7.2 tag。
- 最终决定：所有 P1 发现均已修正并独立复核。自动化审查通过后可准备 0.7.0 发布；真实 VS Code 人工验收和本次实际发布门禁结果仍需在发布前完成并如实记录。

### R70-1 — deferred drag session

- [x] **已修正并独立复核。**
- 实现：pointer/native drop 在应用 deferred state 前，使用 drag start 捕获的 immutable `sourceHash`、`revision` 和完整 `canonicalOrder` 构造 reorder intent；Alt+Arrow 同样使用当前 canonical session。host 的 `validateReorderRequest()` 在确认和 Git 写入前继续复验。
- 测试：`test/webviewDom.test.ts` 覆盖 pointer/native start → deferred changed state → completion，断言发送旧 session payload；`test/rebaseReorderState.test.ts` 覆盖 host stale/partial/locked rejection。

### R70-2 — 右键目标与 selection 一致性

- [x] **已修正并独立复核。**
- 实现：`selectContextTarget()` 统一鼠标和键盘 context menu。右击未选行清空旧多选并将该行作为 single target；右击已选行保留 batch。
- 测试：DOM 回归覆盖 A+B 后右击 C、右击已选 A、空白清选和单项/批量 action payload。

### R70-3 — stage/restore mutation 分类和暂停策略

- [x] **已修正并独立复核。**
- 实现：`stageFile`、`restoreFile` 均为 `mutation`，先经过 host busy serialization；`allowedPausedRebaseMutation()` 明确允许 edit stop 中的文件操作，其他不安全历史写入仍阻止。read/UI/pointer/IME/refresh/Diff 流量维持无 warning。
- 测试：`test/webviewProtocolState.test.ts` 与 `test/mutationGate.test.ts` 覆盖分类、allow-list、busy、unsafe reorder blocked 和非写入流量。

### R70-4 — generated Diff 的只读形态

- [x] **已修正并独立复核。**
- 实现：新增 `GeneratedDiffProvider`、`GeneratedDiffSnapshotStore`，以 `git-rebase-visual-generated-diff:` opaque virtual document 替代 editable `untitled:`。snapshot 在生成时冻结，具有 repository invalidation、TTL、LRU 和 dispose cleanup，URI 不携带 repository/ref/path/Git 参数。
- 测试：`test/generatedDiffDocument.test.ts`、`test/generatedDiffState.test.ts` 验证非 untitled、frozen snapshot、scope、TTL/LRU/cleanup、stale selection 和输出边界。

### R70-5 — 连续多选 generated Diff

- [x] **已修正并独立复核。**
- 实现：多选仅接受 canonical timeline 的无空洞连续区间，并按 oldest-first 输出；非连续菜单 disabled 且给出原因。host 在 Git read/document opening 前拒绝 gapped、unknown、duplicate、stale 或 revision 不匹配的请求。
- 测试：generated-Diff 和 DOM tests 覆盖 single、连续两项/多项、无序连续 payload、1/3 空洞、unknown/duplicate/stale、disabled action 和无 postMessage。

### R70-6 / R71-1 / R72-1 — Fetch forbidden-port LLM test flaky

- [x] **已修正，并经过后续两轮独立复核。**
- 实现：shared LLM test listener 使用 Fetch Standard 完整 83 项 bad-port table，包含 `0`、`5060`、`5061`、`6000`、`6667`、`10080`，移除非标准 `4333`。listener 每次系统分配端口后 inspect；命中禁用端口时 close 后 retry；`withServer()` 使用 `try/finally` 清理。
- 测试：完整 table exact equality 和逐端口 predicate；真实 `http.Server` 断言首个模拟 6000 listener 关闭后才能 second listen；`test/llmClient.test.ts` 多轮 8/8 通过，覆盖 deadline、cancellation、SSE 与资源清理。

### R70-7 — 作者标识 High Contrast collision

- [x] **实现已修正；人工主题/屏幕阅读器验收待执行。**
- 实现：可见列表中同 initial 的不同 author identity 使用最短唯一文字前缀，不再依赖 palette key；forced-colors 下亦保留文本区分。
- 自动测试：`test/webviewDom.test.ts` 覆盖不同 palette 的同 initial label。
- [ ] **人工验收尚未执行。** 原因：Node/jsdom 无法启动真实 VS Code 的 High Contrast Dark/Light 或 screen reader；这不是拒绝修复，而是必须在发布前完成的运行时验证边界。

### R70-8 — 真实 webview 事件路径覆盖

- [x] **P1 所需覆盖已补齐。** `media/main.js` 的关键 DOM handler 由 jsdom 执行；generated Diff 与 mutation gate 由 host/provider 回归覆盖。更广泛的 VS Code E2E harness 作为后续 P2 质量演进，不构成本版本 P1 未闭环。

### 最终自动验证

| 命令 / 方法 | 结果 |
| --- | --- |
| `git diff --quiet 40d5dd3..499dfc1` | 无差异。 |
| `git diff --quiet ed9c11c..2711b66` | 无差异。 |
| `git diff --quiet 147f76b..ee85a85` | 无差异。 |
| `git diff --quiet 371aafb..715234a` | 无差异。 |
| 历史独立审查：`npm run typecheck` | 通过。 |
| 历史独立审查：`npm test` | **120/120 通过**。 |
| 历史独立审查：`npm run compile` | 通过。 |
| 历史独立审查：`node --check media/main.js` | 通过。 |
| 历史独立审查：`git diff --check` | 通过，无空白错误。 |
| 历史独立审查：`npx tsx --test test/llmClient.test.ts` 连续运行 | 每轮 **8/8 通过**。 |
| 本次发布准备：`npm run typecheck`、`git diff --check` | 通过。 |
| 本次发布准备：`npx tsx --test test/worktreeChanges.integration.test.ts` | **4/4 通过**；补强验证 staged restore 不会覆盖仍存在的 working-side 内容。 |
| 本次发布准备：`npm ci` | 通过；按当前 lockfile 重新安装 326 个依赖。 |
| 本次发布准备：`npm run test:release && npm run package` | 已通过：类型检查、**120/120** 覆盖率测试（约 406 秒）、编译和 VSIX 打包；本轮已包含 staged-restore 补强断言。 |

### 发布前人工验收

- [ ] 中文 IME scoped search 和键盘重排抑制。
- [ ] 鼠标、触控板、触笔 pointer/native drag 与 confirmation。
- [ ] staged/working/delete/rename/untracked 的 stage/restore/左右 Diff。
- [ ] 编辑器区域关闭菜单且不产生 paused warning。
- [ ] High Contrast Dark/Light 与 screen reader。
- [ ] binary/超大连续 generated Diff 的截断说明和只读状态。

上述项目尚未由自动测试替代；完成前不应将其标为已验证。