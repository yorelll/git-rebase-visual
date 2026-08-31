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
直接拖动某个 commit 到目标位置松手，即可重排提交顺序（松手即时生效，后台自动执行 rebase）。拖动时按光标落在目标行的**上半区 / 下半区**决定插入到其**前 / 后**（对应蓝色上/下指示线），因此可以把某个 commit 拖到**列表最末位**（落在最后一行的下半区）。

### 2. 悬停查看详情
鼠标悬停在某个 commit 上约 0.4 秒，会弹出浮层：
- 顶部：**作者**（加粗）+ 相对/绝对时间（浅灰，带分隔线）。
- 灰底小徽章：`hash + 变更统计（files changed / insertions / deletions）`。
- **完整 commit message**：放在带左侧强调边框的独立框里，与元信息层次分明、可选中；message 过长时框内可滚动，浮层保持紧凑、不会覆盖整列 commit。
- **复制完整 message** 按钮：鼠标可移入浮层再点击复制。

> 所有插件弹出的提示（复制成功、变基结果、推送结果等）会在 **10 秒后自动消失**。

### 3. 右键菜单

| 菜单项 | 作用 |
|--------|------|
| **复制 commit hash** | 复制完整 hash 到剪贴板 |
| **变基到此 commit** | 将此 commit 标记为 `edit`，rebase 停靠在此，便于在此点做改动（见「变基进行中」） |
| **更改此 commit message** | 弹窗编辑 message，仅改该 commit 的 message，其余不变 |
| **更改 message 并变基至此** | 改完 message 后 rebase 停靠在此 commit |
| **为此 commit 生成 AI message** | 调用大模型根据该 commit 的 diff 生成 message（需先配置，见下文） |
| **将暂存区文件添加到此 commit** | 将当前暂存区追加到选中 commit，自动重放其后的提交；会改写该 commit 及其后的历史（见下文） |
| **锁定 commit / 解除锁定** | 锁定他人的提交，防止把它推送出去（见下文） |
| **删除 commit** | 从历史中移除该 commit（drop） |

### 4. commit message 编辑弹窗（reword / AI）
「更改 message」「更改 message 并变基至此」「为此 commit 生成 AI message」都会打开同一个 compose 弹窗：

- **原始 message**：只读、可选中复制，方便与新内容对比。
- **补充信息给 AI**（仅 AI 模式）：可填写额外上下文（如关联的链接、Issue 号），配合 **生成 / 重新生成** 按钮多次生成。
- **Commit message**：可编辑的结果框，AI 生成的内容会填入这里，可整体替换、也可从原始 message 复制部分内容拼接。
- **保留的 trailer**：若原 message 结尾含 `Change-Id:` / `Signed-off-by:` 等 trailer，会被单独识别并**只读展示**；应用时自动保留、不被修改（`IPCSDK-xxxx` 之类的行仍算正文，可编辑）。
- **应用 / 取消**：应用即写回该 commit（reword），并保留 trailer。

### 5. 将暂存区文件添加到已有 commit
先通过 VSCode 源代码管理（或 `git add`）把要追加的文件放入暂存区，再右键目标 commit → **将暂存区文件添加到此 commit**。

- 插件会用原 message 执行 `git commit --amend --no-edit`，随后自动重放目标 commit 之后的提交；因此目标 commit 和其后的 hash 会变化。
- 被锁定的 commit 不允许追加，须先明确解除锁定，避免修改依赖提交后绕过推送保护。
- 若目标 commit 已包含在 upstream 中，确认弹窗会明确提示：操作会改写已推送历史，完成后需要用插件的 Push（`--force-with-lease`）更新远端。
- 若有未暂存改动，插件会临时 stash 并在完成后恢复；只有操作开始时已暂存的内容会被追加。
- 发生冲突或无法自动重放时，Git 保持可恢复状态并提示错误；请在 VSCode/终端解决后执行 `git rebase --continue` 或 `git rebase --abort`。

### 6. 流式 AI message、Push 诊断与实时状态

