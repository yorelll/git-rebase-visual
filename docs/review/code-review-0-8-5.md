# code review 0.8.5 — Agent B 独立复审（0.8.2 第三轮增量）

## 基线

- 仓库：`D:\work\tools\git plugin`，分支 `main`，HEAD `eddca56`（`eddca5642cb7dadb1645e24e2d6d074a39aedc26`），版本 0.8.2。
- 工作区：开始时 `git status --short` **22 项**，结束时 **22 项**，内容一致；本轮未修改任何产品代码、测试或既有文档。
- 本轮范围：仅复审第 2 轮 4 条发现（P2 abort 归属证明、P3-1 字面 pathspec、P3-2 `applyIndex`、P3-3 陈旧文档）的修复，以及发布完整性与第 1 轮回归。
- 方法：真实 Git 2.53.0.windows.2 + Node v24.16.0。所有破坏性探针在仓库外的临时副本（`%LOCALAPPDATA%\Temp\bb-probe`，`node_modules` 用 junction 指向真实目录）与 OS 临时仓库中进行，结束后已删除。
  **未运行完整套件**（规则要求）。实际运行：`editStopCommit` 7/7、`pendingRecovery` 40/40、`appendStaged` 8/8、`worktreeChanges` 6/6，以及针对性的逐点变异运行。
- 并发负载：复审期间另一个代理（worktree `agent-a4c94786cd3dfa326`）在运行 `scratch/run-per-file.mjs` / `parallel-real.mjs`。本报告的**所有**耗时均受该负载影响（单个真实 Git 用例 5–35 秒），因此本文**不基于任何计时结论**做判断。

---

## 一、第 2 轮发现的结论

| 编号 | 结论 | 依据 |
| --- | --- | --- |
| **P2（阻塞）abort 归属证明删除用户内容** | **已修复**（有一处语义残留，见 N-2） | 见 1.1 |
| **P3-1 字面 pathspec 未钉住** | **部分修复** | 见 1.2 |
| **P3-2 `applyIndex` 只信 `presence.complete`** | **已修复** | 见 1.3 |
| **P3-3 陈旧文档** | **已修复** | 见 1.4 |

### 1.1 P2 — 已修复

`src/git/rebaseEngine.ts:266-284` 的 `abortMayReplace` 同时要求 `rev-parse --verify --quiet <orig>:<path>` 成功 **且** `hash-object --path=<path> -- <path>`（带 `GIT_LITERAL_PATHSPECS`）等于该 blob；任一步失败或无法哈希都归为用户内容。`abortRebase`（`:214-250`）**先对所有阻挡路径分类，再统一决定是否删除**，因此不存在部分删除。

我用真实 Git 复核了实现者声明的三个测试场景之外的对抗场景：

- **混合集合（一条本次变基创建的 + 一条用户内容）**：`a.txt`（字节等于 `orig-head` blob）、`b.txt`（用户字节）。结果 `aExists=true bExists=true partialDeletionOfA=false`，抛错并点名 `b.txt`。**无部分删除**，符合声明。
- **目录挡在被跟踪路径上（无法哈希）**：`later.txt/` 为目录且内含 `inner.txt`。该路径因 `hash-object` 失败被归为用户内容，**未被分类为可删除**；`inner.txt` 保留。⭐ 附带发现：Git 自己的文案是 *"Updating the following directories would lose untracked files in them"*，不匹配 `untrackedCollisions` 的正则，因此 `blocked` 为 `undefined`，`abortRebase` 走 `"throw 原始 stderr"` 分支——**恰好是安全的**（不删任何东西）。这是靠意外而非设计得到的安全，见 N-3。
- **非 ASCII 名、含空格名**：Git 在 `LC_ALL=C` 下按原文（不加引号）打印路径，`中文 notes.txt`、`my notes.txt` 都被正确解析并删除（字节与 blob 相同）。解析器对这两类名字是通的。
- **不可达路径**：`rev-parse <orig>:../outside-probe.txt` 退出 128（`fatal: path 'outside-probe.txt' exists on disk, but not in ...` / 非法路径），因此外部路径**永不**被归类为可删除。`path.join(cwd, filePath)` 的拼接虽未做边界校验，但在真实 Git 输出下不可利用。
- **错误信息可操作性**：`…可能包含你尚未保存的改动，因此未自动删除：b.txt。请先把它们移到别处（例如重命名或备份到仓库外），再重新执行 Abort。原始改动仍完整保存在 stash 中。` —— 点名文件、给出非破坏性建议、未要求用户执行删除命令。✔

