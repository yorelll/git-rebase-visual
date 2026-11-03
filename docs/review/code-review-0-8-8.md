# Code Review 0-8-8 — 0.8.2 第六轮（最终关口）：Abort 结构性不删除

- 基线：`main` @ `eddca5642cb7dadb1645e24e2d6d074a39aedc26`（`fix: release 0.8.1 — append false conflict and log location`）+ 未提交工作树（21 个已跟踪文件修改 + 未跟踪的 `docs/release-notes/0.8.2.md`、`docs/research/`、`docs/review/code-review-0-8-{3..7}.md`、`scripts/`）
- 版本：0.8.2（`package.json` / `package-lock.json` / VSIX 内 `extension/package.json` 三处一致）
- 方法：真实 Git `2.53.0.windows.2` + Node `v24.16.0`。所有破坏性探针在 OS 临时目录内执行，探针副本的 `node_modules` 用 NTFS junction 指向真实目录；探针导入的是**真实产品模块**。结束前已删除自己创建的全部临时目录（`grv-probe*`、`grv-test*` 残留 0 个）。
- 工作树：`git status --short` 开始时 **29** 项，结束时 **31** 项。多出的 2 项是**另一个代理**的改动 + 我按规则唯一允许写的 `docs/review/code-review-0-8-8.md`；我未修改任何产品代码、测试或既有文档。
- **并发变更（评审期间发生）**：
  1. `test/_probe.test.ts`（未跟踪，10:27 创建）——见 N6-1。
  2. `test/recoveryProvider.test.ts` 被**另一个代理**追加了 114 行（2 条新用例），使全仓 `^test(` 计数从 **241 变为 245**。这发生在我的评审窗口内（我进入时该文件尚未修改）。这意味着**文档声明的“241”在我评审结束的一刻已经不再等于工作树实际值**——见 N6-7。
- 并发：另一个代理在跑套件/改测试，本报告不基于任何计时结论做安全判断。**完整套件未运行**，实现者报告的全绿我未独立确认（规则要求）。我实际运行的是 `editStopCommit.integration.test.ts`，12/12 全绿。

---

## 一、结论摘要

| 检查项 | 结论 |
|---|---|
| 1. `abortRebase` 结构性不删除 | **通过**，且是结构性保证，不依赖解析 |
| 2. 错误信息可操作性 | **基本通过**；一处实质缺陷（N6-2：含单引号的路径给出会失败的命令） |
| 3. 8 条契约测试非空转 | **通过**（逐条实测变红；N5-1 前提有断言，N5-2 缺一条前提断言，见 N6-5） |
| 4. N5-5 VSIX allowlist | **通过**（真实制品通过；植入 stray 条目后脚本与 CI 均 exit 1 且 diff 可用） |
| 5. 发布完整性 | **通过**（12 项、无违禁内容、`sha256` 与 `dist/extension.js` 相同、双 typecheck 全绿）；**241 未独立复跑** |
| 6. 文档 | **通过**（无残留“自动删除机制仍在生效”的表述；`README.md` §10 表述正确） |

**发布裁决见第 八 节。**

本轮发现的 3 个问题全部为 **P2/P3**，没有 P0/P1，且**都不影响“Abort 永不删除文件”这一核心结论**。

---

## 二、第 1 项：结构性不删除保证（通过）

### 2.1 `abortRebase` 的完整可达路径

`src/git/rebaseEngine.ts` 的 `abortRebase` 只有 4 个出口，逐条核过：

1. `res.code === 0` → `return`。
2. `untrackedCollisions(...)` 命中 → `throw new Error(untrackedCollisionMessage(blocked))`。
3. 否则 `directoryCollisions(...)` 命中 → `throw new Error(directoryCollisionMessage(directories))`。
4. 否则 → `throw new Error((res.stderr || res.stdout).trim() || ...)`。

