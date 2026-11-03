# Git Rebase Visual

一款用于**可视化交互式变基**的 VSCode 插件。把 `git rebase -i` 的能力封装成侧边栏里的可拖拽 commit 列表：拖动重排、改 message、锁定他人提交防止误推、还能用大模型生成 commit message。

底层驱动原生 `git rebase -i`（通过自定义 sequence editor 注入 todo），行为与命令行一致，冲突走 git 原生流程。

---

## 安装

安装与打包步骤见仓库根目录的 `RELEASE.md`。开发调试可在项目根目录按 `F5` 启动 Extension Development Host。

## 打开面板

安装后左侧活动栏出现 **Git Rebase** 图标，点击展开 **Commits** 面板。面板会显示当前分支**尚未推送**的 commit（默认范围，见下文配置）。

- 列表**从上到下 = 从旧到新**（顶部标记为 **Base / 较早**，底部标记为 **HEAD / 较新**），与交互式 rebase todo 的执行顺序一致。
- 每个 commit 以 message 为主信息（最多两行）；短 hash、作者和日期显示在次级元信息行。行首的中性圆点/时间轴用于浏览，`🔒` 表示锁定。
- 顶部工具栏提供 **Push / Stash / Pop / Undo / Refresh**，右键菜单按查看、变基与编辑、保护、危险操作分组。

---

## 功能一览

所有操作都通过**拖拽**或**右键菜单**触发。

### 1. 拖拽重排
拖动某个 commit 时，行首 grip 与插入线会提示拖拽状态；目标行会明确显示插入到其**之前（较早）/之后（较新）**。松手后会显示历史改写确认，确认后执行 rebase。完成后在通知与 **Git Rebase Visual** Output 中显示操作、old tip、new tip 和受影响 commit 数。拖到最后一行下半区可移动到列表最末位。

### 2. 悬停查看详情
鼠标悬停在某个 commit 上约 0.4 秒，详情浮层会显示在**侧栏内**、贴近该行的位置，不会切换到编辑器区，也不会永久遮挡列表：
- 顶部显示 **作者**、相对/绝对时间以及 `hash + 变更统计（files changed / insertions / deletions）`。
- 浮层中可直接点 `⧉` 复制完整 message、点 `◫` 打开变更 Diff；指针移入浮层后不会立刻消失，移出后自动关闭。
- 右击 commit 或按 `Shift+F10` / Menu 键会在**同一侧栏**内打开操作菜单（见下一节），不会新开编辑器面板；点击编辑器或切换窗口时菜单自动关闭。

> 侧栏内的成功提示（如 Refresh 的“已刷新”、复制、变基结果、推送结果）会短暂显示在 branch context 区域，不推动 commit 列表。

### 3. 右键菜单

| 菜单项 | 作用 |
|--------|------|
| **复制 hash / 复制 message** | 分别复制完整 hash 或 message 到剪贴板 |
| **打开变更… / 生成 Diff…** | 打开该 commit 的变更 Diff；生成 Diff 使用扩展私有的只读 snapshot |
| **编辑 message…** | 打开 compose 弹窗，仅改该 commit 的 message，其余不变 |
| **AI 生成 message…** | 调用大模型根据该 commit 的 diff 生成 message（需先配置，见下文） |
| **追加暂存区** | 将当前暂存区追加到选中 commit，自动重放其后的提交；会改写该 commit 及其后的历史（见下文）。目标锁定、暂存区为空或 rebase 中时会禁用并说明原因 |
| **合并到上一个 (squash) / 合并到上一个，丢弃 message (fixup)** | 把该 commit 与前驱合并；首项、当前或前驱被锁定、rebase 中会禁用并说明原因 |
| **停靠在此 (edit)** | 将此 commit 标记为 `edit`，rebase 停靠在此，便于在此点做改动（见「变基进行中」） |
| **锁定 commit / 解除锁定** | 锁定他人的提交，防止把它推送出去（见下文） |
| **删除 commit (drop)** | 从历史中移除该 commit；锁定 commit 须先解除锁定，且会显示二次确认 |

