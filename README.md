# Git Rebase Visual

一款用于**可视化交互式变基**的 VSCode 插件。把 `git rebase -i` 的能力封装成侧边栏里的可拖拽 commit 列表：拖动重排、改 message、锁定他人提交防止误推、还能用大模型生成 commit message。

底层驱动原生 `git rebase -i`（通过自定义 sequence editor 注入 todo），行为与命令行一致，冲突走 git 原生流程。

---

## 安装

见 [RELEASE.md]。开发调试可在项目根目录按 `F5` 启动 Extension Development Host。

## 打开面板

安装后左侧活动栏出现 **Git Rebase** 图标，点击展开 **Commits** 面板。面板会显示当前分支**尚未推送**的 commit（默认范围，见下文配置）。

- 列表**从上到下 = 从旧到新**（顶部是最早的 commit，底部是最新的）。
- 每个 commit 前有一个**彩色圆点**（由 hash 生成，便于区分）、短 hash、以及 message 摘要。
- 顶部工具栏有**刷新**按钮。

---

## 功能一览

所有操作都通过**拖拽**或**右键菜单**触发。

### 1. 拖拽重排
直接拖动某个 commit 到目标位置松手，即可重排提交顺序（松手即时生效，后台自动执行 rebase）。

### 2. 悬停查看详情
鼠标悬停在某个 commit 上约 0.45 秒，会弹出浮层显示：作者、相对时间与绝对时间、`hash + 变更统计（files changed / insertions / deletions）`、以及**完整 commit message**。浮层里有 **复制完整 message** 按钮，鼠标可移入浮层再点击复制。

### 3. 右键菜单

| 菜单项 | 作用 |
|--------|------|
| **复制 commit hash** | 复制完整 hash 到剪贴板 |
| **变基到此 commit** | 将此 commit 标记为 `edit`，rebase 停靠在此，便于在此点做改动（见「变基进行中」） |
| **变基到此 commit 并 push** | 把历史推进到此 commit 并推送（含锁定检查、可选评审 refspec，见下文） |
| **更改此 commit message** | 弹窗编辑 message，仅改该 commit 的 message，其余不变 |
| **更改 message 并变基至此** | 改完 message 后 rebase 停靠在此 commit |
| **为此 commit 生成 AI message** | 调用大模型根据该 commit 的 diff 生成 message（需先配置，见下文） |
| **锁定 commit / 解除锁定** | 锁定他人的提交，防止把它推送出去（见下文） |
| **删除 commit** | 从历史中移除该 commit（drop） |

### 4. commit message 编辑弹窗（reword / AI）
「更改 message」「更改 message 并变基至此」「为此 commit 生成 AI message」都会打开同一个 compose 弹窗：

- **原始 message**：只读、可选中复制，方便与新内容对比。
- **补充信息给 AI**（仅 AI 模式）：可填写额外上下文（如关联的链接、Issue 号），配合 **生成 / 重新生成** 按钮多次生成。
- **Commit message**：可编辑的结果框，AI 生成的内容会填入这里，可整体替换、也可从原始 message 复制部分内容拼接。
- **保留的 trailer**：若原 message 结尾含 `Change-Id:` / `Signed-off-by:` 等 trailer，会被单独识别并**只读展示**；应用时自动保留、不被修改（`IPCSDK-xxxx` 之类的行仍算正文，可编辑）。
- **应用 / 取消**：应用即写回该 commit（reword），并保留 trailer。

### 5. 为未提交的改动生成 message 并提交
当工作区有未提交改动、且已配置 LLM 时，面板顶部出现 **未提交的改动** 区，提供：
- **为暂存区生成并提交**：基于 `git diff --cached` 生成 message，确认后 `git commit`（仅提交暂存内容）。
- **为工作区生成并提交**：基于 `git diff HEAD` 生成 message，确认后 `git add -A && git commit`。

### 6. 变基进行中（暂停状态）
当选择「变基到此 commit」或发生冲突时，rebase 会**暂停**：
- 面板顶部出现黄色横幅 **变基进行中** + **Continue / Abort** 按钮。
- 暂停所在的 commit 行会**高亮**并显示 `⏸ 停在此` 徽章。
- 有冲突时，在编辑器解决并 `git add` 后点 **Continue**；想放弃点 **Abort**。
- 暂停期间无法发起新的变基操作，需先 Continue 或 Abort。

### 7. 脏工作区自动 stash
应用 reword / 变基时，若工作区有未提交改动，插件会**自动 stash**、变基完成后自动 `stash pop`。若变基暂停（冲突/edit 停靠），stash 会保留，并提示你完成后手动 `git stash pop`。