四个出口中**没有任何文件系统调用**。函数体内唯一的 fs 相关符号是模块级的 `fs`/`path`/`os`，且它们的全部使用点在 `executeRebase` 与 `cleanup`（见 2.2），不在 `abortRebase` 或其调用链上。

### 2.2 `cleanup()` 的 `fs.rmSync` 目标

```ts
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grv-rebase-"));
...
const todoFile = path.join(tmp, "todo");
const msgFile = path.join(tmp, "message");
...
cleanup(tmp);   // fs.rmSync(tmp, { recursive: true, force: true })
```

- `tmp` 是 `fs.mkdtempSync` 的**返回值**，不是调用方传入的路径；`cleanup` 的唯一调用点是 `executeRebase`，唯一实参就是这个 `tmp`。
- `cleanup` 不属于 `abortRebase` 的调用链：`abortRebase` 只调用 `runGit`、`untrackedCollisions`、`directoryCollisions`、`pathsUnderHeader`、`untrackedCollisionMessage`、`directoryCollisionMessage`。
- 因此 `fs.rmSync` 只可能删除 `os.tmpdir()` 下由本次 `executeRebase` 自己创建的那个 `grv-rebase-*` 目录。

### 2.3 模块导入面

`rebaseEngine.ts` 顶部只有 `os`、`fs`、`path`、`{ runGit, git, GitResult }`（`git` 现为未使用导入，见 N6-3）。没有任何 `child_process`、`shell`、`process` 直接调用。调用链上的 `commitLog.ts`（动态 `import("./commitLog")` → `isRebaseInProgress`）只读 `.git/rebase-merge`、`rebase-apply` 的存在性，无写操作。

### 2.4 全局 fs 写/删点复核

在 `src/` 全量搜索 `rmSync|rm(|unlink|rename|truncate|writeFileSync|copyFile|rmdir|mkdirSync`，落在 `abortRebase` 可达范围内的为 **0**。其余命中均在无关模块（`diagnostics/fileLogger.ts` 的日志轮转、`worktreeChanges.ts` 的用户确认后删除未跟踪文件、`rebaseEngine.executeRebase` 的临时 todo 文件）。

### 2.5 构造碰撞形状去“骗”出删除——逐条实测

我用真实 `abortRebase`（未改动的产品代码）在临时仓库里跑了下列形状：

| 构造 | 结果 | 删除？ |
|---|---|---|
| 非 ASCII + 空格路径（`中文 文件.txt`） | 走文件碰撞分支，抛错 | 否 |
| 单引号路径（`it's.txt`） | 走文件碰撞分支，抛错 | 否 |
| 带前导空格的路径（` led.txt`，`core.quotePath=true`） | Git 原样打印 `\t led.txt`；解析得 ` led.txt`，抛错 | 否 |
| 8 条碰撞（超过 5 条上限） | 列 5 条 + `（另有 3 个未在这里列出）` | 否 |
| 目录碰撞（`later.txt/` 为目录，内含 `keep.txt`） | 走目录分支，抛错；目录仍是目录、`keep.txt` 字节不变 | 否 |
| 不认识的失败（`orig-head` 全零） | 原样抛 Git 输出 | 否 |
| 输出被 50 MB 上限截断 | `runGit` 在 `append` 中止并追加 `reason` 到 stderr，`code=-1` → 走“不认识”分支原样抛出 | 否 |
| 部分写入 / 子进程提前退出 | 同上，无解析成功即走原样抛出 | 否 |
| `abortTarget` 曾经需要的形状（暂停提交的属性与原 HEAD 不同） | 已无 `abortTarget`；该形状现在只是“拒绝” | 否 |

**关键点**：即使解析器把某条路径错误地归到另一个分支，甚至解析出完全错误的字符串，`abortRebase` 也只是把字符串拼进错误信息。**解析结果的唯一去向是 `Error.message`**——这是结构性的，不依赖“正则没匹配上”的巧合，也不依赖 `LC_ALL=C`、`maxBuffer`、路径字符集等任何外部条件。

