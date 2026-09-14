# Git Rebase Visual — 最终补充独立代码评审报告（0.7.3）

> **内部审查轮次说明**：本文档名中的 `0.7.3` 是未发布 **0.7.1** 开发过程的第三轮独立审查编号，**不代表 v0.7.3，也不创建或授权任何 0.7.3 release**。0.7.1 的最终版本报告和发布记录由主 agent 汇总。
>
> **评审基线**：已发布 v0.7.0 `e96f60f5af700c3733ee84f38f1b1391261795e0`。
>
> **前序报告 / 回复**：[`code-review-0-7-1.md`](code-review-0-7-1.md)、[`code-review-0-7-2.md`](code-review-0-7-2.md)、[`review-response-0-7-1.md`](review-response-0-7-1.md)、[`review-response-0-7-2.md`](review-response-0-7-2.md)。
>
> **本次独立复核提交**：`3a247aae223786ea67f72c39e7865eb5e50ce870` — `test: cover commit inspector adapter lifecycle`。
>
> **输入**：review5 全部九张截图、R71-1/R72-1 报告与整改回复、adapter test source、`CommitInspectorPanel` lifecycle source、完整测试结果。
>
> **结论**：R72-1 已修正。新的 fake VS Code `WebviewPanel`/`Webview` harness 实例化**实际** `CommitInspectorPanel`，并执行实际的 `open()`、host `close()`、native `onDidDispose`、延迟旧 callback、reopen、message routing 和 extension `dispose()` adapter 路径。未发现新的 P0/P1/P2 代码问题。0.7.1 自动化审查闭环通过；真实 VS Code 的 UI/accessibility 验收仍不能由 fake adapter 替代。

---

## 1. 发布裁决

- [x] **R71-1 P1 与 R72-1 P2 已修正并独立复核。** Commit Inspector 的 close → reopen lifecycle 与 listener cleanup 获得 concrete adapter regression 覆盖。
- [x] **未发现 P0/P1/P2。**
- [ ] **发布前人工验收仍必需。** 真实 VS Code 中连续 inspector close/reopen、多个 editor group/隐藏显示/reload、IME、pointer/触控 drag、SCM bulk confirmation/staged AI、High Contrast 与 screen reader。

---

## 2. R72-1 复核

### R72-1 — P2：CommitInspectorPanel 缺少真实 adapter lifecycle regression

- [x] **已修正。**

**前序缺口**：`PanelLifecycle` 的 pure test 证明了 lease ownership，但不直接执行 `CommitInspectorPanel` 的 `WebviewPanel.onDidDispose` listener、per-panel subscription map、`close()` 和 `open()` adapter wiring。

**整改实现**：新增 `test/commitInspectorPanel.test.ts`。测试通过局部 module loader hook 仅替换运行时 `vscode` import，提供最小行为等价的 fake `WebviewPanel`/`Webview`：`createWebviewPanel`、`webview.postMessage`、`webview.onDidReceiveMessage`、`panel.onDidDispose`、`panel.dispose`。随后加载真实 `CommitInspectorPanel` 代码，而非复制 lifecycle 逻辑。

**实际覆盖的行为**：

```text
open(first)
→ inspector.close()
→ first panel dispose / native onDidDispose / listener cleanup
→ open(second) creates a new panel
→ delayed old native dispose callback fires
→ second remains current and receives exactly one show payload
→ current message action invokes host callback once
→ close(second) cleans listeners
→ open(third) creates another panel
→ extension dispose cleans third listeners
```

**验证结论**：

- 每次 close 后的 right-click/open 创建新的 panel；不存在 disposed panel reuse。
- 延迟 old dispose callback 不会清空 successor。
- 每个 active panel 恰有一个 message listener 和一个 dispose listener；close/extension dispose 后均为零，无 listener accumulation。
- `postMessage(show)` 只发送到当前 panel；inspector action message 仅回调一次。
- fake 不绕过被审 adapter：它只模拟 VS Code 公共 API 返回对象，其 listener 注册、disposal、ownership、map cleanup 和 message routing 都由真实 `CommitInspectorPanel` 执行。

---

## 3. review5 最终自动化状态

| 需求 | 复核结论 |
| --- | --- |
| 1. routine refresh 拖拽不 false stale，仍保持真实 stale 防线 | [x] 无回退：canonical snapshot 只在可操作 timeline 改变时增加 revision，host 仍在确认前后验证。 |
| 2. 移除顶部重复 batch actions | [x] 无回退。 |
| 3. editor-area click 关闭并可后续重开 context surface | [x] public editor/window bridge + inspector adapter lifecycle 已覆盖；真实 VS Code 交互仍需人工走查。 |
| 4–8. SCM 路径/hover overlay/row Diff/restore-delete/header bulk/staged AI | [x] 无回退；DOM、protocol/mutation gate 与真实 Git tests 通过。 |
| 9. Refresh inline feedback | [x] 无回退。 |
| 10–11. compact lock summary / expanded rail | [x] 无回退。 |
| 12. edit 排首位 | [x] 无回退。 |
| 13. inspector 不遮挡 timeline、action routing/accessibility | [x] `ViewColumn.Beside` 设计与 adapter lifecycle/单次 routing 均已覆盖；真实 layout/keyboard/reader 仍需人工验收。 |
| 16. Alt+Arrow | [x] 无回退；focused row extension handler 正确，非 webview focus 的 VS Code binding 竞争结论合理。 |

---

## 4. 独立验证证据

已重新查看 review5 全部参考图：`选中多个右键.png`、`文件暂存管理界面.png`、`参考vscode文件暂存管理界面.png`、`vscode工作区1.png`、`vscode工作区2.png`、`长黄线参考1.png`、`message显示界面.png`、`跨界面显示.png`、`vscode快捷键.png`。

| 命令 / 方法 | 结果 |
| --- | --- |
| `git diff 853f26a..3a247aa` + actual adapter/source inspection | 确认整改仅新增 concrete adapter regression、test index import 和 R72 response；未见 lifecycle/protocol/action routing 回退。 |
| `npx tsx --test test/commitInspectorPanel.test.ts` | **1/1 通过**。 |
| `npm run typecheck` | 通过。 |
| `npm test` | **126/126 通过**，约 399 秒。 |
| `npm run compile` | 通过。 |
| `node --check media/main.js` | 通过。 |
| `git diff --check` | 通过。 |

---

## 5. 发布前人工验收边界

- [ ] 连续至少三轮：commit 右击或 Shift+F10 打开 inspector → 点击其他 editor/selection 关闭 → 再打开；检查 action 可用且没有重复 listener 行为。
- [ ] 多 editor group、panel hidden/reveal、extension reload、窄窗口下检查 inspector 不遮挡 timeline 且 lifecycle 正确。
- [ ] 真实中文 IME、pointer/触控 drag、Changes/Staged Changes header action 的 modal/working-index 边界、staged AI message apply。
- [ ] High Contrast Dark/Light 和 screen reader 下检查 compact lock summary、disabled reason、inspector action focus/order。
