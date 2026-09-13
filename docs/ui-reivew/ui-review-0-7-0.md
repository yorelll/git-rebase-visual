# Git Rebase Visual UI 实现记录（0.7.0）

## 基线、范围与验证

- 基线：v0.6.3（`f4045ea`）。最终候选的四个功能实现提交为 `499dfc1`、`2711b66`、`ee85a85`、`715234a`；它们分别与独立审查使用的 `40d5dd3`、`ed9c11c`、`147f76b`、`371aafb` 内容一致，仅因从已发布 `origin/main` 线性重建而更换 SHA。发布准备还补充版本文档、注释准确性和 staged-restore 回归断言。本记录归档为未发布版本 0.7.0 的最终 UI 实现结论；不会将内部审查轮次当作 0.7.1 / 0.7.2 发布版本。
- 输入：review3/review4 的六张截图、既有三轮建议与 0.5.0、0.6.0、0.6.3 裁决记录。
- 所有 Git 写入继续在 extension host 重新读取状态、验证完整 hash/当前快照并要求确认；webview 只表达用户意图。

## 1. 单选、多选与批量动作

- [x] 普通单击只更新 active/focused commit，不再建立 selection；只有 Ctrl/Cmd+click 才加入/取消多选。
- [x] 仅选择达到两个 commit 时显示批量锁定和批量删除；搜索框旁不再显示批量 lock/drop/squash 按钮。
- [x] 点击列表空白、时间轴锚点或非 commit 区域会清空多选。
- [x] 多选右键菜单提供“批量锁定 commit”和“批量删除 commit”；删除复用 host 的完整短 hash/subject 清单、锁检查、确认后二次快照验证和单一 atomic rebase plan。
- [x] 多选时复制、编辑、AI、停靠、squash/fixup、左右 Diff 都禁用，并明确说明“已选择 N 个 commit”。
- [ ] 不支持批量 squash/fixup。
  - 原因：跨越未选或过滤隐藏 commit 时，合并前驱和最终 message 的语义不可预测；只接受连续区间仍会让批量操作与单 commit 的锁/前驱保护模型混淆。拒绝该操作避免以猜测顺序改写历史，不是以实现难度为由。
- [x] 单 commit 右键始终依据右击目标产生 copy/message/lock 等动作；正常点击留下的是 active context，不能挟持右键目标。修正 review R70-2：右击未选行会先原子清空旧多选、把该行作为 active/single target；右击已选行保留当前批量选择。`test/webviewDom.test.ts` 覆盖 A+B→右击 C、已选行右击、空白清选和批量菜单禁用项。

## 2. 搜索和中文 IME

- [x] `author:`、`msg:`、`hash:0x...` 支持冒号后的可选空格，并 trim scoped value。例如 `msg: feat parser author: Alice` 的 message scope 为 `feat parser`。
- [x] unknown prefix 保持全文检索，防止误解作者/subject 中的冒号；`hash:0x` 仍只按真实 hash prefix 匹配。
- [x] 搜索框 composition start/update 期间不 render 或替换 input；compositionend 只应用最终文字一次。全局快捷键捕获阶段会避开 input/textarea/contenteditable 和 composing 状态，Space、Arrow、Enter、Alt+Arrow 不会成为 rebase 命令。
- [x] 测试：`test/commitSearch.test.ts` 覆盖 scoped whitespace、`hash:0x` 与 composition reducer 的最终单次应用。

## 3. 工作区文件区

- [x] 继续使用 `git status --porcelain=v2 -z` structured parser；路径从不按行拆分，single-file stage 保持 spawn argv 与 `--` pathspec。
- [x] 每行主信息为文件名、次级信息为浅灰目录；状态是带 title/ARIA 的 M/A/U/D/R 单字母，使用 warning/added/deleted/renamed theme token，不以纯颜色为唯一信息。
- [x] hover/focus 显示三个紧凑操作：working/untracked 的 stage `+`、安全 restore `↶`、open/diff `↗`；文件名点击与 open 都走现有公开 `vscode.diff` 左右 Diff。
- [x] staged 一侧显示“已暂存”且没有 stage 操作；同一文件两侧分别列在 Staged Changes 和 Changes。
- [x] restore 拆分为 working（index → working，丢弃未暂存变更）与 staged（HEAD → index，保留工作区）并有 webview 与 host 双确认；untracked 不会自动删除，只有明确的删除确认才调用安全的仓库内路径删除。
- [x] edit stop 中保留相同文件区、stage、diff、restore 能力。修正 review R70-3：`stageFile`/`restoreFile` 均按真实 Git/index/worktree/disk 写入分类为 `mutation`，先进入 host `busy` 串行化，再由实际调用的 paused allow-list 明确允许 edit-stop 文件操作；不再依赖分类漏网。`test/mutationGate.test.ts` 和 `test/webviewProtocolState.test.ts` 覆盖允许、串行化、unsafe write 拒绝和 read/UI 流量无告警。
- [x] 测试：`test/worktreeChanges.integration.test.ts` 真实 Git 覆盖 modify/add/delete/rename/untracked、路径空格/方括号、single-file stage、RM、working 与 staged restore 分离及 untracked 删除保护。

## 4. 重排和 Alt

- [x] grip 维持至少 28px，真实 DOM pointer fallback 包含 pointer capture、elementFromPoint hit testing、插入反馈和 deferred refresh；native DnD 与 pointer intent 都构造 canonical complete order，并由 host revision/hash/lock 验证。修正 review R70-1：pointer/native drop 在应用 deferred state 前，从 drag session 的 immutable revision/canonical order 构造并发送 intent；因此 host 可在任何确认或 Git 写入前拒绝过期 session。`test/webviewDom.test.ts` 真实执行 webview handler，覆盖 start→deferred changed order/revision→pointerup 与 native drop payload。
- [x] Alt+Up/Down 在单一 active commit 上构造一步 canonical reorder，并在 host 进行历史重写确认。
- [x] rebase、过滤、locked、输入/IME 都阻止该快捷键；多选不会作为 Alt 重排来源。