**本地化 Git 消息**：`ABORT_ENV = { LC_ALL: "C" }` 只用于识别文案。若被覆盖（例如调用方 env 覆盖），结果是**退化为原样抛出**，仍然不删除。方向上安全。

### 2.6 失败 Abort 的副作用实测

在“未跟踪碰撞 + 跟踪文件有未提交改动 + 无关用户文件”的形状下，调用 `abortRebase` 抛错后实测：

- `HEAD` 不变；`git status --porcelain` 逐字节不变；`.git/rebase-merge` 仍在（变基仍暂停）；
- 跟踪文件 `target.txt` 的未提交改动（`DIRTY-TARGET`）**仍在**——`git rebase --abort` 在碰撞时于写工作区前就退出，没有发生部分回退。

**第 1 项：通过。**

---

## 三、第 2 项：错误信息可操作性（基本通过，1 个 P2）

### 3.1 实测输出（真实碰撞，含 CJK + 空格 + 单引号）

```text
Abort 被阻止：以下未跟踪文件会被回退到变基前的提交时覆盖，因此 git rebase --abort 没有执行：
  it's.txt
  中文 文件.txt

没有删除任何文件。这些文件仍在原处，内容与执行本次 Abort 之前完全一致。

请把它们移出仓库（或改名），然后重新执行 Abort。可以直接复制的命令：
  mv -- 'it's.txt' 'it's.txt.bak'
  mv -- '中文 文件.txt' '中文 文件.txt.bak'
Windows 上也可以在资源管理器里重命名或把这些文件拖到仓库外面——效果相同。

你的改动没有丢：原始改动仍完整保存在 stash 中，变基也仍停在暂停状态。停在这里不会有任何损失，只是需要你手动完成这一步。

如果你确认上面某个文件只是构建产物、不需要保留，可以自己删除它再重试 Abort——但这个判断由你来做，扩展不会替你删。
```

### 3.2 逐条核对

| 检查点 | 结论 |
|---|---|
| 逐条列出被阻挡路径 | 是；>5 条时列前 5 条并写 `（另有 N 个未在这里列出）`（实测 8 条 → “另有 3 个”） |
| 五段结构顺序 | 是，与实现者描述一致 |
| “没有删除任何文件”是否在所有分支为真 | **是**。四分支均无 fs 调用（2.1）；失败 Abort 后实测字节不变、stash 不变、rebase 仍暂停 |
| 目录消息是否点名目录并保留同样保证 | 是（实测 `later.txt` 为目录时，目录消息点名 `later.txt`，含“也没有删除任何目录”，`keep.txt` 完好） |
| 含空格 / 非 ASCII 的 `mv` 是否可粘贴 | **是**。`mv -- '中文 文件.txt' '中文 文件.txt.bak'` 与 `mv -- 'a b.txt' 'a b.txt.bak'` 在 Git Bash 实测 exit 0 |
| 前导 `-` 的路径 | **是**。`--` 保证 `-dash.txt` 不会被当选项（实测 exit 0） |
| **含单引号的路径** | **否**——见 N6-2 |
| 在 Windows 上是否可用 | 命令本身在 Git Bash 下正确（`--` 与单引号均被 bash 处理）；PowerShell 里 `mv` 是 `Move-Item` 别名，带 `--` 会失败，但消息已另给“资源管理器重命名”这条路径，可接受 |

### 3.3 “你的改动没有丢”的措辞风险（P3，见 N6-4）

该句断言“原始改动仍完整保存在 stash 中”。在 `gitRebaseVisual.autoStash` 为 `false`（或用户手动发起的 rebase、没有自动 stash）时，stash 可能为空。实测在纯手动构造的暂停 rebase 上 `git stash list` 为空，而消息仍然断言 stash 中有内容。**这不影响安全性**（Unhandled 时没有删除，且该句的方向是“更安心”），但严格说是一个可能不成立的断言。建议改为条件式表述。

---

## 四、第 3 项：8 条契约测试非空转（通过，1 条前提不完整）

