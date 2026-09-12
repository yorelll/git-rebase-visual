# Git Rebase Visual UI 实现记录（0.6.3）

## 范围与约束

- 基线：`d0bc968`（v0.6.2）。
- 本次不修改 package version、release 文档、`docs/review/` 或任何 `suggestion*.md`。
- 本文只记录用户提出的需求、已实现事实、自动测试证据和明确的人工验收边界。

## 用户需求与实现

### 搜索语法与中文 IME

- 支持 `author:<text>`、`msg:<text>`、`hash:<prefix>`；`hash:0x...` 会去除 `0x` 后仅以真实 full/short hash 的前缀比较。
- 未知字段（例如 `owner:alice`）按全文检索，不会被误当作字段语法。
- 搜索框在 `compositionstart` / `compositionupdate` 期间不触发列表 render、不替换 input；仅在 `compositionend` 将最终值应用一次。焦点与 selection 仅在最终 render 后恢复。
- UI 保留匹配数和清除按钮。
- 代码：`src/ui/commitSearch.ts`、`media/main.js`。

### 成功通知不推动 commit 列表

- branch context 保持固定 29px 高度；inline success toast 移入 context 内绝对覆盖，未在 context/list 上方插入新的文档流节点。
- toast 超时后仅隐藏覆盖层，底层 branch / upstream / ahead / behind / range 文本仍保留。
- warning/error 仍是 VS Code 系统通知；已有长操作继续使用 Source Control progress。
- 代码：`src/ui/inlineToastState.ts`、`src/ui/rebaseViewProvider.ts`、`media/main.js`、`media/style.css`。

### 更多提交选项中的文件、单文件暂存和 Diff

- 通过 `git status --porcelain=v2 -z --untracked-files=all` 解析变更，绝不按行拆分路径；显示 Staged Changes / Changes、Modify/Add/Delete/Rename/Untracked/Conflict 和 staged+unstaged 同文件的两个状态侧。
- “更多提交选项”与 rebase edit stop 都显示文件清单；edit stop 中每个 working/untracked 条目可单独暂存，随后可走已有 Amend / 新建 commit guard。
- 单文件暂存调用 spawn 参数形式的 `git add -A -- <path> [<original-path>]`，支持空格/特殊字符、删除和 rename 的两侧路径；已暂存条目明确显示“已暂存”。
- 文件点击使用稳定公开 VS Code API：受控 `TextDocumentContentProvider` 虚拟 URI + `vscode.diff`。未暂存为 index ↔ working tree，只有暂存为 HEAD ↔ index，untracked 为 empty ↔ working tree；deleted/rename/root 缺失侧以 empty/受控文本稳定处理，冲突条目给出 SCM fallback。
- 代码：`src/git/worktreeChanges.ts`、`src/ui/worktreeDiffState.ts`、`src/ui/worktreeDiff.ts`、`src/extension.ts`、`src/ui/rebaseViewProvider.ts`、`media/main.js`。

### rebase/edit 的 AI 草稿

- 在 edit stop 可打开 staged 或 working 的 AI “仅生成 message，不提交”界面，标题与面板声明其只生成/复制 message。
- host 仅允许当前 active draft-only session 调用生成；若 conflict 存在，会拒绝以不稳定改动生成草稿并说明原因。
- 真正 amend/new commit 的 `ensureEditStop`、staged、冲突和 session guard 未放宽；AI 草稿不能绕过写入 guard。
- 代码：`src/ui/rebaseViewProvider.ts`、`src/ui/composePanel.ts`。

### 拖拽和键盘兜底

- grip 热区升至至少 28px；保留 grip-only 文本选择设计。
- 增加 pointerdown/move/up/cancel、pointer capture 与 `elementFromPoint` drop target；它与 native HTML DnD 均通过相同的 `reorder()` 生成 canonical revision/order 意图。
- drag 期间收到 refresh 仅暂存 state，拖动结束后才 render，session 不会被刷新销毁。
- Alt+ArrowUp / Alt+ArrowDown 从当前焦点 commit 生成一位完整 canonical intent；边界、locked、filter、rebase 都给出明确 aria-live 文案。宿主仍执行 revision/完整 order/locked 校验并显示确认对话框。
- 代码：`src/ui/rebasePointerDragState.ts`、`src/ui/rebaseReorderState.ts`、`media/main.js`、`media/style.css`。

## 自动测试证据

- `test/commitSearch.test.ts`：字段 parser、`hash:0x`、未知字段全文 fallback、IME reducer 的 composition 终结单次提交。
- `test/inlineToastState.test.ts`：toast 的展示/到期恢复纯状态。
- `test/rebasePointerDragState.test.ts`：pointer canonical intent、Alt 单步、边界与 revision。
- `test/worktreeChanges.integration.test.ts`：真实 Git repo 的 modify/add/delete/rename/untracked/staged+unstaged、单文件 stage、路径空格/特殊字符、Diff 左右版本选择。
- 既有 rebase reorder tests 覆盖 stale revision、locked source、完整 canonical order 拒绝。

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 通过，96 tests |
| `npm run compile` | 通过 |
| `git diff --check` | 通过 |

## 未实施项与人工验收边界

- 未创建浏览器内自绘 diff：这会复制 VS Code 编辑器/文本模型，并在 binary、大文件、rename、root commit 上降低稳定性；已实施真实 `vscode.diff` 与受控虚拟文档，满足打开左右 Diff 的要求。
- Windows 文件系统不允许测试中创建含换行的路径；真实测试已覆盖空格和方括号等特殊字符，解析器仍以 `-z` 协议实现，不依赖换行。
- 需要在真实 VS Code 中人工验证：中文 IME（微软拼音、第三方 IME）、pointer drag 在触控/鼠标设备、实际 binary 文件 Diff 展示、无障碍朗读与主题视觉。这些依赖交互式 VS Code/runtime，不能由 Node 自动测试伪称完成。
