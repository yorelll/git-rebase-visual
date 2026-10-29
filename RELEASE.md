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

- **0.8.1** — 修复追加到 commit 时的误报冲突，日志移入用户主目录：
  - **追加误报“工作区冲突”**：edit 停靠 rebase 中的追加有时会报 `快照中未提交的部分与当前工作区冲突：<文件>`，并建议 `git stash apply --index`。这是**误判**——被判冲突的路径当时存放的正是本次追加已提交的内容（`rebase --continue` 会把该 commit 拥有的路径还原成 `stash^2` 的内容），不是用户的新改动。**没有丢失任何用户数据**：完整快照与 keep-index 残留快照都仍在 `git stash list` 中，追加本身也已成功，被跳过的只是“把未提交部分放回工作区”。旧建议是个死循环（`apply --index` 会重跑同一段比对、得到同一个“冲突”），对这类形状**不再出现**。现在 `restoreResidualSnapshot` 把“工作区 blob == `stash^2:path`”视为本次事务自己的内容并放回快照的工作区版本；判定只看 Git 状态（`ls-tree`/`hash-object`），不看持久化的 `amended` 标志，任何与 `stash^2` 不同的内容（更新的用户改动、快照中的删除）仍然拒绝覆盖。**插件依然永不自动删除 stash，永不覆盖更新内容。**
  - **日志目录移入用户主目录**：从 `<os.tmpdir()>/log/...` 改为 `<用户主目录>/tmp/log/git-rebase-visual-<version>/`（Linux/macOS 为 `~/tmp/log/...`，Windows 为 `C:\Users\<用户>\tmp\log\...`）。轮转、保留 10 个会话、脱敏与写入失败容错不变；旧临时目录中的历史日志**不迁移、不删除**，每次扩展会话首次执行 **Git Rebase: Open Logs** 时在 Output 中追加一行说明旧位置（不弹通知、不重复打扰）。
  - **残留探测误报审计**：用真实 Git 复核了 keep-index 快照的 `worktree=missing unstaged=missing` 结论——后续 commit 不触碰该路径时确实缺失且会被真实写回、报 `restored`；拥有该路径时为 `present` 不重复写；改写该路径时 `rebase --continue` 先冲突，对账走不到。不存在假 `pending`/假 `resolved`，理由已写入代码注释。
  - **测试**：新增上述形状的集成回归（复现 edit 停靠 → `apply --index` → `amend` → `keep-index` 暂存 → `rebase --continue` → 对账，断言残留回到工作区、结论非 `pending`、两份 stash 均在），文件日志路径用例改为注入 `home`/`tmpdir` 以保证可移植。另修掉 `streamChat` 中途取消用例的时序竞态：原先固定 5 ms 定时器与“首个 delta 已收到”竞速，全量套件高负载下会先取消、`chunks` 为空而失败；现在改为首个 delta 送达后立即取消，服务端有上限地继续发数据——取消失效时断言失败而不是挂住套件（已实测 sabotage 后变红）。全量 **217 项**，两个类型检查零输出。

