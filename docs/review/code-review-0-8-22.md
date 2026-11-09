# Code Review 0-8-22 — 0.8.3 第九轮 P4 清理（新发现 1–5 是否真的关闭、两处风险改动是否安全、Action 主版本升级是否成立）

- 评审日期：2026-11-09
- 评审角色：独立评审（Agent B，第十轮）
- 基线 commit：`783dac7149eaaf2aef4ccd74d57a30f75658a51d`（`feat: release 0.8.3 — push notifications, restore-side protocol, option-injection hardening`）
- 被评审材料：基线之上的**未提交工作树**，最终为 **6 个修改文件**、**0 个 untracked**（`git diff --stat 783dac7` = 6 files changed, 101 insertions(+), 16 deletions(-)）：`.github/workflows/release.yml`、`docs/improvement/improvement.md`、`docs/review/code-review-commit.md`、`media/main.js`、`src/ui/rebasePresentation.ts`、`test/rebasePresentation.test.ts`。写本报告前 `git status --short` 是这 6 行；写完后多出的 `?? docs/review/code-review-0-8-22.md` 是本报告自身。
- **工作树在我评审期间被更新过两次**（不是我的改动）：第一次是待评审的 P3-9 清理；第二次是 12:53–13:00 A 针对本报告草稿中列出的 P4-1…P4-4 做的整改（`improvement.md` 新增 P3-10 小节）。**本报告的所有结论都基于 13:00 之后的最终工作树**，对最终内容重新跑过一遍验证（见 §二、§三）；`improvement.md` 与账本里的“已由 B 确认”字样不是我写的，我按自己的实测独立复核了它们的事实主张。
- 本轮任务：上一轮（[`code-review-0-8-21.md`](code-review-0-8-21.md)）**维持批准并建议提交、打 tag**，另留 **5 项 P4**。维护者要求本轮把这 5 项**全部关闭**，并**额外**把 `actions/checkout@v4` / `actions/setup-node@v4` 升到 `@v7`。本轮验证：5 项是否真的关闭、有没有引入新缺陷、两处风险改动（删除 `filteredCommits` 守卫、升 action 主版本）是否安全。
- 顺序：先读 `code-review-0-8-21.md`（我自己的上一份报告），再读 `docs/review/code-review-commit.md`（覆盖账本）。
- 账本状态：`0-8-21` 行在（`code-review-commit.md:52`）；本次清理也有行（`:53`），**SHA 列写的是“（未提交）”**，并注明“SHA 由维护者在提交时填入（本行不写臆造的 SHA）”。这符合台账规则（完整 SHA + 评审文件同时记录才算“已评审”）。**按任务约束我没有编辑账本**；提交时仍需把该行的“（未提交）”换成真实 SHA。
- 环境：Windows 11 + MSYS Git `2.53.0.windows.2`，Node `v24.16.0`（`/d/Program Files/nodejs/node`）。action tag 与发布记录用 `gh api` / `gh run view` 查询。仓库无 `.gitattributes`，`core.autocrlf=true`。
- **约束遵守**：我没有修改 `src/`、`test/`、`media/`、`.github/`、`docs/`（除本文件）或仓库根目录的任何文件；所有变异都在 `%TEMP%` 的副本里做，副本已全部删除；**另一个进程当时正在跑完整套件，我没有启动第二个**；唯一被重写的是构建产物 `dist/extension.js`（跑 `node esbuild.js` 验证可复现性，重写后 sha256 仍为 `793c27fa…`，字节相同）。最终工作树关键文件 sha256 见 §二.4。
- 行尾：`media/main.js`、`improvement.md`、`release.yml` 是 LF；`src/`、`test/`、`package.json`、`style.css` 等是 CRLF（`core.autocrlf=true` 的正常结果，不产生 diff 噪声）。因此本地文件级 `cmp` 会因行尾不同而失败，**payload 比较一律先按各自真实字节比，必要时再归一化 EOL**。

---

## 一、结论摘要

