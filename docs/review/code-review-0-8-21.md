# Code Review 0-8-21 — 0.8.3 第九轮复核（第八轮四项是否真的修好、四项修复有没有引入新缺陷、打包产物是否仍可复现）

- 评审日期：2026-11-09
- 评审角色：独立评审（Agent B，第九轮，签核轮）
- 基线 commit：`577ce8766a46707a60c471cf8090e9f63cd8d49c`（`test: run each file in its own process and split the slowest suite`）
- 被评审材料：基线之上的**未提交工作树**——`git status --short` 共 **39 行**（**25 个修改文件** + **14 个 untracked**）。untracked 为 `src/ui/pushNotification.ts`、`test/{composeSessionGate,pushIsolation,pushNotification,restoreFileProtocol}.test.ts`、`docs/release-notes/0.8.3.md` 与 `docs/review/code-review-0-8-13…20.md`（含本轮之前的第八轮报告）。数字取自**我写本报告之前**的 `git status`。
- 本轮任务：第八轮（[`code-review-0-8-20.md`](code-review-0-8-20.md)）**维持了对 0.8.3 与 `dist-vsix/git-rebase-visual-0.8.3.vsix` 的批准**，并留下四项（2×P3 + 2×P4）。本轮**只验证这四项是否真的修好、有没有引入新缺陷**，并对"是否可以直接提交并打 tag"给出结论。
- 顺序：先读 `code-review-0-8-20.md`（我自己的上一份报告），再读 `code-review-0-8-19.md`，再读账本 `docs/review/code-review-commit.md`。
- 账本状态：**`0-8-20` 行已补上**（`code-review-commit.md:51`，SHA 为基线并注明"被评审材料为未提交工作树"，结论"维持批准、0 个新增产品行为缺陷、另列 4 项均已在本轮修正"）。第八轮的账本遗留项**已闭合**。`0-8-21` 行仍需 A 或所有者补记——本轮任务明确禁止我编辑账本。
- 环境：Windows 11 + MSYS Git `git version 2.53.0.windows.2`，Node `v24.16.0`。本 shell 里 `node`/`npm` 解析不到，命令一律直接调用 `/d/Program Files/nodejs/node` 与 `node_modules/tsx/dist/cli.mjs`。
- 本报告**不修改**任何既有评审报告、不修改账本、不修改 `src/`、`test/`、`media/`、`docs/`（除本文件）与仓库根目录文件。所有变异实验都在 `%TEMP%` 的**副本**里做；工作树关键文件 sha256 与本轮开始时逐字节相同（见 §二.4）。

---

## 一、结论摘要

