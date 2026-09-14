## 0-7-4 回复（对应 `code-review-0-7-4.md`）

### 内部整改说明与决定

- 本文件对应主 agent 即将归档的内部补充报告 `code-review-0-7-4.md`；它是未发布 **0.7.1** 开发过程的整改轮次，不代表 v0.7.4，不创建或授权任何 0.7.4 release。
- 评审基线：已发布 v0.7.0 `e96f60f5af700c3733ee84f38f1b1391261795e0`；此前 inspector lifecycle 与 preserveFocus 整改分别见 `853f26a`、`3a247aa`、`42c4d94`。
- 本回复仅处理主 agent 发现的“hover detail 没有实际跨界面显示”问题；未修改任何 B 报告或 review ledger。
- 决定：已实现非遮挡的 editor-area hover detail preview，并保留右键 action inspector、preserveFocus 与外部 editor click close bridge。整改提交仍须由后续独立 review 覆盖，才能成为 0.7.1 发布闭环的一部分。

### R74-1 — Commit hover detail 没有实际显示到跨界面 inspector

- [x] **已修正。**
- 根因：`openCommitInspector(..., "preview")` 在完成 Git detail 读取后直接 return；因此 hover message/detail 不再遮挡 sidebar，却也没有显示在用户要求的“和 commit message 一样显示在右下”的 editor-area surface。
- 实现：
  - preview 现在真正调用 `CommitInspectorPanel.open()`，使用同一 `ViewColumn.Beside + preserveFocus` inspector，因此 detail/message 显示在 editor area 而不覆盖 commit timeline。
  - inspector preview 标题标为“预览”，只显示作者、时间、统计和完整 message；不显示 mutation/action buttons。右键/Context Menu 仍以 `single`/`batch` payload 打开完整 actions。
  - sidebar hover 保持 400ms 延迟；pointer leave 后发送无副作用 `dismissCommitPreview`，host 以 180ms grace close preview，允许相邻 commit hover 平滑切换。右键/批量 action 或外部 editor interaction 会取消 preview timer，避免误关闭 action inspector。
- 回归：
  - jsdom webview test 断言 `mouseenter` 实际发送 `requestDetail`，`mouseleave` 发送 `dismissCommitPreview`；sidebar 不创建遮挡 menu。
  - concrete fake `CommitInspectorPanel` adapter regression 以 `kind: "preview"` 打开，断言 `postMessage({ type: "show", payload })` 真正把 hover preview 交给 cross-pane inspector，且 preserveFocus 下 panel 不自关闭；后续 host close/reopen/listener boundary 继续覆盖。

### 验证

| 命令 | 结果 |
| --- | --- |
| focused adapter / DOM / lifecycle / protocol / real Git tests | **21/21 通过**。 |
| `npm run typecheck` | 通过。 |
| `npm test` | **126/126 通过**（约 371 秒），包含 hover preview DOM 与 adapter regression。 |
| `npm run compile` | 通过。 |
| `node --check media/main.js` / `git diff --check` | 通过。 |

### 人工验收边界

- [ ] 真实 VS Code 中将指针悬停于 commit 超过 400ms，确认右侧 editor area 显示其完整 message/detail，timeline 不被覆盖；移至相邻 commit 时预览平滑更新，移开后约 180ms 关闭。
- [ ] 右键或 Shift+F10 的 action inspector 在 preview 存在时仍可切换为完整操作面板；点击其他 editor/selection 时关闭，随后可重新打开。
- [ ] 多 editor group、窄窗口、High Contrast、screen reader 与 review5 其他 IME/pointer/SCM 验收。