### 8. commit 锁定（防误推他人提交）
典型场景：你 cherry-pick 了别人的 commit A 作为依赖，在其之上写了自己的 B、C。推送时不应把别人的 A 一起推出去。

- 右键 A → **锁定 commit**（出现 🔒、左侧橙色条）。
- 之后执行 **变基到此 commit 并 push**，若推送范围里**包含**被锁定的 commit，会被**拒绝**并提示。
- 解决办法：把你要推的 commit 拖到锁定 commit **之前**（前提是无依赖），使推送范围不再包含它，再推送。
- 锁定采用 **git patch-id** 作为标识（并保留 hash 作为后备）。patch-id 在 cherry-pick / rebase 后保持稳定，因此**即使 commit hash 因变基而改变、或被 cherry-pick 到别处，锁定依然生效**，不会「莫名解锁」。
- 锁定状态持久化在插件全局状态里，**切换分支再切回、重载窗口都保持一致**。删除某锁定 commit（drop）会一并清除其锁定。

---

## 配置

在 VSCode 设置里搜索 `gitRebaseVisual`（或编辑 `settings.json`）。

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `gitRebaseVisual.commitRange` | `upstream` | 显示哪些 commit：`upstream`(`@{upstream}..HEAD`，未推送的) / `mainBranch`(`<main>..HEAD`) / `recentN`(最近 N 个) / `all`(全部历史) |
| `gitRebaseVisual.mainBranch` | `main` | `commitRange=mainBranch` 时的基准分支 |
| `gitRebaseVisual.recentCount` | `20` | `commitRange=recentN` 时显示的数量 |
| `gitRebaseVisual.llm.baseUrl` | `""` | OpenAI 兼容接口的 base URL，例如 `https://host/openai-compatible/v1` |
| `gitRebaseVisual.llm.apiKey` | `""` | API key |
| `gitRebaseVisual.llm.model` | `fast` | 模型名，如 `fast`、`expert` |
| `gitRebaseVisual.llm.skillPath` | `""` | 一个 markdown 文件的绝对路径；每次生成 message 都会把它作为规则发给模型，用于定制 message 风格 |
| `gitRebaseVisual.diffMaxChars` | `12000` | 发给模型的 diff 最大字符数，超出截断 |
| `gitRebaseVisual.push.refspecTemplate` | `""` | 评审推送的 refspec 模板，例如 `${tip}:refs/for/master`。占位符：`${tip}`（要推送的 commit）、`${branch}`（upstream 分支名）。设置后，推送时会让你选择推送方式；留空则为普通分支推送 |

### AI 生成 commit message 使用步骤
1. 填好 `llm.baseUrl` 与 `llm.apiKey`（未填时相关菜单/按钮为灰）。
2. （可选）在 `llm.skillPath` 指向一个规则 md，例如约定用 Conventional Commits、中文/英文、是否带 body、是否要求输出关联链接等。
3. 右键某 commit → **为此 commit 生成 AI message**，或在顶部 **未提交的改动** 区点生成按钮。
4. 弹窗中可在 **补充信息给 AI** 填写额外上下文，点 **生成 / 重新生成**；右下角显示「生成中…」（可取消）。
5. 生成结果填入 **Commit message** 框，可编辑；确认后 **应用**（保留 trailer），或 **取消** 丢弃。

> 若 skill 要求你提供链接等信息，模型可能会先要求补充——把这些内容填进 **补充信息给 AI** 再重新生成即可。

### 推送方式（普通 / 评审）
- 未配置 `push.refspecTemplate` 时，**变基到此 commit 并 push** 执行普通分支推送（`<tip>:refs/heads/<branch>`，带 `--force-with-lease`）。
- 配置了模板后，推送时弹出选择：**普通推送 / 评审推送（按模板，如 `refs/for/master`）/ 自定义 refspec…**。
- 推送到评审 ref（`refs/for/*`、`refs/drafts/*`）时**不加** `--force-with-lease`（这类 ref 无 force 语义）。

---

## 注意事项

- 变基/推送会**改写历史**。请在自己的功能分支上使用；普通分支推送用的是 `--force-with-lease`（会在远端被他人更新时自动中止，避免覆盖）。
- 重排相互**有依赖**的 commit 可能产生冲突，此时按「变基进行中」提示解决即可，这与命令行 `git rebase -i` 行为一致。
- 面板仅显示**本地分支**的 commit。
- 变基通过驱动原生 `git rebase -i` 实现，编辑器进程使用插件运行时的 node/Electron 可执行文件（`process.execPath`），因此在 vscode-server / 远程环境下即使 PATH 中没有 `node` 也能正常工作。