| 复核项 | 结论 |
| --- | --- |
| **新发现 2**（P3）astral 用例是否真的钉得住按码点截断 | **已修复，且能杀死两种不同的错实现**。真实实现 4/4 绿；副本 `m1`（把 `Array.from` 换成 `last.split("")`，即按 UTF-16 码元切）→ **红**（`actual: 72` / `expected: 141`）；副本 `m5`（保留 `Array.from` 计数、但切 `chars.join("")` 的 UTF-16 前缀——我在给 A 的清单里点名要试的那种"换一种错法"）→ **红**（`actual: 72` / `expected: 141`）；对照副本 `m6`（把 `REASON_LINE` 偏好改回末条非空行，属于第八轮新发现 1）→ **红**，`actual` 正是 `'git <command> [<revision>...] -- [<file>...]'`（见下一行）。用例不再是 `✨` 那种空转。**但**注释里"纯 astral 串上变异体会存活"这句是**错的**（见新发现 1）。 |
| **新发现 1**（P4）`upstreamNoteDetail` 是否优先取 `fatal:`/`error:` 行 | **已修复，且对真实产物无回归**。真实 Git 复现三种形态：`unknown revision` 三行（`fatal:` → `Use '--' …` → 用法提示，exit 128）现在取第一行；损坏对象三行（`error:` ×2 → `fatal: loose object … is corrupt`，exit 128）仍取 `fatal:` 行，且该行 **138 码点 < 140**，整句完整显示、不被截断（实测 `real out cp = 138`）；无标记行的流回退末条非空行（`warning:` + `plain tail` → `plain tail`），不丢给退出码。JSDoc 里"the line Git guarantees to print"已被替换为实测结论。**残留**：末条标记行仍可能取到"原因之后"的标记行（合成探针可复现，真实形态无一命中，见新发现 5，P4 潜伏）。 |
| **新发现 3**（P4）被撤回的"任何原因"说法 | **已修复，且无第三处**。`src/ui/rebasePresentation.ts:67` 现为 "Scope, which is narrower than \"any reason the counts are unknown\": this is set only when an upstream **did** resolve but counting against it failed."，并列出 `[gone]` 吸收的五种形态；`docs/improvement/improvement.md:205` 改为"上游可解析、但对着它计数失败"，`:206` 补了同样的范围限定。我把 `src/`、`media/`、`docs/` 全套 `.ts`/`.js`/`.md` 全文件重扫 `任何原因`/`any reason`：只剩两处引用旧说法**作为被撤回对象的引述**（`rebasePresentation.ts:67` 的 narrow-than 从句、`improvement.md:244/255` 的历史记录），**没有第三处仍在主张它**。 |
| **新发现 4**（P3）缺 `commits` 的 state 是否不再抛 | **已修复，且我实测了"没变坏"的那一半**。用例 13/13 绿且断言 `errors == []`；副本 `m2`（去掉 `renderList` 的 `?? []`）→ **红**（`actual: undefined`）；副本 `m3`（去掉 `renderBanner` 的 `?? []`）→ **红**（`actual: ''`，即横幅全空）。**关键的反向验证**：我用同一份 JSDOM 夹具做**差分渲染**——把当前 `media/main.js` 与"仅把三处守卫去掉、其余完全相同"的副本逐字节对比七种 state，只有"没有 `commits`"这一种不同；`commits: []`（空数组，与 `undefined` 不同）、三条 commit、变基中带 commit、error 带 commit、锁定 run、带 changes——**全部 SAME**。空数组仍渲染 `没有可显示的 commit。`，与 `undefined` 路径一致，`?? []` 没有把"没有改动/没有 commit"变成别的东西。 |
| **`renderChanges` 的 `?? []` 是否把"没有改动"变成"未知改动"** | **不存在这个问题**。`git diff 577ce87 -- media/main.js` 显示 `renderChanges` 的改动列表**一行未改**，仍是 `appendChangeFiles(more, state.changes || [])`；本轮新增的三处 `?? []` 全在 `renderBanner` / `filteredCommits` / `renderList`。任务里点名担心的那一处并不存在。 |
| **测试计数** | **324 项 / 47 个文件**，我独立枚举一致：`grep -rhoE '^test\(' test/*.test.ts \| wc -l` = **324**，`ls test/*.test.ts \| wc -l` = **47**，无缩进的 `test(`（0 行），无 `.only(`，唯一的 `.skip` 是 `rebaseEngine.test.ts:66` 在缺 `sh` 时的子测试跳过（本机有 `sh`，不触发）。`RELEASE.md:136`、`docs/summary/summary.md:150`、`docs/release-notes/0.8.3.md:44` 三处**都是 324**。 |
| **重建后的 VSIX** | **12 个条目、白名单通过、payload 逐字节相同、构建确定**。`node scripts/package-vsix.js --verify-only` → `VSIX contents match the allowlist (12 entries).`；我按中央目录自己解压比对，**10 个 payload 全部 IDENTICAL**（`LICENSE.txt` 源为仓库根的 `LICENSE`，sha256 同为 `5b78c0db…`；`readme.md` 源为 `README.md`）。包内 `extension/dist/extension.js` sha256 `793c27fa035270698ce1aa0731faa7c7ed59969059f666961be51b780517f50a`，与**现场 `node esbuild.js` 重建结果逐字节相同**（`cmp` 通过）。VSIX `mtime = 2026-11-09 09:36:55`，`src/`、`media/`、`scripts/`、`esbuild.js`、`package.json` 中**没有任何文件比它新**（`find -newer` 计数 0）。 |
| **是否引入新缺陷** | **没有产品行为缺陷**。本轮四项全部真实修好，且四项我都能用最小变异打红。新发现 5 项**全部 P4**：1 处注释/文档的理化理由写反、1 处断言窗口未覆盖（`NOTE_DETAIL_LIMIT` 门用的是哪一侧长度）、1 处注释把渲染顺序写反（且与另一处注释互相矛盾）、1 处守卫不可达因此 `m4` 打不红、1 处潜伏的"标记行偏好"方向风险（真实形态零命中）。**没有一项改变用户可见的正确行为**，没有一项落在发布阻断面上。 |

### 裁决：**维持批准，建议提交并打 tag**

**本评审确认 `code-review-0-8-20.md` 对 0.8.3 的批准仍然有效，并继续覆盖 `dist-vsix/git-rebase-visual-0.8.3.vsix`。我建议现在提交工作树并打 `0.8.3` 的 tag。**

理由，逐条对上证据：

1. **四项整改都不是"看起来修了"**。第八轮我点名要的三种"换一种错法"变异——UTF-16 切片、`Array.from` 计数但切 joined 串、去掉 `REASON_LINE` 偏好——**全部把对应用例打红**，失败断言报的正是我预期的那一句。这四项已经达到"改坏就会红"的标准，不需要再等一轮。
2. **没有回退**。第七轮关闭的 48 处 `withPositionals` 穷举审计没有重开，`pushGuard.ts` 的 `[gone]` 判定、`commitLog.ts` 的 `RangeArgv` 分支、`-evil` 三条用例仍在原处；我重跑了 `test/pushIsolation.test.ts`（17/17）、`test/composeSessionGate.test.ts` + `test/restoreFileProtocol.test.ts`（4/4），全绿。`node esbuild.js` 现场重建得到**同一个** sha256，说明构建仍可复现。
3. **本轮新增的守卫没有改变既有行为**。这是任务里最尖的一问（`?? []` 会不会把"没有改动"变成"未知改动"），我用"仅去掉守卫"的差分副本做了对照：七种 state 里只有缺 `commits` 的那一种不同。`state.changes || []` 一行未动。
4. **五条新发现全部 P4，没有一条改用户可见行为。** P4 的含义是"注释/文档与实测不符、断言窗口有缝、不可达代码"，属于 0.8.4 的清理项，不构成发布阻断。继续压着不发，成本高于收益。

