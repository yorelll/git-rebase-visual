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
npm run package
```

成功后会在 **`dist-vsix/`** 目录生成 `git-rebase-visual-<version>.vsix`。所有打包产物都放在这个目录里，仓库根目录不再堆积 `.vsix`；`dist-vsix/` 与 `*.vsix` 均由 `.gitignore` 排除，不会被提交。
>
> 直接用 `vsce package` 会输出到根目录，推荐统一走 `npm run package`。
>
> 脚本不是简单转发 `--out dist-vsix/`：那样在**目录不存在**时（新克隆、CI 首次构建）`vsce` 会把参数当成文件名，写出一个**名为 `dist-vsix` 的普通文件**并仍然退出 0。`scripts/package-vsix.js` 先用 `mkdirSync(..., {recursive:true})` 建目录，再给 `--out` 传**完整文件名**，最后校验产物存在且是普通文件，否则非零退出。若 `dist-vsix` 已是一个普通文件（旧版本留下的那个 zip），脚本会明确报错并让你删掉它再重跑，而不是覆盖或静默失败。

> `vsce` 默认会跑 `vscode:prepublish`（已配置为 `npm run compile`），所以打包时会自动重新编译。
> `dist-vsix/` 与 `*.vsix` 也在 `.vscodeignore` 中：即使目录里还留着旧构建，它们也不会被递归打包进新的 VSIX。
>
> **`.vscodeignore` 是黑名单，单靠它不足以保证 VSIX 内容**：新增一个顶层目录却忘了加排除规则，它会静默进入 VSIX，而条目数看起来仍然“差不多”。因此 `npm run package` 在打包完成后会**列出 VSIX 的实际条目并按集合与显式的 12 项白名单逐项比对**，多一条或少一条都非零退出并打印 `+ 多出` / `- 缺失` 的差异。白名单在 `scripts/package-vsix.js` 的 `expectedEntries` 里，是一份有意写得又短又具体的常量；要调整打包内容时**同时**改 `expectedEntries` 和 `.vscodeignore`，让变化是显式决定而不是遗漏。`.github/workflows/release.yml` 的 “Verify packaged VSIX” 步骤不再重复这份清单，而是执行 `node scripts/package-vsix.js --verify-only`：对打包步骤产出的那个文件跑同一份代码、同一个清单，因此**清单只存在一份**，不会出现“本地改了、CI 的 heredoc 没改”的半改状态。
>
> 手动复核同样可行：
>
> ```bash
> unzip -Z1 dist-vsix/git-rebase-visual-<version>.vsix   # 期望恰好 12 个条目
> ```
>
> 白名单之外的任何条目（`src/`、`test/`、`docs/`、`scripts/`、`node_modules/`、`*.map`、`dist-vsix/`、`tsconfig` 等）都会让门禁失败。

---

## 三、分发与安装（离线 .vsix）

把生成的 `.vsix` 发给使用者，对方任选一种方式安装：

**方式 A — 命令行**
```bash
code --install-extension dist-vsix/git-rebase-visual-<version>.vsix
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
| 发布测试 | TypeScript 类型检查、VSIX 内容必须与显式白名单**逐项完全一致**（多一条、少一条都失败）、Release 版本记录检查 |

测试文件位于 `test/`，运行 `npm run test` 或 `npm run test:coverage`。两者都经 `scripts/run-tests.js` 枚举全部 `test/*.test.ts` 并交给 Node 按文件调度（并发 3），不再有汇总入口文件；`npm run test:release` 仍是全量门禁，不会分成子集。

### 更新记录

