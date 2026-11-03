# code review 0.8.7 — Agent B 独立复审（0.8.2 第五轮增量）

## 基线

- 仓库：`D:\work\tools\git plugin`，分支 `main`，HEAD `eddca56`（`eddca5642cb7dadb1645e24e2d6d074a39aedc26`），版本 0.8.2。
- 工作区：开始时 `git status --short` **28 项**（内容 md5 `2c9dd8cc765ea1f95345ff1fa9849c7a`），结束时 **28 项**，md5 相同；本报告是唯一新增文件。未修改任何产品代码、测试或既有文档；未 commit / tag / checkout / stash / reset。
- 已读台账 `docs/review/code-review-commit.md`：0.8.2 的被评审材料仍是**未提交工作树**（基线 `b87011d` + `git diff` + untracked），没有可记录的 commit SHA。本轮我**无法**更新台账（写权限只允许新增本文件）。
- 本轮范围：第 4 轮 `R4-2`（P2）与 `R4-1`（P1）的整改验证，以及实现者对打包脚本的改动。
- 方法：真实 Git `2.53.0.windows.2` + Node `v24.16.0`。所有破坏性探针在 OS 临时目录（`%LOCALAPPDATA%\Temp\b5\*`，`node_modules` 用 NTFS junction 指向真实目录）与 OS 临时仓库中执行；探针导入的是**真实产品模块**（`src/git/rebaseEngine.ts`，通过 `pathToFileURL` 动态导入，未做任何改动），因此端到端结论直接来自现行 `abortRebase`，不是来自副本。结束时已删除自己创建的全部临时目录，`grv-abort-guard-*` 残留 **0** 个。
- 套件：在临时副本中跑了 5 个受影响套件共 **79 项，全绿**（`editStopCommit` 17/17、`worktree` 8/8、`worktreeChanges` 6/6、`appendStaged` 8/8、`pendingRecovery` 40/40）。**未运行完整套件**（规则要求，约 24 分钟）：实现者报告的 246/246 **我未独立确认**。
- 并发负载：另一个代理可能在跑套件，本轮单个真实 Git 用例耗时数秒到数十秒，**本报告不基于任何计时结论做安全判断**，性能只在第 3 节作为独立的用户体验结论列出。

---

## 一、R4-2 裁决：整改方向正确且有效，但**没有覆盖它自己声称的模型**（详见第 3 节 N5-1 / N5-2）

### 1.1 七形状矩阵：独立复现，实现者的表成立

我用真实 Git 重新量了“预测源 vs 真实 `reset --hard`”。真实值按 abort 的实际动作测量——在副本里**先删掉碰撞路径**再 `rebase --abort`，否则 `reset` 会跳过已与 blob 相同的文件：

| 形状（目标树相对工作区） | `cat-file --filters` | `git archive` | 真实 `reset` 写入 |
| --- | --- | --- | --- |
| 目标树新增 `eol=crlf` | `later\n`（错） | `later\r\n` | **`later\r\n`** |
| 目标树删掉 `eol=crlf` | `later\r\n`（错） | `later\n` | **`later\n`** |
| 目标树新增 smudge filter | `later\n`（错） | `LATER\n` | **`LATER\n`** |
| 目标树删掉 smudge filter | `LATER\n`（错） | `later\n` | **`later\n`** |
| 目标树新增 `ident` | `x $Id$ y\n`（错） | `x $Id: 08a4620… $ y\n` | **已展开** |
| 目标树删掉 `ident` | 已展开（错） | `x $Id$ y\n` | **`x $Id$ y\n`** |
| 目标树有 `export-subst` | `s $Format:%H$ e\n` | 已替换（错） | **`s $Format:%H$ e\n`** |

结论：`cat-file --filters` **6/7 错误**（只有 `export-subst` 碰巧正确），`git archive` **1/7 错误**（且在 `export-ignore` 上还会丢路径）。与 `docs/release-notes/0.8.2.md` 的第 45–57 行表述一致，也与实现者对第 3 轮 `ident` 结论的更正一致。

### 1.2 新 guard 与真实 reset 的一致性

`abortCheckoutBytes` 的 `read-tree` + 镜像每级 `.gitattributes` + `checkout-index` 路线，在我能构造的所有“属性来源”形状上都与真实 reset **逐字节一致**：

