## 0-6-3 回复（对应 `code-review-0-6-3.md`）

- **评审基线 / 版本**：评审报告覆盖 `828bd4cfa7e62e4dc90f5c3b899c3d0ebde72992`（`feat: implement 0.6.3 rebase interactions`），本回复对应 0.6.3 P1 整改提交。
- **整改范围**：按报告要求修复 R63-1 与 R63-5；R63-2 的 repository authority 和 URI 生命周期要求作为 R63-5 共用受控 resolver 的一部分同时落实。R63-3 至 R63-4 不在本次 P1 整改中单独扩大为 webview/图形环境测试项目。

### Findings 决策

- [x] **R63-1 — 已暂存 rename 后的工作区修改无法单文件暂存：已修复。**
  - `src/git/worktreeChanges.ts` 的 `stageWorktreeChange()` 现在仅传入工作区侧的当前 `change.path`：`git add -A -- <current-path>`。不再把 index-side rename 的 `originalPath` 当作工作树 pathspec，因此 `XY=RM` 中已经不存在的旧路径不会导致 `pathspec did not match`。
  - 新增真实 Git 回归 `test/worktreeChanges.integration.test.ts`：提交 `old.txt`，`git mv old.txt new.txt` 暂存 rename，再修改 `new.txt` 和一个无关文件；调用真实 `stageWorktreeChange()` 后断言 `new.txt` 不再有 unstaged side、`:new.txt` 是新内容，且无关文件仍保持 unstaged。测试同时保留 delete、untracked/空格路径等已有单文件暂存回归。

- [x] **R63-5 — commit“打开变更…”不是左右 Diff：已修复。**
  - `src/ui/rebaseViewProvider.ts` 已将所有共享的 `openDiff` 消息路径从旧的 `openDiffDocument()` patch 文档切换到 `openCommitDiff()`。右键菜单、hover 按钮及 Compose 的“打开目标变更…”本来共用该消息，现统一进入 `vscode.diff`。
  - host 使用 `git diff-tree --name-status -z -M --root` 枚举文件，`--numstat -z -M` 检测二进制文件，文件数大于一时通过 `showQuickPick` 选择具体文件。`src/ui/commitDiffState.ts` 解析这些结构化 Git 数据；`src/ui/gitDiffRequestState.ts` 生成 parent ↔ commit 描述。root/add 使用 empty ↔ target，delete 使用 parent ↔ empty，rename 使用 old path ↔ new path；二进制和多 parent merge 给出明确的安全 fallback，不会通过 UTF-8 provider 损坏二进制内容。
  - worktree 与 commit Diff 现共同复用 `src/ui/worktreeDiff.ts` 的 `vscode.diff` 路径、`GitContentProvider` 和受控 content request store。URI query 只包含随机 opaque request id，provider 不再从 URI 接收 repository/ref/path；request store 对 descriptor 校验、TTL、LRU 上限、repository invalidation 与 extension dispose cleanup 全部有实现。commit 文件选择 plan 另有 128 条上限 cache，并在 repository 切换/extension dispose 时清空。
  - 新增测试：
    - `test/gitDiffRequestState.test.ts`：opaque authority、非法 ref/path、LRU、过期、repository invalidation、clear cleanup，以及 root/add/delete/rename/binary resolver 语义；
    - `test/commitDiffState.integration.test.ts`：真实 Git root commit、add/delete 的多文件选择数据、rename 的 old/new 路径、binary fallback、merge-parent fallback；
    - 旧的可序列化 repository/path URI state 测试及实现已删除，避免保留绕过 opaque resolver 的第二套 URI 协议。

- [ ] **R63-3 — worktree binary side 的二进制呈现：延后。**
  - 本轮对 commit binary 已在文件选择前安全 fallback，避免将 commit blob 交给 text provider。worktree 的 index/HEAD binary 检测和实际 VS Code binary viewer 策略仍需要独立设计及图形环境人工验收；为避免把未经验证的推断混入 P1 修复，本轮未将其标记为完成。

- [ ] **R63-4 — browser/host protocol harness：延后。**
  - 本轮新增的是纯 resolver 和真实 Git fixture 回归，覆盖 P1 的数据/安全边界。`media/main.js` 的 DOM event-to-message harness 仍是后续改进项，不能宣称由当前 Node tests 验证。

### 最终验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test` | 通过，`102/102` tests |
| `npm run compile` | 通过 |
| `git diff --check` | 通过 |

未执行 push 或 tag，未修改 package version 或 release 文档。实际 VS Code 图形环境下的 binary viewer、IME、pointer/touch 和辅助技术仍需独立人工验收。