---

## 二、我实际跑了什么（以及没有跑什么）

### 2.1 类型与定向用例

```text
node node_modules/typescript/bin/tsc --noEmit                          exit 0，零输出
node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit    exit 0，零输出

node node_modules/tsx/dist/cli.mjs --test test/rebasePresentation.test.ts test/webviewDom.test.ts
  → tests 17 / pass 17 / fail 0        （rebasePresentation 4 + webviewDom 13）

node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 test/pushIsolation.test.ts
  → tests 17 / pass 17 / fail 0 / skipped 0

node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 \
     test/composeSessionGate.test.ts test/restoreFileProtocol.test.ts
  → tests 4 / pass 4 / fail 0 / skipped 0
```

合计 **38 项定向用例**，全绿。

**完整 324 项套件不是我跑的**——按任务约束，另一个进程正在跑全量，我没有启动第二个全量进程。`RELEASE.md:136` 与 `docs/release-notes/0.8.3.md:44` 的 324 项全绿是 **A 的**运行结果；我只独立复核了**计数**（静态枚举 324/47）与**三处文档一致**，不能把 A 的绿色算作我的证据。

### 2.2 变异副本（全部在 `%TEMP%` 下，工作树未动）

每一个变异都是在 `%TEMP%\grv21b`…`grv21e` 的副本里改的，`node_modules` 用 junction 指回真实仓库；每次改完用仓库原文件覆盖回去再跑一遍绿作为对照。

| 副本 | 改了什么 | 结果 |
| --- | --- | --- |
| `m1` | `rebasePresentation.ts`：`Array.from(last)` → `last.split("")`（UTF-16 码元切） | **红**：`actual: 72` / `expected: 141` |
| `m5` | `rebasePresentation.ts`：保留 `Array.from` 计数，但截断改成 `last.slice(0, NOTE_DETAIL_LIMIT)`（我点名要试的"另一种错法"） | **红**：`actual: 72` / `expected: 141` |
| `m6` | `rebasePresentation.ts`：`const last = [...lines].reverse().find(...) ?? lines[lines.length - 1]` → `const last = lines[lines.length - 1]`（第八轮新发现 1 的对照） | **红**：`actual: "'git <command> [<revision>...] -- [<file>...]'"` |
| `m7` | `rebasePresentation.ts`：`return chars.length > NOTE_DETAIL_LIMIT` → `return last.length > NOTE_DETAIL_LIMIT`（用 UTF-16 长度当门、按码点切） | **绿 4/4** → 新发现 2 |
| `m2` | `media/main.js`：`renderList` 的 `const commits = state.commits ?? [];` → `const commits = state.commits;` | **红 12/13**：`actual: undefined` |
| `m3` | `media/main.js`：`renderBanner` 的 `(state.commits ?? []).find(...)` → `state.commits.find(...)` | **红 12/13**：`actual: ''`（`/变基进行中/` 没匹配到） |
| `m4` | `media/main.js`：`filteredCommits` 的 `(state.commits ?? [])` → `state.commits` | **绿 13/13** → 新发现 4（守卫不可达） |

### 2.3 我自己的探针（不复用 A 的夹具）

1. **真实 `unknown revision` 三行形状**：`git rev-list --left-right --count "ghost/master...HEAD"`，Git 2.53.0.windows.2，exit 128，stderr 三行（`fatal:` / `Use '--' …` / `'git <command> …'`）。
2. **真实损坏对象**：临时仓库三个 commit，把 `HEAD~2` 的 loose object 覆写成 `garbage`，再跑 `rev-list --left-right --count "master~1...HEAD"`：stderr 是 `error:` ×2 然后 `fatal: loose object… is corrupt`，exit 128。把这段真实 stderr 灌进 `upstreamNoteDetail` → 输出 **138 码点**，整句保留。
3. **`commit-graph` 损坏**：`git commit-graph write` 后把文件头改成 `CGPH`+零字节。结果 `error: commit-graph file is too small` 但 **exit 0**、仍打印计数——所以这个形态**根本走不到** `upstreamNote` 分支（不会制造"有 note 却计数成功"的假象）。
4. **合成顺序探针**：`"fatal: the real cause\nerror: cleanup also failed"` → 输出 `error: cleanup also failed`；`"error: first\nfatal: real\nerror: hook printed this afterwards"` → 输出最后那条 `error:`。这就是新发现 5 的潜伏方向。
5. **纯 astral vs 混合串的判别力**（直接对两个实现测，不经测试文件）：

   | 输入 | 正解码点 | 变异体码点 | 变异体 UTF-16 | 变异体孤立代理 | 长度断言能否杀 | 孤立代理断言能否杀 |
   | --- | --- | --- | --- | --- | --- | --- |
   | `𝄞`×145（纯 astral） | 141 | 71 | 141 | false | **能** | 不能 |
   | `a`+`𝄞`×145（混合） | 141 | 72 | 141 | **true** | 能 | **能** |
   | `𝄞`×140 | 140 | 140 | 280 | false | — | — |
   | `a`×139+`𝄞` | 140 | 140 | 141 | false | — | — |
   | `x`×145（纯 BMP） | 141 | 141 | 141 | false | 不能 | 不能 |

   结论：混合串是**对的选择**，但"纯 astral 串上变异体存活"这句理由是错的——纯 astral 串会被**长度断言**杀掉（71 ≠ 141），只是不会触发孤立代理断言。见新发现 1。