**非空转（见第三节）两项均实测成立。**

### 1.2 P3-1 — 部分修复

同时去掉 `worktree.ts` 与 `worktreeChanges.ts` 的 `env: LITERAL_PATHSPECS` 后：`appendStaged` 8 项中 **1 红**（`a quoted non-ASCII path, a leading space and a glob name are all appended for real`，`the decoy must be untouched`），`worktreeChanges` 6 项中 **1 红**（`a glob-named path is staged and restored literally, never touching its decoy`，`the decoy is not staged over`）。与实现者声明的 5 通过 / 1 失败一致。

但**逐点变异**（每次只撤一个站点）显示，两个文件里的 9 个站点中只有 **5 个**被现有测试钉住：

| 站点 | 去掉 env 后 |
| --- | --- |
| `worktree.ts:104`（暂存半 `restore --staged`） | ✔ 1 红 |
| `worktree.ts:128`（`checkout <sha>^3`） | ✘ 全绿 |
| `worktree.ts:134`（未跟踪半 `reset`） | ✘ 全绿 |
| `worktree.ts:159`（工作区半 `restore --worktree`） | ✘ 全绿 |
| `worktreeChanges.ts:192`（`add -A`） | ✔ 1 红 |
| `worktreeChanges.ts:229`（单文件工作区恢复） | ✘ 全绿 |
| `worktreeChanges.ts:236`（单文件暂存恢复） | ✔ 1 红 |
| `worktreeChanges.ts:262`（批量工作区恢复） | ✘ 全绿 |
| `worktreeChanges.ts:276`（批量撤销暂存） | ✘ 全绿 |

代码本身是**正确**的（环境变量都在），但 4 个站点**没有任何测试钉住**。因此 `docs/release-notes/0.8.2.md` 中“`worktree.ts` 与 `worktreeChanges.ts` 的**每个站点**都用「诱饵与目标内容不同」的夹具钉住”与 `RELEASE.md:116` 的同类表述**超过了实测证据**，降级为 P3 文档准确性问题（N-4）。

### 1.3 P3-2 — 已修复（非空转已实测）

`src/git/pendingRecovery.ts:717` 为 `ok: res.code === 0 && presence.complete`。把 `res.code === 0 &&` 去掉后，`test/pendingRecovery.integration.test.ts:1312` 的用例变红：

```
AssertionError: a non-zero apply must keep the record, got: {"kind":"restored",...}
```

即失败时被误判为 `restored`。该用例的前提断言（`after.complete === true` 且 `git ls-files -u` 仍列出 `later.txt`）是**真实**的，确实钉住了“内容探测看不见索引写失败”这一根因。恢复原始代码后 40/40 全绿。

### 1.4 P3-3 — 已修复

`RELEASE.md:111` 的表述为“目标恰好是 tip 时不会触发 `apply --index` 合并冲突……因此‘目标为 tip 就总能成功’不成立”，不再声称 tip 总成功；`docs/release-notes/0.8.2.md` 全文**不含** `0.8.3`、不含 `{{…}}` 模板残留，悬空引用已换成文内描述性引用。全仓库仅 `docs/review/code-review-0-8-4.md`（历史评审）提到 0.8.3，属正常。

---

## 二、新发现

### N-1（P2）`npm run package` 在 `dist-vsix/` 已存在时会递归打包自身，并把陈旧文件带进发布包

`package.json:205` 为 `"package": "vsce package --no-dependencies --out dist-vsix/"`，而 `dist-vsix/` **不在** `.vscodeignore` 中。

实测（干净副本，真实 vsce）：

| 场景 | 结果 |
| --- | --- |
| `dist-vsix/` 目录不存在（CI 每次全新 checkout 的情况） | `-o dist-vsix/` 被当作**目录**，产出 `dist-vsix/git-rebase-visual-0.8.2.vsix`，11 项，正常 |
| `dist-vsix/` 已存在且为空 | 同上，正常 |
| `dist-vsix/` 已存在且含任意文件（例如上一次的 `git-rebase-visual-0.8.1.vsix`） | `-o` 被当作**文件**，产出名为 `dist-vsix` 的文件，**并把该目录递归打包**：VSIX 出现第 12 项 `extension/dist-vsix/<旧构建>/…` |