| 复核项 | 结论 |
| --- | --- |
| **新发现 1**（P4）“纯 astral 串上变异体会存活”是否改对 | **已按实测改正，且无第三处**。最终 `test/rebasePresentation.test.ts:97-109` 写的是“纯 145 码点输入（也是 290 码元）在正确实现下出 141 码点、UTF-16 切片下出 71 码点，所以 141 ≠ 71、长度断言会失败；在纯 astral 串上不触发的是**孤立代理断言**——对从 0 开始，偶数边界落在两对之间；前缀一个 BMP 字符把对推到奇数偏移，两道断言才都生效”。`docs/improvement/improvement.md:252` 表述一致。**我独立复算**：`𝄞`×145 = **145 码点 / 290 码元**，正确输出 **141 码点**，UTF-16 切片输出 **71 码点**；混合串 `a`+`𝄞`×141 的 140 码元前缀**确实**含孤立代理（正则命中 `true`）。全树只剩这两处**新结论**，以及 `code-review-0-8-20.md` / `0-8-21.md` 中**作为被撤回对象的引述**（历史档案，按项目规则不得修改）。 |
| **新发现 2**（P4）`NOTE_DETAIL_LIMIT` 门是否被断言钉住 | **已钉住，且最终版本把“差一”窗口也关掉了**。我按要求把门改成 `return last.length > NOTE_DETAIL_LIMIT` → **3 pass / 1 fail**，失败断言 `unchanged, with no ellipsis: the gate counts code points`，`actual` 是 `"a"×139 + "𝄞" + "…"`、`expected` 是 `"a"×139 + "𝄞"`。最终树又加了第二条夹具 `overByOne = "a"×140 + "𝄞"`（**141 码点 / 142 码元**）要求**精确**截成 `"a"×140 + "…"`；我实测把门改成 `> NOTE_DETAIL_LIMIT + 1`、`+ 5`、`+ 6`、`+ 100`、`- 1`、`>=` **全部变红**（见 §三.2 表）。**不会“因为错误的原因”通过**：两条夹具各自显式断言码点数与码元数，再做整串精确相等。 |
| **新发现 3**（P4）“横幅最后绘制”的注释 | **三处一致**：`media/main.js:79-82` 的 `render()` 是 `renderBanner(); renderContext(); renderChanges(); renderList();`；`:132-137` 的注释说“`renderBanner` 是 `render()` 做的**第一件**事”；`test/webviewDom.test.ts:602-606` 说“it is the first thing render() does”。全树没有第三处反向说法。 |
| **新发现 4**（P4，本轮最高风险）删除 `filteredCommits` 的 `?? []` | **删除安全，我判定它不可能崩**。静态：`filteredCommits` 全树**只有 2 处命中**（`:305` 定义、`:367` 调用）；唯一调用点前有 `const commits = state.commits ?? []; … if (!commits.length) { …; return; }`；`state` 初值就是 `{ commits: [], … }`；消息处理只有 `state = m; render()` 与 `recoveryNotice` 分支（只调 `renderBanner()`）；`applyDeferredState()` 需 `deferredState` 非空；`renderList` 体内无 `await`、无动态按名调用。动态：JSDOM 探针跑 7 条路径（正常渲染 / 输入过滤 / Alt 方向键 / 无 commits / **陈旧脱离节点**上的 input+keydown / `rebaseInProgress` 无 commits / commits→none→commits 重入 + `recoveryNotice`）→ **4 次真实调用，`state.commits === undefined` 零命中，`ERRORS: []`**。 |
| **新发现 5**（P4）`REASON_LINE` 权衡注释，行为不许变 | **只改注释，行为零变化，且注释里的实测主张成立**。`git diff` 显示 `src/ui/rebasePresentation.ts` 只有 JSDoc；把**基线 `783dac7` 的源码**在干净目录重新 `node esbuild.js`，产物 sha256 **`793c27fa…`**，与当前 `dist/extension.js` 逐字节相同。注释说“取第一条标记行更差”也被我独立打红：副本改成 `lines.find(...)` → 红，`actual: 'error: inflate: data stream error (incorrect header check)'`、`expected: 'fatal: loose object … is corrupt'`。最终版本还按我上一条建议，把五种实测形态**内联**进注释，不再引用 `docs/review/`（`grep -n "docs/review" src/ media/` → 无命中；`grep -c "code-review" dist/extension.js` → **0**）。 |
| **Action 主版本升级 v4 → v7** | **成立，且没有偷偷改 Node**。`v7` 对两个 action 都是**真实且当前**的 tag（checkout `v7.0.1`，setup-node `v7.1.0`，两者 latest 也都是 v7，无 v8）；两者 `action.yml` 的 `runs.using` 都是 **`node24`**，正好是弃用告警指向的运行时；`node-version: 20` **原样保留**，线上运行实测解析到 `20.20.2`；本工作流用到的输入（`node-version`、`cache: npm`）在 v4→v7 之间**形状与默认值都没变**（`always-auth` 是 **v6.1.0** 删除的，不是 v7——见 §四 P4-1 已修；`package-manager-cache` 是 v5 新增、默认 `true`，但仅当 `package.json` 有 `packageManager`/`devEngines` 才生效，本仓库**两者都没有**）；`ubuntu-latest` 实测 runner `2.338.2` 高于 node24 要求的 `v2.327.1`，也高于 checkout 仅在“Docker 容器 action 内跑需认证 git 命令”时才要求的 `v2.329.0`（本工作流无容器 action）。**会消失的告警**正是 `##[warning]Node.js 20 is deprecated … actions/checkout@v4, actions/setup-node@v4`（发布运行 `42551241078` 第 2090 行）；`punycode`、npm `deprecated`、`EBADENGINE` 等与 action 主版本无关的告警**仍会存在**（§四 P4-5）。 |
| **是否引入新缺陷** | **没有产品行为缺陷**。`src/` 只加 JSDoc（产物仍 `793c27fa…`）；`media/` 只改注释并删除一处已证明不可达的守卫；`.github/` 只换两行 `uses` + 一段注释；其余是文档/账本。两项类型检查零输出；`test/rebasePresentation.test.ts` **4/4**、`test/webviewDom.test.ts` **13/13**（**我自己的**进程跑的）。 |
| **测试计数与文档** | **324 项 / 47 个文件**，静态枚举一致；改动的测试文件**仍是 4 条**（新断言并入既有用例）。`RELEASE.md:136`、`docs/summary/summary.md:150`、`docs/release-notes/0.8.3.md:44` 三处都是 324，`improvement.md:278` 也写 324 并注明“本轮条数不变”。**324 项全绿是 A 的运行结果，不是我跑的**（§五）。 |
| **VSIX** | **12 个条目、白名单通过、payload 与工作树逐字节相同**。`node scripts/package-vsix.js --verify-only` → `VSIX contents match the allowlist (12 entries).`；逐个 `cmp`：`readme.md`、`package.json`、`media/{style.css,main.js,icon.svg,extension-icon.png}`、`dist/{seq-editor.js,extension.js}` 全部 **SAME**。包内 `dist/extension.js` = `793c27fa…` = 现场重建结果。`dist-vsix` 产物时间早于本轮 `src/`、`test/` 的最后修改，但**逐字节比较才是证据**：`src/` 改动不进包、`test/` 不进包、`media/main.js` 的内容已一致，所以 `dist-vsix` 仍然有效；下次发布前 `npm run package` 会重建。 |