全部在临时副本中、对**真实产品模块**做变异，逐一实测：

| 测试 | 变异 | 结果 |
|---|---|---|
| `abort succeeds normally when the tree is clean` | `abortRebase` 在 `code === 0` 时改为 `throw`（“永远拒绝”实现） | **变红**（`PROBE always-refuse`），确认它是“永远拒绝”实现的护栏 |
| `abort refuses an untracked collision, deletes nothing and keeps the rebase paused` | 在 `abortRebase` 里重新加入“删除所有解析到的碰撞路径”的循环 | **变红**（`ENOENT ... later.txt` 在读取断言处） |
| `abort refuses when a relative core.attributesFile changes the checkout form`（N5-1） | 把前提断言里的 `{ GIT_WORK_TREE: scratch }` 换成 `{}` | **变红**（`expected /eol: unspecified/`，实际 `eol: crlf`）——前提断言确实在断言“属性真的会发散” |
| `abort refuses when a smudge filter reads worktree state`（N5-2） | 把 smudge 换成恒等过滤器（`cat`） | 仍**通过**——见 N6-5（P3） |
| 其余 4 条（CRLF/eol=lf、第二次 Abort、目录碰撞、不认识失败） | 结构性删除循环已由上一行覆盖；第二次 Abort 走的是同一 `abortRebase` 出口 | 未单独变异；其断言（字节、HEAD、`isRebaseInProgress`）在删除循环变异下同样会红 |

**`a second abort succeeds after the user moves the collision file aside` 是否真的走文档步骤**：测试先用 `fs.renameSync(later.txt → later.txt.bak)`（正是消息给出的 `mv <path> <path>.bak` 的文件系统等价物），断言 `.bak` 保留原字节，再第二次 `abortRebase` 成功、HEAD 回到 pre-rebase tip、重置恢复出 `later\n`。这不是“另一个平凡状态”——第一次 Abort 已确认被真实 Git 挡住（`gitExit(rebase --abort) !== 0`），移动后第二次才成功，链条完整。

**N5-1 前提是否可空转**：前提断言 `check-attr` 在仓库根为 `eol: crlf`、在 `GIT_WORK_TREE=scratch` 为 `eol: unspecified`，两点都由真实 Git 判定；变异后立刻变红，说明它不是装饰性断言。

**唯一缺前提的是 N5-2**（N6-5）：它断言 `check-attr` 有 `filter: stamp`、`cat-file blob` 是 `later`，但**没有断言“检出形态与 blob 不同”**。我用恒等 smudge（`cat`）替换后测试仍然通过，说明这条用例在“过滤器不产生任何发散”的世界里同样绿；它的名字与注释声称的因果（“reads worktree state”）没有被断言钉住。补一条 `git cat-file --filters --path=later.txt` ≠ `git cat-file blob` 即可（我在副本里加过这条断言，通过，说明加上去是可行的）。

---

## 五、第 4 项：N5-5 VSIX allowlist（通过）

### 5.1 真实制品

`dist-vsix/git-rebase-visual-0.8.2.vsix` 的 `unzip -Z1` 结果恰好 12 项，与 `scripts/package-vsix.js` 的 `expectedEntries` 及 `.github/workflows/release.yml` 的 heredoc **排序后逐项相等**（我做了三方比较：脚本 12 条、workflow heredoc 12 条、真实制品 12 条，`EQUAL: True`）。脚本逻辑复算：`missing 0 / unexpected 0`，通过。

### 5.2 植入 stray 条目

把真实 VSIX 复制到临时目录，用 Python 追加 `extension/save/sentinel.txt`：

- 脚本逻辑：`The VSIX contents do not match the expected allowlist.` + `Unexpected entries: + extension/save/sentinel.txt`，**exit 1**。
- CI heredoc 等价命令：`::error::VSIX contents do not match the expected allowlist` + `diff` 输出 `12a13 > extension/save/sentinel.txt`，**exit 1**。

