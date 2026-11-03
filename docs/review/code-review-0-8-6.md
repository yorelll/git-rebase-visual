# code review 0.8.6 — Agent B 独立复审（0.8.2 第四轮增量）

## 基线

- 仓库：`D:\work\tools\git plugin`，分支 `main`，HEAD `eddca56`（`eddca5642cb7dadb1645e24e2d6d074a39aedc26`），版本 0.8.2。
- 工作区：开始时 `git status --short` **26 项**（内容 md5 `f2b3fc1aa09e06c20e2586a3924a42d7`），结束时 **26 项**，内容一致；本报告是唯一新增文件（写入后为 27 项）。未修改任何产品代码、测试或既有文档，未 commit/tag/checkout/stash/reset。
- 已读台账 `docs/review/code-review-commit.md`：0.8.2 的被评审材料仍是**未提交工作树**（基线 `b87011d` + `git diff` + untracked），没有可记录的 commit SHA；台账更新需要提交后由实现者在同一变更中完成，不在本代理可写范围（规则只允许新增本文件）。
- 本轮范围：第 3 轮三条 P3（N-2、N-3、N-4）的整改与归属裁决，N-1 的争议再裁决，以及发布完整性。
- 方法：真实 Git `2.53.0.windows.2` + Node `v24.16.0`。所有破坏性探针在仓库外的临时副本（`%LOCALAPPDATA%\Temp\bb4\*`，`node_modules` 用 NTFS junction 指向真实目录）与 OS 临时仓库中执行，结束后只删除自己创建的目录。
- 套件：在临时副本中跑了 5 个受影响套件共 **74 项，全绿**（`worktree` 8/8、`worktreeChanges` 6/6、`appendStaged` 8/8、`editStopCommit` 12/12、`pendingRecovery` 40/40）。**未运行完整套件**（规则要求，约 21 分钟）：实现者报告的 241/241 **我未独立确认**。
- 并发负载：另一个代理（Agent C）在独立 worktree 中做测量、可能同时在跑套件。本轮单个真实 Git 用例耗时 3–35 秒，**本报告不基于任何计时结论**做判断。

---

## 一、N-2 裁决：实现者正确，我第 3 轮的建议是错的

第 3 轮我建议把比较基准改回 `hash-object --path=`（clean 形态）或原始 blob。**该建议错误**，理由正是实现者指出的那一点：guard 要回答的是“`reset --hard` 会不会把这串字节原样写回来”（checkout/smudge 方向），不是“这个文件会不会存成同一个 blob”（clean 方向）。我在真实 Git 上独立重做了四行测量（`probe/fourrow.ts`，每行都同时读 `cat-file --filters` 的输出与真实 `reset --hard` 后的磁盘字节）：

| 形状 | clean(磁盘)==blob | checkout(blob)==磁盘 | `reset --hard` 实际写入 | 无损？ |
| --- | --- | --- | --- | --- |
| `core.autocrlf=true`，工作区 CRLF | 是 | **是** | `later\r\n` | **是** |
| `*.txt text eol=lf`，工作区 CRLF | 是 | **否**（写回 `later\n`） | `later\n` | 否 |
| 有损 clean filter（去行尾空白），内容 `later    \n` | 是 | 否 | `later\n` | 否 |
| `core.autocrlf=false`，工作区 CRLF | 否 | 否 | `later\n` | 否 |

第一行就是决定性的：clean 与 checkout 在这里都是恒等映射，**删除是无损的**，而 raw-blob/clean 比较会把它误判为“用户内容”而拒绝。实现者的判断成立。

**“完全撤掉后”的实测与实现者声明一致**（我把 `abortMayReplace` 换回旧的 `hash-object --path=` + `rev-parse` 比较，其余不动）：

- `abort refuses a CRLF file whose normalization equals the committed blob (eol=lf)` → **变红**
- `abort refuses a file a lossy clean filter would normalize into the blob` → **变红**
- `abort removes a CRLF file when the checkout form really is CRLF (autocrlf=true)` → **仍绿**

恢复现行实现后三者全绿。