### 裁决：**可以提交；`filteredCommits` 的守卫删除不会崩；Action 升级成立**

**我建议直接提交这 6 个文件，并在同一提交里把账本第 53 行的“（未提交）”换成真实 SHA。** 依据：

1. **五条 P4 全部真关闭，且我能用最小变异把它们打红**：`last.length` 门、`+1`/`+5`/`+6`/`+100`/`-1`/`>=` 六种门变异、取第一条标记行，全部红；纯 astral 的判别力我独立复算过数值。
2. **风险改动一（删守卫）没有崩溃路径**：静态上唯一调用点有前置早退，动态上 7 条路径（含陈旧脱离节点与重入）一次都没让 `filteredCommits` 见到 `undefined`，也没有未捕获异常。
3. **风险改动二（Action 升级）没有夹带运行时变化**：`node-version: 20` 一字未动；两个 action 用的是 `node24` 运行时，与项目构建/测试所用的 Node 相互独立；本工作流用到的输入没有形状或默认值变化；runner 版本满足最低要求。
4. **产品行为零变化**：基线源码重建的 `dist/extension.js` 与工作树逐字节相同，说明 `src/` 只是注释；`media/` 的守卫删除已由探针证明等价。

---

## 二、我实际跑了什么（以及没有跑什么）

### 2.1 类型与定向用例（最终工作树）

```text
node ./node_modules/typescript/bin/tsc --noEmit                     → exit 0，零输出
node ./node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit → exit 0，零输出

node ./node_modules/tsx/dist/cli.mjs --test test/rebasePresentation.test.ts
ℹ tests 4   ℹ pass 4   ℹ fail 0

node ./node_modules/tsx/dist/cli.mjs --test test/webviewDom.test.ts
ℹ tests 13  ℹ pass 13  ℹ fail 0
```

17/17 与 `improvement.md:278` 记录一致。**完整套件不是我跑的**（§五）。

### 2.2 变异副本（全部在 `%TEMP%` 下，工作树未动）

