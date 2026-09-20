# Git Rebase Visual — v0.7.2 最终独立代码评审报告

> **命名说明**：`code-review-0-7-2.md` 已作为未发布 v0.7.1 的历史内部审查轮次保留，不能覆盖或重写。本文件是 v0.7.2 候选的独立最终评审记录。
>
> **评审基线**：已发布 v0.7.1 `4a1e2088ee5c83202eab9e17ad83f5372dbf21e3`。
>
> **评审候选**：`a3a21a61611c54cce08e6d96deb24819acda066c` — `fix: hide batch drop for locked selections`。
>
> **覆盖范围**：`4a1e2088ee5c83202eab9e17ad83f5372dbf21e3..a3a21a61611c54cce08e6d96deb24819acda066c` 的 9 个提交；完整 SHA 见第 2 节及评审台账。
>
> **参考输入**：`pic_ref/review6/右键直接显示在编辑区.png`。该图展示的是本版本明确要移除的旧 editor-area Inspector/Tab 行为，不能作为目标交互。
>
> **发布规则**：P0/P1 为发布阻断项；P2 必须记录但不阻断发布。

---

## 1. 裁决

- [x] 已独立检查候选的 active UI route、命令入口、宿主侧验证、拖拽 intent、未跟踪文件删除保护、原生菜单声明、回归测试和打包排除规则。
- [x] **未发现已确认的 P0。**
- [ ] **发现 1 项 P1：当前用户文档仍把已移除的 editor-area Commit Inspector 作为现行行为。** 因此候选尚不满足“无 P0/P1 才可发布”的门槛，**不得进入 v0.7.2 发布流程**。
- [ ] 真实 Extension Development Host 的原生浮层交互验收尚未执行；作为 P2 人工验收边界记录于第 6 节，不得被表述为已完成。

---

## 2. 本次独立覆盖的提交

| SHA | 说明 |
| --- | --- |
| `4482e4ebfd07f1831c39472d4ea53e5e95e7fb8c` | `feat: use native commit context UI` |
| `50d96d3ad55b4bde5651f114ce72ad80f7ba7aef` | `fix: restore native tree action parity` |
| `b047cf80420e9b1dbc128ec0ce3e6f3afb9ee4e3` | `test: cover native tree drag intent` |
| `89791fe901af227748c690f1ae73075f3f808504` | `fix: retain locked batch native actions` |
| `c108037cadf40182c8af9e37c50f969a12f582c5` | `fix: retain native read actions for locks` |
| `60571fbb26fb06731db427e17ad0b0a79e5d517e` | `fix: complete native tree P1 remediation` |
| `0861c9b1ec2dc0fa7033e3eab0dc8ec5b4636abc` | `fix: preserve locked batch restrictions` |
| `d131d4052b4b97c682186ee3f6ac7aec793de027` | `fix: derive working AI pause policy from Git state` |
| `a3a21a61611c54cce08e6d96deb24819acda066c` | `fix: hide batch drop for locked selections` |

---

## 3. v0.7.2 需求复核

| 需求 | 独立结论 | 证据 |
| --- | --- | --- |
| Commit hover 与右键必须是可越过 sidebar 边界的原生 Workbench UI，不能打开 Inspector Tab | [x] active commit route 已迁移到 `vscode.window.createTreeView`；commit item 提供 native tooltip/context value，且无默认 row command，因此普通点击与 Ctrl/Cmd 多选不会打开 editor tab。旧 `CommitInspectorPanel` 未被 active provider/activation route 实例化。 | `src/ui/rebaseViewProvider.ts`、`src/ui/nativeCommitTree.ts`、`src/extension.ts`、`package.json`、`test/nativeCommitTree.test.ts`、`test/nativeManifest.test.ts` |
| 原生菜单必须由宿主验证，不能信任 command/menu 可见性 | [x] native command 先翻译为既有 intent，再进入 host mutation gate、canonical revision、selection/contiguity、lock、paused-rebase 和 Git 状态检查路径。 | `src/ui/nativeCommandIntent.ts`、`src/ui/rebaseViewProvider.ts`、`test/nativeCommandIntent.test.ts` |
| 删除 worktree 区重复的“仅生成 message、不提交”入口，但保留生成草稿能力 | [x] 活跃 native working section 只保留工作区 AI compose 路由；正常状态可生成后应用，rebase paused 时强制 draft-only，且未配置 LLM 或存在 conflict 时由 host 拒绝无效操作。 | `src/ui/rebaseViewProvider.ts`、`src/ui/composePolicy.ts`、`test/composePolicy.test.ts`、`media/main.js` |
| 点击未跟踪文件的 x 必须删除而非 restore；必须 modal 确认、确认后重新读取 porcelain，且仅仍为未暂存未跟踪时删除 | [x] untracked item 使用独立 delete context/command；删除前后均 fresh-read `getWorktreeChanges`，验证 `!staged && unstaged && worktreeKind === "untracked"`，modal 取消不删除，helper 还拒绝 repository root 外路径。 | `src/ui/nativeCommitTree.ts`、`src/ui/rebaseViewProvider.ts`、`src/git/worktreeChanges.ts`、`test/worktreeChanges.integration.test.ts` |
| 拖拽反馈不得插入 normal-flow row 推动 commit 列表，且可放到 latest/最后边界 | [x] native TreeView DnD 不在拖拽时改变 provider rows；`target === undefined` 以真实末项为 `after` anchor 构造完整 canonical intent。source/anchor lock、revision 和 complete order 仍经 host 复验。 | `src/ui/rebasePointerDragState.ts`、`src/ui/rebaseViewProvider.ts`、`test/rebasePointerDragState.test.ts` |
| 锁定摘要冒号后必须有空格，并在 active native TreeView 生效 | [x] native locked-run label 为精确格式 `🔒 : <count> lock · no push …`，不是仅修复旧 webview。 | `src/ui/nativeCommitTree.ts`、`test/nativeCommitTree.test.ts` |
| locked/batch 菜单权限不能回退 | [x] 只读 action 保留于 locked/batch contexts；rewrite action 不向 locked context 暴露；含 locked selection 的 batch Drop 不暴露，host lock 校验仍作为第二防线。 | `package.json`、`src/ui/nativeCommandIntent.ts`、`test/nativeManifest.test.ts` |
| Git 控制的 metadata 不能成为 trusted Markdown | [x] native tooltip 对 subject/hash/author/date/stat/message 使用 `MarkdownString.appendText()`，并设为 `isTrusted = false`。 | `src/ui/nativeCommitTree.ts`、`test/nativeCommitTree.test.ts` |