### 2.4 清理与进程

- `%TEMP%\grv21a…e` 全部删除；删除前先把 junction `node_modules` 用 `(Get-Item $p).Delete()` 摘掉，避免顺着链接删真实依赖。真实 `node_modules/tsx/dist/cli.mjs` 仍在。
- 探针临时仓库 `%TEMP%\grv21c`、`%TEMP%\grv21d` 一并删除。
- **进程计数回到基线**：结束时 `Get-Process node` = **3**（PID 15596、28968、35732），与我这轮开始时一致，我起的进程一个没漏。
- 工作树未动：`git status --short` 仍 **39 行**，`git stash list` 为空；关键文件 sha256 与本轮开始时相同——`rebasePresentation.ts` `99ad6d9e…`、`rebaseViewProvider.ts` `99623ab8…`、`gitRunner.ts` `58f587aa…`、`media/main.js` `9aa56eda…`、`test/rebasePresentation.test.ts` `41792927…`、`test/webviewDom.test.ts` `e680442e…`。
- 唯一被我改写的产物是 `dist/extension.js`（现场 `node esbuild.js`），重建前后 sha256 都是 `793c27fa…`，`cmp` 逐字节相同，属于无副作用的确定性重建。

---

## 三、逐项复核（证据均为本轮实测输出）

### 1. 新发现 2（P3）：astral 用例现在钉得住，且钉得住两种错法

`test/rebasePresentation.test.ts:103-111`：

```ts
const mixed = "a" + "\u{1D11E}".repeat(NOTE_DETAIL_LIMIT + 5);
const mixedDetail = upstreamNoteDetail({ code: 128, stdout: "", stderr: mixed });
assert.equal(Array.from(mixedDetail).length, NOTE_DETAIL_LIMIT + 1, "140 code points plus the ellipsis");
assert.doesNotMatch(mixedDetail, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "no lone surrogate: …");
assert.equal(mixedDetail.includes("�"), false, "and therefore no replacement glyph");
```

这是我的要求里最难的一条：第八轮我指出 `✨`（U+2728，UTF-16 长度 1）根本不是代理对，把实现换成 UTF-16 切片后 4/4 仍绿。现在：

- `m1`（`Array.from` → `split("")`，即整体 UTF-16 切）→ **红**，`actual: 72`。
- `m5`（**保留** `Array.from` 计数，只把截断改成对 joined 串做 UTF-16 切）→ **红**，`actual: 72`。这一条是我在给 A 的清单里专门点名的"会不会在另一种错实现上通过"，答案是不会。
- 真实实现 → **4/4 绿**。

`m5` 能红靠的是**长度断言**而非孤立代理断言：变异体在这个混合串上给出 72 码点（71 个"半个对"+ 省略号），与 141 差得足够远。孤立代理断言是第二道网，两个断言各自独立可杀。

**残留（P4，见新发现 2）**：`chars.length > NOTE_DETAIL_LIMIT` 这个**门**用的是码点数，这一点没有被任何断言钉住；改用 UTF-16 长度当门（`m7`）仍然 4/4 绿。

### 2. 新发现 1（P4，潜伏）：`fatal:`/`error:` 行优先，且真实产物更清晰

实现（`src/ui/rebasePresentation.ts:42`）：

```ts
const last = [...lines].reverse().find((line) => REASON_LINE.test(line)) ?? lines[lines.length - 1];
```

我复现了第八轮点名的 `unknown revision` 三行形状，并把它当输入灌进函数：

- stderr（真实采集，exit 128）：
  ```text
  fatal: ambiguous argument 'ghost/master...HEAD': unknown revision or path not in the working tree.
  Use '--' to separate paths from revisions, like this:
  'git <command> [<revision>...] -- [<file>...]'
  ```
- `m6`（改回"末条非空行"）→ **红**，`actual: "'git <command> [<revision>...] -- [<file>...]'"`，`expected: "fatal: ambiguous argument 'ghost/master...HEAD': unknown revision or path not in the working tree."`。这正是第八轮预计的失败模式，一字不差。
- 真实实现 → 取第一行 `fatal: ambiguous argument …`。

