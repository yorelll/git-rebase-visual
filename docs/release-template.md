# GitHub Release Body 模板

> 本模板是 **每次发布的 GitHub Release body 标准格式**。
>
> 发布前在 tag 所在提交中创建 `docs/release-notes/<version>.md`（例如 `docs/release-notes/0.5.1.md`），严格按本模板填入最终内容。Release workflow 读取该文件并将它直接传给 `gh release create --notes-file`。
>
> `docs/release-notes/` 是**发布工作流的输入**，会被 `.vscodeignore` 排除，不会进入 VSIX。Release 创建后，body 是最终发布记录；**不得依赖事后 `gh release edit` 补写功能/修复说明**。

```markdown
## Git Rebase Visual {{VERSION}}

可视化交互式 Git rebase VS Code 扩展：在侧边栏中安全地重排、编辑、锁定和推送 commit，并支持 AI message、stash 与 staged append。

> 来源：Git tag `v{{VERSION}}` · GitHub Actions 自动构建 · CI 已通过 `npm run test:release`、VSIX 内容校验与版本记录校验。

### ✨ 新功能（{{VERSION}}）

- **功能名称**：面向用户说明行为、入口、边界和预期收益。

### 🐛 修复（{{VERSION}}）

- **问题名称**：说明触发场景、错误行为与修复后的保护/行为。

### 🔒 安全与可靠性

- 历史改写、stash、锁定、并发、CI 或回归测试方面的重要保证。

### 使用方式

- 下载 `git-rebase-visual-{{VERSION}}.vsix`。
- VS Code：扩展面板 → `...` → **Install from VSIX...**。
- 命令行：`code --install-extension git-rebase-visual-{{VERSION}}.vsix`。

### 功能总览

- 交互式 rebase：拖拽重排、edit/reword/drop、冲突 Continue/Abort；
- 提交保护：patch-id 锁定、Push guard、`--force-with-lease`；
- 工作区辅助：auto-stash、stash list、将暂存区追加到已有 commit；
- AI message：流式生成、deadline、取消、trailer 保留；
- 诊断与质量：OutputChannel、真实 Git 集成测试、VSIX 内容门禁。

### 文件

- **`git-rebase-visual-{{VERSION}}.vsix`** — VS Code 离线安装包。

### 系统要求

- VS Code `^1.85.0`
- Git `2.31.0+`
- 本地安装可运行 extension host 的 Node/Electron 环境（VS Code 自带）。
```

## 填写规则

1. 删除不适用的小节，而不是保留空标题。
2. `{{VERSION}}` 必须替换为不带 `v` 的语义化版本。
3. 每条修复都写明**用户影响/触发条件 → 修复后行为**；不只罗列文件名或 commit。
4. 每条新功能都写明**入口与行为边界**；尤其是 rebase、drop、append、stash 等历史操作。
5. 与 `RELEASE.md` 保持一致，但 Release body 应是面向下载者的完整最终说明；`RELEASE.md` 是仓库内版本历史。
6. 工作流会校验该文件存在、版本标题匹配且不为空；缺失或模板占位符未替换时，发布失败。