| 攻击 | 结果 |
| --- | --- |
| 无属性（基线） | 一致；磁盘=reset → 删除 |
| `.git/info/attributes` 给 `eol=crlf` | 一致 → 拒绝 |
| `core.attributesFile` 指向**绝对**路径 | 一致 → 拒绝 |
| 工作区有**未跟踪**的根 `.gitattributes`、目标树没有 | 一致 → 拒绝 |
| 目标树有嵌套 `d/.gitattributes`、工作区 `d/` 没有 | 一致（按目标树 blob 铺镜像生效）→ 拒绝 |
| 工作区有嵌套 `d/.gitattributes`、目标树没有 | 一致 → 拒绝 |
| 深路径 `a/b/c/later.txt` + 目标树 `a/b/c/.gitattributes` | 一致 → 拒绝 |
| `ident` 目标树新增 / 删掉 | 一致 → 分别拒绝 / 删除 |
| `export-subst` | 一致（`checkout-index` 正确不展开）→ 删除 |
| `working-tree-encoding=UTF-16` | 一致 → 拒绝（guard 的值与磁盘 BOM 顺序/字节都不同） |
| `core.autocrlf=true`（仓库配置） | 一致 → 删除 |
| `core.autocrlf=true` 经父进程环境 `GIT_CONFIG_COUNT` 注入 | 一致 → 拒绝 |
| dest 的碰撞路径是符号链接（120000） | `ls-tree` 双检拦下 → 拒绝，字节保留 |
| dest 的碰撞路径是 gitlink（160000） | 同上 → 拒绝，字节保留 |
| 碰撞路径的**祖先**是普通文件（`sub` 被换成文件） | `checkout-index` 非零 → 拒绝，blocker 完好 |
| 目录碰撞（dest 是目录） | 走 `directoryCollisions` 分支 → 拒绝，目录内容保留 |
| smudge filter 命令是相对脚本路径 `./smudge.sh` | 一致（脚本在真实工作区，scratch 检出仍能执行）→ 删除 |
| 工作区的 `.gitattributes` 是符号链接（指向 `real.attrs`） | 一致 → 拒绝 |
| `core.symlinks=false` | 一致 → 拒绝 |
| 碰撞文件名含空格 / 非 ASCII / 前导 `-` | 一致（`GIT_LITERAL_PATHSPECS` + `--`）→ 删除 |
| 20 MiB 碰撞文件 | 一致 → 删除，约 3.3 s |
| `mkdtemp` 失败（`TMPDIR` 指向不存在目录） | 异常被捕获 → 拒绝，字节保留 |
| 上次崩溃遗留的 `grv-abort-guard-*` 目录 | 被忽略且**未被删除**，guard 正常工作 |
| sparse-checkout cone 模式排除目标目录 | 该形状下普通 abort 本来就成功（无碰撞），guard 未被触发——结论不适用于它 |
| LFS / 失败 smudge（`smudge = false`） | 普通 abort 仍报碰撞；guard 检出失败 → 拒绝，字节保留 |

**scratch 目录在以上全部探针（含异常路径）之后都没有泄漏**：每次运行结束 `os.tmpdir()` 下 `grv-abort-guard-*` 计数为 0，`finally` 的 `rm(recursive,force)` 覆盖了所有我构造的错误分支。

### 1.3 非空转：`cat-file --filters` 变异实际打红 **4** 个用例，不是文档说的 3 个

我把 `abortCheckoutBytes` 整体换回 `runGit(["cat-file","--filters",…], { rawStdout: true })`（其余不动）后跑 `editStopCommit`：

- ✖ `abort refuses when the later commit drops eol=crlf and the worktree still has it`
- ✖ `abort refuses when the later commit deletes .gitattributes entirely`
- ✖ `abort refuses when the later commit removes a smudge filter the worktree still uses`
- ✖ `abort refuses when the destination adds eol=crlf the paused worktree never saw` ← **文档没算进去的第 4 个**，红在 `assert.rejects`：`Missing expected rejection: the guard refuses rather than deleting bytes the reset cannot reproduce`
- 其余 13 个仍绿；恢复 `checkout-index` 实现后 17/17 全绿。