**关于“旧夹具含多余文本、旧比较器因错误原因拒绝”的自查**：我把 `test/editStopCommit.integration.test.ts:308` 的 `userBytes` 改成 `later\r\nEXTRA` 后，`eol=lf` 用例**变红**，且红在前提断言 `the clean form really equals the blob, so only the checkout form can distinguish`。也就是说该夹具现在确实被那条前提断言钉住，不会再退化成“因为别的差异而变红”。实现者的自查成立。

**结论：N-2 关闭，我认错。** 但“checkout 形态就是 `reset --hard` 写出的字节”这句等价本身仍然过强，见下。

---

## 二、R4-2（P2，阻塞）`cat-file --filters` 从**工作区**解析属性，`reset --hard` 用**目标树**的属性，guard 因此仍会静默丢弃用户字节

### 机制

`git cat-file --filters` 的属性来源是工作区/索引里的 `.gitattributes`；而 `reset --hard <orig-head>` 写文件时用的是**目标树自带的**属性。两者只在“工作区属性 == 目标树属性”时一致，而这个条件既不受代码控制、也没有被任何测试钉住。

### 证据（均为真实 Git，直接对比“guard 的预测”和“真实 reset 写出的字节”）

1. 同 blob、属性方向相反的两次 reset（`arch6`/`arch3`）：提交 A 的树为 `*.txt text eol=crlf`、提交 B 的树为 `*.txt -text`，两棵树里 `later.txt` 是同一个 blob `e974158c2b867531a738941c09dbb50427e7dc6d`。
   - 工作区在 B（`-text`）时 `reset --hard A`（树 `eol=crlf`）→ 写 `later\r\n`；而 `cat-file --filters A:later.txt` 按工作区属性预测 `later\n`。
   - 工作区在 A（`eol=crlf`）时 `reset --hard B`（树 `-text`）→ 写 `later\n`；`cat-file --filters B:later.txt` 预测 `later\r\n`。
2. **端到端（无需用户做任何事）**（`probe/paused.ts`）：base 无属性；`edit` 停靠点的提交加入 `*.txt text eol=crlf`；tip（= 变基前 HEAD，也就是 `orig-head`）删除该属性恢复 `-text`。变基停在 edit 后，**完全没有用户编辑**，事务把 `later.txt` 以停靠形态（CRLF）放回工作区：
   - `cat-file --filters tip:later.txt` → `later\r\n`（= 磁盘）→ guard 判定可删；
   - `reset --hard tip` 实际写 `later\n`（目标树 `-text`）；
   - `abortRebase` **不抛错**，变基完成，**用户的 CRLF 字节丢失**，`USER BYTES LOST: true`。
3. **端到端（用户在暂停期间编辑 `.gitattributes`）**（`probe/dirty.ts`）：同一形状，同样无损检测失败、字节丢失、变基完成。
4. **属性在提交间翻转的矩阵**（`probe/matrix.ts`）：R1（后续提交**删除** `eol=crlf`）LOSS；R4（后续提交删除整个 `.gitattributes`）LOSS；R5（后续提交**移除** smudge filter）LOSS；R2/R3（后续提交**新增**属性）正确拒绝；R6（`eol=lf`）与 R7（`autocrlf=true`）行为正确。也就是说：**目标树属性比工作区少时放行，少的那一侧正好是“检出会丢字节”的一侧。**
5. **形状可达性**（`probe/restorebytes.ts`）：扩展自己的恢复用 `git restore --source=<orig> --worktree`，它按**当前**属性写出，落在碰撞路径上的字节是停靠形态 `later\r\n`；随后 `reset --hard <orig>` 写 `later\n`。所以“磁盘字节恰好等于 guard 预测”不是人为构造，而是本次恢复流程自己的产物。

### 影响

静默数据丢失，且不报错、变基正常完成——这正是第 2 轮 P2 修复承诺要消除的类别（“真正未跟踪的用户文件永不删除”“删除只在可证明无损时发生”）。触发条件：仓库的 `.gitattributes` 在 tip 与停靠提交之间对相关路径不同（合并/变基/删属性都会造成），叠加已知的“事务恢复路径被后续提交占用”形状。不需要用户误操作。

### 修复方向（两条我都实测过）