## 5. 通知和右键菜单

- [x] inline success toast 继续 absolute overlay branch context，不推进列表。
- [x] 不能声称 webview document click 能看见编辑器区域。通过公开 `onDidChangeActiveTextEditor`、`onDidChangeTextEditorSelection`、`onDidChangeWindowState` host events 发 `closeMenu` 协议关闭菜单。
- [x] 单 commit menu 的动作组标题为“变基与编辑”，rebase 动作位于该组；多选菜单同样使用此标题。
- [x] 移除 Push review confirmation 中与 LLM API key settings/SecretStorage 有关的无关文字。

## 6. 作者视觉

- [x] author email hash 映射为 12 个离散 classic/theme palette token，而不是任意 HSL；dot 内始终有 author initial，title 包含完整作者/email/当前作者状态。
- [x] 同一可见列表中 author initial 相同的不同身份使用最短唯一文本前缀（不少于两个字符），不再仅在 palette key 相同才升级；因此 High Contrast/forced-colors 折叠 palette 后，点内仍保留可区分文本而不依赖颜色。
- [ ] 尚未完成 High Contrast Dark/Light 的人工逐屏视觉验收。
  - 原因：自动 Node/compile 环境无法启动真实 VS Code 主题；代码使用 VS Code tokens/forced-colors fallback，发布前仍应人工验收。这是事实边界，不是拒绝无障碍工作。

## 7. 生成 Diff

- [x] 右键新增“生成 Diff…”。单选用该 commit；多选仅在当前 canonical timeline 中构成无空洞连续区间时可用，按 oldest-first 拼接精确 selected commits，并在只读 `diff` 文档中打开，用户可复制或另存。修正 review R70-4：内容改由扩展私有 `git-rebase-visual-generated-diff:` `TextDocumentContentProvider` 的 opaque snapshot URI 提供，不再创建 editable `untitled:` 文档。
- [x] 非连续多选的“生成 Diff…”菜单项会 disabled 并说明仅支持连续 commit；host 也独立拒绝 gapped/stale/unknown/duplicate payload，不能绕过 UI 生成离散 patch 串接。它不替代“打开变更”的 parent ↔ commit `vscode.diff`。
- [x] host 以完整当前 hash selection 和连续区间重验。调用 `git show --binary --find-renames --no-ext-diff`，标明 binary patch/摘要，并在 2,000,000 字符截断时写入明确说明。snapshot store 有 repository scope、TTL、LRU、生命周期 cleanup，并冻结生成内容；生成前后重验 canonical revision，refresh 时不发布过期 snapshot；`test/generatedDiffDocument.test.ts`、`test/generatedDiffState.test.ts` 和 `test/webviewDom.test.ts` 覆盖 provider 输入安全属性、host contiguous rejection 和菜单 disabled 行为。

## 8. rebase paused 时的频繁系统提示

- [x] 所有 main webview postMessage 带 source/action；host Output 记录 source、action、intent，便于开发诊断追踪。
- [x] paused guard 只对 explicit unsafe mutation 出 warning。refresh、scroll、pointer、focus、selection、composition、toast 和 read-only Diff 不会触发 mutation warning。
- [x] polling refresh 仍只发送 state；pointer drag deferred refresh 仍不发 host mutation；menu scroll 仅关闭 DOM 菜单。
- [x] 测试：`test/webviewProtocolState.test.ts` 覆盖 paused state 下 refresh/pointer/selection/composition/toast/read traffic 无 mutation/warning、host closeMenu、stage/restore allow-list 和 unsafe reorder warning candidate；`test/mutationGate.test.ts` 覆盖 host busy gate。

## 自动验证

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` / focused generated-Diff, DOM, protocol tests / `node --check media/main.js` | 历史最终候选审查通过。 |
| `npm test` | 历史最终候选为 **120/120 通过**。整改过程中依次发现并修正 safe-port policy 漏掉 5060/5061、6000 及包含非标准 4333 的问题；最终集合与 Fetch Standard 完整表精确相等（含 0/5060/5061/6000，不含 4333），并完成新的全量回归。 |
| `npm run compile` / `git diff --check` | 历史最终候选审查通过。 |

## 发布前人工走查

1. 微软拼音与第三方中文 IME 的 scoped search（含 Space、Arrow、Enter、Alt+Arrow）。
2. 鼠标和触控/触笔 pointer reorder、Alt one-step confirmation。
3. staged/working/delete/rename/untracked 的 Diff 与 restore 确认文案。
4. 编辑器区点击关闭右键菜单，High Contrast Dark/Light 下作者 palette、状态字母和 focus ring。
5. 二进制和超大 multi-commit Diff 的 Git 输出说明与截断可见性。

### 修正提交自动验证（待独立复核）

- `npm run typecheck`、focused generated-Diff/DOM/protocol tests、`node --check media/main.js`：历史最终候选审查通过。
- 初始修正提交时 `npm test`：119/119 通过（约 377 秒）；每次后续整改都重新运行全量测试。
- `npm run compile`、`git diff --check`：历史最终候选审查通过。
- R72-1 后 `npx tsx --test test/llmClient.test.ts` 连续 12 次均通过；shared server helper 与 Fetch Standard 完整 bad-port table 精确一致（含 0、5060、5061、6000、6667、10080；不含 4333），并以真实 listen → close → retry 回归覆盖 6000。