| 变异（只改 `src/ui/rebasePresentation.ts` 的门） | 结果 |
| --- | --- |
| `return last.length > NOTE_DETAIL_LIMIT`（上一轮的 `m7`） | **红**，`3 pass / 1 fail`，失败断言 `unchanged, with no ellipsis: the gate counts code points` |
| `return chars.length > NOTE_DETAIL_LIMIT + 1` | **红**（122 行新增的 `overByOne` 夹具杀死） |
| `return chars.length > NOTE_DETAIL_LIMIT + 5 / + 6 / + 100` | **红** |
| `return chars.length > NOTE_DETAIL_LIMIT - 1` | **红** |
| `return chars.length >= NOTE_DETAIL_LIMIT` | **红** |
| `return last.length >= NOTE_DETAIL_LIMIT + 1` | **红** |
| `return last.length > NOTE_DETAIL_LIMIT + 1`（**双重错误**：度量与边界同时错） | **绿 4/4**（残留，见 §四 P4-2 与 §六） |
| 标记行偏好：`[...lines].reverse().find(...)` → `lines.find(...)` | **红**，`actual: 'error: inflate: data stream error (incorrect header check)'` |

每次变异后都把仓库原文件 `cp` 回副本并核对 sha256（`482c058f…`），副本目录最后整体删除。

### 2.3 我自己的探针

1. **`filteredCommits` 可达性探针（JSDOM）**：把定义行插桩成 `window.__fcCalls++` 并记录 `state.commits == null`，再 `window.eval(media/main.js)`，依次投递正常 state、输入过滤、Alt+方向键、无 commits、`rebaseInProgress` 无 commits、commits→none→commits、`recoveryNotice`-only，并对**已脱离文档的旧节点**补发 input/keydown：

   ```text
   row present: true filterCalls: 1 undefSeen: false
   after input filterCalls: 2 rows: 1
   after keydown filterCalls: 2 undefSeen: false
   list empty text: 没有可显示的 commit。 filterCalls: 2 undefSeen: false
   after stale events filterCalls: 2 undefSeen: false
   banner: 变基进行中，等待继续… filterCalls: 2 undefSeen: false
   filterCalls: 4 undefSeen: false
   ERRORS: []
   ```

2. **数值复算（直接对实现测，不经测试文件）**：

   ```text
   pure cp: 145 units: 290
   mutant-equivalent slice+ellipsis cp: 71
   real out cp: 141 real out units: 281
   mixed cp: 146 units: 291
   mixed slice carries lone surrogate: true
   codePointLimit cp: 140 units: 141
   overByOne cp: 141 units: 142
   ```

3. **基线可复现性**：`git archive 783dac7 src esbuild.js package.json tsconfig.json` 到干净目录（`node_modules` junction），`node esbuild.js` →

   ```text
   793c27fa035270698ce1aa0731faa7c7ed59969059f666961be51b780517f50a *dist/extension.js
   BASELINE-BUILD == worktree dist/extension.js
   ```

   证明本轮唯一 `src/` 改动（`REASON_LINE` JSDoc）不进入产物。

4. **“残留窗口能不能关”的可行性探针**：在副本里给测试**追加**一条纯 BMP 夹具 `"x".repeat(NOTE_DETAIL_LIMIT + 1)`（141 码点 / 141 码元）要求截断——

   ```text
   real impl + fixture -> 4/4 绿
   last.length > NOTE_DETAIL_LIMIT + 1 + fixture -> 3/4 红
     AssertionError: pure BMP 141 code points must also truncate
   ```

   说明 §四 P4-2 的残留是**可闭合的**，代价是 5 行；我没有把它写进工作树（只写副本）。

### 2.4 清理与进程

- 临时目录 `%TEMP%\grv22a`…`grv22e`（全量副本、基线重建、action 元数据、最终变异副本）**全部删除**；其中的 `node_modules` 是 **junction**，先用 `[System.IO.Directory]::Delete()` 解开再删目录，真仓库 `node_modules` 未受影响（顶层项仍 267 个，`tsx`、`jsdom`、`typescript` 均在）。`%TEMP%` 下 `grv22*` 计数 **0**。
- `%TEMP%\nv.json`、`mut22.js`、`mut23.js`、`mutfirst.js`、`addfixture.js` 与 `/tmp` 下的 `rp.orig.ts`、`probe22.ts`、`ob.ts` 均删除。
- 进程：本轮期间 `node.exe` 的**基线**是 3 个 long-lived 服务（15596、28968、35732，codegraph / MCP）。评审中另有**另一个进程**启动过完整套件（`36352 → 32956 scripts/run-tests.js → 26840 tsx --test --test-concurrency=3 → 18664 → …`，12:55 起），到 13:05 仍在跑，**不是我启动的**；我的全部命令都是前台同步执行、退出即回收，没有新增常驻 PID。
- 最终工作树 sha256（我的验证全部针对这组字节）：

  ```text
  482c058f…  src/ui/rebasePresentation.ts
  1b9d762b…  test/rebasePresentation.test.ts
  5bb9e540…  media/main.js
  0d2a342d…  .github/workflows/release.yml
  bebea1f6…  docs/improvement/improvement.md
  0d1ba6f3…  docs/review/code-review-commit.md
  793c27fa…  dist/extension.js（重建后不变）
  ```

  `git status --short` = 那 6 个 `M` + `?? docs/review/code-review-0-8-22.md`（本报告）。