- **0.8.2** — 修复追加到 commit 时把后续 commit 的文件误报为冲突（`Index was not unstashed.`），并消除两处会误导/静默放弃追加的提示：
  - **假冲突的根因**：`stashPush` 保存整个工作区，`stashApplyIndexBySha` 却用 `git stash apply --index` 恢复——该命令会合并 stash 的**工作区那一半**，于是在只含目标 commit 树的停靠点上，**后续 commit 才引入的路径**变成 “Updated upstream 已删除 / Stashed changes 已修改” 的 `CONFLICT (modify/delete)`，整次恢复以 `Index was not unstashed.` 中止。每个 commit 只添加自己的文件，冲突不可能成立。**影响范围比报告更广**：目标早于 tip 即可能失败，不只是“最早那个 commit”；目标恰好是 tip 时不会触发这个 `apply --index` 合并冲突，但**路径名含非 ASCII、以空格开头或含 `*`/`?`/`[` 时仍会静默丢路径并报告成功**，因此“目标为 tip 就总能成功”同样不成立。**没有丢失任何用户数据**：stash 完整保留，Abort 后能按原暂存/未暂存状态完整放回。
  - **修复方式**：改为把快照的**三个部分各自从自己的树**恢复，只触碰快照自己的路径——工作区部分用 `git restore --source=<stash> --worktree -- <stash^1..stash>`；暂存区部分用 `git restore --source=<stash>^2 --staged -- <stash^1..stash^2>`；未跟踪文件从 `stash^3` checkout 后 `reset` 保持未跟踪。**工作区必须先于暂存区**（先做暂存删除会让该路径离开索引，`restore --worktree` 随后无法解析 pathspec）；枚举路径的 `git diff` **必须带 `--no-renames`**（否则重命名折叠成只剩目标路径）。任一步非零即保持 stash 不动并在 `message` 中写明失败步骤。
  - **被否决的方案**：`git read-tree <stash>^2` 替换整个索引，实测令 `commit --amend` 把五个文件全部提交进目标 commit；`git stash push --staged` 与 `--include-untracked` 互斥、单独使用又留下脏工作区，且需 Git 2.35+（下限 2.31.0）。两者均未采用。
  - **提示死胡同**：amend 之前失败时曾提示“请解决冲突后 Continue 或 Abort”，但 Continue 在该状态（`amended: false`）本身会被拒绝。现改为明确说明“暂存内容尚未写入目标 commit、不能 Continue，请 Abort 自动恢复”。
  - **静默放弃（第二个独立缺陷）**：照旧提示把“冲突”文件 `git add` 后，索引恰好与快照一致，对账曾判 `resolved` 清除记录——而变基仍停靠在原目标、追加从未 amend。现在只有 `stagedSnapshotInHead` 确认内容进入 HEAD（或记录标记 `amended`）才算完成；目标仍是祖先且变基仍在进行时**保留记录**并提示“追加未完成”。用户显式 Abort 后进行中的变基已不存在，同一状态正常结算、不会永久告警。
  - **Abort 永不删除任何文件**：`git rebase --abort` 会被“未跟踪文件会被回退覆盖”（`untracked working tree files would be overwritten`，128）挡住。此前实现在“删除可证明无损”时会自动删掉阻挡路径以完成 abort；**这条路径已彻底移除**。
    - **为什么放弃**：三轮审查各发现一种“证明无损、实际丢字节”的形状——① 归属证明只说明路径曾在本 HEAD 里，不说明盘上字节属于本次变基；② 预测源的属性基准：`git cat-file --filters --path=<p>` 从**工作区**解析 `.gitattributes`，而 `git reset --hard <orig>` 解析它即将写入的**目标树**里的那份；③ 相对路径的 `core.attributesFile`（Git 按进程工作目录解析，合成检出若换 `GIT_WORK_TREE` 就找不到它）与被 smudge filter 读取的工作区状态。每次修补只封住一种形状。这个类**无法穷举**：它的定义是“检出过滤器可能依赖 blob 之外的一切”，而 Git 过滤器可以执行任意命令、读取任意文件。
    - **现在的行为**：只调用一次 `git rebase --abort`；成功即返回。失败时只认 Git 自己给出的碰撞文案（`untrackedCollisions` / `directoryCollisions` → `pathsUnderHeader`），用它**列出路径**，然后抛错。函数内**没有任何删除分支**。
    - **错误信息**（`untrackedCollisionMessage` / `directoryCollisionMessage`）按五步写，面向从未读过这段代码的用户：① 发生了什么并逐条列出 Git 给出的原始路径；② **明确写明“没有删除任何文件”**；③ 下一步——把路径移出仓库或改名后重新 Abort，并给出可复制的 `mv <path> <path>.bak`（超过 5 条只列前 5 条并注明余数），同时提示 Windows 用户可在资源管理器里重命名；④ 改动没丢——**按 `git stash list` 实测结果**说明（有条目报条数，为空就明说为空并改为“工作区原封未动”），变基仍停在暂停态，停在这里没有损失；⑤ 若某个文件其实只是构建产物、用户愿意删掉，那个判断由用户做，扩展不替他决定。目录碰撞用同一套保证，并给出适合目录的处理建议。
    - **可复制命令的 shell 转义**：路径用 POSIX 单引号包裹，内部 `'` 以 `'…'\''…'` 闭合重开。旧写法只加一层单引号，`it's.txt` 会生成粘不上的命令，`pwn'; touch OWNED; echo '.txt` 这种名字则会执行别的东西。扩展从不执行这些字符串，但它们的用途就是被复制。正确性由单测证明：每个恶意文件名经 `sh -c 'printf %s <quoted>'` 往返后必须逐字节等于原名，并断言执行载荷没有真的生成 `OWNED`；换回旧写法该用例立刻变红。
    - **不认识的失败形状**原样抛出 Git 输出；因为整个函数不存在删除分支，这类形状不可能导向删除——这是结构性的，不再依赖“文案没匹配上”的巧合。
    - **代价（据实说明）**：遇到历史遗留的碰撞状态，用户需要多手动做一步（把文件移开）才能完成 Abort，而不是点一下自动完成。这是有意的取舍——一步手动操作，换掉一整类无法枚举的静默丢字节风险。追加事务本身已改为“先索引/未跟踪 → amend → 再工作区”，不再产生这类残留，所以需要这一步的情况应当很少。
    - **已删除的死代码**：`abortMayReplace`、`abortCheckoutBytes`、`attributeDirs`、`abortTarget`、`removable`/`userContent` 分类与两处删除循环，以及 `gitRunner.ts` 中只为预测器服务的 `rawStdout`/`stdoutBytes`/`stdoutChunks` 管线（已无其他调用方，一并移除以免留下无人钉住的安全辅助）。
  - **删除预检与恢复公告（第四轮复审）**：`stashRemoveBySha` 开头的独立 `git stash list` 只判断退出码，reflog 损坏（退出 0、无输出、`refs/stash` 仍解析得到）会被读成“栈为空”并返回“条目已不存在”；当时只因调用方 `removeOwnStash` 先检查 `presence.listed !== true` 才不可达。现在预检走同一个 `readStashList`：`unreadable` → **拒绝**（`refused: true`）且不写入，只有 `empty` 才算 `gone`；`git stash drop` 非零退出的 `refused: false` 也改为 `true`。公告侧（`rebaseViewProvider.announceSettled`）原先用 `removal.message.includes("git stash store")` 分类，两个方向都错：`ambiguous` 拒绝（什么都没恢复）被公告成“删到了别的条目…已原样恢复”，drop 后列表读不出来则落进残留分支并给出 `git stash drop stash@{0}`，而该槽位占用者未知。现在 `StashRemoveResult` / `StashRemoval` 带判别字段 `kind`（`removed` / `leftover` / `undo-restored` / `undo-unknown` / `ambiguous-refusal`），公告只按 `kind` 分支，全链路不再对自产文案做子串或正则判断。`removeOwnStash` 曾把“删除前列表未能读取、无法交叉核对”这句说明构造后丢弃，现在作为 `uncrosschecked` 带出并同时进入日志与弹出提示；这类结果也不再显示无条件的“已恢复…已删除”成功话术。
  - **目录碰撞显式拒绝**：Git 对目录碰撞的文案是 `Updating the following directories would lose untracked files in them`，与文件碰撞不同。旧代码不认识这种文案，只是把原始 stderr 抛出去——**恰好**没删东西，但这份安全是意外的。现在两种文案分别解析：目录碰撞明确报错、点名目录、说明未删除任何文件也没有删除任何目录，并给出“先移走再重试”的步骤。**不认识的失败形状只抛原始输出**；因为整个函数不存在删除分支，这类形状不可能导向删除。
  - **测试**：新增真实 Git 集成用例，覆盖原始形状、暂存新文件+后续文件工作区改动（修复前失败）、纯修改后续文件且无任何残留（最简形状，修复前失败）、暂存删除（修复前通过，用于固定行为）、“索引一致但追加未落地必须保持 `pending`、Abort 后能结算”，以及本轮重写的拒绝契约：未跟踪碰撞 → 抛错且文件字节不变、变基仍暂停、stash 不变、错误信息包含每个路径并写明“没有删除任何文件”；目录碰撞 → 同类保证并点名目录；干净树 → 正常成功（回归护栏）；用户把文件改名移开后第二次 Abort 成功（把文档里的恢复步骤端到端钉住）；N5-1 形状（相对 `core.attributesFile`）与 N5-2 形状（smudge filter 读取工作区状态）现在一律拒绝，只断言抛错与字节存活；不认识的失败形状不删除任何东西。另保留 `worktree.ts`/`worktreeChanges.ts` 的**全部 9 个**字面 pathspec 站点（逐个站点撤掉 `GIT_LITERAL_PATHSPECS` 都实测变红，见下方逐点对照表）、`git stash apply --index` 退出码非零时记录仍保持 `pending`（该形状下内容探测会误报 `complete`）。已实测非空转：撤掉对应修复后相应用例变红，恢复后全绿。另有 3 条本轮新增用例钉住本节新增的两处改动：`shellQuote` 的恶意文件名往返证明（换回旧的未转义写法即变红）、`abort refuses when a smudge filter reads worktree state` 的 `cat-file --filters` 前提断言（把 filter 换成恒等 `cat` 即变红）、以及 `the abort refusal describes the stash as it actually is, not as assumed`（stash 为空与有一条两种状态都要匹配 `git stash list`）。全量 **275 项**通过、0 失败、0 跳过，两个类型检查零输出。

    字面 pathspec 站点与钉住它的用例（每个站点单独撤掉 `GIT_LITERAL_PATHSPECS` 均实测变红）：

    | 站点（文件 / 符号） | 调用 | 钉住它的用例 | 用例所在文件 |
    | --- | --- | --- | --- |
    | `worktree.ts` `restoreStagedHalf` | `restore --staged`（暂存半） | `a quoted non-ASCII path, a leading space and a glob name are all appended for real` | `appendStaged.integration.test.ts` |
    | `worktree.ts` `restoreUntrackedHalf` | `checkout <stash>^3 -- <path>` | `an untracked glob-named path is restored from ^3 without checking out its decoy` | `worktree.integration.test.ts` |
    | `worktree.ts` `restoreUntrackedHalf` | `reset -q -- <path>` | 同上（诱饵在快照后已有索引条目，glob 会把它改写成 stash 内容） | `worktree.integration.test.ts` |
    | `worktree.ts` `restoreWorktreeHalf` | `restore --source=<stash> --worktree` | `the worktree half restores a glob-named path without reverting its decoy` | `worktree.integration.test.ts` |
    | `worktreeChanges.ts` `stageWorktreeChange` | `add -A -- <path>` | `a glob-named path is staged and restored literally, never touching its decoy` | `worktreeChanges.integration.test.ts` |
    | `worktreeChanges.ts` `restoreWorktreeChange`（working） | `restore --worktree -- <path>` | `single-file and bulk worktree restoration treat glob names literally` | `worktree.integration.test.ts` |
    | `worktreeChanges.ts` `restoreWorktreeChange`（staged） | `restore --staged -- <paths>` | `a glob-named path is staged and restored literally, never touching its decoy` | `worktreeChanges.integration.test.ts` |
    | `worktreeChanges.ts` `discardAllWorktreeChanges` | `restore --worktree -- <paths...>` | `single-file and bulk worktree restoration treat glob names literally` | `worktree.integration.test.ts` |
    | `worktreeChanges.ts` `unstageAllWorktreeChanges` | `restore --staged -- <paths...>` | `bulk unstage treats glob names literally and keeps the decoy's entry` | `worktree.integration.test.ts` |

    诱饵的构造原则（否则用例空转）：**错 glob 写入的字节必须与不写不同**。因此每个夹具都让诱饵在该次调用发生的那一刻持有目标永远没有的内容——例如 bulk unstage 的两条路径都是**新增文件**（`restore --staged` 会整条删掉无 HEAD 对应项的索引条目，而“已跟踪文件被回退到 HEAD 值”这种变化与“没碰它”无法区分）。