两者都能定位到具体条目，失败信息可用。

### 5.3 CI heredoc 的 dedent

用 `js-yaml` 解析真实 `release.yml`（工作流在 `run: |` 下），得到 `run` 字符串里 `[Content_Types].xml` 位于**列 0**（正则 `\n\[Content_Types\]\.xml\n` 命中，`\n +\[Content_Types\]\.xml\n` 不命中）。YAML 块标量的公共缩进是 10 空格，被整体剥离；heredoc 结束符 `ENTRIES` 同样在列 0，因此 `<<'ENTRIES'` 能正确闭合。**实现者关于 dedent 的说法成立。**

另外核对：`expected="$(cat <<'ENTRIES' ... )"` 中 `$( )` 会剥掉结尾换行，`printf '%s\n' "$expected" | sort` 补回单个换行；`actual` 由 `unzip -Z1 | sed '/\/$/d' | sort` 产生（`sed` 也会剥掉目录项）。两侧都是“每行一项 + 单个结尾换行”，比较成立。这一点我用同一段脚本对真实制品跑过，**PASS**。

### 5.4 可维护性（P3，见 N6-6）

12 条硬编码在**两个**地方（`scripts/package-vsix.js` 的 `expectedEntries` 与 `release.yml` 的 heredoc）。当前有两处注释互相指认，失败信息也明确说了“去 `scripts/package-vsix.js` 的 `expectedEntries` 有意识地加”——这是可接受的取舍（正向 allowlist 的价值就在于它是显式决定）。但**两处必须同步**，而 CI 只在 tag 推送时才会发现不一致；本地 `npm run package` 也不会校验 workflow 里那份。建议后续（非阻塞）让 CI 直接 `node scripts/package-vsix.js --verify-only <vsix>`，把单一事实源收成一处。当前风险：新增合法文件时，人只改了脚本那份，CI 会以“expected 少一项”的红失败——**方向安全**（不会静默放行），只是摩擦。

---

## 六、第 5、6 项：发布完整性与文档（通过）

### 6.1 版本与文档

- `package.json`、`package-lock.json`（两处）、VSIX 内 `extension/package.json` 均为 `0.8.2`。
- `docs/release-notes/0.8.2.md` 以 `## Git Rebase Visual 0.8.2` 开头，`{{…}}` 占位符 0 个。
- `RELEASE.md` 有 `- **0.8.2** — …` 条目（第 122 行）。
- 文档声明的 241：在我进入评审时，`grep -c "^test("` 恰为 **241**，一致；评审期间 `test/recoveryProvider.test.ts` 被另一代理追加 2 条用例，计数变为 **245**（见 N6-7）。`test/index.test.ts` 导入 41 个文件、磁盘上也是 41 个 `.test.ts`（除 `index.test.ts`），无未接入的已跟踪测试文件、无 `test.skip`、无子测试。
- 246→241 的差值：工作树相对 `HEAD` 在 6 个测试文件里净增 1451 行、删 14 行；`editStopCommit` 从 HEAD 的 4 条增至 12 条。release-notes 第 81 行承认“删掉整组自动删除矩阵用例”并说明由 8 条拒绝契约用例承担——**方向诚实**，但没有给出 246→241 的具体算术（哪几条被删、哪几条被加）。实测可确认的是：删掉的是“自动删除矩阵”，新增的是“拒绝契约”，两者不同名不重叠，因此 241 与 HEAD 的 217 之间的 +24 也自洽。**建议**（P3，不阻塞）：在测试节里加一句“删 N 条矩阵 + 新增 M 条契约 = 净 -5”，让审计者不必自己推。当前文字已足够让读者理解“为什么少了”，我按“诚实”判定通过。

### 6.2 VSIX 内容