- **0.8.0** — 详情回到侧栏、可解释的写锁与文件日志：
  - **详情与操作回到侧栏**：撤销 0.7.1 的 editor-area Commit Inspector。悬停详情重新使用侧栏内的浮动 tooltip（含复制 message、打开变更），右键/`Shift+F10` 重新使用侧栏内菜单；多选 ≥2 时的右键菜单直接提供批量锁定、批量删除与连续区间生成 Diff，不再新开编辑器面板。相关 panel/lifecycle/preview/dismiss 模块与其测试一并删除，v0.7.1 的拖拽稳定性、Refresh feedback、文件级批量 SCM 与紧凑锁定摘要全部保留。
  - **根治“上一个操作尚未完成，请稍候。”**：`runGit` 不再等待 `close` 事件——子进程 `exit` 后立即在输出排空或 50ms 宽限期结算，因此 Git hook / rebase editor 留下的、继承 stdio 的孙进程无法再永久挂住调用；超时与 Abort 只在固定宽限后结算一次，并用 `taskkill /T /F`（Windows）或进程组信号（POSIX）**尝试**回收进程树；`taskkill` 只能沿树根向下枚举，已脱离或期间新建的孙进程可能存活——那只是进程泄漏，不再阻塞结算或占用调用方 deadline。
  - **可解释的写锁**：`busy` 布尔值替换为带 `{id, action, label, source, startedAt}` 的 `MutationLock`。拒绝消息会说明具体操作、来源与耗时；释放按 owner 身份校验，迟到的 `finally` 不会误清新的 owner；owner 已结束但释放丢失时，下一条消息会自愈回收。90 秒看门狗会写入一行 `mutation-stuck ...` 诊断，并提供 **强制解除并刷新**——先重读 Git 的 rebase 标记、冲突文件与 commit 列表再释放，不盲信内存状态。
  - **文件日志**：每次扩展会话在 `<os.tmpdir()>/log/git-rebase-visual-<version>/` 下创建带时间戳的会话日志，按大小轮转并保留最近 10 个文件；记录与 Output 相同的诊断、写锁生命周期、webview 操作、每次 Git 调用（argv/退出码/耗时）、rebase 状态与异常堆栈，复用并扩展凭据脱敏；日志写入失败只会静默关闭文件日志。新增 **Git Rebase: Open Logs** 命令。
  - **插件永远不自动删除 stash**：恢复全程只用 `git stash apply`（含 `--index`），自动路径上没有任何 `git stash pop` / `git stash drop` / `git stash clear`；`stashDropBySha`、`stashPopBySha`、`dropConfirmed`、`dropListedStash` 等“自动删除”实现已整体删除，`git stash pop` 只保留在用户显式点击 **Pop** 的命令里。记录只有在内容被**正面确认**已在工作区/暂存区/HEAD 中时才清除；确认不了就保留记录、横幅与 stash，误判的最坏结果是“多留一个 stash”，而不是“唯一副本被删掉”。
  - **待恢复改动对账与 Reset Extension State**：`refresh()` 不再因为一条遗留的“追加事务未完成”记录而直接 `return` 掉整张 commit 列表，而是先与真实 Git 状态对账（rebase 是否进行、stash 是否仍列出、stash 内容是否已在 index/worktree、`targetHash` 是否仍是 HEAD 祖先）再渲染。内容已在（包括 `stash apply` 成功但未丢弃 stash、以及用户手动 `git stash apply --index` 之后）判定为已恢复，静默清记录、不重复 apply、不告警，**并保留 stash**；内容未落地则自动 `apply --index`，冲突时保留记录。同一 `(stash sha, 原因)` 只警告一次（后续只写日志），界面改用一条可关闭的“待恢复的改动”横幅，横幅内直接列出 `git stash apply --index <name>`、`git stash apply <name>`、`git stash drop <name>` 三条可复制的显式命令——删除永远由用户自己执行。恢复按记录单飞，轮询/事件/读取消息重叠时只执行一次，且不会在写操作持锁期间插队执行 Git 写入。新增 **Git Rebase: Reset Extension State**（`gitRebaseVisual.resetState`）：先对账，只清孤儿状态记录，绝不删除仍保存未提交内容的 stash，并报告清理/保留内容（含保留 stash 的可执行恢复命令）与日志目录。日志与 Output 首行新增会话头（版本、扩展路径、VS Code 版本、宿主 pid、平台），便于确认运行的是哪个构建。
  - **对账失败即保守**：遗留记录的对账改为“正面验证才放行”。index/worktree/untracked 三部分默认 `unknown`，只有探测成功才提升为 `present`/`missing`；`complete` 要求 `git stash list` 成功且三部分全部 `present`，任何探测失败（`^1`/`^3` 对象或 `^3` 树不可读、`git diff` 非零）都只会得到 `pending`，记录与 stash 原样保留。`git stash list` 非零退出，或在 reflog 损坏时“空输出 + `refs/stash` 仍指向列表外的 sha”，都返回未知而不是 `[]`，不再被误判为 stash 已消失。`targetHash` 被改写时不再仅凭祖先关系认定 amend 已落地，而是逐路径用 `git ls-tree` 比较快照 `^2` 与 HEAD 的 **mode + object**；任何一项无法读取都判为未知。
  - **恢复与写锁、渲染路径**：恢复轮次整体在 mutation lock 内执行，锁忙时整轮跳过并在下一次空闲轮询重试，不再出现“入口检查一次、随后 6–14 次 Git 写在锁外”的窗口。对账也移出渲染路径：commit 列表先渲染，对账随后异步执行，持续失败时指数退避（最长 30 秒），不再每 1.5 秒阻塞一次渲染。`RecoveryCoordinator` 改为先登记 `inFlight` 再放行任务，同步抛出的异常不再永久占用单飞 key。`stop()` 在子进程已 `exit` 时只安排结算定时器，不再按可能被回收的 pid 追发 kill。
  - **关闭提示真正生效**：横幅文本随 `(stash sha, 原因)` 去重状态一起持久化，渲染只读取当前 banner key；`dismissRecoveryNotice` 清除状态并通知 webview 隐藏横幅，之后同一问题的刷新不会再把它画回来，只有出现不同 key 才重新提示。
  - **快照完成判定改为逐路径 mode + object 比对**：amend 之后若同一文件在后续 commit 中又被修改，最终 `HEAD:path` 内容本就不同于快照。现在对快照的每条变更路径执行 `git ls-tree -z <sha^2> -- <path>` 与 `git ls-tree -z HEAD -- <path>`，要求 **mode 与 object 同时相等**才算“内容已在 HEAD”。这一版同时退役了三代启发式：`git rev-list --objects <rev> --not <since> -- <path>`（只列区间内新引入对象，会剪掉复用 blob：仅模式变化、回退到更早内容、目录整体移动）、`git log --format= --raw -M --full-history` 扫描（revert 形状的 amend 让该路径 diff 为空、根本不产生 raw 记录）、`git log --find-object=<blob>`（同字节出现在其他文件即误判）。它们都只为“是否允许 drop”服务，随自动 drop 一起删除，没有留下死代码。锁定「无法确认就保留记录」的后果由可执行的横幅命令兜底。
  - **残留内容只在 stash 时不再清记录**：追加后的对账原先只要 `index === "present"` 就视为完成，于是“索引匹配、未跟踪文件缺失”的状态会清掉记录并 drop 唯一保本。现在要求快照的每一部分都有正面证据：未跟踪/未暂存部分缺失时只补回没人改过的路径（`git restore --source=<stash^3|stash>`），有冲突则保留记录并告警，**且不再 drop 任何 stash**——内容补回只是让记录结算，恢复副本始终留给用户。
  - **发布不再携带源码**：`esbuild.js` 的 `sourcemap` 改为仅在 `--watch`/显式 `--sourcemap` 时开启，普通打包不生成、并删除上一次遗留的 `.map`；`release.yml` 增加门禁，VSIX 中出现任何 `.map` 即失败（sourcemap 的 `sourcesContent` 会内嵌完整 TypeScript 源码）。
  - **测试与质量门禁**：新增写锁、文件日志、`exit` 结算/超时/取消尝试回收进程树、侧栏 tooltip/菜单，以及待恢复改动对账、告警去重、恢复单飞与恢复横幅的回归测试，并补充了四类探测失败、reflog 损坏、`reset --hard` 后 HEAD 缺文件、stash 槽位漂移的失败模式用例和 provider 级用例（真实 `vscode` stub + 真实 Git：关闭横幅跨刷新、reset 保留不可验证记录、恢复与写锁不重叠、看门狗只告警一次）。“是否已恢复”的测试全部改为**不变量测试**：确认已落地的追加会结算且 **stash 仍在列表里**；仅模式变化、revert + 后续编辑、目录重命名、同字节巧合四种形状都保留记录、保留 stash 并显示横幅；一次完整恢复过程中通过 Git 调用观察器断言**没有任何** `stash drop|pop|clear` argv（覆盖原先会走 drop 的分支）；reset 命令拒绝删除仍保存内容的 stash 并说明原因。保留破坏性探测用例（`^1`/`^2`/`^3` 不可读、reflog 损坏、`stash@{n}` 过期）。另把 `streamChat` deadline 用例从 20ms 放宽到 1s（原先在负载下可能先于首个 delta 超时，属用例自身不稳定）。`tsconfig.test.json` 将 `test/` 纳入 `npm run typecheck`；`npm run typecheck` 与 `npm run test` 全绿（214 项，两个类型检查均为零输出，全量套件从干净进程表运行）。横幅在槽位无法解析时改为回退到 sha（旧实现拼出的 `stash:<sha>` 在 Git 里不是有效引用），槽位名在每轮恢复检查时重新解析（不是每次界面重绘都查询 Git）；回归用例会真正执行横幅打印的命令。进程回收用例改用 `/proc/$!/winpid` 判定存活，修正了 MSYS pid 与 Windows pid 混用导致的空洞断言；断言“已回收”前先确认该 pid 确实存活，避免 pid 从未有效时空过，且把 `killProcessTree` 临时改回“先直接 kill”后该用例确实变红（已实测）。同时修掉了另一个用例自身的泄漏：其 hook 的无限等待循环在临时目录被删后仍会永久 `sleep 0.1`，现在循环有上限、清理前先等孙进程退出——多次运行后进程表干净。发布门禁仍使用 `npm run test:release`、VSIX 内容检查与版本化中文发布说明。