---

## 三、逐项复核（证据均为本轮实测输出）

### 1. 新发现 1（P4）：理据已按实测改正，且无第三处

最终 `test/rebasePresentation.test.ts:97-109`：

```text
  // The string MIXES a BMP character with an astral one, and that is the
  // stronger fixture. On a pure astral string the code-point length assertion
  // below still kills the mutant: a pure 145-code-point input (`𝄞`×145, which
  // is also 290 UTF-16 units) comes out at 141 code points with the correct
  // implementation and at 71 with a UTF-16 slice, so 141 ≠ 71 and the assertion
  // fails. What never fires on a pure astral string is the lone-surrogate
  // assertion, because given pairs starting at offset 0 every even 140-unit
  // boundary lands exactly between two pairs. Prefixing one BMP character
  // shifts every pair to an odd offset, so the boundary falls inside a pair and
  // BOTH assertions become live.
```

`docs/improvement/improvement.md:252` 同步写“**纯 astral 串仍会被长度断言杀掉**（`𝄞`×145 是 141 码点，UTF-16 切片后只剩 71 码点，`141 ≠ 71`），只是它的**孤立代理断言**永远不触发……混合串让**两道**断言都生效”，并注明原文是反的。

**我的独立复算**与这两处一致。**第三处检查**：全树 `grep "纯 astral|pure astral"` 只剩这两处新结论与 `code-review-0-8-20.md` / `code-review-0-8-21.md` 的历史引述（不可修改的审计快照）。

### 2. 新发现 2（P4）：码点门被两条夹具从两侧钉住

最终测试（`test/rebasePresentation.test.ts:123-153`）先钉 140 码点 / 141 码元“原样返回”，再钉 **141 码点 / 142 码元必须截断**：

```ts
const codePointLimit = "a".repeat(NOTE_DETAIL_LIMIT - 1) + "\u{1D11E}"; // 140 cp / 141 units
…
const overByOne = "a".repeat(NOTE_DETAIL_LIMIT) + "\u{1D11E}";           // 141 cp / 142 units
assert.equal(Array.from(overByOne).length, NOTE_DETAIL_LIMIT + 1, "141 code points");
assert.equal(overByOne.length, NOTE_DETAIL_LIMIT + 2, "142 UTF-16 units");
assert.equal(
  upstreamNoteDetail({ code: 128, stdout: "", stderr: overByOne }),
  "a".repeat(NOTE_DETAIL_LIMIT) + "…",
  "one code point over is truncated to the limit plus the ellipsis"
);
```

**变异复现（副本，只改 `src/`）**：

```text
m22a: → return last.length > NOTE_DETAIL_LIMIT
✖ the count-failure detail is the last stderr line, on one line, and bounded
AssertionError [ERR_ASSERTION]: unchanged, with no ellipsis: the gate counts code points
  actual:   'a'×139 + '𝄞' + '…'
  expected: 'a'×139 + '𝄞'
ℹ tests 4  ℹ pass 3  ℹ fail 1
```

其余六种门变异（`+1`、`+5`、`+6`、`+100`、`-1`、`>=`）**全部红**。**“是否因为错误的原因通过”**：不会——两条夹具分别显式断言码点数与码元数，再做**整串精确相等**，任何一侧度量错、任何边界偏移都会先撞断言。**残留**（P4-2）：把度量与边界**同时**写错（`last.length > NOTE_DETAIL_LIMIT + 1`）仍 4/4 绿；我用 §二.3.4 的纯 BMP 141 夹具验证过，它能被杀死，代价 5 行。

### 3. 新发现 3（P4）：注释、`render()` 顺序、测试注释三处一致

- `media/main.js:79-82`：`captureSearchFocus(); renderBanner(); renderContext(); renderChanges(); renderList(); restoreSearchFocus();`
- `media/main.js:132-137`：`renderBanner` 是 `render()` 做的**第一件**事，抛异常发生在任何错误文案被绘制之前，横幅全空。
- `test/webviewDom.test.ts:602-606`：`it is the first thing render() does — so the throw happens before the error text is painted`。

全树无第三处反向说法；`git diff 783dac7 -- media/main.js` 只有这段注释与守卫删除。

