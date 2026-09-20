## 0-7-2 发布回复（对应 `code-review-0-7-2-release.md`）

### 评审基线与结论

- 发布基线：v0.7.1，`4a1e2088ee5c83202eab9e17ad83f5372dbf21e3`。
- 最终发布候选：`1fa107ceb200696ac01a0f52cf9fdfbefdf83b5c`，其后仅添加本回复、最终发布复核报告与台账记录。
- `code-review-0-7-2-release.md` 的独立结论为 **P0 0、P1 0、P2 1**。依照“无 P0/P1 可以发布”的规则，允许 v0.7.2 发布。

### 发现决策与实施证据

- [x] **V072-F1 — 旧 editor-area Commit Inspector 被写成当前交互：已修复并独立复核。**
  - `README.md` 改为说明原生 TreeView tooltip、原生 context menu、普通 click 只选择及 Ctrl/Cmd 多选不打开 editor Tab。
  - `docs/summary/summary.md` 改为 active `NativeCommitTreeProvider` / `createTreeView()` 架构，并把 `CommitInspectorPanel` 明确为历史、非激活源码；`ComposePanel` 保留为唯一编辑/生成 message 的 editor-area panel。
  - `docs/release-notes/0.7.2.md` 与 `RELEASE.md` 新增准确的 v0.7.2 原生交互说明。
  - 实现证据：`1075328e2c4500df1adfdb1e8d0ab7fc332b2166`；独立文档复核记录为 `code-review-0-7-2-docs.md`。

- [x] **V072-D1 — 当前文档仍承诺不可达的 Webview 搜索、键盘和禁用控件：已修复并独立复核。**
  - `44c6d162ac8eacd555aef50e5565e38aec61e5af` 删除 README 中的 Webview 搜索、IME、keyboard pickup/drop、Alt-arrow、right-click selection redirect 叙述，并在 summary 中明确它们是历史 Webview 行为。
  - `1fa107ceb200696ac01a0f52cf9fdfbefdf83b5c` 将残留“webview 禁用非连续选择”改为当前语义：原生 context menu 不对非连续选择暴露批量 Generate Diff，且宿主仍复验 hash、revision 与连续性。
  - 独立复核确认 `nativeCommitTree.ts` 的 batch context、`package.json` 的 contiguous 菜单贡献和 `nativeCommandIntent.ts` 的宿主验证与文档一致。

- [x] **发布元数据和 VSIX 内容：已验证。**
  - `9087314e9be1f9bd1b4fed34300ce56cbde54fc2` 将 `package.json` 和 `package-lock.json` 更新到 `0.7.2`。
  - release note 标题为 `## Git Rebase Visual 0.7.2`，无模板占位符；`RELEASE.md` 包含 `**0.7.2**`。
  - `.vscodeignore` 与实际 VSIX 检查确认未包入 `src/`、`test/`、`docs/`、`node_modules/`、`.claude/`、`.codegraph/` 或 `pic_ref/`。

- [ ] **P2 — 真实 Extension Development Host 验收：记录，不作为发布阻断。**
  - 原因：本轮已完成 TypeScript、Node、Git 集成和 VSIX 静态门禁，但未在真实 Workbench 中记录原生 tooltip/context menu 跨 sidebar/editor 的浮层位置、click-outside/`Esc` 关闭、Ctrl/Cmd 多选、end-boundary DnD、确认期间文件状态变化及 locked/batch 菜单的人工结果。
  - 后续：在下一个交互版本的手工验收中执行并记录这些 Workbench 项；在此之前不将其表述为已完成。

### 最终验证

| 命令 / 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run compile` | 通过 |
| `node --check dist/extension.js` | 通过 |
| `npm test` | 146 passed，0 failed |
| `git diff --check 4a1e208..1fa107c` | 通过 |
| `npm run package` | 通过，生成 `git-rebase-visual-0.7.2.vsix` |
| VSIX 内容检查 | 通过；运行时文件存在，源码、测试、文档和开发资产未打包 |
| 最终独立文档复核 | P0 0、P1 0、P2 1；允许发布 |
