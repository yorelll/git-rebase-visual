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
2. 更新 `package.json` 的 `version`（遵循语义化版本），可在下方维护更新记录。
3. 重新 `vsce package`（或 `vsce publish`）。

### 更新记录

- **0.1.0** — 首个版本：
  - 拖拽重排、变基到此 commit（edit 停靠）、改 message、改 message 并变基、变基并 push、删除 commit、复制 hash。
  - commit 锁定/解锁（基于 git patch-id，cherry-pick / rebase 后依然生效）；push 前锁定检查。
  - 悬停查看完整 message + 变更统计，可复制。
  - Compose 弹窗：原始 message 对比、AI 补充信息输入、`Change-Id`/`Signed-off-by` trailer 自动保留。
  - AI 生成 message（批量模式）；支持为暂存区 / 工作区改动生成 message 并提交。
  - 应用变基时对脏工作区自动 stash / pop。
  - 可配置评审推送 refspec（如 `refs/for/master`），推送时可动态选择普通 / 评审 / 自定义。
  - 编辑器进程使用 `process.execPath`，兼容 vscode-server / 远程（PATH 无 `node` 亦可）。