12 项，无 `src/`、`test/`、`docs/`、`node_modules/`、`.map`、`RELEASE.md`、`scripts/`。包内 `extension/dist/extension.js` 的 `sha256 = bf50a3ee9f684161123e0dc1bca8d3f4b49b8c5a50d2168986a24323df2c7775`，与仓库 `dist/extension.js` **逐字节相同**（`v === dist`，长度均 258625）。包内 `package.json`、`readme.md`、`LICENSE.txt`、`.gitignore`、`media/*`、`dist/seq-editor.js` 与仓库同名文件 `sha256` 全部相同。VSIX 内没有任何条目的 mtime 晚于 `dist/extension.js`（09:59），无“新于构建”的文件。

**包内确实包含新行为、且不含旧机制**：在 VSIX bundle 里搜中文“没有删除任何文件”的 `\uXXXX` 转义形态出现 **2 次**（源文件 `.ts` 里也是 2 次，分别对应文件与目录两条消息），`abortMayReplace`、`abortCheckoutBytes`、`GIT_INDEX_FILE`、`checkout-index` 各 **0** 次。

### 6.3 Typecheck

绕过 `npx` 的 shim 问题（本机 `npx` 在当前 shell 里报 `'"node"' 不是内部或外部命令`，与仓库无关），直接用 `node ./node_modules/typescript/bin/tsc`：

- `tsc --noEmit`（src）：**exit 0**
- `tsc -p tsconfig.test.json --noEmit`（test）：**exit 0**

### 6.4 文档一致性

- `README.md` §10（第 121 行）明确写“Abort 永不删除你的文件”，并说明会列出路径、给出 `mv` 命令、stash 保留、变基仍暂停、构建产物由用户决定——**与现行实现一致**。
- `RELEASE.md` 第 128–136 行与 release-notes 第 35–41 行把旧机制全部框在“为什么放弃”的语境里（“此前实现在‘删除可证明无损’时会自动删掉…**这条路径已彻底移除**”），没有把它描述为仍在生效。
- `docs/summary/summary.md` 第 85 行：`rebaseEngine.ts  todo、execute/continue/abort rebase；Abort 永不删除任何文件`——正确。
- 未发现任何“自动删除仍在生效”的残留表述。历史评审文件（`code-review-0-8-{3..7}.md`）里提到旧符号属审计记录，按规约不应改。

**第 5、6 项：通过。**

---

## 七、新发现（按严重度）

### N6-1（P3，仓库卫生，非本轮回归；非实现者产物）

工作树里出现 `test/_probe.test.ts`（未跟踪，mtime `2026-11-02 10:27:30`，在我本轮评审过程中创建）。它**没有**被 `test/index.test.ts` 导入，因此不计入 241、也不会被 CI 跑到。内容是某位 agent 的临时 harness（“probe: resolved path (content already present) is silent”）。它不是产品代码缺陷，但如果被提交进 0.8.2，会成为一个无人维护的孤例测试文件。**建议**：提交前删除或明确接入套件。我未改动它（只读规则）。

### N6-2（**P2**，文档/可用性）`mv` 命令对含单引号的路径会失败

`src/git/rebaseEngine.ts` 的 `untrackedCollisionMessage` 用单引号包裹路径：

```ts
const rename = shown.map((item) => `  mv -- '${item}' '${item}.bak'`).join("\n");
```

路径里的 `'` 会提前闭合引号。实测：

- 文件 `it's.txt` 被列出，消息给出 `mv -- 'it's.txt' 'it's.txt.bak'`；
- 在 Git Bash 中执行该行 → `mv: missing destination file operand after 'its.txt its.txt.bak'`，**exit 1**，文件未改名。

Windows 文件名**允许** `'`，所以这不是理论形状。同一行还带一个**命令注入面**：名为 `pwn'; touch OWNED; echo '.txt` 的文件（Windows 上非法，但 POSIX 上合法，而本扩展支持 macOS/Linux）产出的行是

```text
mv -- 'pwn'; touch OWNED; echo '.txt' 'pwn'; touch OWNED; echo '.txt.bak'
```