- **`GIT_ATTR_SOURCE=<orig-head>`**：`cat-file --filters` 改为从目标树解析属性，预测与真实 reset **逐字节一致**。把该变量加进 `abortMayReplace` 的 env（`src/git/rebaseEngine.ts:336`）后，`paused.ts` 与 `dirty.ts` 都**改为拒绝**（磁盘字节保留、变基仍暂停），`editStopCommit` **12/12 仍全绿**。
  - 限制：该变量是 Git **2.41** 引入的（本机 2.53 的 `RelNotes/2.41.0.adoc:116`），而本项目下限是 **2.31.0**（`RELEASE.md:227`、`docs/release-notes/0.8.2.md:132`）。在我这里，**格式非法**的值会 `fatal: bad --attr-source or GIT_ATTR_SOURCE`（exit 128 → `code !== 0` → 拒绝，安全方向）；但**格式合法而不存在的对象**会**静默回退到工作区属性**（exit 0）。因此在 < 2.41 的 Git 上这个变量会被直接忽略，guard 悄悄退回有损行为——不是安全方向。需要配一个能力探测（例如项目已有的 `checkGitFeature` 思路）或在探测失败时保守拒绝。
  - CLI 形式 `git --attr-source=<tree> cat-file ...` 同样有效（我验证过），可避免依赖环境变量合并，但仍受 2.41 限制。
- **`git archive <orig-head> -- <path>`**：在**所有版本**上都按目标树属性解析，并且会跑 smudge/eol。我用两个不同的 smudge filter（树里 `filter=up`、工作区 `filter=down`）做了判别实验：archive 输出 `LATER\n`、工作区属性下的 `cat-file` 输出 `later\n`、真实 reset 输出 `LATER\n` —— archive 与真实 reset 一致。`eol` 方向同样一致（树 `eol=crlf` → `later\r\n`，真实 reset 相同）。
  - 限制：输出是 tar 流（需要解析，不是 `cat-file` 的 drop-in）；并且它尊重 `export-ignore`（我验证过被标记的路径会被整个略去），空输出应当按拒绝处理——现行 `!want.stdoutBytes` 与随后逐字节比较已经会拒绝，方向安全。

### 文档/注释需要同步收窄

以下三处把“`cat-file --filters` 的输出 == `reset --hard` 写入的字节”写成了无条件等价，正是本轮被证伪的那句：

- `docs/release-notes/0.8.2.md:45`
- `RELEASE.md:122`
- `src/git/rebaseEngine.ts:209-212` 与 `:303-306`

修好 guard 后这些句子可以保留（并注明依赖 `--attr-source`/目标树解析）；不修则至少必须改成“在工作区属性与目标树属性一致时”。

---

## 三、R4-1（P1，阻塞发布流水线）全新 checkout 下 `npm run package` 产出**名为 `dist-vsix` 的文件**，`release.yml` 的 `test -f` 必然失败

### 先承认：实现者在 N-1 争议中是对的

- 预存在的 **目录**（即使非空）：`--out dist-vsix/` 被 vsce 当作目录，产出 `dist-vsix/git-rebase-visual-0.8.2.vsix`，**12 项**，旧文件原地保留、不被递归打包。我复现了这条（`n1c`）。`.vscodeignore` 新增的 `dist-vsix/` 与 `*.vsix` 也确实把这一路堵死。
- 我第 3 轮“目录已存在就递归自打包”的复现，是**旧脚本 + 旧 `.vscodeignore` + 旧产物**的组合（当时的日志确实出现第 12 项 `extension/dist-vsix`，随后 yazl ENOENT）。换成新脚本后这一机制不再成立。**这一条我判错，撤回。**

### 但新脚本引入了另一个更确定的缺陷

`node_modules/@vscode/vsce/out/package.js` 的 `getPackagePath`（`:1408`）在 `stat` 抛 ENOENT 时**原样返回 `options.packagePath`**（含末尾斜杠），`writeVsix`（`:1356`）只 `unlink`（吞 ENOENT）然后 `createWriteStream(packagePath)`；整个 `out/` 目录里**没有任何 `mkdir`**（`grep` 为空）。所以在没有 `dist-vsix/` 的干净 checkout 上：

