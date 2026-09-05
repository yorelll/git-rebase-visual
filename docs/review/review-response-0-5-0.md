# Git Rebase Visual — 评审回复（0-5-0）

> 对应评审报告：[`code-review-0-5-0.md`](code-review-0-5-0.md)
>
> 评审基线：`v0.4.0` tag（`a467e58`）之后的 UI 改进与安全修正迭代。

---

## 0-5-0 回复（对应 `code-review-0-5-0.md`）

**处理流程：**

1. Agent A 基于 `pic_ref/` 的六张截图、现有 UI 实现和用户建议做独立 UI/UX 评审；
2. Agent B 汇总用户建议和 A 的结论，生成 [`../ui-reivew/ui-review-0-5-0.md`](../ui-reivew/ui-review-0-5-0.md)，实施确认存在且低风险的项；
3. Agent C 独立代码审查并修复 append Abort 双恢复、rebase edit stop 判定等安全问题；
4. 主 agent 复核后，补修普通 reword 暂停时错误发送 `applySucceeded`、关闭并丢失 Compose 输入的协议漏洞。

### 已修复项

- [x] **locked commit 的 Drop 一致性**

  Drop 在菜单层、消息处理层和 `runRebase()` 层均复查 lock。目标被锁定时要求先显式解锁；Drop rebase 暂停、失败或 Abort 时不再删除锁。

  **证据：**`test/rebaseSafety.integration.test.ts` 真实 Git 冲突/Abort 流程验证锁保留。

- [x] **冲突 Continue 的可见反馈和防御式检查**

  新增 `rebaseState.ts` 派生 `conflictFiles` / `conflictCount` / `pausedReason`；未解决冲突时客户端禁用 Continue、宿主处理前再次查询冲突；Git 继续失败时显示返回错误。

  **证据：**`test/rebasePauseState.test.ts` 与 `test/rebaseSafety.integration.test.ts`。

- [x] **append replay conflict → Abort 的重复 stash 恢复**

  Abort 时完整 snapshot 已恢复 staged、unstaged 与 untracked；因此不再 pop keep-index subset stash，而是清理两条 recovery stash 和 pending 记录，避免重复应用、冲突和残留状态。

  **证据：**Agent C 审查修正 `00023b9`；真实 Git 安全流程测试随本轮通过。

- [x] **rebase conflict 被错误显示为 edit stop**

  不再仅凭 `stopped-sha` 推断 edit；新增 `rebaseAtEditStop()` 识别真正的 interactive todo edit action，冲突优先显示为 conflict。

  **证据：**`test/rebasePauseState.test.ts`、`test/rebaseSafety.integration.test.ts`。

- [x] **Compose Apply 失败保留用户输入**

  Webview 使用 `applySucceeded` / `applyFailed` 协议。Apply pending 时保留 dialog 和文本；成功才关闭；失败时恢复按钮、焦点并显示 dialog 内错误。普通 reword 在 rebase 暂停/失败时也会走 `applyFailed`，不再误报成功。

  **证据：**`src/ui/rebaseViewProvider.ts` outcome 检查、`media/main.js` dialog 状态机、`npm run typecheck` 与 `npm test`。

- [x] **方向、菜单、列表与最低无障碍基线**

  保持 oldest-first（与 Git rebase todo 一致），新增 Base/HEAD 和较早/较新方向提示、grip、拖放确认；列表改为 subject 主行和 metadata 次行；菜单增加目标 header、风险分组、危险 Drop 尾置和 locked append 禁用原因；加入 `lang="zh-CN"`、ARIA、Escape、Menu 键和 Ctrl/Cmd+Enter。

  **证据：**[`../ui-reivew/ui-review-0-5-0.md`](../ui-reivew/ui-review-0-5-0.md)。

- [x] **改写结果与工作区范围可见化**

  成功历史改写记录 operation / old tip / new tip / affected count 到 Output 与通知；workingStatus 传递 staged/unstaged 文件数，工作区提交明确提示会执行 `git add -A`；未配置 LLM 时保留设置入口。

### 明确延后项

- [ ] **不直接实现 ORIG_HEAD 一键 Undo。**

  **原因：**ORIG_HEAD 可被其它 Git 操作覆盖；`reset --hard` 可能覆盖用户在重写后新增的工作。安全 Undo 需要扩展私有 ref、事务持久化、expected tip 检查、干净工作区检查及完整 Git 集成测试。

- [ ] **不实现 Skip、squash/fixup、完整键盘重排、默认 newest-first、Compose Panel 迁移、精确 rebase N/M 进度和状态栏常驻。**

  **原因：**这些会扩大 Git 事务、冲突、stash/append 恢复、消息协议或可访问性交互的测试矩阵。当前版本优先修复已有操作的安全性和反馈边界。

- [ ] **不以“hover layout shift”名义修改 tooltip。**

  **事实纠正：**当前 tooltip 已使用 `position: fixed`，不在文档流中，不会推开下方 commit；截图中的该项判断不成立。

### 最终验证

```bash
npm run typecheck   # 通过
npm test            # 48 / 48 通过
npm run compile     # 通过
git diff --check    # 通过
```

**最终结论：**`code-review-0-5-0.md` 中确认的问题已按安全边界修复；暂缓项均有明确原因。可进入 0.5.0 发布。