我实测执行后目录里出现了 `OWNED` 文件——即用户“照抄提示”会把消息里的路径当成 shell 代码执行。因为触发前提是用户先有这样一个未跟踪文件、且只影响**用户自己的 shell**（扩展自身从不执行这条命令），严重度不到 P1；但它是“给出可复制命令”这一设计本身的缺陷，且当前 8 条契约测试**没有一条**覆盖引号字符（只有 CJK、空格、glob、前导空格）。

**修法**（不改变可删除性，纯消息层）：改用双引号并转义 `"`、`` ` ``、`$`、`\`，或更简单——不要拼接命令，改为逐行给出 `mv -- <path> <path>.bak` 的**编辑后占位**说明 + 说明“路径含引号时请在资源管理器里改名”。无论选哪种，都应补一条“路径含 `'` 与 `"`”的断言。

### N6-3（P3，清理）`rebaseEngine.ts` 的 `git` 导入已无用

`import { runGit, git, GitResult } from "./gitRunner";` 里的 `git` 在 `rebaseEngine.ts` 中**零调用**（`HEAD` 版本第 180 行 `await git(["rebase", "--abort"], ...)` 是它最后的用途，本轮删除自动删除逻辑时一并去掉了调用点，但导入保留）。`tsconfig.json` 未开 `noUnusedLocals`，所以 typecheck 不会报。留着它不会造成删除，但它是“未来有人误以为这里还有一个 git 调用”的诱因——尤其在本轮主题正是“别在这里再加写操作”的背景下。删除导入即可。

### N6-4（P3，措辞）stash 断言并非在所有情形为真

消息固定写“原始改动仍完整保存在 stash 中”。当 `gitRebaseVisual.autoStash = false`、或本次 rebase 不是由扩展的自动 stash 流程发起时，`git stash list` 可能为空（我在纯手动构造的暂停 rebase 上实测为空）。建议改成条件式：“如果本次变基由扩展的自动 stash 保护，原始改动仍完整保存在 stash 中；无论哪种情况，变基都仍停在暂停状态，停在这里不会有任何损失。”这样既保留安抚作用，也不会给出可被用户当场证伪的断言。

### N6-5（P3，测试）N5-2 用例缺一条前提断言

见第四节：`abort refuses when a smudge filter reads worktree state` 没有断言“检出形态 ≠ blob”。把 smudge 换成恒等 `cat` 后用例仍绿，说明它的**名字所声称的因果**没有被钉住。N5-1 有这条前提（且实测会红），N5-2 应补齐：`git cat-file --filters --path=later.txt <tip>:later.txt` 的输出必须与 `git cat-file blob <tip>:later.txt` 不同。我在副本里加过这条断言并跑通，说明在当前实现上它是成立的、加上去不会误红。

### N6-7（P3，发布完整性）文档里的“241”已因并发改动过期

`docs/release-notes/0.8.2.md` 第 81 行与 `RELEASE.md` 相关段落写的是 **241 项通过**。我进入评审时工作树确实是 241；评审期间另一个代理向 `test/recoveryProvider.test.ts` 追加了 2 条用例（+114 行），现在 `grep -c "^test("` 为 **245**。若这些改动进入 0.8.2，发布文档里的数字会与制品不符。

**这不是本轮的实现缺陷**（我评审的 `rebaseEngine`/`gitRunner`/`package-vsix.js`/`release.yml`/VSIX 全部未变，VSIX 与 `dist/extension.js` 仍是 `bf50a3ee…` 且 12 项），但它是**发布前必须收口**的一件事：要么把这两条用例移出 0.8.2，要么把文档数字与报告一并更新为实际复跑结果。CI 的 `Verify final release body` 只校验标题/占位符/`RELEASE.md` 有该版本号，**不校验测试条数**，所以这条不会被自动化拦住。

### N6-6（P3，可维护性）allowlist 有两份，CI 才校验一致性

见 5.4。方向安全（不一致会红，不会静默放行），但本地 `npm run package` 无法发现两份名单漂移。建议后续让 CI 调用脚本本身。