- **流式 AI message**：AI 生成结果会随着 SSE 响应逐步填入 message 输入框；可在 VS Code 通知中取消。`llm.timeoutMs`（默认 120000）可限制单次生成的最长等待时间。
- **安全错误提示**：LLM 认证失败、限流和服务端错误会显示分类提示，不会把服务端响应正文展示到界面中。
- **可取消 Push**：Push 显示可取消进度；Push 或其他 provider 操作失败时，可在 VS Code 的 **Output → Git Rebase Visual** 查看诊断摘要。
- **自动刷新暂存状态**：通过 VS Code 源代码管理或终端 `git add` 暂存文件后，面板会自动更新菜单状态；无需手动点击 Refresh。
- **危险操作确认**：删除 commit 前会显示目标 commit 与历史重写确认；edit 停靠横幅会明确显示当前目标及 Continue / Abort 下一步。

### 测试与发布校验

- 本地执行 `npm run test`：运行逻辑、边界和真实 Git 临时仓库集成测试。
- 本地执行 `npm run test:coverage`：在上述测试基础上输出 Node 测试覆盖率报告。
- 推送版本标签触发 Release 时，GitHub Actions 会依次执行类型检查、覆盖率测试、VSIX 打包、VSIX 内容检查以及 RELEASE.md 版本记录检查；任一步失败都不会创建 Release。

### 7. 为未提交的改动生成 message 并提交
当工作区有未提交改动、且已配置 LLM 时，面板顶部出现 **未提交的改动** 区，提供：
- **为暂存区生成并提交**：基于 `git diff --cached` 生成 message，确认后 `git commit`（仅提交暂存内容）。
- **为工作区生成并提交**：基于 `git diff HEAD` 生成 message，确认后 `git add -A && git commit`。

### 8. 变基进行中（暂停状态）
当选择「变基到此 commit」或发生冲突时，rebase 会**暂停**：
- 面板顶部出现黄色横幅 **变基进行中** + **Continue / Abort** 按钮。
- 暂停所在的 commit 行会**高亮**并显示 `⏸ 停在此` 徽章。
- 有冲突时，在编辑器解决并 `git add` 后点 **Continue**；想放弃点 **Abort**。
- 暂停期间无法发起新的变基操作，需先 Continue 或 Abort。

### 9. 顶部工具栏（Push / Stash / Pop / Refresh）
面板顶部工具栏提供：
- **Push**：**普通推送**（推送当前 HEAD）。
  - 推送前做锁定检查（范围 `<upstream>..HEAD`）：若含被锁定 commit 则拒绝。
  - 若配置了 `push.refspecTemplate`，弹出选择：**普通推送 / 评审推送 / 自定义 refspec…**。
  - **变基过程中也可推送**：例如用「变基到此 commit」停靠后，在该 commit 上改代码并 commit，可直接点 **Push** 推送这个 commit（此时 HEAD 处于 detached，插件会用正在变基的分支解析其 upstream）。锁定检查依然生效——**不允许推送越过被锁定的 commit**。
  - 推送与变基解耦，避免 Gerrit 因「无改动」拒绝合并式推送。
- **Stash**（archive 图标）：把当前未提交改动 `git stash push -u`（默认命名）。
- **Pop**（inbox 图标）：`git stash pop` 恢复最近一次 stash。
- **Refresh**：刷新列表。

> Stash / Pop 按钮主要用于**手动 stash 模式**（见下）：你自行 stash 后再执行变基相关操作，完成后再 pop。

### 10. 脏工作区自动 stash（可切换）
`gitRebaseVisual.autoStash`（默认开启）控制变基时对未提交改动的处理：
- **自动（默认）**：变基前自动 stash，变基**完全结束后**（或你点 Continue / Abort 后）自动恢复。若变基暂停（冲突 / edit 停靠），stash 会保留、**不会**中途 pop，待你 Continue/Abort 时再恢复——避免基于中间状态 pop 导致冲突。仅在确实做了 stash 时才提示/恢复，工作区干净时不会有多余通知。
- **手动**（关闭 autoStash）：若工作区/暂存区有内容导致无法变基，直接弹警告，请你用顶部 **Stash** 按钮或自行 `git stash` 后再操作，完成后用 **Pop** 恢复。