### 4. 新发现 4（P4，本轮最高风险）：删除 `filteredCommits` 的 `?? []` 不会崩

**静态**：

```text
$ grep -n "filteredCommits" media/main.js
305:  function filteredCommits() { return state.commits.filter((c) => queryMatch(c, filterText)); }
367:    const visible = filteredCommits();
```

```js
function renderList() {
  listEl.innerHTML = "";
  const commits = state.commits ?? [];
  const known = new Set(commits.map((c) => c.hash));
  selectedHashes = new Set([...selectedHashes].filter((h) => known.has(h)));
  if (!commits.length) { …; return; }
  const visible = filteredCommits();
```

- `state` 初值 `{ commits: [], … }`（`:28`）；状态只经 `state = m; render()`（`:706`）与 `applyDeferredState()`（`:576-578`，需 `deferredState` 非空）进入；`recoveryNotice` 只调 `renderBanner()`，不经过 `renderList`。
- `renderList()` 体内**无 `await`**，早退检查与调用在同一同步片段；无 `window["filteredCommits"]` / `eval` / 按名调用。
- 其余 `renderList()` 调用点全是行内事件处理；即便事件来自陈旧脱离节点，`renderList` 自己的 `?? []` + 早退先兜住。

**动态**（§二.3.1）：7 条路径、4 次真实调用、`undefined` 零命中、`ERRORS: []`，含陈旧节点事件与重入。**结论：不可能在 `state.commits` 为 `undefined` 时抵达 `filteredCommits`；删除守卫不引入崩溃，新注释“a guard here would be unreachable”准确。**

### 5. 新发现 5（P4）：注释记录权衡，行为未变

`git diff 783dac7 -- src/ui/rebasePresentation.ts` 只有 JSDoc 新增；实现行 `[...lines].reverse().find(...) ?? lines[lines.length - 1]` 与截断逻辑一字未改。基线源码重建的 `dist/extension.js` 与工作树**逐字节相同**，所以“行为不变”是产物级证据。注释里“替代方案更差”由 `m22e` 独立打红。最终版本把五种实测形态内联进注释，不再引用 `docs/review/`。

### 6. Action 主版本升级

**v7 真实且当前**：`actions/checkout` 的 `v7` tag → `3d3c42e5…`，latest `v7.0.1`；`actions/setup-node` 的 `v7` tag → `949feb24…`，latest `v7.1.0`；两者 release 列表止于 v7，**无 v8**。

**运行时**：checkout `v4.4.0` 是 `runs.using: node20`，`v7.0.1` 是 `node24`；setup-node `v7.1.0` 是 `'node24'`。发布运行 `42551241078`（基线 `783dac7`）第 2090 行：

```text
##[warning]Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: actions/checkout@v4, actions/setup-node@v4.
```

升到 v7 后该告警的来源消失。

**Node 没有被偷偷改**：工作流仍是 `node-version: 20`；同一次运行实测 `Attempting to download 20…` → `Acquiring 20.20.2`，`npm warn EBADENGINE … current: { node: 'v20.20.2' }`。

**输入对比**（各主版本 `action.yml`）：

| 输入 | v4.4.0 | v5/v6 | v7.1.0 | 本工作流 |
| --- | --- | --- | --- | --- |
| `node-version` | 有 | 有 | 有 | `20`（不变） |
| `cache` | `npm/yarn/pnpm` | 同 | 同 | `npm`（不变） |
| `always-auth` | 有 | v6.0.0 有、**v6.1.0 删除**（PR #1436） | 无 | 未使用 |
| `package-manager-cache` | 无 | v5 新增，默认 `true` | 同 | 未使用；仅当 `packageManager`/`devEngines` 存在才自动缓存，本仓库**两者都没有** |
| `cache-primary-key` / `cache-matched-key`（输出） | 无 | 无 | v7 新增 | 未使用 |

**runner**：两个 v7 README 都要求 ≥ `v2.327.1`；checkout 另有 Docker 容器 action 场景 ≥ `v2.329.0`。发布运行实测 `Current runner version: '2.338.2'`（当前 latest `v2.338.2`），`ubuntu-latest` 远高于两者。

**仍会存在的告警**（与 action 主版本无关）：`DEP0040 punycode`、`npm warn deprecated whatwg-encoding@3.1.1 / prebuild-install@7.1.3`、成批 `npm warn EBADENGINE … required: { node: '>=22.0.0' } current: v20.20.2`（`@azure/*` 等）。这些不会因升 action 消失；`EBADENGINE` 见 §四 P4-5。