- **0.7.1** — review5 交互、跨编辑器详情与工作区批量操作升级：
  - **稳定拖拽与紧凑锁定显示**：工作区状态轮询不再错误地使正常拖拽 session 过期；只有仓库、分支、范围、rebase 状态、commit 顺序或锁定集合发生实际变化时才会拒绝旧 intent。连续锁定 commit 的折叠摘要改为紧凑信息，展开后不再显示贯穿整组的长黄色边线。
  - **跨编辑器详情与操作**：commit hover、右键和键盘 Context Menu 的详情/操作移到相邻 editor-area inspector，不覆盖侧栏时间线；hover preview 可移动到右侧阅读或复制，明确操作不会被慢速 preview 覆盖；点击普通 TextEditor 会关闭 inspector，之后可可靠重新打开。单项操作将“停靠在此 (edit)”置于首位。
  - **文件区与批量 SCM**：文件行静止时优先显示文件名和目录，hover/focus 时才覆盖显示 stage/restore 等动作；点击文件行直接打开 VS Code Diff，不再显示重复的打开 Diff 图标。Changes 支持全部暂存/恢复，Staged Changes 支持全部撤销暂存和基于暂存区的 AI message；所有写入在 host 重新读取 Git 状态并通过 mutation gate 串行化。删除未跟踪文件在确认后会再次验证状态，避免确认期间状态变化时误删。
  - **反馈与质量门禁**：手动 Refresh（侧栏、标题按钮和命令）都会显示“已刷新”，自动轮询保持安静。新增 canonical snapshot、inspector lifecycle/adapter、preview ownership、dismiss policy、refresh feedback 和 bulk SCM 的回归测试；发布门禁使用 `npm run test:release`、VSIX 内容检查与版本化中文发布说明。