第 12 项会随机增大包体（实测 +0.18 KB）、把历史构建产物塞进用户安装的扩展，或用多余条目扰动“12 项”门禁。CI 因为全新 checkout 不会命中，**但本地按 `RELEASE.md` 说明重新打包时极易命中**（`dist-vsix/` 就在仓库根、且正是文档指引用户去放的目录）。

修复建议：把 `dist-vsix/` 加入 `.vscodeignore`（纵深防御），并改用确定的文件名输出，例如 `--out dist-vsix/git-rebase-visual-0.8.2.vsix` 或让脚本先清空/创建目录后传显式文件路径；同时在 `RELEASE.md` 第 3 步的校验里断言条目数恰好为 12。

### N-2（P3）abort 的“逐字节相同”是经 clean filter 的**规范化结果**相同，存在语义保留但字节被替换的窄路径

`hash-object --path=` 会套用 clean filter，因此它比较的是“规范化后的字节”，而非磁盘字节。我在真实 Git 上实测了三种形状：

| 形状 | `hash-object` == blob | abort 行为 | 用户字节 |
| --- | --- | --- | --- |
| `core.autocrlf=true`，用户写了 CRLF | true | 删除并重建 | **保留**（checkout 时再转回 CRLF）✔ |
| `*.txt text eol=lf`，用户写了 CRLF | true | 删除并重建 | **被替换为 LF** ✘ |
| 无属性、`autocrlf=false`，用户写 CRLF | false | 拒绝删除 | 保留 ✔ |
| 有损 clean filter（`sed 's/[ \t]*$//'`），用户内容为 `later    \n` | true | 删除并重建 | **尾随空格丢失** ✘ |

因此“逐字节相同”在文档与代码注释里的措辞略强于实际（实际是“clean 后相同”）。风险很低（只发生在用户自己配置了 `eol` 或 filter 的仓库，且清理后的内容确实等于将要写回的 blob），但 `docs/release-notes/0.8.2.md` 与 `rebaseEngine.ts` 注释把这条不变量写成绝对，属**声明精度**问题。建议在注释里说明“比较的是经 clean filter 规范化后的对象 ID”。

### N-3（P3）目录碰撞走的是“意外安全”路径，非设计路径

见 1.1：Git 对目录碰撞的文案是 `Updating the following directories would lose untracked files in them`，不匹配 `untracked working tree files would be overwritten`，所以不进入分类逻辑，直接原样抛出。**当前行为安全**（不删除），但一旦将来有人扩展正则去覆盖更多文案，就会把目录场景送进 `abortMayReplace`，而 `path.join(cwd, filePath)` + `fs.rm(..., {force:true})` 对目录的处理需要重新论证。建议补一个目录场景的回归用例把这层保护钉住。

### N-4（P3）发布说明与 `RELEASE.md` 声称“每个站点都被钉住”，实测 4 个站点无覆盖

见 1.2 的逐点变异表。代码正确，但可审计的声明应改为“已覆盖 5 个站点，其余 4 个站点由 X 保证”或补齐用例。

---

## 三、两项非空转声明的核实

在隔离副本中分别施加变异、只跑 `editStopCommit` 的三个 abort 用例：

| 变异 | 结果 |
| --- | --- |
| **M1**：`return current.code === 0 && current.stdout.trim() === want;` → `return current.code === 0;`（去掉字节比对） | `abort refuses to delete user content at a collision path…` **变红**（`abortRebase must refuse rather than delete user content`）；另两个仍绿 |
| **M2**：`abortMayReplace` 函数体首行插入 `return true;`（整个归属证明替换为无条件删除） | 同上，**同一用例变红**；另两个仍绿 |

两项声明**成立**。同时说明：单靠 M1/M2 无法区分这两个变异，因为守卫用例断言的是“必须抛错”；但配合 1.1 的混合集合与目录探针，归属证明的两条独立前提都已被实际验证。

---

## 四、第 1 轮回归

| 编号 | 结论 | 依据 |
| --- | --- | --- |
| P1-1 NUL 切分 | 仍修复 | `gitRunner.ts:50` `splitNul` 按 `\0`；`commitLog.ts:457` `diff --name-only -z` |
| P1-2 恢复中的字面 pathspec | 仍修复（覆盖广度同上，见 N-4） | `pendingRecovery.ts` 中 8 处 `LITERAL_PATHSPECS`；去掉全部后 `pendingRecovery` 40 项中 **1 红**（`a residual path with glob characters restores literally and never overwrites the decoy`） |
| P2-1 横幅命令 | 仍修复 | `every command the banner offers actually runs against a real repository`、`the first command offered for an index-present append exits 0 against the real state` 均通过 |
| P2-2 分阶段窗口 | 仍修复 | `stashRestoreForAmend` 先暂存/未跟踪半、`stashRestoreWorktreeAfterAmend` 在 amend 之后恢复工作区半；`the full restore applies the worktree half before the index half` 通过 |
| P3 顺序断言 | 仍修复 | 同上用例；`stashApplyIndexBySha` 中 `restoreWorktreeHalf` 先于 `restoreStagedHalf` |