- **0.8.1** — 修复追加到 commit 时的误报冲突，日志移入用户主目录：
  - **追加误报“工作区冲突”**：edit 停靠 rebase 中的追加有时会报 `快照中未提交的部分与当前工作区冲突：<文件>`，并建议 `git stash apply --index`。这是**误判**——被判冲突的路径当时存放的正是本次追加已提交的内容（`rebase --continue` 会把该 commit 拥有的路径还原成 `stash^2` 的内容），不是用户的新改动。**没有丢失任何用户数据**：完整快照与 keep-index 残留快照都仍在 `git stash list` 中，追加本身也已成功，被跳过的只是“把未提交部分放回工作区”。旧建议是个死循环（`apply --index` 会重跑同一段比对、得到同一个“冲突”），对这类形状**不再出现**。现在 `restoreResidualSnapshot` 把“工作区 blob == `stash^2:path`”视为本次事务自己的内容并放回快照的工作区版本；判定只看 Git 状态（`ls-tree`/`hash-object`），不看持久化的 `amended` 标志，任何与 `stash^2` 不同的内容（更新的用户改动、快照中的删除）仍然拒绝覆盖。**插件永不覆盖更新的用户内容；它只删除自己创建的 stash 条目**——内容被完整确认（列表 / 索引 / 工作区与未跟踪三处）回来后，才把记录里的 sha 解析成当前槽位、复核占用者仍是自己的 sha、`drop` 后复核删掉的正是自己的 sha（不符则 `git stash store` 还原），结算后 `git stash list` 与用户原有条目按 sha 集合一致；用户自己压入的条目在任何路径上都不会被删除。
  - **日志目录移入用户主目录**：从 `<os.tmpdir()>/log/...` 改为 `<用户主目录>/tmp/log/git-rebase-visual-<version>/`（Linux/macOS 为 `~/tmp/log/...`，Windows 为 `C:\Users\<用户>\tmp\log\...`）。轮转、保留 10 个会话、脱敏与写入失败容错不变；旧临时目录中的历史日志**不迁移、不删除**，每次扩展会话首次执行 **Git Rebase: Open Logs** 时在 Output 中追加一行说明旧位置（不弹通知、不重复打扰）。
  - **残留探测误报审计**：用真实 Git 复核了 keep-index 快照的 `worktree=missing unstaged=missing` 结论——后续 commit 不触碰该路径时确实缺失且会被真实写回、报 `restored`；拥有该路径时为 `present` 不重复写；改写该路径时 `rebase --continue` 先冲突，对账走不到。不存在假 `pending`/假 `resolved`，理由已写入代码注释。
  - **测试**：新增上述形状的集成回归（复现 edit 停靠 → `apply --index` → `amend` → `keep-index` 暂存 → `rebase --continue` → 对账，断言残留回到工作区、结论非 `pending`、两份 stash 均在），文件日志路径用例改为注入 `home`/`tmpdir` 以保证可移植。另修掉 `streamChat` 中途取消用例的时序竞态：原先固定 5 ms 定时器与“首个 delta 已收到”竞速，全量套件高负载下会先取消、`chunks` 为空而失败；现在改为首个 delta 送达后立即取消，服务端有上限地继续发数据——取消失效时断言失败而不是挂住套件（已实测 sabotage 后变红）。全量 **217 项**，两个类型检查零输出。