- **0.7.0** — 多选/工作区/生成 Diff 的宿主安全闭环与交互可靠性升级：
  - **选择与批量操作语义**：普通点击仅切换 active context，Ctrl/Cmd+点击才建立多选；右击未选 commit 会先原子切换为该单项，右击已选项才保留批量集合，避免批量锁定、删除和 Diff 的目标与鼠标目标不一致。
  - **连续且只读的生成 Diff**：单项或无空洞连续多选才能生成 Diff；非连续选择在 UI 中置灰并给出原因，host 也拒绝 unknown/duplicate/stale/gapped payload。生成结果改为扩展私有、opaque token 的只读 virtual document snapshot，不再打开可编辑 `untitled:` 文档；snapshot 有 repository invalidation、TTL、LRU 和 dispose cleanup。
  - **文件级 SCM 操作保护与恢复**：`stageFile`/`restoreFile` 被正确归类为 mutation，先通过 host busy 串行化；edit stop 的文件操作由明确 paused allow-list 放行，纯 refresh/scroll/pointer/IME/selection/read Diff 不产生暂停告警。补齐单文件 staged/working restore 与经确认删除未跟踪文件；`XY=RM` 暂存只使用现存 working-side path，修复旧 rename path 导致的失败。
  - **拖拽、搜索与无障碍**：pointer/native drag 在 deferred refresh 前用 captured revision/canonical order 发送 intent，host 可拒绝过期手势；支持 Alt+Arrow 一步重排。搜索支持 `author:`、`msg:`、`hash:0x...` 与中文 IME composition；同 initial 作者在 High Contrast/forced-colors 下也使用文字前缀区分，不依赖颜色。
  - **LLM 测试稳定性**：共享 HTTP test server 按 Fetch Standard 的完整 bad-port table 进行 listen → inspect → close/retry，覆盖 `0`、`5060`、`5061`、`6000`、`6667`、`10080`，消除 Windows 动态端口导致的 `fetch failed: bad port` 随机失败。
  - **评审与测试**：初始实现、两轮独立审查、整改与最终独立复核完成；新增 webview DOM、generated-Diff snapshot、mutation gate、完整 Fetch port policy 与真实 Git 工作区回归，自动测试套件扩展至 **120 项**。