多选 ≥2 个 commit 后，菜单提供 **批量锁定 commit**、**批量删除 commit** 与连续区间的 **生成 Diff…**；其余单项操作会禁用并说明原因。

### 4. commit message 编辑弹窗（reword / AI）
右键菜单的 **编辑 message…** 与 **AI 生成 message…**、顶部 **未提交的改动** 区的 **仅生成 message（不提交）**、以及 edit 停靠时的 **追加到 … (amend)…** / **新建 commit…** 都会打开同一个 compose 弹窗：

- **原始 message**：只读、可选中复制，方便与新内容对比。
- **补充信息给 AI**（仅 AI 模式）：可填写额外上下文（如关联的链接、Issue 号），配合 **生成 / 重新生成** 按钮多次生成。
- **Commit message**：可编辑的结果框，AI 生成的内容会填入这里，可整体替换、也可从原始 message 复制部分内容拼接。
- **保留的 trailer**：若原 message 结尾含 `Change-Id:` / `Signed-off-by:` 等 trailer，会被单独识别并**只读展示**；应用时自动保留、不被修改（`IPCSDK-xxxx` 之类的行仍算正文，可编辑）。
- **应用 / 取消**：应用期间对话框保留并锁定输入，只有宿主 Git 操作成功后才关闭；失败时保留手写 message、在对话框内显示错误并可重试。支持 `Ctrl/Cmd+Enter` 应用、`Esc` 取消。
- 支持基础键盘/无障碍操作：提交列表、菜单和弹窗带语义与焦点环；按 `Shift+F10` 或 Menu 键可打开当前 commit 的操作菜单。

### 5. 追加暂存区（把暂存区文件添加到已有 commit）
先通过 VSCode 源代码管理（或 `git add`）把要追加的文件放入暂存区，再右键目标 commit → **追加暂存区**。

- 插件会用原 message 执行 `git commit --amend --no-edit`，随后自动重放目标 commit 之后的提交；因此目标 commit 和其后的 hash 会变化。
- 被锁定的 commit 不允许追加，须先明确解除锁定，避免修改依赖提交后绕过推送保护。
- 若目标 commit 已包含在 upstream 中，确认弹窗会明确提示：操作会改写已推送历史，完成后需要用插件的 Push（`--force-with-lease`）更新远端。
- 若有未暂存改动，插件会临时 stash 并在完成后恢复；只有操作开始时已暂存的内容会被追加。**追加到任何早于 tip 的 commit 都支持**：插件把快照拆成“工作区 / 暂存区 / 未跟踪”三部分、各自从自己的树恢复，因此后续 commit 才引入的文件不会被牵扯进本次追加。
- 发生冲突或无法自动重放时，Git 保持可恢复状态并提示错误；请在 VSCode/终端解决后执行 `git rebase --continue` 或 `git rebase --abort`。
- 若失败发生在“写入目标 commit”之前，提示会明确说明**此时不能 Continue**（暂存内容尚未写入目标 commit），请用 **Abort** 自动恢复原始改动。
- 判断“这次 stash 是否真的创建了条目”只看**前后 sha 集合差**，不看 `git stash push` 的提示文案（`No local changes to save` 是会被翻译的 gettext 文案；依赖它会在非英语环境下把用户已有的 `stash@{0}` 记成插件创建的条目）：恰好新增一个才是自己的，没有新增（没东西可存）或有多个新增（并发 push）都不认领。
- 若追加过程中插件退出（重载窗口、崩溃、卸载重装），下一次启动会以**真实 Git 状态**对账，而不是相信上次保存的标记：rebase 是否仍在进行、stash 是否仍在 `git stash list`、stash 的内容是否**已经存在于** index/worktree。内容已在 = 视为已恢复，静默清掉记录、不重复恢复、不弹警告；stash 内容尚未落地则按“工作区 / 暂存区 / 未跟踪”三段各自从自己的树恢复。注意“暂存区与快照一致”**不等于**追加已完成：若目标仍是 HEAD 祖先且变基仍在进行中，记录会保持 `pending` 并提示追加未完成，只有内容被确认进入 `HEAD`（或记录标记已 amend）才算落地。**插件只删除自己创建的 stash 条目，从不碰你自己压入的条目**。恢复本身始终只写内容（`git stash apply` / `git restore` / `git checkout`，绝不用 `pop`），只有在内容被**完整确认**（列表仍在、索引复现暂存那一半、worktree 复现改动、未跟踪文件逐字节一致，四处均为正面探测，`stashPresence().complete`）之后，才把插件自己那条临时条目删掉——此时它的内容已存在于条目之外，删除只是记账，不会丢失任何字节。结算后 `git stash list` 与你让插件动手之前**完全一致**（按 sha 集合比较），你压入的条目在整个过程中不会被删除或移动。确认不了（模式位不同、revert 形状的 amend、重命名、字节巧合、探测失败等）就保留记录、横幅和条目三样东西，并在横幅里给出可一键复制的恢复命令；这一类条目**只会在你明确要求时**由你删除——提示里会点名当前 `stash@{n}`（附稳定 sha）并给出可直接复制的 `git stash drop stash@{n}`，插件自己不会在未确认的情况下动手。对账**失败即保守**：任何一项探测（读 `^1`/`^2`/`^3` 对象、`git ls-tree`、`git diff`、`git stash list`）出错时都判定为“未知”而不是“已恢复”。