> 恢复采用 stash 的**提交 sha** 作为标识（不依赖会被变基改写的 commit hash）。若你在终端自行 continue 并 pop 了 stash，插件下次刷新时会检测到该 stash 已不存在并静默清理，不会重复 pop，避免状态不同步。

### 11. commit 锁定（防误推他人提交）
典型场景：你 cherry-pick 了别人的 commit A 作为依赖，在其之上写了自己的 B、C。推送时不应把别人的 A 一起推出去。

- 右键 A → **锁定 commit**（出现 🔒、左侧橙色条）。
- 点顶部 **Push** 时，若推送范围（`@{upstream}..HEAD`）里**包含**被锁定的 commit，会被**拒绝**并提示。
- 解决办法：把锁定的 commit 移出推送范围（拖到你要推送的提交之后，或先 drop），再推送。
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
| `gitRebaseVisual.llm.timeoutMs` | `120000` | 等待 LLM 响应的最长时间（毫秒），超时后自动取消请求 |
| `gitRebaseVisual.diffMaxChars` | `12000` | 发给模型的 diff 最大字符数，超出截断 |
| `gitRebaseVisual.push.refspecTemplate` | `""` | 评审推送的 refspec 模板，例如 `HEAD:refs/for/master`。占位符：`${tip}`（解析为 HEAD）、`${branch}`（upstream 分支名）。设置后，推送时会让你选择推送方式；留空则为普通分支推送 |
| `gitRebaseVisual.autoStash` | `true` | 变基前是否自动 stash 脏工作区并在结束后恢复。关闭则改为手动模式：脏工作区会阻止变基并提示你自行 stash |

### AI 生成 commit message 使用步骤
1. 填好 `llm.baseUrl` 与 `llm.apiKey`（未填时相关菜单/按钮为灰）。
2. （可选）在 `llm.skillPath` 指向一个规则 md，例如约定用 Conventional Commits、中文/英文、是否带 body、是否要求输出关联链接等。
3. 右键某 commit → **为此 commit 生成 AI message**，或在顶部 **未提交的改动** 区点生成按钮。
4. 弹窗中可在 **补充信息给 AI** 填写额外上下文，点 **生成 / 重新生成**；右下角显示「生成中…」（可取消）。
5. 生成结果填入 **Commit message** 框，可编辑；确认后 **应用**（保留 trailer），或 **取消** 丢弃。

> 若 skill 要求你提供链接等信息，模型可能会先要求补充——把这些内容填进 **补充信息给 AI** 再重新生成即可。

### 推送方式（普通 / 评审）
- 顶部 **Push** 按钮执行普通推送（推送 HEAD）。
- 未配置 `push.refspecTemplate` 时为普通分支推送（`HEAD:refs/heads/<branch>`，带 `--force-with-lease`）。
- 配置了模板后，推送时弹出选择：**普通推送 / 评审推送（按模板，如 `HEAD:refs/for/master`）/ 自定义 refspec…**。
- 推送到评审 ref（`refs/for/*`、`refs/drafts/*`）时**不加** `--force-with-lease`（这类 ref 无 force 语义）。

---

## 注意事项

- 变基/推送会**改写历史**。请在自己的功能分支上使用；普通分支推送用的是 `--force-with-lease`（会在远端被他人更新时自动中止，避免覆盖）。
- 重排相互**有依赖**的 commit 可能产生冲突，此时按「变基进行中」提示解决即可，这与命令行 `git rebase -i` 行为一致。
- 面板仅显示**本地分支**的 commit。
- 变基通过驱动原生 `git rebase -i` 实现，编辑器进程使用插件运行时的 node/Electron 可执行文件（`process.execPath`），因此在 vscode-server / 远程环境下即使 PATH 中没有 `node` 也能正常工作。