所以“换回旧预测源会让测试变红”成立，且比我预期的更强；但 `docs/release-notes/0.8.2.md` 里“**三个**…全部变红”的计数**少算一个**（见 P3，N5-4）。方向安全（少报红），但数字是错的。

### 1.4 性能与健壮性（不用于安全判断）

- 单路径：深度 1 ≈ **2.9 s**；深度 10（10 级 `.gitattributes` 镜像）≈ **8.9 s**，git 调用数随祖先目录数线性增长（10 次/路径 + 每级 3 次）。
- 批量：10 条碰撞路径一次性分类 ≈ **18.0 s**（逐路径串行）。
- 20 MiB 文件 ≈ 3.3 s；含空格/非 ASCII 的路径 ≈ 4.2 s。
- 这些耗时发生在 `abortRebase` 内、`MutationLock`（`staleAfterMs = 90_000`）之外，尚未触发 90 s 看门狗，但用户点 Abort 后会有明显停顿；对 10 条以上碰撞路径接近看门狗阈值的一半。
- 结论：**功能正确，代价是“每次 abort 都做一遍真实检出”**；除 P3 提醒外不作为阻塞理由。

### 1.5 文档同步（`ident` 与测量口径）

`docs/release-notes/0.8.2.md` 与 `RELEASE.md` 都已把 `ident` 两方向改对（“目标树新增 → 已展开”“目标树删掉 → 原始 blob”），并写明“真实 `reset` 写入必须按 abort 的实际动作测量——先删掉碰撞路径再 `reset --hard`”。这一条我按原文重测，成立。`RELEASE.md` 的 9 行附录表 4 列齐全（`file` 列每行都有），`docs/release-notes/0.8.2.md` 附录 A 6 列、9 行每行都有“用例所在文件”；两份文档中**没有** `.ts:<line>` 形式（仅 `docs/review/code-review-0-8-3/4/5/6.md` 等历史评审文件里有，属历史记录，不应改）。

---

## 二、R4-1 裁决：**完全修复**，三种状态都正确

在**干净副本**（从当前工作树 `tar` 出，`node_modules` 用 junction）上独立复现，每种状态都跑了两次：

| `dist-vsix` 状态 | 结果 |
| --- | --- |
| 不存在 | `npm run package` 退出 0；产出 `dist-vsix/git-rebase-visual-0.8.2.vsix`；**12 条目**；无 `scripts/`、无 `dist-vsix` 条目 |
| 存在且是目录、有内容（`sentinel.txt`） | 退出 0；产出同名 vsix 于该目录内；**12 条目**；`sentinel.txt` **未被打进包**，也未被删除；目录其余内容不被动 |
| 存在且是**普通文件** | 退出 **1**；输出可执行的具体信息：`… exists but is not a directory. It is probably the zip that \`vsce package --out dist-vsix/\` wrote before the directory existed. Delete that file and re-run \`npm run package\`.`；那个文件**保持原样**（内容仍是我写的 `not-a-dir`），没有被改写成 zip |

补充变异与边界：

- **删除前置检查**（只留 `mkdirSync`）：`mkdirSync(recursive)` 直接抛原始 `EEXIST` 栈，退出 1。行为仍是“不静默接受”，但文本退化成堆栈——说明前置检查的价值是信息而非安全。
- **目标路径本身是目录**（`dist-vsix/git-rebase-visual-0.8.2.vsix/` 存在）：vsce 会往里再写一层同名文件并报成功；`scripts/package-vsix.js` 的事后 `existsSync`/`isFile()` 检查将其判为失败，退出 **1**，并打印 `vsce reported success but did not produce …`。这条兜底确实在起作用。
- **绕过脚本直接调 `vsce package --out dist-vsix/`**（普通文件已存在时）：产物仍是 12 条目、无 `dist-vsix` 条目，说明 `.vscodeignore` 的 `dist-vsix`（无斜杠）对“文件形态”也生效。
- `.gitignore` 新增 `/dist-vsix`：确认 `dist-vsix/` 只匹配目录、`/dist-vsix` 匹配两种形态；仓库内 `dist-vsix/` 不进版本控制。

**结论：R4-1 关闭。** 发布流水线里 `test -f "$vsix"` 在全新 checkout 下不再必然失败。

---

## 三、新发现（最严重在前）