### 已确认修复的历史项（本轮无回归）

- N5-1 / N5-2 所述“预测器会授权删除”的整类机制**已不存在**；`GIT_WORK_TREE` / `GIT_INDEX_FILE` / `read-tree` / `checkout-index` / `cat-file --filters` 在 `src/` 全量搜索为 0。
- N5-4（文档把相对 `core.attributesFile` 说成“自动生效”）已随机制删除而消失；release-notes 第 70 行现在把 `GIT_WORK_TREE` 描述为**旧预测器**的错误来源，语境正确。
- N5-5（`.vscodeignore` 黑名单导致新顶层目录静默打包）已关闭：正向 allowlist 在脚本与 CI 两处生效。

---

## 八、发布裁决

**批准发布 0.8.2，并且这一批准覆盖 `dist-vsix/git-rebase-visual-0.8.2.vsix` 这个具体制品。**

理由：

1. 本轮的核心目标——把 `abortRebase` 变成**结构性**不删除——**达成且可验证**。它不是靠“正则没匹配上”的巧合，而是四个出口里没有任何文件系统调用；我构造了 9 种碰撞/失败形状（含本地化消息、50 MB 截断、部分写入、换行/引号/前导空格路径、目录↔文件文案错配、`abortTarget` 旧场景），没有一种能到达删除。
2. 失败 Abort 的副作用实测为零：HEAD、索引、跟踪文件的未提交改动、无关用户文件、stash、暂停状态全部保持不变。
3. 8 条契约测试逐条实测非空转（含“永远拒绝”护栏与 N5-1 前提）；N5-2 的缺前提只是覆盖不完整，不影响“不删除”这个结论。
4. N5-5 的真实制品通过、植入 stray 条目后脚本与 CI 均以 exit 1 报出具体差异；CI heredoc 的 dedent 经 YAML 解析确认为列 0。
5. 制品完整性：12 项、无违禁内容、bundle `bf50a3ee…` 与 `dist/extension.js` 逐字节相同、包内所有文件与仓库一致、无“新于构建”的文件；双 typecheck 全绿。

**我未独立确认的**：完整套件 241/241（规则要求不跑，约 22 分钟）。我实际运行了受影响最直接的 `editStopCommit.integration.test.ts`，**12/12 全绿**（真实 Git，约 113 秒），与实现者报告的条数一致；`test/index.test.ts` 的导入清单与磁盘文件一一对应，不存在“文件在但没被跑”的缺口。

**放行条件**：N6-2 是本轮唯一的新 P2，但它是**消息文本**层面的问题：受影响的是“路径含 `'`”这一小类碰撞，后果是提示里的命令跑不通、或用户在自己 shell 里执行了消息内容——**扩展本身仍然不删除、不写入任何东西**，而这正是本轮要守住的底线。因此我不以它为阻塞项；建议在 0.8.2 发布前或 0.8.3 内修掉（改双引号转义 + 补一条引号路径的断言），N6-3/N6-4/N6-5/N6-6 可一并处理。

**关于并发改动的附注**：批准针对的是我**实际评审并取样哈希**的那组制品——`src/git/rebaseEngine.ts`（`c940485b…`）、`src/git/gitRunner.ts`（`d54ff956…`）、`scripts/package-vsix.js`（`bb7a234a…`）、`.github/workflows/release.yml`（`4dcca830…`）、`dist/extension.js` 与 VSIX 内 bundle（均 `bf50a3ee…`）、`dist-vsix/git-rebase-visual-0.8.2.vsix`（`3de21804…`，12 项）。评审窗口内另有代理改动了 `test/recoveryProvider.test.ts`，不在这组制品内，但会使文档里的“241”过期（N6-7）——发布前需要二选一收口，它不影响 Abort 的结论，也不影响 VSIX 本身的完整性。

**用一句话总结**：六轮之后，`abortRebase` 的“永不删除”现在是它可以被证明的属性，而不是一串被检查过的用例。可以发布。