**损坏对象形态没有回归**：真实采集的三行 stderr 是 `error: inflate: data stream error (incorrect header check)`、`error: unable to unpack <sha> header`、`fatal: loose object <sha> (stored in .git/objects/…) is corrupt`，exit 128。函数输出 `fatal: loose object … is corrupt`，且 `real out cp = 138` < 140——**整句完整显示，省略号不会咬掉"is corrupt"**。这一点我在第八轮只做了构造串验证，本轮用真实 stderr 复测。

**无标记行回退**：`"warning: something\nplain tail\n"` → `plain tail`（不退化成 `git rev-list 退出码 1`）；CRLF 版本 `"warning: a\r\nplain tail\r\n\r\n"` → `"plain tail"`。回退路径的两条分支都在。

**JSDoc 不再说过头**：`:24` 现为 "There is no line Git is guaranteed to print, so match the tags it does use instead."——第八轮指出的"the line Git guarantees to print"已被删除，改为对"为什么取最后一条标记行"的说明（`error:` 两行在前、`fatal:` 在后，末条标记行更具体）。

**新增的旁证（合成，非真实形态）**：`git rev-list --left-right --count "origin/my branch...HEAD"`（把含空格的字符串当 revision）也是同一三行形状。真实出现这条路的前提是 `%(upstream:short)` 含空格，而 Git 在 `git branch` 层就拒绝 `'my branch' is not a valid branch name`，所以它只是旁证，不是新形态。

### 3. 新发现 3（P4）：被撤回的"任何原因"没有第三处

- `src/ui/rebasePresentation.ts:67` 现为：

  > Scope, which is narrower than "any reason the counts are unknown": this is set only when an upstream **did** resolve but counting against it failed. A pruned, never-fetched, dangling, symref-broken or non-commit tracking ref is reported as `[gone]` by `%(upstream:track)`, so `getUpstream` returns `undefined` before any counting happens and this field is never filled; … If a future change widens the `[gone]` test, those shapes would start arriving here.

  这是**引用旧说法以否定它**，不是仍在主张它。
- `docs/improvement/improvement.md:205` 已改为"在**上游可解析、但对着它计数失败**时填入该字段"，`:206` 又补了"**不**覆盖"的五种形态与"唯一实测能走到这里的是'HEAD 与上游 tip 相同 + 其身后有一个对象损坏'"。
- 全仓扫描 `任何原因|any reason|所有原因|each reason`（`.ts`/`.js`/`.md`，排除 `node_modules`/`dist`/`dist-vsix`）：命中只剩三类——本轮/前轮评审报告中对旧说法的**引用**、`improvement.md:244/255` 的历史记录、以及 `rebasePresentation.ts:67` 的 narrow-than 从句。**没有第三处仍在主张它。**
- 顺带复核同一区块的实现注释（`rebaseViewProvider.ts:427-440`）："Scope, stated precisely because it was once claimed too broadly: this covers '`getUpstream` resolved an upstream, but the count against it failed'…"——与文档和 JSDoc 三处口径一致。

### 4. 新发现 4（P3）：缺 `commits` 的 state 不再抛，而且没有把"空"变成"未知"

`media/main.js` 新增三处守卫：

```js
const stopped = (state.commits ?? []).find((c) => c.hash === state.stoppedAt);          // renderBanner:137
function filteredCommits() { return (state.commits ?? []).filter((c) => queryMatch(c, filterText)); }  // :303
const commits = state.commits ?? [];                                                    // renderList:361
```

**正向**：`test/webviewDom.test.ts` 的 `a state without a commit list renders the banner and the reason instead of throwing` 两个变体（非变基 / `rebaseInProgress`）都断言：横幅带错误文案、上下文带 `↑? ↓?`、列表渲染 `没有可显示的 commit。`、且 `errors` 为空数组（没有未捕获异常逃逸）。13/13 绿。

**反向**：

- `m2`（去掉 `renderList` 守卫）→ **红**，`actual: undefined`，正是 `assert.equal(list.querySelector(".empty")?.textContent, "没有可显示的 commit。")`。
- `m3`（去掉 `renderBanner` 守卫）→ **红**，`actual: ''`，`/变基进行中/` 匹配不到——即第八轮我指出的"更严重的一半"：`rebaseInProgress` 变体下抛在绘制之前，横幅与列表全空。我先用**基线**（`git show 577ce87:media/main.js`）复现过，未捕获异常是 `Cannot read properties of undefined (reading 'map')`，`banner` 有文本但 `list` 为空；加了守卫后同一 state 下 `errs=[]`、`banner="boom"`、`list` 是空态文案。
- `m4`（去掉 `filteredCommits` 守卫）→ **绿 13/13**。原因：`filteredCommits()` 唯一的调用点是 `renderList` 里 `const visible = filteredCommits();`，而它前面就是 `if (!commits.length) { … return; }`——缺 `commits` 时根本到不了。守卫是**防御性的、当前不可达**（新发现 4）。

