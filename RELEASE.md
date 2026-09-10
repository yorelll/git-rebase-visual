# 发布与分发指南

本插件用 [`@vscode/vsce`](https://github.com/microsoft/vscode-vsce) 打包成 `.vsix` 文件分发。别人拿到 `.vsix` 即可离线安装，无需上架应用市场。

---

## 一、准备

确保依赖已安装、代码可编译：

```bash
npm install
npm run compile      # 产出 dist/extension.js 与 dist/seq-editor.js
```

> **Windows PATH 提示**：本机若出现 `'node' 不是内部或外部命令`（npm 拉起子进程时找不到 node），在命令前临时把 node 目录加入 PATH，例如：
> ```bash
> PATH="D:\Program Files\nodejs;$PATH" npm run compile
> ```

打包前请检查 `package.json` 中的字段是否符合分发需求：

- `name` / `displayName` / `description` / `version`
- `publisher`：当前为 `local`。**若要上架 Marketplace 必须改成你在 Marketplace 注册的 publisher ID**；仅内部分发 `.vsix` 则可保留任意值。
- 建议补充 `repository`、`license`、`icon`（一张 128×128 的 png）等字段，否则打包会有警告。

---

## 二、打包成 .vsix

安装打包工具（一次即可）：

```bash
npm install -g @vscode/vsce
```

在项目根目录执行：

```bash
vsce package
```

成功后会在根目录生成 `git-rebase-visual-<version>.vsix`。

> `vsce` 默认会跑 `vscode:prepublish`（已配置为 `npm run compile`），所以打包时会自动重新编译。
> 打包只包含必要文件；`dist/`、`media/`、`package.json` 会被包含，`node_modules`、`src/`、`.superpowers/` 等按 `.vscodeignore` 规则排除（如需精细控制可新增 `.vscodeignore`）。

---

## 三、分发与安装（离线 .vsix）

把生成的 `.vsix` 发给使用者，对方任选一种方式安装：

**方式 A — 命令行**
```bash
code --install-extension git-rebase-visual-<version>.vsix
```

**方式 B — VSCode 界面**
1. 打开扩展面板（`Ctrl+Shift+X`）。
2. 点右上角 `...` → **Install from VSIX...**。
3. 选择 `.vsix` 文件。

安装后重载窗口，左侧活动栏即出现 **Git Rebase** 图标。

---

## 四、（可选）上架 VSCode Marketplace

面向公众发布时才需要：

1. 在 [Azure DevOps](https://dev.azure.com) 创建 **Personal Access Token**（Marketplace → Manage 权限）。
2. 在 [Marketplace 管理页](https://marketplace.visualstudio.com/manage) 创建 **publisher**，并把 `package.json` 的 `publisher` 改成该 ID。
3. 登录并发布：
   ```bash
   vsce login <publisher-id>
   vsce publish            # 或 vsce publish minor / patch 自动升版本号
   ```

发布后用户可直接在扩展市场搜索安装。

---

## 五、版本升级流程

1. 修改代码并 `npm run compile` 验证。
2. 更新 `package.json` 的 `version`（遵循语义化版本），并在下方维护更新记录。
3. 运行完整发布门禁：`npm run test:release`（类型检查 + 逻辑/边界/真实 Git 集成测试 + 覆盖率）。
4. 重新 `npm run package`，确认 VSIX 内容正确。
5. 按 [`docs/release-template.md`](docs/release-template.md) 创建 `docs/release-notes/<version>.md`，填入面向下载者的**最终**新功能、修复、可靠性说明、使用方式、功能总览、文件和系统要求。不得保留 `{{...}}` 占位符。
6. 推送与版本一致的 `v<version>` tag。GitHub Actions 会再次执行发布门禁、校验 VSIX 不含源码/测试/文档/node_modules、校验 RELEASE.md 与 `docs/release-notes/<version>.md`，全部通过后以该 Markdown 文件作为最终 Release body 创建并上传 Release。

> Release 工作流不会以测试失败的构建发布 VSIX；本地门禁与 CI 使用相同的 `npm run test:release` 命令。Release 创建后不依赖事后 `gh release edit` 补写功能说明。`docs/release-notes/` 仅为发布输入，按 `.vscodeignore` 排除在 VSIX 外。

### 测试覆盖范围

| 测试类型 | 覆盖内容 |
|---|---|
| 逻辑测试 | trailer 拆分/保留、rebase todo 构建、refspec 模板替换 |
| 边界测试 | 空 todo、空白 refspec、无 trailer、Git 输出上限、取消信号、失效 stash |
| Git 集成测试 | 临时仓库中的 staged/unstaged 状态、stash apply/pop/drop、keep-index、提交范围、rebase edit 停靠与绝对 git-path |
| 发布测试 | TypeScript 类型检查、VSIX 必需文件与排除文件检查、Release 版本记录检查 |

测试文件位于 `test/`，运行 `npm run test` 或 `npm run test:coverage`。

### 更新记录

- **0.6.2** — 第三轮 UI 交互可靠性与 Compose/拖拽修复：
  - **拖拽稳定性**：仅 grip 可拖且扩大热区，显式 `dataTransfer`、drag session 与 refresh defer 防止 1.5 秒轮询销毁原生拖拽 DOM；宿主以 source/anchor/placement/revision/完整 canonical todo 重新验证并展示具体改写确认。
  - **锁定分组与刷新状态**：`collapseLockedRuns` 默认 true，连续 ≥3 锁定 commit 才折叠；展开、搜索 focus/selection 和“更多提交选项”状态跨 refresh 保持。锁定摘要支持将提交插入整组前/后，不必先展开。
  - **Compose 可靠交付**：重构 Panel 为 session/revision/ready/ack delivery queue，修复首次打开/reload 时原 message、trailer 和 draft 为空；同 target dirty draft 不被覆盖，旧 target/session 不能写入新 target。
  - **edit 停靠与 draft-only**：实际渲染 Amend/New/Draft-only 操作；Amend 保留 trailer，新 commit 不继承目标 trailer；仅生成 message 严格不进入提交路径。
  - **通知/上下文**：成功 inline toast、错误系统通知、长任务 SourceControl progress；显示 branch/upstream/ahead/behind/range；scroll 关闭菜单不发 mutation 的协议回归测试。
  - **安全审查**：Undo/locked patch continuity、trailer 粘贴、edit-stop、drag canonical order 由独立审查修正；测试套件扩展至 **89 项**。

- **0.6.1** — rebase 面板交互稳定性修复：
  - **Compose 原 message / trailer 可靠交付**：修复首次打开或 Webview reload 时宿主在 listener 就绪前发送 payload，导致原 message 与 trailer 为空的竞态。Compose Panel 现通过 `composeReady` handshake 保存并重发最新 payload。
  - **locked run 交互稳定性**：连续 locked commit 仅在数量 **≥3** 且 `gitRebaseVisual.collapseLockedRuns=true`（默认）时折叠；用户展开状态跨 refresh 保持。折叠摘要支持将非 locked commit 拖到 run 前/后，不必展开。
  - **搜索/更多选项状态保留**：状态刷新后恢复搜索焦点和光标 selection，保持“更多提交选项”展开状态，避免轮询刷新使用户无法输入或自动收起。
  - **通知与上下文**：复制、stash 等成功反馈改为面板内 2.5 秒 inline toast；warning/error 保持 VS Code 系统通知；Push/AI/rebase 使用 SourceControl progress。面板增加 branch、upstream、ahead/behind 与 range context bar。
  - **edit 停靠 draft-only 修正**：停靠横幅中的“仅生成 message”现在严格携带 `messageOnly`，Compose 只复制/保留 message，绝不意外提交。新增 Compose delivery、暂停 Compose policy、branch context 等测试；测试套件扩展至 **70 项**。

- **0.6.0** — 大版本 rebase 状态模型、恢复能力与编辑体验升级：
  - **受控 Undo 与操作历史**：历史改写前创建私有 `refs/gitRebaseVisual/undo/<id>` checkpoint，并记录仓库、分支、before/after tip 与操作类型。工具栏、成功结果和历史入口可 Undo；Undo 会验证 rebase、分支、HEAD、工作区、checkpoint 和已推送风险，优先 `reset --keep`，不使用不安全的裸 `ORIG_HEAD + reset --hard`。
  - **真实 rebase 状态**：新增 rebase session/progress，显示步骤 N/M、edit/conflict/paused 原因、当前/待重放 commit；待重放行明确 hash 将变化，外部无法可靠解析时显示 unknown，不虚构进度。增加可点击状态栏提示。
  - **暂停工作区**：edit stop 提供 Amend 当前 commit、新建 commit、仅生成 message；conflict-only Skip 显示将丢弃 patch 的完整后果并确认；Continue 始终宿主复查冲突。
  - **提交操作升级**：新增 squash/fixup、复制 message、受控只读 Git diff；首项、locked 当前/前驱和 rebase 中操作均防御式禁用并说明原因。
  - **Compose Panel**：message 编辑迁移到编辑器区 WebviewPanel，支持 subject/body、50/72 提示、72 列参考、原 message/trailer 折叠、AI cancel/replace/append/restore、draft/session 保留和 Apply 失败保留输入。
  - **UI/无障碍**：作者 email 稳定色与首字母、状态颜色语义分离、grip-only drag、文本可选择、搜索/多选/安全 locked-run 折叠、键盘 pickup/drop、菜单 roving focus、状态栏、High Contrast fallback。
  - **安全修正与测试**：Undo journal 按仓库隔离并在淘汰时清理私有 refs；todo parser 正确处理 exec/merge workflow 并对未知语法降级；`messageOnly` 不再误提交；fixup message 丢弃语义有真实 Git 回归测试。测试套件扩展至 **64 项**。

- **0.5.1** — 后台 Git 状态轮询的 index-lock 竞争修复：
  - **终端切分支/stash 并发保护**：面板可见时后台 `git status` 刷新可能触发 Git 的可选 index metadata refresh，短暂创建 `.git/index.lock`，与终端 `git switch`、`git stash` 等写 index 操作竞争。后台 `workingStatus()` 与 `isDirty()` 现使用 `GIT_OPTIONAL_LOCKS=0`，状态结果保持正确但不再获取 optional index lock；rebase、stash、commit、push 等写操作仍保留正常 Git lock。
  - **回归测试**：真实临时仓库中预先创建 `index.lock`，验证后台状态读取仍能正确返回 staged/unstaged 状态和 dirty 结果。
  - **发布说明标准化**：新增 [`docs/release-template.md`](docs/release-template.md)；每次 tag 前必须提交 `docs/release-notes/<version>.md`。Release workflow 校验 body 存在、标题版本匹配、无未替换占位符，并以 `--notes-file` 发布最终说明，不再使用 `--generate-notes` 或依赖事后编辑。

- **0.5.0** — UI/UX 安全反馈与历史改写可靠性增强：
  - **UI 评审闭环**：基于六张实际 UI 截图、用户建议、独立 UI 审查、实施审查与主 agent 复核，新增 [`docs/ui-reivew/ui-review-0-5-0.md`](docs/ui-reivew/ui-review-0-5-0.md)；逐项记录已实施、延后与事实纠正（如 hover 已是 fixed 浮层，不存在 layout shift）。
  - **列表与菜单**：保持与 interactive-rebase todo 一致的 oldest-first，新增 Base/HEAD 方向、拖拽 grip/前后方向提示与历史改写确认；列表调整为 subject 主行、hash/author/date metadata；菜单增加目标 header、分组、危险 Drop 尾置、锁定/暂存/rebase 状态禁用原因。
  - **历史安全**：locked commit 无法直接 Drop，避免 rebase 冲突/失败/Abort 后锁丢失；Drop、reorder、edit-stop、Abort 增加明确确认和 operation old/new tip/影响范围反馈。
  - **暂停 rebase**：新增 `rebaseState`，实时显示冲突文件/数量/暂停原因；未解决冲突时 Continue 禁用且宿主二次检查；不再把 replay conflict 的 stale stopped-sha 错标为 edit stop。
  - **append Abort 修正**：修复 replay conflict → Abort 时完整 snapshot 与 keep-index stash 的双重恢复，避免重复应用未暂存改动、冲突与 pending stash 残留。
  - **Compose/无障碍**：Apply 在宿主成功前保留 dialog 和手写输入；reword 暂停/失败也走 applyFailed；新增最小 ARIA、`lang="zh-CN"`、Escape、Menu 键、Ctrl/Cmd+Enter 和 focus-visible 基线。
  - **测试**：新增真实 Git rebase 安全测试与暂停状态测试；全套扩展至 **48 项**。

- **0.4.0** — P2 高价值项落地与可靠性增强：
  - **测试覆盖扩展（P2-6）**：新增真实 bare remote 集成测试，覆盖 `--force-with-lease` 并发远端变更拒绝与 `lockedInPush` 锁定拦截/解锁放行；新增 append 前置守卫测试（目标已在 upstream / 目标被锁定均不可 append）；`streamChat` 增加流读取途中取消与超时的 HTTP mock 测试，并据此加固实现——每次 SSE read 与取消/超时竞速、吸收进行中 read 的取消拒绝、撤销时清理计时器，杜绝挂死与 unhandled rejection。
  - **大仓库性能（P2-3，部分）**：patch-id 增加按 `<repoRoot>:<hash>` 的 session 缓存（`clearPatchIdCache` 供测试重置），避免同一 hash 在 hover/lock/push 路径重复计算；hover 变更统计改用结构化 `--numstat`（`summarizeNumstat`，正确处理二进制/重命名行），`--shortstat` 文本解析仅作降级；顺带修复根提交（root commit）patch-id 恒为空的缺陷（`diff-tree --root`）。
  - **Stash 恢复可见性（P2-1）**：append/auto-stash 冲突提示精确到 `stash@{n}` + 短 sha + 可执行的手动恢复命令；新增 `gitRebaseVisual.stashList` 命令（优先调用 `git.openStash`，降级列出到 **Git Rebase Visual** OutputChannel）。
  - **安全与可移植性（P2-5，部分）**：启动时通过 `checkGitFeature` 检查最低 Git 版本（2.31.0），过旧时显示明确错误而非崩溃；SecretStorage 接入管线打通（`activate` 注入 `context.secrets`，通过 `secretsAccess.ts` 安全访问），评审推送时若 API key 仍存于 settings 会提示迁移。
  - **append 已推送保护强化**：目标 commit 已在本地 upstream 时，确认框要求显式输入「我已推送同内容，仍要改写」二次确认，杜绝静默改写已共享历史。
  - 测试套件扩展至 **40 项**；全文件行覆盖 85%。发布 CI 中发现并修复 patch-id 跨重写测试的同秒 hash 时序 flaky：不再假设 `cherry-pick` 必然换 hash，改以 `commit-tree` 构造同 diff、不同 message 的确定性 clone。
  - 回复文档改为按版本命名（`review-response-0-4-0.md`），`CLAUDE.md` 命名规则同步更新。

- **0.3.1** — 评审整改与评审归档规范：
  - 修复 commit message compose/apply 在列表更新后使用过期 hash 可能触发无意义 rebase 的问题；现在会拒绝过期 commit 操作并要求刷新。
  - 面板隐藏或 dispose 时停止 index 轮询并释放 refresh timer，重新显示时恢复自动状态同步，避免后台 Git 空转。
  - 优化 Git 输出上限计数为常数时间累计，避免大型输出场景的重复字节扫描。
  - 将版本化评审规则固化到 `CLAUDE.md`：评审原文使用 `code-review-<major>-<minor>-<patch>.md`，项目回复只追加到 `docs/review/review-response.md` 的同版本章节。
  - 将既有评审原文重命名为 `code-review-0-3-0.md`，将回复文档重命名为 `review-response.md`，并更新文档链接。
  - 测试套件扩展至 27 项。

- **0.3.0** — P1 体验、可靠性与诊断增强：
  - Push 显示可取消进度；新增 **Git Rebase Visual** OutputChannel 记录 push 与 provider 操作失败摘要。
  - 暂存状态通过文件事件与节流 index 轮询自动刷新，终端 `git add` 后无需手动 Refresh 即可使用相关菜单。
  - 删除 commit 前增加目标与历史重写确认；rebase edit 停靠横幅显示当前目标和 Continue/Abort 指引。
  - 新增 LLM HTTP mock 覆盖流式 SSE、畸形事件、deadline、取消与错误脱敏；完整测试套件扩展至 26 项。

- **0.2.1** — 历史编辑安全性、恢复可靠性与发布质量修复：
  - 历史重排和 commit 操作增加互斥与 refresh 快照版本控制，避免并发操作或旧刷新结果改写当前状态。
  - 后端校验来自 Webview 的 commit hash 及拖拽顺序，阻止过期/残缺列表导致的静默历史改写。
  - 追加暂存区文件前禁止修改锁定 commit；若目标已推送到 upstream，明确提示需要 `--force-with-lease`。
  - Git 子进程增加 50 MiB 输出上限、120 秒超时和取消支持；rebase 状态检测改用绝对 Git 路径，兼容非标准 git-dir/worktree。
  - 修复 commit message trailer 保留逻辑，避免编辑时意外丢失原 trailer 块。
  - 新增 21 项逻辑、边界和真实 Git 集成测试；版本发布前自动执行类型检查、覆盖率测试、VSIX 内容检查和版本说明检查。

- **0.2.0** — 可将暂存区文件追加到任意显示的 commit：
  - 在目标 commit 的右键菜单中选择「将暂存区文件添加到此 commit」，插件会自动停靠、`--amend --no-edit` 并重放后续提交。
  - 操作前显示改写历史确认；暂存区为空时菜单不可用。
  - 同时存在未暂存改动时自动临时 stash，完成后恢复，确保只有操作开始时暂存的文件被追加。

- **后续开发门禁** — 逻辑、边界与真实 Git 集成测试已加入发布工作流：
  - `npm run test:release` 会运行 TypeScript 类型检查及 Node 测试覆盖率测试。
  - 打版本 tag 时，Release CI 在打包前执行测试，并验证 VSIX 所含文件和 RELEASE.md 版本记录；失败时不发布。
  - 覆盖范围包括 trailer、rebase todo/refspec、stash 状态机、rebase edit 停靠、Git 输出限制及取消信号。

- **0.1.0** — 首个版本：
  - 拖拽重排、变基到此 commit（edit 停靠）、改 message、改 message 并变基、变基并 push、删除 commit、复制 hash。
  - commit 锁定/解锁（基于 git patch-id，cherry-pick / rebase 后依然生效）；push 前锁定检查。
  - 悬停查看完整 message + 变更统计，可复制。
  - Compose 弹窗：原始 message 对比、AI 补充信息输入、`Change-Id`/`Signed-off-by` trailer 自动保留。
  - AI 生成 message（批量模式）；支持为暂存区 / 工作区改动生成 message 并提交。
  - 脏工作区处理：`autoStash`（默认）自动 stash，并在变基完全结束 / Continue / Abort 后按 stash sha 恢复（兼容 hash 改写与外部 continue/pop 的状态同步）；可切换为手动模式（阻止并提示自行 stash）。
  - 顶部 Push 按钮：普通推送当前分支（与变基解耦，避免 Gerrit 因无改动拒绝），含锁定检查；可配置评审推送 refspec（如 `HEAD:refs/for/master`），推送时动态选择普通 / 评审 / 自定义。
  - 编辑器进程使用 `process.execPath`，兼容 vscode-server / 远程（PATH 无 `node` 亦可）。