### N5-1（**P2，阻塞 auto-delete**，静默丢用户字节，且是相对旧实现的**回归**）`abortCheckoutBytes` 在 scratch 检出里设置 `GIT_WORK_TREE`，使**相对路径的 `core.attributesFile` 无法解析**，guard 由此预测出未转换的 blob，授权删除

- 位置：`abortCheckoutBytes`（`src/git/rebaseEngine.ts`）里 `checkout-index` 调用传入 `env: { ...scratchEnv, GIT_WORK_TREE: gitPath(workTree) }`。镜像循环只铺 `.gitattributes`，从不铺 `core.attributesFile`。
- 机制：Git 把**相对** `core.attributesFile` 解析在**工作区根**（我用 `check-attr` 实测：`cwd=repo` 与 `cwd=repo/sub` 结果相同；且 `GIT_WORK_TREE=/tmp/other` 时同一配置返回 `eol: unspecified`）。guard 的 scratch 工作区是空的，于是“检出”认为该路径无属性，预测 = 原始 blob；真实 reset 在真实工作区里读到相对属性文件，写出的是转换后的字节。
- 端到端证据（**导入真实产品模块**，普通 abort 在同一仓库确认为 128 碰撞，真实值在副本上“先删后 abort”测得）：

  | 形状 | 磁盘（用户字节） | 真实 reset | `abortRebase` 结果 |
  | --- | --- | --- | --- |
  | `core.attributesFile = myattrs`（仓库根），`*.txt eol=crlf` | `later\n` | `later\r\n` | **completed**，文件被删后重写为 `later\r\n`（用户字节丢失） |
  | `core.attributesFile = cfg/global.attrs`（子目录相对路径），同上 | `later\n` | `later\r\n` | **completed**，用户字节丢失 |

- **这是回归**：旧的 `cat-file --filters` 预测源以 `cwd = 真实仓库` 运行，在这两个形状上预测 `LATER`/`later\r\n` 与磁盘**不等**，因而会**拒绝**（安全）。我实测确认旧预测源在这两个形状上都是“refuse (safe)”。
- 影响：任何把 `core.attributesFile` 配成相对路径的用户，只要在变基暂停时把某个即将被回放路径写成“工作区形态”，guard 就会判定可删并删除。默认配置下不触发，但这是合法且常见的配置写法，且后果不可恢复。
- 与第 4 轮同类：错误的来源都是“guard 在一个合成环境里预测检出结果”。区别只是这次环境差异来自 `GIT_WORK_TREE` 而不是属性树。
- 可选的收窄方向（任一都能把方向改回安全）：
  1. 若 `core.attributesFile` 是相对路径，按 Git 的规则解析到**真实工作区根**，再按其相对位置镜像进 scratch 工作区（仅当目标树没有提供同名属性文件时）；
  2. 或者在 `git config --get core.attributesFile` 得到相对路径（以及任何无法证明与真实工作区等价的情形）时**一律拒绝**自动删除——拒绝只会让用户手动挪文件，删除不可挽回。

### N5-2（**P2，阻塞 auto-delete**，静默丢用户字节）smudge filter 的输出依赖工作区/进程环境时，scratch 检出得到的字节与真实检出不同

- 位置：同上，`abortCheckoutBytes` 的 `checkout-index`。filter 程序在 scratch 工作区里执行，`cwd` 与工作区内容都不是用户的真实环境。
- 端到端证据（`GIT_WORK_TREE` 之外的独立机制）：`core.attributesFile` 指向**绝对**路径，`later.txt filter=ctx`，`filter.ctx.smudge = sh -c 'if [ -f marker.txt ]; then cat marker.txt; else printf "STABLE\n"; fi'`；真实工作区里 `marker.txt = VERSION2\n`。磁盘写 `STABLE\n`（即 filter 在**没有** marker 时的输出），scratch 检出正好复现这个输出 → guard 判等 → **`abortRebase` completed，文件被重写为 `VERSION2\n`，用户字节丢失**；真实 reset 会写 `VERSION2\n`。
- 说明：这不是“过滤器有副作用”这种人为构造；任何读取工作区状态、环境变量或相邻文件的 smudge（模板展开、按配置注入版本号、按 `marker` 决定占位符）都会命中。**方向上与 N5-1 同类：guard 无法证明“scratch 里的检出 == 真实 reset”，而它把不能证明当成了可以删除。**
- 建议：只要路径的属性栈里出现 `filter`（`check-attr filter` 非 `unspecified`），或出现 `working-tree-encoding` / `ident` 这类“内容变换依赖外部状态”的属性，就直接拒绝自动删除。纯 `eol`/`text`/`autocrlf` 的文本变换可以保留自动删除（这些是 guard 真正能建模的部分）。