**"没有把空变成未知"——差分验证**：我把当前 `media/main.js` 与"仅去掉三处守卫、其余逐字节相同"的副本放进同一个 JSDOM 夹具，对七种 state 逐元素比较 `#banner` / `#context-text` / `#changes` / `#list` 的 `outerHTML`：

| state | 结果 |
| --- | --- |
| 三条 commit | SAME |
| `commits: []`（空数组） | SAME |
| 无 `commits` 键 | **DIFF**（当前渲染空态文案，去守卫后为空且抛异常） |
| 变基中 + commit | SAME |
| `error` + commit | SAME |
| 锁定 run（4 条，`collapseLockedRuns`） | SAME |
| 带 changes | SAME |

空数组与 `undefined` 走同一条 `!commits.length` 分支，输出都是 `没有可显示的 commit。`——`?? []` 没有把"没有改动/没有 commit"变成别的语义。

**顺带回答任务里的点名**：`renderChanges` 的改动列表**没有**加 `?? []`，`git diff 577ce87 -- media/main.js` 显示那一行 `appendChangeFiles(more, state.changes || [])` 原样未动。该区域与基线的差异全部来自 `omitDraftEntry`（0.8.3 已记录在 `docs/release-notes/0.8.3.md`），不是本轮引入，也不是守卫造成的。

---

## 四、新发现（按严重度）

本轮**没有 P0/P1/P2，也没有 P3**。五条全部 P4，且都不是"今天会显示错东西"的问题。

### 新发现 1（P4，注释/文档理化理由写反）"纯 astral 串上变异体会存活"与实测相反

`test/rebasePresentation.test.ts:97-102`：

> The string must MIX a BMP character with an astral one. A pure astral string does not discriminate: pairs start at offset 0, so a UTF-16 slice at an even boundary lands exactly between pairs and **the mutant survives**.

`docs/improvement/improvement.md:252` 有同一句的中文版（"纯 astral 串不行…变异体照样存活；这一点是反向实测出来的"）。

**实测（§二.3 表）**：`𝄞`×145 → 正解 141 码点，`m1`/`m5` 变异体 **71 码点**，长度断言 `141 !== 71` **必然红**。所以纯 astral 串**是**有判别力的，只是它的判别力来自长度断言，而孤立代理断言在它上面确实空转（`mutLone=false`）。

**影响**：无用户可见影响；但对下一轮维护者是**反向误导**——如果有人据此以为"混合不重要、纯 astral 也行"而改回纯 astral，结果是长度断言仍然守着（不会立刻变红），孤立代理那条网却失效；反过来若有人据此认为纯 astral 会"存活"而去调实现，会调错方向。**建议 0.8.4 改成**："纯 astral 串能被长度断言杀掉，但孤立代理断言在它上面不触发（偶数边界恰好落在对之间），混合串让两道断言都生效。"

### 新发现 2（P4，断言窗口）`NOTE_DETAIL_LIMIT` 的门按码点还是按 UTF-16 长度，没有断言钉住

`src/ui/rebasePresentation.ts:50-53`：

```ts
const chars = Array.from(last);
return chars.length > NOTE_DETAIL_LIMIT ? `${chars.slice(0, NOTE_DETAIL_LIMIT).join("")}…` : last;
```

副本 `m7` 只把门改成 `last.length > NOTE_DETAIL_LIMIT`（按 UTF-16 长度判断、仍按码点切）→ **4/4 绿**。

**为什么绿**：现有用例的输入在两种度量下都 > 140（`x`×180、`a`+`𝄞`×145 = 146 码点 / 291 码元、`y`×140 恰好相等），没有一条落在"码点 ≤ 140 而码元 > 140"的窗口里。该窗口的真实例子：`"a".repeat(139) + "𝄞"`（140 码点 / 141 码元）——正解原样返回、无省略号；`m7` 会多贴一个 `…`。

**影响**：只在 140 码点窗口上多一个省略号，属于呈现瑕疵；且需要一条恰好卡在那个宽度的 `fatal:` 行才会出现。**建议 0.8.4**：加一行 `assert.equal(upstreamNoteDetail({code:128,stdout:"",stderr:"a".repeat(NOTE_DETAIL_LIMIT-1)+"𝄞"}), "a".repeat(NOTE_DETAIL_LIMIT-1)+"𝄞")`。

### 新发现 3（P4，注释事实错误）`renderBanner` 的注释说"横幅最后绘制"，与 `render()` 顺序相反，且与测试注释互相矛盾

`media/main.js:132-136`：

> This one is worse than the list throwing — **the banner is painted last**, so a throw here leaves the user looking at an empty banner with no error at all.

实际 `media/main.js:79-82`：

```js
function render() {
  captureSearchFocus();
  renderBanner(); renderContext(); renderChanges(); renderList(); restoreSearchFocus();
}
```

横幅是**第一个**绘制的。而 `test/webviewDom.test.ts:603-605` 的注释写的是对的：

> `renderBanner` reads `state.commits` to find the stopped commit, and **it is the first thing render() does** — so the throw happens before the error text is painted.