- **0.8.0** — 详情回到侧栏、可解释的写锁与文件日志：
  - **详情与操作回到侧栏**：撤销 0.7.1 的 editor-area Commit Inspector。悬停详情重新使用侧栏内的浮动 tooltip（含复制 message、打开变更），右键/`Shift+F10` 重新使用侧栏内菜单；多选 ≥2 时的右键菜单直接提供批量锁定、批量删除与连续区间生成 Diff，不再新开编辑器面板。相关 panel/lifecycle/preview/dismiss 模块与其测试一并删除，v0.7.1 的拖拽稳定性、Refresh feedback、文件级批量 SCM 与紧凑锁定摘要全部保留。
  - **根治“上一个操作尚未完成，请稍候。”**：`runGit` 不再等待 `close` 事件——子进程 `exit` 后立即在输出排空或 50ms 宽限期结算，因此 Git hook / rebase editor 留下的、继承 stdio 的孙进程无法再永久挂住调用；超时与 Abort 只在固定宽限后结算一次，并用 `taskkill /T /F`（Windows）或进程组信号（POSIX）**尝试**回收进程树；`taskkill` 只能沿树根向下枚举，已脱离或期间新建的孙进程可能存活——那只是进程泄漏，不再阻塞结算或占用调用方 deadline。
  - **可解释的写锁**：`busy` 布尔值替换为带 `{id, action, label, source, startedAt}` 的 `MutationLock`。拒绝消息会说明具体操作、来源与耗时；释放按 owner 身份校验，迟到的 `finally` 不会误清新的 owner；owner 已结束但释放丢失时，下一条消息会自愈回收。90 秒看门狗会写入一行 `mutation-stuck ...` 诊断，并提供 **强制解除并刷新**——先重读 Git 的 rebase 标记、冲突文件与 commit 列表再释放，不盲信内存状态。
  - **文件日志**：每次扩展会话在 `<os.tmpdir()>/log/git-rebase-visual-<version>/` 下创建带时间戳的会话日志，按大小轮转并保留最近 10 个文件；记录与 Output 相同的诊断、写锁生命周期、webview 操作、每次 Git 调用（argv/退出码/耗时）、rebase 状态与异常堆栈，复用并扩展凭据脱敏；日志写入失败只会静默关闭文件日志。新增 **Git Rebase: Open Logs** 命令。
  - **只删除插件自己创建的 stash 条目**：恢复全程只用 `git stash apply`（含 `--index`），自动路径上没有任何 `git stash pop` / `git stash clear`。内容被**完整确认**重新回到索引、worktree 与未跟踪文件三处（`stashPresence().complete`）之后，插件把自己那条临时条目删除；结算后 `git stash list` 与插件动手前**按 sha 集合完全一致**。恢复与删除是两件事：恢复只用 apply（失败可重试、不吞副本），删除是记账（内容已在条目之外）。
  - **为什么删除必须按槽位、而且要检查两次**：`git stash pop <sha>` / `git stash drop <sha>` 都不是合法用法（实测 `error: '<sha>' is not a stash reference`），只能用 `stash@{n}`。而 `stash@{n}` 是**位置**：解析出槽位到真正删除之间若有并发 `git stash push`，该槽位会换成用户的条目。因此删除前重读槽位占用者、必须仍等于自己的 sha 才动手；删除后核对实际被删掉的是哪一个条目：判据是**删除前后的 sha 集合差**——自己的 sha 已不在列表即正确；仍在列表说明删掉的是别的条目，从删除前一刻的快照里找出消失的那一个。Git 的 `Dropped stash@{n} (<sha>)` 只作旁证：它是 gettext msgid、会被翻译，旧实现依赖它时在非英语环境下把“删错了”报成“删对了”，整段回滚静默失效。若不是自己的，用 `git stash store` 把它**原样恢复**（实测可完整恢复该 commit 与其 reflog 条目；复原后条目位于列表最上方、**reflog 说明 `%gs`（`git stash list` 显示的那行）**变为 `git-rebase-visual restored <sha7>`，而 stash commit 的**标题 `%s`（`git log` 显示的那行）不变**，回滚消息把两个字段都点名写出）。判断“只删掉了自己那条”还要求删除前快照里**没有别的 sha 同时消失**：删除窗口内并发删掉自己那条、自己的 drop 又删掉用户那条时，列表同样不再包含自己的 sha，但用户那条必须被认出来并用 `stash store` 复原；同时消失多条则拒绝并点名，不猜。删除前快照读不出来时仍返回已删除，但消息写明**未做交叉核对**。任一步不符都是拒绝并报告，绝不重试。
  - **为什么不是 `pop`**：自动 stash 带 `--include-untracked`，其未跟踪文件被恢复回工作区之后，对同一条目执行 `pop` 必然以 `already exists, no checkout` / `could not restore untracked files from stash` 失败且**条目仍在**（实测）。也就是说“先 apply 再 pop”永远不会成功，“先 pop 再 apply”则会让每次冲突重试都先做一次破坏性写入。
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