```
$ npm run package            # 全新副本，无 dist-vsix/
 DONE  Packaged: dist-vsix/ (12 files, 142.81 KB)
$ echo $?
0
$ test -d dist-vsix && echo dir || echo not-a-dir
not-a-dir
$ file dist-vsix
dist-vsix: Zip archive data ...            # 146242 字节的普通文件
$ test -f "dist-vsix/git-rebase-visual-0.8.2.vsix" || echo "workflow test -f FAILS"
workflow test -f FAILS
```

我复现了三次（两个独立副本 + 一次 `npm run package`）。包内 12 项正确、bundle 哈希与工作区一致，**但路径是错的**。`release.yml` 第 51-52 行 `vsix="dist-vsix/git-rebase-visual-$version.vsix"; test -f "$vsix"` 因此在 **`npm ci` 后的全新 checkout 上必然失败**，release job 在 `gh release create` 之前中止。

补充两点：

- **不会自愈**：带着这个 146 KB 的 `dist-vsix` 文件再跑一次，vsce 退出 **1**（`ENOENT: stat ...\dist-vsix`），并把 `dist-vsix` 留成 **0 字节**。
- **`.gitignore` 不覆盖它**：`.gitignore` 只有 `dist-vsix/`（目录形态）与 `*.vsix`；`git check-ignore -v dist-vsix` 返回 1（未忽略），所以这个无扩展名的 ZIP 会作为未跟踪文件出现在仓库根。

### 修复方向（已验证）

- `mkdir -p dist-vsix` 后再执行现有命令 → `dist-vsix/git-rebase-visual-0.8.2.vsix`，12 项，正确。
- 或者 `--out dist-vsix/git-rebase-visual-<version>.vsix`（显式文件名）**配合** `mkdir -p`：显式文件名而无目录时 vsce 退出 **1** 并 `ENOENT`（会**响亮失败**，比现在静默产出错名文件好得多）。
- 建议同时把 `.gitignore` 的 `dist-vsix/` 改为 `dist-vsix`（不带斜杠），让文件形态也被忽略。

**这一条是发布阻塞的确定性缺陷**：内容正确不等于能发布，`release.yml` 现在无法完成。

---

## 四、N-3 裁决：**成立**（显式拒绝 + 逐路径 `lstat` 重检已按要求落地）

### 我自己的两个变异

1. 把 `directoryCollisions` 的结果强制为 `undefined`（模拟“不认识目录文案”），其余不动：
   - `abort refuses a directory collision and keeps the directory's contents` → **变红**，红在 `AssertionError: and says nothing was removed`，`actual` 正是 Git 原文 `error: Updating the following directories would lose untracked files in them:\n\tlater.txt\n\nAborting\nfatal: could not move back to ...`。即该用例钉住的确实是“分类成功并点名目录/说明未删除”，而不只是“没删东西”。
2. 在兜底 `throw` 之前插入 `await runGit(["clean", "-fdq"], { cwd, env: ABORT_ENV })`（模拟“将来有人加兜底放行”）：
   - `an unrecognized abort failure deletes nothing` → **变红**，红在读取 `later.txt` 的 `ENOENT`——两条用户文件被清掉。该用例钉住的确实是“不认识的形状绝不导向删除”这条原则。

恢复后两套件全绿。

### 对抗形状（我尝试的）

- **真实 abort 文案**（`probe/n3msg.ts`）：`error: Updating the following directories would lose untracked files in them:\n\tlater.txt\n\nAborting\nfatal: could not move back to <sha>`——头部匹配、路径是**一个 tab**、空行结束列表，`pathsUnderHeader` 的解析与之一致。
- **目录 + 文件混合**：`git reset --hard` 输出被 Git 自己的行为掩盖（Reset 会直接删掉挡路目录，见下），而 `git read-tree -u -m` 在混合形状下给出**另一种文案** `error: Updating 'dirpath.txt' would lose untracked files in it`（单数、带引号），**两个正则都匹配不到** → 走原始抛错、不删除。我无法通过 `git rebase --abort` 复现这条文案，因此把它记为观察项而非发现：**若它真出现在 abort 输出里，现行代码仍然安全（不删除），只是不再点名/解释**。
- **>50 MB 截断**：60 MB blob 触发 `code -1` 且 `stdoutBytes` 恰为 52428800；`want.code !== 0` → 拒绝（安全方向）。
- **本地化文案**：本机 Git 没有消息目录（`share/locale` 为空），**无法实际构造**本地化的 abort 失败。`ABORT_ENV = { LC_ALL: "C" }`（`:186`）给 abort 与重试都注入了 `LC_ALL=C`，这是正确的防御；但“本地化文案一定被制服”这一点我只能从代码推断，不能声称实测。