两处注释直接冲突。**结论本身两边都对**（横幅确实在抛异常时保持全空，因为它在写 `innerHTML` 之前就抛了，实测 `banner=''`），错的是 `main.js` 那句"painted last"。**建议 0.8.4**：改成"it is the first thing `render()` does"或"nothing has been painted yet"。

### 新发现 4（P4，不可达守卫）`filteredCommits` 的 `?? []` 当前不可达，`m4` 打不红

`filteredCommits()` 只在 `renderList` 内被调用（`:365`），而 `:363` 已 `if (!commits.length) { … return; }`。缺 `commits` 时走不到它；`commits` 存在时 `(state.commits ?? [])` 与 `state.commits` 没有差别。副本 `m4` → **13/13 绿**。

**这不是缺陷**（防御性代码本身无害），但注释 `:301-302` 说"the filter controls are still reachable"在当前实现下**不成立**：没有 commit 时 `renderList` 提前返回，控件根本不会渲染。**建议 0.8.4**：要么删掉这处守卫和注释（少一处误导），要么把注释改成"防御性，当前不可达"。不要为它编一条用例——那会变成"为不可达代码造测试"。

### 新发现 5（P4，潜伏）末条标记行可能取到"原因之后"的标记行

`REASON_LINE` 偏好取**最后一条**标记行。合成探针（§二.3.4）证明：如果真实原因之后还有一条 `error:`（例如某个 hook 或清理步骤随后失败），会取到后面那条，而丢掉真正的原因。

**可达性**：我这一轮又试了 `commit-graph` 损坏（exit **0**，不会进这条分支）、损坏 loose object（`fatal:` 在最后）、`unknown revision`（`fatal:` 在最先、用法提示无标记）、缺 alternates（`error: unable to normalize alternate object path…` 在第一行、后面才是 `fatal:`）、2 个损坏对象——**没有一种真实形态在 `fatal:` 之后再打印标记行**。它与第八轮"取末条非空行会取到用法提示"是同一处代码、相反方向的风险；第八轮的形态是**真实可达**的，这一条的形态我只能构造。**不建议现在改**：改成"取第一条标记行"会让损坏对象形态取到上面那两条 `error:`（更不具体），需要"最后一条 `fatal:`，没有才取最后一条 `error:`"这类更细的规则——为一条不可达形态加复杂度不划算。记录在此，等真实出现再说。

---

## 五、我没有验证的部分

1. **完整 324 项套件是否全绿**——按约束没有跑（另一进程在跑全量，我没有启动第二个）。我用 **38 项定向用例** + 两个类型检查 + 静态枚举（324/47）+ 7 个变异副本 + 差分渲染替代，**不能等同**。本轮完全没执行的文件包括 `pendingRecovery`、`recoveryProvider`、`appendStaged` / `appendGuard` / `rebaseSafety` / `editStopCommit` / `worktree` / `llmClient` / `composeDraft`、`commitLog.integration`、`rebaseEngine` 等。`pushIsolation`（17）、`composeSessionGate`+`restoreFileProtocol`（4）、`rebasePresentation`+`webviewDom`（17）是**我自己的**进程跑的。
2. **真实 VS Code GUI / Restricted Mode / 真实 webview 往返**：provider 断言跑在 `test/helpers/vscodeStub.ts` 上，webview 断言跑在 JSDOM 上（同一份 `media/main.js`，但没有真实 `acquireVsCodeApi`）。
3. **非 Git 2.53.0.windows.2**：`unknown revision` 的三行形状、`%(upstream:track)` 的 `[gone]` 语义、`--end-of-options` 在项目声明下限 **2.31.0** 上没实测。新发现 1 的形态**尤其**依赖版本（用法提示措辞可能不同），但"末行不是原因"这个结构大概率稳定。
4. **非 C locale**：`fatal:`/`error:` 前缀在本地化 Git 下是否仍是英文，我没有在 de/zh/fr locale 下复测（第八轮测过，结论是无差异；本轮未重跑）。
5. **Linux/macOS**：路径分隔符、大小写敏感、CRLF 行为未验证。CRLF 用例是**构造**的 stderr，不是在真实 Windows 管道上采集的（本机 Git 输出是 LF）。
6. **真实远端服务器**：只对本地 bare 远端与 `file://` 验证过。
7. **`dist/extension.js` 的逐行源码映射**：我只确认 sha256 与重建一致、包内含 `REASON_LINE`/`upstreamNoteDetail`/`NOTE_DETAIL_LIMIT`/`state.commits ?? []` 这些符号，没有逐行核对 bundle 与源码。
8. **"上游范围查询超时但 `getCommits` 成功"的形状**（第七/八轮遗留）：仍无夹具。如果 0.8.4 要动 `...presentation`，建议先造超时夹具。
9. **`package-lock.json` 的依赖树**：只确认版本号与 `package.json` 一致，没有审计。
10. **`node scripts/package-vsix.js` 的完整重新打包**：本 shell 里 `npm` 不在 PATH（脚本会 `spawnSync("npm", …)` 跑 `vscode:prepublish` 并失败），所以我**没有**重新产出 VSIX，只跑了 `--verify-only` 并自己解压比对 10 个 payload + 现场重建 `dist/extension.js`。`--verify-only` 不写文件，前后 VSIX sha256 都是 `f2cfc9e9…`。**"从删除后的 `dist-vsix/` 重建"这一步是 A 做的，我没有复现。**

