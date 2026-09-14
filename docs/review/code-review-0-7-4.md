# Git Rebase Visual — 最终发布代码评审报告（0.7.1）

> **发布版本说明**：本文是 v0.7.1 的最终版本化评审记录。此前的 `code-review-0-7-1.md`、`code-review-0-7-2.md`、`code-review-0-7-3.md` 是同一未发布候选的内部独立审查轮次，保留为原始证据，不代表发布版本 v0.7.2 / v0.7.3。
>
> **评审基线**：已发布 v0.7.0 `e96f60f5af700c3733ee84f38f1b1391261795e0`。
>
> **本次覆盖提交**：`c3371b48f744053cc3b1b4edcea0f94ca123d295`、`75298342a71728db99d18bf4cf40333121d2f3a2`、`e2a3875664f59f66188f2759faa41a38a901b800`、`67352fc8425082fdf67f0bee16e32051824faf4a`、`348e84e5a385cb82b5cea2d7f77226aa46051609`、`a7626f652294ab2d46257f3b02feabdfec835f96`。
>
> **已继承的独立审查覆盖**：`8a61f65`、`853f26`、`3a247aa` 分别由 `code-review-0-7-1.md`、`code-review-0-7-2.md`、`code-review-0-7-3.md` 覆盖。
>
> **P2 发布政策**：按项目发布决策，P0/P1 为发布阻断项；P2 如存在须记录，但不阻断发布。

## 1. 发布裁决

- [x] 已完成 v0.7.1 review5 实现、内部独立审查和整改闭环。
- [x] 内部审查发现的 R71-1（P1 inspector lifecycle）与 R72-1（P2 adapter regression coverage）均已修正并保留原始报告与回复。
- [x] 发布候选未保留已知 P0/P1；无新增已确认 P2。
- [x] v0.7.1 可以进入打包、tag 与 GitHub Release 流程。

## 2. 最终整改覆盖

| 内部问题 / 需求 | 最终结论 | 依据 |
| --- | --- | --- |
| R71-1：inspector close 后无法可靠重开（P1） | [x] 已修正 | panel lease 与 per-panel listener ownership；adapter lifecycle regression 覆盖 close/reopen、old dispose callback 和 extension dispose。 |
| R72-1：缺少真实 adapter lifecycle regression（P2） | [x] 已修正 | fake `WebviewPanel`/`Webview` 实例化真实 `CommitInspectorPanel`，不只测试抽象 helper。 |
| inspector 创建即因焦点桥接关闭 | [x] 已修正 | `ViewColumn.Beside + preserveFocus: true`，保持已有 editor focus。 |
| hover detail 未真正跨界面显示 | [x] 已修正 | preview 打开无 action 的 editor-area inspector payload。 |
| hover/action 异步竞态 | [x] 已修正 | `InspectorPreviewCoordinator` 以 session ownership 阻止慢 preview/旧 dismiss 覆盖 action。 |
| panel focus 导致操作自身关闭 | [x] 已修正 | 仅 concrete TextEditor 活动/selection 变化关闭 inspector。 |
| preview 离开侧栏过早关闭 | [x] 已修正 | 已显示 preview 保持到下一 preview、explicit action 或外部 editor interaction。 |
| command Refresh 无“已刷新” | [x] 已修正 | command 改走 `refreshFromCommand()`；manual source 显示反馈，poll/ready 静默。 |
| untracked 删除确认后状态变化 | [x] 已修正 | confirm 后 fresh porcelain revalidation，非未跟踪状态拒绝删除。 |

## 3. review5 功能结论

- [x] routine refresh 不造成正常 drag false stale，真实 timeline/lock/rebase 变化仍拒绝旧操作；
- [x] 顶部重复 bulk controls 已移除，批量操作转为跨编辑器 inspector；
- [x] 文件行默认展示路径，hover/focus 才展示操作，行点击保留 Diff；
- [x] single restore、untracked delete、section-level stage/discard/unstage、staged AI 都进入 host mutation/revalidation 边界；
- [x] locked summary 紧凑化，展开移除 long rail；
- [x] edit action 排在单项操作第一位；
- [x] Alt+Arrow 的扩展 row-focus 路径正确，系统焦点范围内的 VS Code keybinding 不应被扩展夺取。

## 4. 记录的非阻断人工验收边界

以下是 Node/jsdom/real-Git 自动化不能替代的真实 VS Code 验收，不作为本次已知 P0/P1：多 editor group 与窄窗口的 inspector；中文 IME；pointer/触控/触笔 drag；SCM header modal/staged AI；High Contrast 与 screen reader。详见 [`../ui-reivew/ui-review-0-7-1.md`](../ui-reivew/ui-review-0-7-1.md)。

## 5. 发布回复

最终项目决定、实现和发布门禁见 [`review-response-0-7-4.md`](review-response-0-7-4.md)。
