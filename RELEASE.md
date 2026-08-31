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
5. 推送与版本一致的 `v<version>` tag。GitHub Actions 会再次执行发布门禁、校验 VSIX 不含源码/测试/文档/node_modules、校验 RELEASE.md 有该版本记录，全部通过后才创建并上传 Release。

> Release 工作流不会以测试失败的构建发布 VSIX；本地门禁与 CI 使用相同的 `npm run test:release` 命令。

### 测试覆盖范围

| 测试类型 | 覆盖内容 |
|---|---|
| 逻辑测试 | trailer 拆分/保留、rebase todo 构建、refspec 模板替换 |
| 边界测试 | 空 todo、空白 refspec、无 trailer、Git 输出上限、取消信号、失效 stash |
| Git 集成测试 | 临时仓库中的 staged/unstaged 状态、stash apply/pop/drop、keep-index、提交范围、rebase edit 停靠与绝对 git-path |
| 发布测试 | TypeScript 类型检查、VSIX 必需文件与排除文件检查、Release 版本记录检查 |

测试文件位于 `test/`，运行 `npm run test` 或 `npm run test:coverage`。

### 更新记录

- **0.3.0** — P1 体验、可靠性与诊断增强：
  - AI message 改为流式生成；新增 `llm.timeoutMs`（默认 120 秒）、用户取消和安全的认证/限流/服务端错误提示。
  - Push 显示可取消进度；新增 **Git Rebase Visual** OutputChannel 记录 push 与 provider 操作失败摘要。
  - 暂存状态通过文件事件与节流 index 轮询自动刷新，终端 `git add` 后无需手动 Refresh 即可使用相关菜单。
  - 删除 commit 前增加目标与历史重写确认；rebase edit 停靠横幅显示当前目标和 Continue/Abort 指引。
  - 新增 LLM HTTP mock 覆盖流式 SSE、畸形事件、deadline、取消与错误脱敏；完整测试套件扩展至 25 项。

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