### N5-3（P3，体验）逐路径真实检出的代价是用户可见停顿，且随祖先目录数与碰撞条数线性增长

- 单路径 2.9 s（深度 1）/ 8.9 s（深度 10）；10 条碰撞路径 ≈ 18.0 s；全部在 `abortRebase` 内的串行分类阶段。
- 未触发 `MutationLock` 的 90 s 看门狗，但已经接近“用户以为界面卡住”的量级；若把上面的拒绝面收窄（N5-1/N5-2 建议），顺带可以把不必要的检出省掉。仅记录，不作为阻塞项。

### N5-4（P3，文档）两处与实测不符的表述

1. `docs/release-notes/0.8.2.md` 第 93 行：“换回 `cat-file --filters` 后，**三个**…用例全部变红”。实测是 **4 个**（第四个是 `abort refuses when the destination adds eol=crlf the paused worktree never saw`，同样红在 `assert.rejects` 的 `Missing expected rejection`）。数字少算，方向安全，但它是“非空转证明”的核心数字，应改为 4 并补上该用例名。
2. 同一文件第 57 行（以及 `abortCheckoutBytes` 的注释）称 “`.git/info/attributes` 与 `core.attributesFile` 由这次临时检出自动生效”。`.git/info/attributes` 成立（它按 `GIT_DIR` 解析，scratch 环境沿用真实仓库）；**`core.attributesFile` 只在配置为绝对路径时成立**，相对路径恰恰是 N5-1。这句需要收窄为“绝对路径的 `core.attributesFile`”，否则文档在为一个不成立的机制背书。

### N5-5（P3，打包，非本轮回归）`.vscodeignore` 是黑名单，发布工作区里任何未列出的顶层目录都会被打进 VSIX

- 我验证打包脚本时在副本里创建一个 `save/` 目录，产物立刻变成 **13 条目**（多出 `extension/save/sentinel.txt`），`scripts/package-vsix.js` 与 `release.yml` 的检查都**不会**发现：脚本只校验“产物存在且是普通文件”，workflow 只否定 `src/`、`test/`、`docs/`、`node_modules/`、`*.map`。
- 从干净 checkout 构建时不会触发，故只是加固建议：把校验改成“条目白名单”（12 条），或至少在 workflow 里断言条目数。

---

## 四、0.8.2 发布结论

- **打包与产物：通过。** `R4-1` 完全修复；当前仓库里的 `dist-vsix/git-rebase-visual-0.8.2.vsix`（sha256 `47c8eba0a8242da69fb22139fde4e80ec90c0e74a08e0df27534bddcc9759e0e`，147 136 字节）：
  - **12 条目**，无 `src/`、`test/`、`docs/`、`node_modules/`、`tsconfig*`、`scripts/`、`dist-vsix`、无 `*.map`；
  - 版本 `0.8.2`，`main = ./dist/extension.js`，`engines.vscode ^1.85.0`；
  - 包内 `extension/dist/extension.js` 与仓库 `dist/extension.js` **sha256 相同**（`260f4a7fcec8050ac5043561fc43551d479c061ff8f4cf5defa178358f2e555e`，即实现者报告的当前值；比第 4 轮的 `1152b424…` 已更新）；
  - 在干净副本里重新 `npm run package` 得到**同一个 bundle hash**，`dist/` 中没有比产物更新的文件，包内含新 guard（`grv-abort-guard-` 字样）且不含 `GIT_ATTR_SOURCE`、不含 `sourcesContent`。
  - 说明：VSIX **容器** sha256 每次构建都会变（zip 时间戳/顺序），所以“容器哈希”不是复现性判据；应比对包内 `extension/dist/extension.js`。两次干净构建的容器哈希分别为 `bbe18eb9…`、`626f8bb…`，bundle 相同。
