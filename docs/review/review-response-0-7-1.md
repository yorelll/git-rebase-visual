## 0-7-1 回复（对应 `code-review-0-7-1.md`）

### 基线与结论

- 评审基线：已发布 v0.7.0 `e96f60f5af700c3733ee84f38f1b1391261795e0`。
- 被审实现：`8a61f6549117b9729f2f269ddc173e76bc085512` — `feat: refine review5 rebase interactions`。
- 本回复只处理独立评审报告中的 R71-1；未修改 `code-review-0-7-1.md`。
- 结论：R71-1 已在新的整改提交中修正；整改提交仍须接受后续独立 review，才可解除 0.7.1 发布阻止。

### R71-1 — 关闭 Commit Inspector 后无法可靠重开

- [x] **已修正。**
- 根因：首次实现把 panel-specific 的 `onDidReceiveMessage` / `onDidDispose` listener 放在类级 disposable 列表。第一次 editor-area close 会把自身 dispose listener 一同释放，后续新 panel 的 native dispose 不再清空 panel 指针，导致下一次右键无法可靠新建 inspector，并可能残留 listener。
- 实现：
  - 新增 `src/ui/panelLifecycle.ts`，将当前可复用 panel ownership 建模为 idempotent lease；旧 panel 的延迟 dispose 不能清空其后创建的新 panel。
  - `CommitInspectorPanel` 为每个 native `WebviewPanel` 保存独立 listener 集合，以 lease id 为 key；native `onDidDispose` 只 release 当前 lease 并清理该 panel 的 listener，不再破坏用于后续 reopen 的 class-level 状态。
  - `close()`、extension `dispose()` 与 VS Code 的 native panel dispose 都可安全重复调用。
- 测试：`test/panelLifecycle.test.ts` 覆盖 open → host close → reopen → delayed old dispose → close → reopen；断言每次 `current()` 正确清空/重建，旧 callback 不会清除新 panel。该 pure lifecycle model 与 `CommitInspectorPanel` 一对一使用的 lease 语义相同。

### 验证

| 命令 | 结果 |
| --- | --- |
| `npx tsx --test test/panelLifecycle.test.ts test/webviewDom.test.ts test/worktreeChanges.integration.test.ts test/canonicalSnapshot.test.ts` | 通过。 |
| `npm run typecheck` | 通过。 |
| `npm test` | 已在整改前全量通过 124/124；本整改的完整套件结果须由后续独立 review 如实核验。 |
| `npm run compile` | 通过。 |
| `node --check media/main.js` | 通过。 |
| `git diff --check` | 通过。 |

### 发布前人工验收边界

- [ ] 真实 VS Code 中连续三次执行：commit 右击打开 inspector → 点击其他编辑器/选择变化关闭 → 再右击打开；同时检查 keyboard Context Menu/Shift+F10。
- [ ] 多 editor group、隐藏/显示 panel、extension reload 下检查 panel 不重复、actions 不失效，且点击 editor area 能关闭 sidebar/inspector 操作表面。
- [ ] 继续完成 review5 已记录的 IME、pointer/触控、SCM bulk action、High Contrast 和 screen reader 人工验收。