**结论：N-3 关闭。** 附带一个非缺陷观察：`git reset --hard` 本身会**直接删除**挡路的未跟踪目录（我在混合形状探针里看到 `dirpath.txt/keep.txt` 被清掉），而 `git rebase --abort` 会拒绝——扩展走的是 `rebase --abort`，所以安全前提成立，但这解释了为什么两条路径的文案不同。

---

## 五、N-4 裁决：**成立，9/9 全部变红**

我把 9 个站点**逐点单独**撤掉 `env: LITERAL_PATHSPECS`（每次只改一行，其余代码与测试不动），跑该站点声称的用例：

| # | 站点 | 我跑的用例（文件） | 结果 |
| --- | --- | --- | --- |
| 1 | `worktree.ts:104` | `a quoted non-ASCII path…`（`appendStaged`） | **红**（sha 断言） |
| 2 | `worktree.ts:128` | `an untracked glob-named path is restored from ^3…`（`worktree`） | **红** |
| 3 | `worktree.ts:134` | 同上 | **红** |
| 4 | `worktree.ts:159` | `the worktree half restores a glob-named path…`（`worktree`） | **红** |
| 5 | `worktreeChanges.ts:192` | `a glob-named path is staged and restored literally…`（`worktreeChanges`） | **红** |
| 6 | `worktreeChanges.ts:229` | `single-file and bulk worktree restoration…`（**`worktree`**） | **红** |
| 7 | `worktreeChanges.ts:236` | `a glob-named path is staged and restored literally…`（`worktreeChanges`） | **红** |
| 8 | `worktreeChanges.ts:262` | `single-file and bulk worktree restoration…`（**`worktree`**） | **红** |
| 9 | `worktreeChanges.ts:276` | `bulk unstage treats glob names literally…`（**`worktree`**） | **红** |

所以我第 3 轮“4 个站点无覆盖”的判断已被补测推翻；`docs/release-notes/0.8.2.md:69` 的“全部 9 个”与 `RELEASE.md:116` 的同类表述现在**准确**。

**一个纯文档的精度问题（P3，不影响代码）**：附录 A 的第 6、8、9 行引用的用例实际都在 `test/worktree.integration.test.ts`，第 7 行在 `test/worktreeChanges.integration.test.ts`，而表格没有标注所属文件。我第一次按“`worktreeChanges.ts` 的站点 ⇒ `worktreeChanges` 套件”去跑第 6 行，用例**保持绿**，一度以为声明为假；换成正确的套件才变红。建议在“钉住它的用例”一列补上文件名（第 1 行已经这么做了）。

---

## 六、其余核验

### 第 3 轮的 `rebaseEngine.ts:207` 引用

仓库里**不存在任何 `:207` 引用**（`docs/`、`RELEASE.md`、`README.md`、`src/`、`test/` 全文搜索均为 0）。`code-review-0-8-5.md` 对 `rebaseEngine.ts` 的引用只有 `:266-284` 与 `:214-250`。按当前文件，这两处**确实已经漂移**：`abortMayReplace` 现在在 `:323-350`，`abortRebase` 在 `:230-287`（上方注释变长）。历史评审文件按规约不改；建议后续评审与新文档改用**符号名**（`abortMayReplace`/`abortRebase`）而非行号。

### 类型检查

`node node_modules/typescript/bin/tsc --noEmit` → exit 0；`node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit` → exit 0。

### 五个受影响套件（临时副本，非真实仓库）

`worktree` 8/8、`worktreeChanges` 6/6、`appendStaged` 8/8、`editStopCommit` 12/12、`pendingRecovery` 40/40 = **74/74 全绿**。完整套件（实现者报告 241/241）**未独立确认**（规则要求不跑）。