- **两个类型检查：通过**（`tsc --noEmit` 与 `tsc -p tsconfig.test.json --noEmit`，在临时干净副本中退出码均为 0，零输出）。
- **5 个受影响套件：79/79 全绿**（本轮独立复跑）；**完整套件未运行**，实现者报告的 246/246 我未独立确认。
- **发布裁决：`0.8.2` 本身（打包、VSIX、文档主体、`R4-1`）可以发布；但 `abortRebase` 的自动删除能力仍有一个 P2 级静默丢字节面（N5-1、N5-2），因此我不同意以“自动删除已被证明无损”的说法发布。** 若坚持在 0.8.2 内保留自动删除，最小放行条件是 N5-1 与 N5-2 的收窄落地（相对 `core.attributesFile` 与含 `filter`/`working-tree-encoding` 的属性栈一律拒绝），并补一条相对 `core.attributesFile` 的集成用例。若不改代码，则建议在 0.8.2 里**关掉自动删除**（见下），其余照发。

---

## 五、`abortRebase` 的自动删除现在安全吗？

**比第 4 轮明显更安全，但不安全。** 具体的剩余风险不是我推演出来的假设，而是本轮**端到端复现**的两条：相对 `core.attributesFile`（N5-1）与依赖工作区状态的 smudge filter（N5-2）。两者都会让 guard 判定“磁盘字节 == reset 会写的字节”，随后 `abortRebase` 删除文件、真实 reset 写回**不同**的字节，用户未提交的内容不可恢复。且 N5-1 在**旧实现下本来是被拒绝的**——这一轮把它变成了丢数据。

根因是结构性的，不是某个分支写漏了：guard 的整个正确性依赖“在合成环境里跑一次真实检出，结果等同于用户在真实工作区里 reset 的结果”。属性**树**这部分已经被 `read-tree` + 镜像精巧地解决了；剩下的差异全部来自**环境**（`GIT_WORK_TREE`、`cwd`、工作区里除 `.gitattributes` 以外的文件、filter 进程读取的一切）。这类差异不可能靠枚举补齐，每补一个还会引入“我以为已覆盖”的错觉——第 4 轮到第 5 轮就是一次实例。

因此我的建议，按偏好排序：

1. **把自动删除收窄成可证明的白名单**：只有当该路径的属性栈**只**含 `text`/`eol`/`autocrlf`（且 `core.attributesFile` 为绝对路径或未配置、`.git/info/attributes` 与目标树一致）时才允许删除；出现任何 `filter`、`working-tree-encoding`、`ident`、相对 `core.attributesFile`、或 guard 无法在 scratch 里复现的环境条件时**拒绝**。这样保留了 90% 的真实价值（`eol` 冲突是变基暂停时最常见的碰撞来源），并把“预测”退化成“我确实在这里算对了”的范围。
2. 若不愿引入白名单的复杂度，**彻底移除自动删除是更好的交易**：失败方向永远安全，而代价极小——`abortRebase` 保留现有的“拒绝 + 点名文件 + 给出‘先移走再重试’”文案，用户手动挪一个文件后再次 Abort 即可完成；`pendingRecovery`/`restorePendingAppend` 的收尾路径不受影响。相比之下，当前的设计把“用户少一次手动操作”换成了“在少数配置下静默删除用户文件”，这个交换在数据安全上不划算。
3. 如果既保留自动删除又不收窄，那么至少要把 N5-1 修掉（它既是回归，也有明确的修法：按真实工作区根解析相对 `core.attributesFile` 并镜像进 scratch），并在文档里明确“依赖工作区状态的 filter 不在保证范围内”——但我不建议用文档免责来代替代码收窄。

（关于第 4 轮的 `R4-2` 本身：它提出的“预测基准必须来自目标树”这一判断是**对的**，我认账；本轮的问题不在于这个判断，而在于实现把它推广成了“所以我可以在任何环境下重放一次检出”。）

---

## 附：本轮未覆盖 / 需后续确认

- 完整套件（246 项）未运行。
- `docs/review/code-review-commit.md` 未更新：0.8.2 仍是未提交工作树，没有 SHA 可记录，且我的写权限只允许新增本文件。待实现者提交后，需在同一变更中按真实 SHA 追加台账。
- 未评估 UI 层（`src/ui/rebaseViewProvider.ts` 的 Abort 分支）在 N5-1/N5-2 下的用户可见提示是否足够——因为当前结论是“根本不该删”，先修代码再看提示。