### 6. 流式 AI message、Push 诊断与实时状态

- **流式 AI message**：AI 生成结果会随着 SSE 响应逐步填入 message 输入框；可在 VS Code 通知中取消。`llm.timeoutMs`（默认 120000）可限制单次生成的最长等待时间。
- **安全错误提示**：LLM 认证失败、限流和服务端错误会显示分类提示，不会把服务端响应正文展示到界面中。
- **可取消 Push**：Push 显示可取消进度；Push 或其他 provider 操作失败时，可在 VS Code 的 **Output → Git Rebase Visual** 查看诊断摘要。
- **操作互斥提示与恢复**：同一时间只允许一个写操作。被拒绝时会说明**正在执行什么**、来自哪里、已耗时多久，例如 `正在执行 “变基重排” (reorder, webview, 12s)；请等待完成，或点击“强制解除”。`；若操作超过 90 秒仍未结束，会弹出带 **强制解除并刷新** 的警告。强制解除不会盲信内存状态，而是重新读取 Git 的 rebase 标记、冲突文件和 commit 列表后再刷新，因此在终端里已经结束或手动恢复的仓库是安全的。
- **日志**：一次扩展会话一个日志文件，位于 `<用户主目录>/tmp/log/git-rebase-visual-<版本>/session-<时间>-<pid>.log`（Linux/macOS 即 `~/tmp/log/git-rebase-visual-0.8.2/`，Windows 为 `C:\Users\<用户>\tmp\log\git-rebase-visual-0.8.2\`）。可用命令 **Git Rebase: Open Logs**（`gitRebaseVisual.openLogs`）直接打开该目录。0.8.1 之前的日志写在系统临时目录（Linux/macOS 的 `/tmp/log/...`、Windows 的 `%TEMP%\log\...`），这些旧文件**没有迁移也没有删除**；每个扩展会话首次打开日志目录时，**Output → Git Rebase Visual** 会追加一行说明旧日志的位置。日志包含 Output 中的诊断、写锁获取/释放、webview 操作、每次 Git 调用的参数/退出码/耗时、rebase 状态变化与异常堆栈，并对 URL userinfo、Authorization、token/password 等凭据做脱敏；写入失败（只读目录、磁盘满）只会关闭文件日志，不影响插件功能。每个日志文件与 **Output → Git Rebase Visual** 的第一行都是会话头，写明扩展版本、扩展安装路径、VS Code 版本、扩展宿主 pid 与操作系统，可用来确认当前运行的是哪一个构建。
- **待恢复改动与 Reset Extension State**：若遗留的追加/自动 stash 记录在启动对账后仍无法自动恢复，侧栏会显示一条可关闭的“待恢复的改动”横幅（commit 列表照常显示，不会被记录挡住），并提供 **打开日志** / **关闭提示**；同一条警告（同一 stash sha + 原因）只弹一次，后续轮询只写文件日志；关闭横幅后不会在下一次轮询里重新弹出，只有出现**不同**的问题才会再次提示。恢复动作按记录单飞（single-flight），1.5 秒轮询、工作区事件与读取消息重叠时只会执行一次恢复。恢复会**获取同一把写锁**：写操作进行中时整轮跳过、下一次空闲轮询再试，绝不与 rebase 并发写同一个 index。对账本身不在渲染路径上——commit 列表先显示，对账在其后异步进行；持续无法解决时按指数退避重试（最长 30 秒），不会每 1.5 秒重复探测。命令 **Git Rebase: Reset Extension State**（`gitRebaseVisual.resetState`）会先做同样的 Git 对账——内容已确认回来的插件条目会像正常轮询一样被结算删除——之后再清理已成为孤儿的状态记录；**你自己压入的 stash 在任何情况下都不会被它删除**。它会报告清理了什么、保留了什么、日志目录位置。手动 `git stash apply --index` 恢复后，下一次刷新会自动识别、静默清除记录，并删掉插件自己那条临时条目。横幅与 reset 报告都会列出可直接执行的下一步，例如 `git stash apply --index <name>`（恢复暂存区与工作区）、`git stash apply <name>`（只恢复工作区）、以及在你确认不再需要后才执行的 `git stash drop <name>`；这里列出的条目都是**内容尚未被确认恢复**的插件自己的条目，此时自动路径不会删它们，只有你自己动手。`stash@{n}` 只是**位置**而不是名字：每一轮恢复检查都会重新解析它（不是缓存在首次出现的值上），并始终同时给出稳定的 sha；当槽位无法解析时（例如 stash reflog 损坏），命令回退到 sha（`git stash apply --index <sha>`，Git 接受），并且**不再提供 drop**——Git 没有按 sha 的 `stash drop`，这样的命令只会失败。
- **自动刷新暂存状态**：通过 VS Code 源代码管理或终端 `git add` 暂存文件后，面板会自动更新菜单状态；无需手动点击 Refresh。后台只读状态查询使用 `GIT_OPTIONAL_LOCKS=0`，避免与终端 `git switch` / `git stash` 的 optional `index.lock` 刷新竞争。
- **危险操作确认**：删除 commit 前会显示目标 commit 与历史重写确认；edit 停靠横幅会明确显示当前目标及 Continue / Abort 下一步。

### 7. 文件级 SCM、连续生成 Diff 与可靠交互（0.7.0）

- **文件级工作区恢复**：在既有 **Staged Changes / Changes** 的 Git porcelain v2 结构化列表上，支持单文件暂存、working/staged restore 和经确认删除未跟踪文件。文件名或打开按钮继续使用原生 VS Code `vscode.diff` 展示 index ↔ working、HEAD ↔ index 或 commit parent ↔ commit 的左右 Diff；rename、delete、root、nested path、binary 与多文件选择均有受控处理。
- **连续区间生成 Diff**：右键单个 commit，或 Ctrl/Cmd 多选时间轴中无空洞的连续 commit，可生成扩展私有的只读 Diff snapshot。非连续选择会置灰并说明“仅支持连续 commit”；host 会独立拒绝未知、重复、过期或有空洞的请求，不能通过伪造 webview message 绕过。
- **选择与右键一致性**：普通单击只更新 active context；Ctrl/Cmd+单击才切换多选。右击未选 commit 会先清除旧集合并以该 commit 作为单项目标，右击已选 commit 才保留批量 lock/drop/Diff 集合。
- **IME 与重排稳定性**：筛选支持 `author:`、`msg:`、`hash:` 和 `hash:0x...`，中文 IME composition 期间不会重建输入框或触发全局快捷键。pointer/native drag 会保留开始时的 revision 与完整 canonical order；拖拽中收到刷新时，旧手势不会按新列表重新解释。`Alt+↑/↓` 可作为单项一步重排兜底。
- **暂停 rebase 的文件写入策略**：stage/restore 是受 busy 串行化的 mutation；仅 edit stop 的明确 allow-list 可在暂停期间执行。滚动、选择、IME、刷新和只读 Diff 均为无副作用流量，不会反复显示 paused-rebase 警告。

### 8. 受控 Undo、步骤进度与编辑器 Compose（0.6.0）

- **受控 Undo**：每次成功历史改写都会记录私有 checkpoint、操作、before/after tip；工具栏、成功结果和历史入口可撤销。Undo 会验证当前分支、HEAD、工作区、rebase 状态、checkpoint 与已推送风险，优先使用 `git reset --keep`，不会把 `ORIG_HEAD + reset --hard` 作为不安全快捷方式。
- **rebase 状态模型**：横幅与状态栏显示步骤 `N/M`、edit/conflict/paused 原因、冲突文件与待重放数量；待重放 commit 明确提示 hash 将在 Continue 后变化。无法可靠解析的外部 rebase 会显示未知状态，而不伪造进度。
- **停靠工作区与 Skip**：edit 停靠提供 Amend 当前 commit、新建 commit、仅生成 message；Skip 仅在冲突暂停时可用，且会确认即将丢弃的 patch。
- **更完整的操作能力**：支持 squash、fixup、复制 message 和只读 diff；首项、locked 当前/前驱及 rebase 中等不安全场景会禁用并解释。
- **编辑器区 Compose Panel**：message 编辑迁移到独立编辑器区 Panel，支持 subject/body、50/72 提示、72 列参考、折叠原 message/trailer、AI cancel/replace/append/恢复 draft。
- **筛选与键盘**：支持搜索、Ctrl/Cmd 多选、连续 locked run 安全折叠；可用 Space、Arrow、Home/End、Alt+Arrow 和 Escape 完成键盘重排，菜单支持方向键导航。

### 测试与发布校验

- 本地执行 `npm run test`：运行逻辑、边界和真实 Git 临时仓库集成测试（`scripts/run-tests.js` 枚举全部 `test/*.test.ts`，由 Node 按文件并发 3 调度）。
- 本地执行 `npm run test:coverage`：在上述测试基础上输出 Node 测试覆盖率报告。
- 推送版本标签触发 Release 时，GitHub Actions 会依次执行类型检查、覆盖率测试、VSIX 打包、VSIX 内容检查以及 RELEASE.md 版本记录检查；任一步失败都不会创建 Release。

### 9. 为未提交的改动生成 message 并提交
当工作区有未提交改动时，面板顶部出现 **未提交的改动** 区；展开 **更多提交选项** 后提供：
- **AI 生成 message 并提交暂存区**（Staged Changes 分组右侧的 `✦`，需先配置 LLM）：基于暂存内容生成 message，确认后提交暂存区（`git commit -s`，仅提交暂存内容）。
- **仅生成 message（不提交）**（需先配置 LLM）：基于暂存内容（无暂存时基于工作区）生成草稿，只复制到弹窗，不执行任何 Git 写操作。
- 文件行的 `+`、`↶`、`⌫` 分别用于暂存单个文件、恢复单个文件的工作区改动或撤销其暂存、删除未跟踪文件；分组标题提供 **暂存全部更改 / 恢复全部更改** 与 **撤销全部暂存**。

### 10. 变基进行中（暂停状态）
当选择「变基到此 commit」或发生冲突时，rebase 会**暂停**：
- 面板顶部出现**变基进行中**横幅 + **Continue / Abort** 按钮；Abort 会先要求确认。
- 暂停所在的 commit 行会**高亮**并显示 `⏸ 停在此` 徽章；横幅区分冲突、显式 edit 停靠和其它暂停状态。
- 有冲突时横幅会显示冲突文件；Continue 会禁用，直到你在编辑器解决冲突并 `git add`。宿主在 Continue 前还会再次检查 Git 冲突状态。
- 暂停期间无法发起新的历史改写操作，需先 Continue 或 Abort。
- **Abort 永不删除你的文件**。如果 `git rebase --abort` 因为工作区里有未跟踪文件（或目录）会被回退覆盖而失败，扩展会**中止并列出这些路径**，明确告诉你“没有删除任何文件”，并给出可复制的 `mv` 命令（路径已按 POSIX shell 正确转义，含 `'`、空格、换行、前导 `-`、反引号或 `$` 的文件名也能直接粘进终端——这一点由一条把每个恶意文件名丢进真实 `sh` 往返比对的单测保证）。你把这些路径移出仓库（或改名）后再点一次 Abort 即可完成；变基仍停在暂停状态，停在这里不会有任何损失。至于 stash，消息会**按 `git stash list` 的实测结果**来说：有条目就报条数，为空就明说为空、并说明你的工作区原封未动——不会让你去一条并不存在的 stash 里找东西。即使某个文件看起来像构建产物、你愿意删掉它，这个决定也由你来做——扩展不会替你删。

### 11. 顶部工具栏（Push / Stash / Pop / Undo / Refresh）
面板顶部工具栏提供：
- **Push**：**普通推送**（推送当前 HEAD）。
  - 推送前做锁定检查（范围 `<upstream>..HEAD`）：若含被锁定 commit 则拒绝。
  - 若配置了 `push.refspecTemplate`，弹出选择：**普通推送 / 评审推送 / 自定义 refspec…**。
  - **变基过程中也可推送**：例如用「变基到此 commit」停靠后，在该 commit 上改代码并 commit，可直接点 **Push** 推送这个 commit（此时 HEAD 处于 detached，插件会用正在变基的分支解析其 upstream）。锁定检查依然生效——**不允许推送越过被锁定的 commit**。
  - 推送与变基解耦，避免 Gerrit 因「无改动」拒绝合并式推送。
- **Stash**（archive 图标）：把当前未提交改动 `git stash push --include-untracked`（含未跟踪文件）。
- **Pop**（inbox 图标）：确认后执行 `git stash pop` 恢复**并删除**最近一次 stash（冲突时 Git 会保留该条目）。这是插件里唯一会删除**任意** stash（包括你自己的）的操作，必须由你点击并在弹窗中确认；恢复流程与对账永不调用它，它们只按 sha 删除插件自己创建的条目。
- **Undo**（discard 图标）：撤销最近一次成功的历史改写；会先校验分支、HEAD、工作区、rebase 状态与已推送风险（见第 8 节）。
- **Refresh**：刷新列表。

stash 槽位提示：恢复冲突提示、待恢复横幅与 reset 报告都会给出精确的 `stash@{n}` 与稳定 sha；需要完整列表时可用 VS Code 源代码管理视图或 `git stash list`。

- `git stash apply` 恢复内容之后仍可能“看起来一致、其实差一半”：`git diff --name-only` 默认会把一次**重命名**折叠成只剩目标路径，于是快照里“暂存了 `a.txt → b.txt`”只被当作 `b.txt` 一件事。插件所有枚举路径的 diff 都带 `--no-renames`，重命名的删除与新增两半都会被逐一核对，因此只还原目标文件不会被误判为“内容已全部回来”。

> Stash / Pop 按钮主要用于**手动 stash 模式**（见下）：你自行 stash 后再执行变基相关操作，完成后再 pop。

### 12. 脏工作区自动 stash（可切换）
`gitRebaseVisual.autoStash`（默认开启）控制变基时对未提交改动的处理：
- **自动（默认）**：变基前自动 stash，变基**完全结束后**（或你点 Continue / Abort 后）用 `git stash apply` 自动恢复内容，确认内容完整回来后再删除**插件自己那条**条目——`git stash list` 会回到你原来的样子，你自己的条目不会被动。若变基暂停（冲突 / edit 停靠），stash 会保留、不会中途应用，待你 Continue/Abort 时再恢复，避免基于中间状态恢复导致冲突。仅在确实做了 stash 时才提示/恢复，工作区干净时不会有多余通知。
- **手动**（关闭 autoStash）：若工作区/暂存区有内容导致无法变基，直接弹警告，请你用顶部 **Stash** 按钮或自行 `git stash` 后再操作，完成后用 **Pop**（会先确认）恢复。

> 恢复采用 stash 的**提交 sha** 作为标识（不依赖会被变基改写的 commit hash）。若你在终端自行 continue 并 pop 了 stash，插件下次刷新时会检测到该 stash 已不存在并静默清理记录，不会重复恢复，避免状态不同步。
>
> **插件只删除自己创建的 stash 条目。** 恢复成功后，插件会把自己那条临时条目删掉，因此 `git stash list` 与你让插件动手之前完全一致，你压入的条目不会被挡在后面、也不会被删除。自动化语义本来就是 stash → rebase → pop，而 `pop` 会删条目；用 `apply` 恢复内容、确认内容回来后删除自己的条目，效果与 `pop` 相同，但失败时不会吞掉唯一副本。`stash@{n}` 只是**位置**：插件按 sha 解析槽位、删除前再确认该槽位仍指向自己的 sha（期间你压入了新 stash 就拒绝删除并说明），删除后再核对 Git 实际删掉的是哪一个条目——判据是删除前后的 sha 集合，而不是 Git 那句会被翻译成其他语言的 `Dropped …`；只删掉自己那条要求删除前快照里没有别的条目同时消失（删除窗口内并发删掉自己那条、又误删你那条时，两条都会消失，你那条会被认出来并复原），同时消失多条则拒绝并点名而不是猜，删除前快照读不出来时消息会写明未做交叉核对（这条说明会同时进入日志与弹出提示，而不是只在 Git 模块里生成后被丢掉）。删除前的列表**读不出来**（reflog 损坏时 `git stash list` 退出码为 0 却什么都不打印）时，删除**直接拒绝**、不写任何内容——插件不会把“读不出”当成“已经没有这个条目”。万一删错会用 `git stash store` 原样恢复（复原后该条目会回到列表**最上方**，它的 reflog 说明 `%gs`——`git stash list` 显示的那行——变为 `git-rebase-visual restored <sha7>`，而 stash commit 的标题 `%s`——`git log` 显示的那行——不变，内容与 commit 也不变）。同一个 sha 同时出现在多个槽位（例如你对仍在列表里的条目执行过 `git stash store`）时一律拒绝删除并报告，两个条目都保留。内容未能完整确认时不删除，改为弹一次提示，点名 `stash@{n}`（附 sha）并给出可直接复制的 `git stash drop stash@{n}`。

### 13. commit 锁定（防误推他人提交）
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
| `gitRebaseVisual.collapseLockedRuns` | `true` | 是否折叠连续三个及以上的 locked commit；关闭后始终完整显示时间轴 |

### AI 生成 commit message 使用步骤
1. 填好 `llm.baseUrl` 与 `llm.apiKey`（未填时相关菜单/按钮为灰）。
2. （可选）在 `llm.skillPath` 指向一个规则 md，例如约定用 Conventional Commits、中文/英文、是否带 body、是否要求输出关联链接等。
3. 右键某 commit → **AI 生成 message…**，或在顶部 **未提交的改动** 区点生成按钮。
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
- 重排相互**有依赖**的 commit 可能产生冲突，此时按「变基进行中」提示解决即可，这与命令行 `git rebase -i` 行为一致。成功改写会在 Output 中记录 old/new tip 和影响范围；这不是一键 Undo，若需手动恢复请以记录的 tip 为边界审慎操作。
- 面板仅显示**本地分支**的 commit。
- 变基通过驱动原生 `git rebase -i` 实现，编辑器进程使用插件运行时的 node/Electron 可执行文件（`process.execPath`），因此在 vscode-server / 远程环境下即使 PATH 中没有 `node` 也能正常工作。
