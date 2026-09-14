## 0-7-2 回复（对应 `code-review-0-7-2.md`）

### 内部整改说明与决定

- 本文件是未发布 **0.7.1** 开发过程中的内部 R72-1 整改回复；文件名 `0-7-2` 不代表 v0.7.2，不创建或授权任何 0.7.2 release。
- 评审基线：已发布 v0.7.0 `e96f60f5af700c3733ee84f38f1b1391261795e0`；前序 lifecycle 修正为 `853f26ab8b3219a95d5467dd847e0729e847974c`。
- 本回复仅处理 [`code-review-0-7-2.md`](code-review-0-7-2.md) 的 R72-1；未修改任何 B 评审报告或 review ledger。
- 决定：R72-1 的 P2 覆盖缺口已补充。新增整改提交仍须由后续独立 reviewer 复核，才能作为 0.7.1 发布闭环的一部分。

### R72-1 — CommitInspectorPanel 缺少真实 adapter lifecycle regression

- [x] **已修正。**
- 实现：新增 `test/commitInspectorPanel.test.ts`，在 Node 测试中拦截 `vscode` runtime import，提供最小 fake `WebviewPanel` / `Webview` adapter；真实实例化 `CommitInspectorPanel`，执行其实际 `open()`、`close()`、native `onDidDispose()` 和 `onDidReceiveMessage()` wiring。
- 覆盖路径：
  ```text
  open(first)
  → host close / panel.dispose / native dispose
  → open(second)
  → delayed first native dispose callback
  → second remains current and receives exactly one further show payload
  → close(second)
  → open(third)
  → extension dispose
  ```
- 断言：每次 reopen 都新建可用 panel；旧 dispose callback 不清空 successor；每个当前 panel 只有一个 active message listener 和一个 active dispose listener；listener 在 close/dispose 后清理；postMessage 只发送到当前 panel；inspector action message 只回调一次。

### 验证

| 命令 | 结果 |
| --- | --- |
| `npx tsx --test test/commitInspectorPanel.test.ts` | **1/1 通过**。 |
| `npm run typecheck` | 通过。 |
| `npm test` | **126/126 通过**（约 377 秒），包含真实 adapter lifecycle regression。 |
| `npm run compile` | 通过。 |
| `node --check media/main.js` / `git diff --check` | 通过。 |

### 人工验收边界

- [ ] 真实 VS Code 连续验证 inspector：右击或 Shift+F10 打开 → 点击其他编辑器/selection 关闭 → 重开，至少三轮。
- [ ] 多 editor group、panel 隐藏/显示、extension reload 下验证 inspector action 不丢失且无重复 listener。
- [ ] 完成 review5 的 IME、pointer/触控、SCM header action/confirmation/staged AI、High Contrast 与 screen reader 验收。