### VSIX 完整性（`dist-vsix/git-rebase-visual-0.8.2.vsix`，sha256 `15ae008d17734252eaf916e68acd45f8a13dec108e75bdb91431d583ae84cbe6`，146242 字节）

- **恰好 12 项**：`extension.vsixmanifest`、`[Content_Types].xml`、`extension/{readme.md,package.json,LICENSE.txt,.gitignore}`、`extension/media/{style.css,main.js,icon.svg,extension-icon.png}`、`extension/dist/{seq-editor.js,extension.js}`。
- 无 `.map`、无 `sourcesContent`、无 `sourceMappingURL`（逐条目扫描）、无 `extension/src/`、`test/`、`docs/`、`node_modules/`、`tsconfig`、`dist-vsix`。
- manifest `Identity Version="0.8.2"`，包内 `extension/package.json` 为 0.8.2。
- 包内 `extension/dist/extension.js` sha256 `1152b4242470af86ed516f452976babc82bbb1a80c69e81fa923e8ccb0b592e3`，**等于**工作区 `dist/extension.js`；我在干净副本里重打包也是同一哈希（可重现）。
- **没有比 VSIX 更新的产物**：`find src test -newer dist/extension.js` 为空，`media/` 为空；`docs/` 只有 `docs/research/test-performance.md`（不随包发布）比 `dist/` 新。
- 包内 bundle 确实含本轮代码：`cat-file`、`--filters`、`lstat`、`Updating the following directories` 正则、`GIT_LITERAL_PATHSPECS`；**不含 `GIT_ATTR_SOURCE`**（与第二节的 P2 一致）。
- 既有小瑕疵（非本轮引入）：仍随包发布 `extension/.gitignore`（436 B）。

### 文档

- 附录 A 9 行表：9/9 与我的变异结果一致（见第五节）。
- 已无未加限定的“每个站点都被覆盖”式表述；“全部 9 个”现在有实测支撑。
- 发布的文档里“逐字节相同/byte-identical”已清除；唯一残留 `src/git/pendingRecovery.ts:622` 指的是**树条目内容 + 模式**，作用域正确。
- 但 `release-notes:45` / `RELEASE.md:122` / `rebaseEngine.ts:209-212,303-306` 仍把“`cat-file --filters` 的输出就是 reset 写出的字节”写成无条件成立，需按第二节收窄。

---

## 七、发布结论

**0.8.2 当前工作树与已产出的 VSIX：不批准发布。**

- 已产出的 `dist-vsix/git-rebase-visual-0.8.2.vsix` **如实覆盖了被评审的工作树**：12 项干净、bundle 哈希与 `dist/extension.js` 一致、版本 0.8.2、包含第 3 轮全部整改（含目录碰撞显式拒绝与 9 个字面 pathspec 站点）。就“包是否忠实”这一点，它合格。
- 但**不能据此批准出包**，有两个阻塞项：
  1. **R4-2（P2）**：`abortMayReplace` 的属性来源错误会在**无需用户任何误操作**的形状下静默丢弃用户字节（第二节的 `paused.ts` 端到端）。这是第 2 轮 P2 承诺“删除只在可证明无损时发生”的直接反例，且当前包内确实存在。建议按第二节修 `GIT_ATTR_SOURCE`/archive + 能力探测，并补一条“停靠提交与 orig-head 属性不同”的用例；若决定不修，必须在 `release-notes` 与注释里改成条件性表述。
  2. **R4-1（P1）**：`npm run package` 在全新 checkout 上产出**名为 `dist-vsix` 的文件**（exit 0），`release.yml` 的 `test -f "dist-vsix/git-rebase-visual-$version.vsix"` 必然失败，release job 在创建 release 之前中止。一行 `mkdir -p dist-vsix`（或显式文件名 + mkdir）即可修复，修完重跑打包即可。

- 两个修复都不大；完成后再跑一次打包与五个受影响套件，即可重新评审。N-2、N-3、N-4 已关闭，第 1 轮的回归与第 2 轮的 abort 归属证明（在属性一致的前提下）仍然成立。

**一句话**：三条 P3 的整改我确认有效（其中 N-2 是我错了、N-1 的实现者反驳成立），但第 4 轮新增的属性来源缺陷与打包路径缺陷各自阻塞发布，0.8.2 请勿在修复前打 tag。
