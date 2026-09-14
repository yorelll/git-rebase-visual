## 0-7-8 回复（对应 `code-review-0-7-8.md`）

### 内部整改说明与决定

- 本文件对应主 agent 即将归档的内部补充报告 `code-review-0-7-8.md`；它是未发布 **0.7.1** 开发过程的整改轮次，不代表 v0.7.8，不创建或授权任何 0.7.8 release。
- 评审基线：已发布 v0.7.0 `e96f60f5af700c3733ee84f38f1b1391261795e0`；此前 review5 功能实现及 inspector remediation 见前序内部回复。
- 本回复仅处理 command Refresh feedback、单文件删除确认后重验及 preview 文案准确性；未修改任何 B 报告或 review ledger。
- 决定：三项均已修正，整改提交仍须后续独立 review 覆盖。

### R78-1 — title/command Refresh 没有“已刷新” inline feedback

- [x] **已修正。**
- 根因：`gitRebaseVisual.refresh` command 直接调用 `provider.refresh()`，绕过 webview `refresh` case 的 inline toast。
- 实现：新增 public `refreshFromCommand()`，command 注册改为调用该入口；成功 refresh 后使用既有 branch-context inline toast 显示“已刷新”。抽出 `refreshFeedbackPolicy`，command/webview 为可见反馈，poll/ready 保持 quiet。
- 回归：`test/refreshFeedbackPolicy.test.ts` 覆盖 command/webview 有反馈、poll/ready 无反馈。

### R78-2 — 单文件 untracked 删除确认后缺少 fresh porcelain 重验

- [x] **已修正。**
- 实现：host modal confirmation 后再次调用 `getWorktreeChanges()`；只有 path 仍是 unstaged、非-staged 的 untracked entry 才执行 `fs.rm`。确认期间被 `git add` 或变为其他状态时明确拒绝，不删除文件。
- 回归：真实 Git integration test 先读取 untracked snapshot，再在模拟确认间隙 stage 文件，断言删除 helper 拒绝且文件保留；恢复为 untracked 后才可删除。

### R78-3 — preview 文案仍声称 mouseleave 自动关闭

- [x] **已修正。**
- 实现：preview text 改为说明可在右侧阅读/复制，直到下一条 preview/操作或 editor switch 更新；与 persistent cross-pane preview 的实际语义一致。

### 验证

| 命令 | 结果 |
| --- | --- |
| focused refresh/delete/preview + adapter + DOM + protocol + lifecycle + real Git tests | **26/26 通过**。 |
| `npm run typecheck` | 通过。 |
| `npm test` | **131/131 通过**（约 382 秒）。 |
| `npm run compile` | 通过。 |
| `node --check media/main.js` / `git diff --check` | 通过。 |

### 人工验收边界

- [ ] 点击 title/tool bar/command Refresh，确认 branch header 显示“已刷新”；自动 poll、初始加载不显示噪声 toast。
- [ ] untracked delete confirmation 打开后，在终端或 SCM 改变文件状态，确认 host 拒绝删除；重新打开后仍为 untracked 才可删除。
- [ ] preview/inspector lifecycle、IME、pointer/触控、SCM bulk action、High Contrast 与 screen reader 全量验收。