- **0.6.3** — 文件级工作区管理、左右 Diff、IME 搜索与拖拽可靠性升级：
  - **文件级变更区**：更多提交选项展示 porcelain v2 -z 结构化状态，清晰区分 staged/working/untracked 与 Modify/Add/Delete/Rename/Conflict；支持单文件暂存，处理空格路径、删除、rename 和 `XY=RM` staged rename+working modify。
  - **统一左右 Diff**：工作区文件、commit 右键/hover/Compose 的“打开变更”均通过受控 opaque content provider 打开 VS Code parent↔commit 或 index↔working 左右 Diff；支持 root/add/delete/rename/multi-file，binary/merge 提供明确 fallback；嵌套路径递归枚举避免将目录误当 diff 文件。
  - **搜索与交互状态**：支持 `author:`、`msg:`、`hash:`、`hash:0x...` 与中文 IME composition；refresh 后保持焦点/selection、搜索、locked-run 展开和更多选项状态。成功通知复用固定 branch context 区 overlay，不推动 commit 列表。
  - **可靠重排**：pointer drag 与 native drag 共用 canonical reorder intent，自动 refresh 在拖拽期间延迟；Alt+上下键作为完整 order 的键盘兜底，所有操作仍由宿主 revision/lock/order 验证和确认。
  - **edit/AI 安全**：edit stop 真实渲染 Amend/New/Draft-only 操作；Amend 保 trailer，新 commit 不继承 trailer；AI 在暂停 rebase 中仅生成 draft。Compose session/revision 保护原 message/trailer/draft 不被首次加载或 reload 丢失。
  - **评审与测试**：A 实现 → B 文档 review → A response → B 独立复核循环完成；新增状态、stage、diff、IME、drag、scroll、Compose、edit-stop、nested commit 等测试，测试套件扩展至 **103 项**。

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