---

## 4. Finding

### V072-F1 — P1：README 与当前架构总结仍承诺已移除的 editor-area Inspector

- [ ] **待实现方修正；发布阻断。**

**位置**：

- `README.md:30-34`
- `docs/summary/summary.md:3,37,95`

**问题**：候选的 active commit UI 已改为 native TreeView 的 tooltip 与 `view/item/context` 菜单；它不再创建 `Git Rebase · Commit` editor tab，也不应把 hover/右键详情实现为 editor-area WebviewPanel。然而 README 仍声明 hover 在约 0.4 秒后显示于相邻 editor-area **Git Rebase · Commit** 面板，右键和 `Shift+F10` 也会在该面板打开操作；当前架构总结同样把 `CommitInspectorPanel` 和 editor-area Inspector 列为现行架构。

这不是仅限历史文档的记录：README 和 summary 对当前安装版本作出了与实现及 v0.7.2 明确需求相反的用户承诺。用户会预期/寻找会创建或切换 editor tab 的 Inspector，且文档会掩盖 native migration 的关键安全、选择和交互语义。

**修正要求**：

1. 更新 `README.md` 的 hover/context 说明：明确 commit hover 使用 VS Code 原生 tooltip，右键/`Shift+F10` 使用 VS Code 原生 context menu；不要承诺 0.4 秒 Inspector、右侧阅读面板、因 TextEditor click 关闭 Inspector 或任何 `Git Rebase · Commit` tab。
2. 更新 `docs/summary/summary.md` 的当前基线、核心功能和模块图：改为 active native TreeView / native tooltip / native context menu / host-validated command 与 native DnD；不要再将 `commitInspectorPanel.ts` 列为 active route。若保留该文件的历史兼容信息，须明确它不服务于当前 commit sidebar。
3. 在发布准备时**新增** `docs/release-notes/0.7.2.md` 并向 `RELEASE.md` 增加 v0.7.2 条目，准确描述 native migration、安全 untracked delete、末端拖放与 locked summary 格式修正。不得改写 0.7.1 的历史 release note/记录，因为该条目如实描述了当时的 Inspector 行为。
4. 实现方须以新的整改 commit 提交上述修改；随后由非实现者按新的完整 SHA 复核。本报告和历史报告不得被实施方重写。

**失败场景**：用户安装 v0.7.2 后按 README 将鼠标悬停或右击 commit，期待 editor-area `Git Rebase · Commit` tab；实际看到 native tooltip/menu 且没有 tab。用户无法从文档得知这正是 v0.7.2 的目标设计，误判扩展失效或功能回退。

---

## 5. 自动化与静态验证证据

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | **146 passed, 0 failed**（约 401.8 秒） |
| `npm run compile` | 通过 |
| `node --check dist/extension.js` | 通过 |
| `git diff --check 4a1e208..a3a21a6` | 通过 |
| `git diff --exit-code -- dist/extension.js` | 通过：编译产物与候选一致 |
| candidate worktree status | 开始及验证后均 clean；本报告/台账写入前无实现代码或测试改动 |

---

## 6. P2：发布前真实 VS Code 人工验收边界

Node/假 VS Code harness、静态 source review 与真实 Git 临时仓库测试不能替代真正的 Workbench surface 验收。修复 V072-F1 并经独立复核后，发布前仍应在 Extension Development Host 中记录以下结果：

- [ ] 从 sidebar 最右侧 commit 打开原生 context menu，确认其按 pointer 锚定、可以覆盖 editor 区、click-outside 与 `Esc` 都会关闭，且未创建/切换 editor tab。
- [ ] hover tooltip 为 Workbench 原生浮层；普通单击与 Ctrl/Cmd 多选均不打开 Inspector tab。
- [ ] 拖动到时间线最末/最新位置，确认不产生 normal-flow 提示行或列表位移。
- [ ] 对仍未跟踪的文件点击删除，确认 modal、确认后的删除和 refresh；在确认框停留期间将文件 stage 后，确认删除被拒绝。
- [ ] 检查 locked summary 的可见文本为 `🔒 : <n> lock`，并检查 locked/batch context menu 未暴露重写操作。

这些是待执行验收，不是已知实现缺陷；在未执行前不得将其描述为“已完成真实 VS Code UI 验收”。

---

## 7. 后续与发布结论

1. Agent A 应仅处理 V072-F1 的文档/发布说明整改，并在回复文件中逐项提供修改位置与验证证据。
2. Agent B（或另一位不参与该整改的 reviewer）必须针对整改后的**新完整 SHA**重新审查；`a3a21…` 的本报告不能替代对后续 commit 的独立评审。
3. 仅当 V072-F1 已修正、复审确认无 P0/P1，并完成 release gate 后，才可请求/使用新的 outward-facing tag、push 与 release 授权。
4. 当前结论：**v0.7.2 不批准发布。**