---

## 六、给 A 的清单（全部 P4，不阻塞发布）

1. **（0.8.4，P4）** `test/rebasePresentation.test.ts:97-102` 与 `docs/improvement/improvement.md:252` 的"纯 astral 串上变异体会存活"改成实测结论：纯 astral 串能被**长度**断言杀掉（变异体 71 码点），但**孤立代理**断言在它上面不触发；混合串让两道断言都生效（新发现 1）。
2. **（0.8.4，P4）** 加一条卡在"码点 ≤ 140 而 UTF-16 码元 > 140"窗口的断言（`"a".repeat(NOTE_DETAIL_LIMIT-1) + "𝄞"` 原样返回、无省略号），把 `chars.length` 这个门钉住（新发现 2）。
3. **（0.8.4，P4）** `media/main.js:135` 的 "the banner is painted last" 改成"it is the first thing `render()` does"，与 `test/webviewDom.test.ts:604` 一致（新发现 3）。
4. **（0.8.4，P4）** `media/main.js:301-303`：要么删掉 `filteredCommits` 的 `?? []` 与"filter controls are still reachable"注释（当前不可达），要么把注释改成"防御性，当前不可达"；**不要**为它补用例（新发现 4）。
5. **（0.8.4，P4，仅记录）** `REASON_LINE` 取末条标记行的方向风险：真实形态零命中，建议等真实出现再改，不要现在引入"最后一条 `fatal:` 优先"的额外规则（新发现 5）。
6. **（流程）** 账本缺 `0-8-21` 行。本轮任务禁止我编辑账本，请 A 或所有者按本报告补记（基线 `577ce8766a46707a60c471cf8090e9f63cd8d49c`、被评审材料为未提交工作树、结论为**维持批准、建议提交并打 tag**）。`0-8-20` 行已补，可照抄格式。
7. **（沿用遗留项）** §五.8 的超时形态仍无夹具；§五.10 的"从空目录重建 VSIX"我只做了 `--verify-only` 与逐字节比对。

---

## 七、裁决与覆盖范围（重述）

**维持批准。本评审覆盖基线 `577ce87` 之上的未提交工作树（25 修改 + 14 untracked），以及由它构建的 `dist-vsix/git-rebase-visual-0.8.3.vsix`（12 条目、白名单通过、10 个 payload 与工作树逐字节相同、`LICENSE.txt` = 仓库根 `LICENSE`、包内 `extension/dist/extension.js` 与现场重建同为 `793c27fa…`、产物晚于所有源码）。**

第八轮留下的四项，逐项闭合：

- **新发现 2**（astral 用例空转）：**已闭合**。`m1`（UTF-16 切）与 `m5`（`Array.from` 计数但切 joined 串）**都红**，真实实现绿；`✨` 已换成 `"a"+"𝄞"×145`。残留只是注释里的理由写反（本轮新发现 1）。
- **新发现 1**（末条非空行取到用法提示）：**已闭合**。`m6` 红且 `actual` 正是用法提示；真实 `unknown revision` 三行取第一行 `fatal:`；真实损坏对象仍取 `fatal:` 且 **138 码点 < 140**，完整显示；JSDoc 的"guaranteed"断言已删。残留是不可达方向的标记行偏好（本轮新发现 5）。
- **新发现 3**（"任何原因"仍在两处）：**已闭合**。两处都收窄，全仓重扫无第三处主张。
- **新发现 4**（缺 `commits` 抛异常）：**已闭合**，且**反证充分**——回退 `renderList` 或 `renderBanner` 任一守卫都红（`actual: undefined` / `actual: ''`）；差分渲染证明七种带 `commits` 的 state 输出与"去守卫"版本**逐字节相同**，空数组仍渲染空态文案。`filteredCommits` 的守卫不可达（本轮新发现 4），但不是缺陷。

**本轮没有引入新缺陷。** 五条新发现全部 P4：1 处理化理由写反、1 处断言窗口有缝、1 处注释把渲染顺序写反（并与他处注释矛盾）、1 处守卫不可达、1 处潜伏方向风险（真实形态零命中）。它们都不是用户可见的错误行为，都不落在发布阻断面上，也不需要再等一轮。

**结论：0.8.3 与 `dist-vsix/git-rebase-visual-0.8.3.vsix` 的批准继续有效。我明确建议现在提交工作树并打 `0.8.3` 的 tag；上面五条 P4 并入 0.8.4 清理即可。** 提交后仍需由后续独立评审按真实 SHA 覆盖（本报告覆盖的是未提交工作树 + 基线 `577ce87`）。