**工作流合法性**：`js-yaml` 解析通过；单 job `release`（`ubuntu-latest`），8 个 step；`grep -rn "uses: actions/" .github/` → 只有这两行、均为 `@v7`（其余 `@v4` 命中都在 `.claude/worktrees/*` 的历史副本，不进仓库、不进 VSIX）。

### 7. 打包产物

```text
node scripts/package-vsix.js --verify-only
VSIX contents match the allowlist (12 entries).

cmp 包内 payload vs 工作树：
SAME extension/readme.md            SAME extension/package.json
SAME extension/media/style.css      SAME extension/media/main.js
SAME extension/media/icon.svg       SAME extension/media/extension-icon.png
SAME extension/dist/seq-editor.js   SAME extension/dist/extension.js
```

包内 `dist/extension.js` = `793c27fa…`。`dist-vsix` 的产物时间（11:43）早于本轮 `src/`（12:53）与 `test/`（13:00）的最后修改，但这两类改动**不进包**；`media/main.js` 的内容已一致，所以 `dist-vsix` 仍然有效。已发布的 0.8.3 资产（`580cb097…`）与当前本地 VSIX 的差异只有 `media/main.js` 的新注释与两处 EOL（`package.json`、`style.css` 归一化后相等），**不影响已发布版本**，无需重发。

---

## 四、新发现（按严重度）

本轮**没有 P0/P1/P2**。草拟阶段列出的 P4-1…P4-4 已在最终工作树中整改，我逐条复核通过；下面保留编号与结论，并给出仍未关闭的两项。

### P4-1（已整改，已验证）`always-auth` 的删除原先归给了 v7，实际是 v6.1.0

`improvement.md:277` 现写“本工作流用到的输入（`node-version`、`cache: npm`）在 v4→v7 之间形状与默认值都没变；`package-manager-cache`（v5 新增、默认 `true`）只在 `package.json` 有 `packageManager`/`devEngines` 时才生效，本仓库两者都没有”。`:284` 另记正确归因（`v6.0.0` 仍有 `always-auth`，**`v6.1.0`** 才删除，PR #1436）。**我复核**：各 tag 的 `action.yml` 与 release notes 一致。

### P4-2（部分关闭；残留 P4）“差一”窗口已关闭，但“度量 + 边界同时错”仍存活

最终测试关掉了 `chars.length > NOTE_DETAIL_LIMIT + 1` 这格（实测红）。**残留**：`return last.length > NOTE_DETAIL_LIMIT + 1`（同时把度量换成码元、把边界放宽一格）仍 **4/4 绿**；此时 141 码点的纯 BMP 行不被截断。这是上一轮那条缺陷的**双重叠加**形态，比已关闭的单错形态窄得多，**不建议为它再压一轮**。若想顺手关掉，加 5 行即可（我已在副本验证：真实现绿、该变异红）：

```ts
const bmpOverByOne = "x".repeat(NOTE_DETAIL_LIMIT + 1); // 141 cp / 141 units
assert.equal(
  upstreamNoteDetail({ code: 128, stdout: "", stderr: bmpOverByOne }),
  "x".repeat(NOTE_DETAIL_LIMIT) + "…"
);
```

### P4-3（已整改，已验证）`𝄞`×145 那句的主语

最终注释写“a pure 145-code-point input (`𝄞`×145, which is also 290 UTF-16 units) comes out at 141 code points … and at 71 with a UTF-16 slice”，主语与数值都准确。`improvement.md:252` 本来就是准确表述。

### P4-4（已整改，已验证）产品源码不再引用评审档案

`src/ui/rebasePresentation.ts:7-21` 现在把五种实测形态直接写在注释里（commit-graph 损坏 exit 0、loose object 的 `fatal:` 在最后、unknown revision 的 `fatal:` 在最前且用法提示无标记、缺 alternates 是 `error:` 在前、两个损坏对象仍以 `fatal:` 收尾），不再出现 `docs/review/`。`grep -n "docs/review" src/ media/` → 无命中；`grep -c "code-review" dist/extension.js` → 0。

### P4-5（未整改，记录在案）`node-version: 20` 已过上游 EOL，依赖侧开始报 EBADENGINE

`nodejs/Release` 的 `schedule.json`：`v20` 的 `end` 是 **2026-04-30**（今天 2026-11-09 已过）；`v22` 到 2027-04-30，`v24` 到 2028-04-30。发布运行里 `@azure/abort-controller@2.2.0` 等已要求 `node >=22`，`npm warn EBADENGINE` 会持续出现。**本轮保留 20 是正确的**（任务明确要求，且 `scripts/run-tests.js` 的存在理由就是 Node 20 无 `node --test` glob），已记入 `improvement.md` 的 0.9.0 路线。**不阻塞本次提交。**