两项类型检查（`tsc --noEmit`、`tsc -p tsconfig.test.json --noEmit`）均**零输出、退出码 0**。

---

## 五、发布完整性

逐项核对：

- **版本**：`package.json` / `package-lock.json`（2 处）/ `README.md` 日志路径示例 / `RELEASE.md` 均为 0.8.2；VSIX manifest `Identity Version="0.8.2"`、包内 `extension/package.json` 为 0.8.2。
- **发布说明**：`docs/release-notes/0.8.2.md` 标题为 `## Git Rebase Visual 0.8.2`，无 `{{…}}` 残留，无悬空 `0.8.3` 引用。
- **测试数**：源码中顶层 `test(` 共 **232** 个，与声明的 232/232 一致（我未复跑完整套件）。
- **VSIX 内容**：**12** 项——`extension.vsixmanifest`、`[Content_Types].xml`、`extension/{readme.md,package.json,LICENSE.txt,.gitignore,media/{style.css,main.js,icon.svg,extension-icon.png},dist/{seq-editor.js,extension.js}}`；无 `.map`、无 `src`/`test`/`docs`/`node_modules`/`tsconfig`，包内 bundle 不含 `sourcesContent`/`sourceMappingURL`。
- **打包一致性**：包内 `extension/dist/extension.js` 的 sha256 = `666748d97e5e7ae042f01a33d418527c440e212302b82a3954dd51c7094706a8`，**等于** 工作区 `dist/extension.js`。我又在干净的打包副本里重新执行 `vsce package`，产出的 bundle **哈希相同**，说明当前源码可重现同一个 bundle。
- **包内确实含本轮修复**：bundle 中存在 `GIT_LITERAL_PATHSPECS`、`hash-object`、`--path=`，以及 abort 拒绝删除的提示串与三段式恢复的失败串（以 `\uXXXX` 转义形式存放，已按转义核对）。
- **没有比 VSIX 更新的产物**：最新源码 mtime 16:52，`dist/extension.js` 17:38，VSIX 17:39——顺序正确，`dist/` 之后没有源码改动。
- **`dist-vsix/` 打包改动**：`.gitignore` 加了 `dist-vsix/`（`git check-ignore` 确认生效），`.github/workflows/release.yml` 的校验与 `gh release create` 资产路径都改到 `dist-vsix/…`，与 `package.json` 的 `--out dist-vsix/` 一致；CI 全新 checkout 下该目录不存在，vsce 会按目录创建——**该路径本身可用**。缺陷仅在“目录已存在”时，见 N-1。
- **一处本就有、本次未改的瑕疵**：VSIX 内含 `extension/.gitignore`（436 B），对最终用户毫无用处。非本轮引入，不计入结论。

---

## 六、发布结论

**当前工作区状态可以批准。** 第 2 轮的阻塞项 P2 已真正修复，且我用混合集合、目录碰撞、非 ASCII/空格名、CRLF、有损 filter 等对抗场景尝试破坏它，均未造成用户内容丢失；P3-2、P3-3 已修复且非空转经实测确认；第 1 轮全部回归仍然成立。

**但这份批准对 VSIX 有一个限定条件：**

- 现存的 `dist-vsix/git-rebase-visual-0.8.2.vsix` **可以**随本次批准发布——它的 bundle 与工作区 `dist/extension.js` 哈希一致，12 项内容干净，确实包含本轮全部修复，且不存在“包比源码旧”的情况。
- 该 VSIX **不可原样重新打包**。只要 `dist-vsix/` 目录非空（本地重打包的正常状态），`npm run package` 会产出**名为 `dist-vsix` 的文件**并把旧构建递归塞进包里（N-1）。发布前请先落地 N-1 的修复，或在重新打包前手动清空 `dist-vsix/`。

N-2、N-3、N-4 均为 P3，不阻塞发布，建议随后续版本一并处理。