### 非缺陷观察（记录，不计入清单）

- **常量的值不被断言钉住**：`NOTE_DETAIL_LIMIT` 改成 139 或 145 后 4/4 仍绿（所有断言都相对该常量）。这是**有意为之**（140 是排版选择），`improvement.md` 已写明。
- **行尾**：LF/CRLF 混用是 `core.autocrlf=true` 且无 `.gitattributes` 的正常结果，提交时索引归一化为 LF，不产生 diff 噪声。
- **`dist-vsix/` 不在 git 跟踪内**（`git ls-files dist` 为空），不会误提交；下次发布前 `npm run package` 重建即可。

---

## 五、我没有验证的部分

1. **完整 324 项套件不是我跑的。** 按任务约束，另一个进程当时正在跑全量，我没有启动第二个。`improvement.md:278` 与账本里的“324 项 / 47 文件全绿”是 **A 的运行结果**；我只独立复核了**静态计数**（324/47）与**三处文档一致**。我自己的进程只跑了 `test/rebasePresentation.test.ts`（4/4）与 `test/webviewDom.test.ts`（13/13）。
2. **升级后的 release 工作流没有真正跑过。** 我验证的是 YAML 可解析、tag 存在、`runs.using`、输入形状、runner 下限、`node-version: 20` 的解析结果（取自**升级前**那次运行）。升级后第一次真实发布才会给出“告警消失、`npm ci`/`test:release`/打包/发布全部成功”的最终证据。
3. **`punycode` / `DEP0169` 告警是否随 v7 消失**：没有跑 CI，无法确认；只确认它们与本轮改动无关、也不构成失败。
4. **JSDOM 探针不等于真实 VS Code webview。** 我覆盖的是消息投递顺序、陈旧节点事件与重入；IME、拖拽、焦点行为不在本轮范围（`test/webviewDom.test.ts` 13/13 是现有最强证据）。
5. **`gh api` 读的是当前 GitHub 状态**：tag 列表、release notes、按 tag 取的 `action.yml`、latest runner 都是**评审时**的快照。
6. **没有验证已发布 0.8.3 资产的签名/发布元数据**，只做了逐条 payload 比对与 sha256 记录（`580cb097…`）。
7. **没有在其他平台（Windows/macOS runner）验证 Node 20 行为**：发布工作流只用 `ubuntu-latest`。
8. **没有独立验证 `improvement.md` / 账本里关于“B 已确认”的转述是否与我本意一致**——那些段落是 A 写的；我以本报告为准，若两者措辞有出入，以本报告为准。

---

## 六、给 A 的清单（全部 P4，不阻塞本次提交）

1. **（可选，5 行）** 加纯 BMP 141 夹具（§四 P4-2），关掉 `last.length > NOTE_DETAIL_LIMIT + 1` 这格双重错误窗口。
2. **（0.9.0，政策项）** 记录 `node-version: 20` 已于 2026-04-30 过 EOL；升到 22/24 时同步评估 `scripts/run-tests.js` 是否还需要手写枚举（`improvement.md` 已记）。
3. **（提交时必做，不是我做的）** 账本第 53 行把“（未提交）”换成真实 SHA；`0-8-21` 行保持不动。

---

## 七、裁决与覆盖范围（重述）

- **裁决：批准提交。** 6 个文件的最终内容**没有产品行为变化**（`src/` 只加 JSDoc、`media/` 删除的守卫已证明不可达、`.github/` 只换 `uses`），五条 P4 全部真实关闭，类型检查与 17 项定向用例绿，VSIX 12 条目、白名单通过、payload 与工作树逐字节相同。
- **`filteredCommits` 守卫删除：不会崩。** 静态唯一调用点 + 前置早退 + `state` 初值 `commits: []` + 无 await/动态调用；动态 7 路径 4 次调用、`undefined` 零命中、无未捕获异常。
- **Action 升级：成立。** v7 真实且当前，`node24` 运行时，`node-version: 20` 原样保留并实测解析到 20.20.2，本工作流使用的输入形状/默认值未变，runner `2.338.2` 满足最低版本。
- **覆盖范围**：本报告覆盖基线 `783dac7` 之上的**未提交工作树**（6 个修改文件，最终 sha256 见 §二.4）与 `dist-vsix/git-rebase-visual-0.8.3.vsix` 的当前内容。**这一轮不改变对已发布 0.8.3 的批准**（`code-review-0-8-20.md` / `0-8-21.md` 仍然有效）。提交之后，仍需由后续独立评审按**真实 SHA** 覆盖这次清理提交——本报告不能替代那一步。
