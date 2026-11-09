# Code Review 0-8-23 — 0.8.3 第十一轮复核（P4-1 至 P4-4 是否真关闭、bundle 是否仍逐字节不变、有没有夹带新缺陷）

- 评审日期：2026-11-09
- 评审角色：独立评审（Agent B，第十一轮）
- 基线 commit：`783dac7149eaaf2aef4ccd74d57a30f75658a51d`（`feat: release 0.8.3 — push notifications, restore-side protocol, option-injection hardening`）
- 被评审材料：基线之上的**未提交工作树**，`git diff --stat 783dac7` = **6 files changed, 101 insertions(+), 16 deletions(-)**：`.github/workflows/release.yml`、`docs/improvement/improvement.md`、`docs/review/code-review-commit.md`、`media/main.js`、`src/ui/rebasePresentation.ts`、`test/rebasePresentation.test.ts`；untracked 仅 `docs/review/code-review-0-8-22.md`（上一轮报告）。`git rev-list --count 783dac7..HEAD` = **0**，基线之后没有任何新提交，`783dac7` 仍是那种工作树的唯一基线。
- 本轮任务：上一轮（[`code-review-0-8-22.md`](code-review-0-8-22.md)）**批准提交**，另留 P4-1…P4-5 五项。维护者要求 A 修掉 **P4-1 至 P4-4**，P4-5（`node-version: 20` 已过 EOL）明确保留为 0.9.0 政策项且不阻塞。本轮验证：四项是否真关闭、bundle 是否仍为 `793c27fa…`（若变则说明夹带了行为改动）、有没有新缺陷、测试计数与账本是否与事实一致、VSIX 是否仍逐字节可复现。
- 顺序：先读 `code-review-0-8-22.md`（我自己的上一份报告，本轮回答其 §四 P4-1…P4-4），再读 `docs/review/code-review-commit.md`（覆盖账本）。
- **一个必须先说的事实**：本轮工作树的 6 个文件 sha256 **与 `code-review-0-8-22.md` §二.4 记录的完全一致**（逐项见 §二.3）。也就是说，P4-1…P4-4 的整改在我上一轮写报告之前（12:53–13:00）就已经落地，我已经在 0-8-22 里复核过一遍；本轮是**同一组字节上的第二次独立复核**，重点是换更强的探针（P4-2 的额外变异、P4-4 的五种 Git 形态重新实测、bundle 重建）。
- **约束遵守**：我只写了本文件。没有改 `src/`、`test/`、`media/`、`.github/`、`docs/`（除本文件）或仓库根目录；所有变异都在 `%TEMP%` 的副本里做（`node_modules` 用符号链接，不复制），副本与探针仓库已全部删除；**另一个进程正在跑完整套件，我没有启动第二个**；唯一被重写的是构建产物 `dist/extension.js`（跑 `node esbuild.js` 验证可复现性，重建后 sha256 仍 `793c27fa…`、`cmp` 逐字节相同）。我没提交、没打 tag、没 push、没 `git add`、没编辑账本。
- 环境：Windows 11 + MSYS Git `2.53.0.windows.2`，Node `v24.16.0`（`/d/Program Files/nodejs/node`），TypeScript `5.9.3`。action tag / release note / Node EOL 用 `gh api` 与 `nodejs/Release` 的 `schedule.json` 查询。仓库无 `.gitattributes`，`core.autocrlf=true`（`src/ui/rebasePresentation.ts` 工作树是 CRLF、基线 blob 是 LF，属正常归一化，无 diff 噪声）。

---

## 一、结论摘要

| 复核项 | 结论 |
| --- | --- |
| **P4-4**（产品源码不再引用 `docs/review/`，形态清单内联且准确） | **已关闭，且五种形态我全部用真实 Git 复现、逐条对得上**。`src/ui/rebasePresentation.ts:6-22` 把五种形态内联在 `REASON_LINE` 的 JSDoc 里；`grep -rn "docs/review" src/` → 无命中（exit 1）；`grep -rn "code-review" src/ media/ scripts/ package.json` → 无命中；`grep -c "code-review" dist/extension.js` = **0**、`grep -c "docs/review" dist/extension.js` = **0**。实测：commit-graph 损坏 **exit 0**（`error: commit-graph version 0 does not match version 1`）、loose object 的 `fatal:` **在最后**、unknown revision 的 `fatal:` **在最前**且随后两行用法提示**无标记**、缺 alternates 是 `error:` **在前**再 `fatal:`、两个损坏对象仍以 `fatal:` 收尾。把四种真实 stderr 灌进真函数，取到的分别正是注释描述的行（cp=98 / 138 / 92 / 54）。 |
| **P4-1**（`always-auth` 归因改成 v6.1.0，且写明本工作流从未使用） | **已关闭，且我用真实 tag 复核**。`actions/setup-node` 的 `action.yml`：`v6.0.0` **有** 2 处 `always-auth`，`v6.1.0` **0 处**，`v7.0.1`/`v7.1.0` **0 处**；`v6.1.0` release note 原文 `Remove always-auth configuration handling`（PR #1436），`v7.0.0` release note 是 ESM 迁移 / 依赖升级 / `cache-primary-key`+`cache-matched-key` 输出 / 去掉 dummy `NODE_AUTH_TOKEN`——与 `improvement.md:284` 的陈述逐条相符。“本工作流从未使用”成立：`release.yml` 的 `with:` 只有 `node-version` 与 `cache: npm`，`git log --all -p -- .github/workflows/release.yml \| grep always-auth` 零命中。原来那句错误归因已从 P3-9 的“流程项”（`improvement.md:277`）删掉，不是只在下面加一段反驳。 |
| **P4-2**（差一断言钉住 141 码点必须截断 `140 + …`） | **目标变异已关闭，但上一轮记录的“度量 + 边界同时错”残留仍在**。我复现 `chars.length > NOTE_DETAIL_LIMIT + 1` → **3 pass / 1 fail**，失败断言正是 `one code point over is truncated to the limit plus the ellipsis`（严格相等，`actual` 是无省略号的 141 码点原串、`expected` 是 `"a"×140 + "…"`）。`+5`、`+2`、`-1`、`>=` 以及切片侧 `slice(0,N+1)`、`slice(0,N-1)`、`last.slice(0,N)` 全部红。**残留**：`last.length > NOTE_DETAIL_LIMIT + 1`（把度量换成 UTF-16 码元、同时把边界放宽一格）仍 **4/4 绿**；等价的 `last.length >= NOTE_DETAIL_LIMIT + 2` 也仍绿。这与 0-8-22 §四 P4-2 记录的**是同一格**，不是新出现的，也未在本轮关闭（最后那 5 行纯 BMP 141 夹具没有加）。**不阻塞**，见 §四。 |
| **P4-3**（测试注释主语：141/71 是输出长度，不是输入长度） | **已关闭，数值我独立复算**。`test/rebasePresentation.test.ts:97-107` 现写“a pure 145-code-point input（`𝄞`×145, which is also 290 UTF-16 units）comes out at 141 code points with the correct implementation and at 71 with a UTF-16 slice”。实测：输入 `𝄞`×145 = **145 码点 / 290 码元**；正解输出 **141 码点**；UTF-16 切片输出 **71 码点**（141 码元）。补充的判别力主张也对：纯 astral 串的 140 码元前缀**不含**孤立代理（`lone=false`），混合串的 140 码元前缀**含**孤立代理（`lone=true`）。 |
| **是否引入新缺陷** | **没有**。`src/ui/rebasePresentation.ts` 去掉注释后与基线**逐字符相同**（`COMMENT-ONLY: stripped sources identical`）；`media/main.js` 去注释后与基线的**唯一**差异就是上一轮已审的 `filteredCommits` 守卫删除（`(state.commits ?? []).filter(...)` → `state.commits.filter(...)`），其唯一调用点 `:367` 仍在 `renderList` 的 `if (!commits.length) { …; return; }` 之后；`release.yml` 只换两行 `uses` 加一段注释；其余是文档/账本。 |
| **bundle 是否仍为 `793c27fa…`** | **是，逐字节相同**。工作树 `dist/extension.js` sha256 = `793c27fa035270698ce1aa0731faa7c7ed59969059f666961be51b780517f50a`；跑 `node esbuild.js` 重建后 sha256 **不变**，`cmp` 通过。结合上面的“去注释后源码相同”，可以断定 `src/` 的改动**纯 JSDoc、零行为变化**。 |
| **测试计数与文档** | **324 项 / 47 个文件**，静态枚举（`grep -cE '^test\('`）逐文件加总一致；`RELEASE.md:136`、`docs/summary/summary.md:150`、`docs/release-notes/0.8.3.md:44`、`docs/improvement/improvement.md:264`/`:278` 全是 324，`improvement.md:278` 另写“47 个文件”“本轮条数不变”。`test/rebasePresentation.test.ts` 仍是 **4 条**（新断言并入既有用例），`test/webviewDom.test.ts` 仍是 **13 条**。 |
| **账本行是否准确、是否写了不存在的 SHA** | **准确**。`code-review-commit.md:53` 的 SHA 列是 **“（未提交）”**，正文写明“SHA 由维护者在提交时填入（本行不写臆造的 SHA）”；该行**不含任何 40 位十六进制串**（`grep -oE '\b[0-9a-f]{40}\b'` 零命中），不存在“账本声称了一个不存在的 commit”的情况。该行引用的 `code-review-0-8-22.md` 存在。 |
| **VSIX** | **12 个条目、白名单通过、payload 与工作树逐字节相同**。`node scripts/package-vsix.js --verify-only` → `VSIX contents match the allowlist (12 entries).`；解包后逐个 `cmp`：`readme.md`、`package.json`、`media/{style.css,main.js,icon.svg,extension-icon.png}`、`dist/{seq-editor.js,extension.js}` 全部 **SAME**；包内 `dist/extension.js` = `793c27fa…` = 现场重建结果。 |
| **P4-5 是否按事实记录、是否明确不阻塞** | **是**。`improvement.md:289` 的复选框是 **`[ ]`**（未勾），写明“**0.9.0 政策项，本轮不改**”“**这一条不阻塞本次提交**”；EOL 日期与 `nodejs/Release/schedule.json` 完全一致（见 §三.5）。 |

### 裁决：**可以提交并 push；四项已关闭，bundle 未变，没有新缺陷**

**我建议提交这 6 个文件，并在同一提交里把账本第 53 行的“（未提交）”换成真实 SHA。** 依据：

1. **P4-1、P4-3、P4-4 三条都用真实外部事实关闭**：setup-node 各 tag 的 `action.yml` 与 release note、Node 的数值复算、五种 Git 形态的真实采集。不是“文档里写了就算”，是我自己拉回来的字节。
2. **P4-2 的目标变异确实被钉死**：`chars.length > 140 + 1` 红，且失败断言是专门为这条夹具写的那句；`+2`/`+5`/`-1`/`>=` 与三种切片错法也全红。残留只在“度量与边界同时错”这一格，上一轮已记录、维护者明确选择不加那 5 行，本轮不因此阻塞。
3. **产品行为零变化有两条独立证据**：源码去注释后与基线相同；bundle 重建后 sha256 不变。两者互相印证，不是同一条证据换个说法。
4. **没有夹带**：`media/` 的唯一语义差异是已审的守卫删除，`release.yml` 只换 `uses`，其余全在文档/账本/测试里。

---

## 二、我实际跑了什么（以及没有跑什么）

### 2.1 类型与定向用例（工作树本体）

```text
node node_modules/typescript/bin/tsc --noEmit                      → exit 0，零输出
node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit → exit 0，零输出

node node_modules/tsx/dist/cli.mjs --test --test-concurrency=3 test/rebasePresentation.test.ts
ℹ tests 4   ℹ pass 4   ℹ fail 0   ℹ skipped 0

node node_modules/tsx/dist/cli.mjs --test --test-concurrency=3 test/webviewDom.test.ts
ℹ tests 13  ℹ pass 13  ℹ fail 0   ℹ skipped 0
```

**完整 324 项套件不是我跑的**：另一进程正在跑，按约束我没有启动第二个（见 §五）。

### 2.2 变异副本

在 `%TEMP%` 下建副本（`cp -r src test tsconfig*.json package.json`，`node_modules` 用**符号链接**指回仓库），先跑基线 **4/4 绿**确认副本可用，再逐条变异。每次变异后都把原文件 `cp` 回副本并核对 sha256 = `482c058f…`。**工作树从未被这些变异触碰**；副本最后整体删除（`ls -d /tmp/rv23` → No such file or directory）。

### 2.3 工作树 sha256（与 0-8-22 §二.4 逐项相同）

```text
482c058f…  src/ui/rebasePresentation.ts
1b9d762b…  test/rebasePresentation.test.ts
5bb9e540…  media/main.js
0d2a342d…  .github/workflows/release.yml
bebea1f6…  docs/improvement/improvement.md
793c27fa…  dist/extension.js（node esbuild.js 重建后不变，cmp 通过）
```

这组哈希与上一份报告记录的完全一致，说明本轮复核的字节就是 0-8-22 批准的那组，整改在这两份报告之间没有被再次改动。

---

## 三、逐项验证

### 3.1 P4-4 — 产品源码不引用评审档案，五种形态内联且准确

**分层检查**：

```text
grep -rn "docs/review" src/                              → 无命中（exit 1）
grep -rn "code-review" src/ media/ scripts/ package.json  → 无命中（exit 1）
grep -c "code-review" dist/extension.js                   → 0
grep -c "docs/review" dist/extension.js                   → 0
```

`src/ui/rebasePresentation.ts:6-22` 现在是自足的 JSDoc，不再指向 `docs/review/` 或 `docs/improvement/`。

**五种形态的真实复现**（Git `2.53.0.windows.2`，临时仓库，已删除）：

| 形态 | 实际 stderr / 退出码 | 注释里的说法 | 判定 |
| --- | --- | --- | --- |
| `commit-graph` 损坏 | `error: commit-graph version 0 does not match version 1`，**exit 0**，仍打印 `0\t1` | “exits 0 and never reaches this code” | 准确 |
| 损坏 loose object | `error:` ×2 → `fatal: loose object … is corrupt`，exit 128 | “prints `fatal:` last” | 准确 |
| unknown revision | `fatal: ambiguous argument …` → `Use '--' …` → `'git <command> …'`，exit 128 | “`fatal:` first with the trailing usage hint untagged” | 准确（用法提示两行都不以 `fatal:`/`error:` 开头） |
| 缺 alternates（备用对象库被删除） | `error: unable to normalize alternate object path …` ×3 → `fatal: ambiguous argument …`，exit 128 | “`error:` first and then `fatal:`” | 准确 |
| 两个损坏对象 | `error:` ×4 → `fatal: loose object … is corrupt`，exit 128 | “still end on `fatal:`” | 准确 |

我把四种真实 stderr 直接灌进真 `upstreamNoteDetail()`，取到的行分别是：unknown revision → `fatal: ambiguous argument …`（cp=98）、两个损坏对象 → `fatal: loose object …`（cp=138）、缺 alternates → `fatal: ambiguous argument …`（cp=92）、commit-graph → `error: commit-graph version 0 …`（cp=54）。**注释描述与函数行为一致**。

**一处仅措辞层面的收窄（不是缺陷）**：如果把 alternates 指向一个**不存在**的路径，Git 只打印一行 `error: unable to normalize alternate object path` 并以 **exit 0** 结束，根本到不了 `fatal:`；只有“备用对象库曾存在、后来被删/不可读，且缺的正是要用的对象”这种形态才会 `error:` → `fatal:`。注释的 “missing alternates print `error:` first and then `fatal:`” 覆盖了后者、没覆盖前者。由于这段注释的用途是**证明“没有真实形态在 `fatal:` 之后再打印标记行”**，而两种变体都**不在 `fatal:` 之后**，结论不受影响；只是别把这句话读成“任何 alternates 故障都会走到 `fatal:`”。记为观察，不是条目。

### 3.2 P4-1 — `always-auth` 归因 v6.1.0

```text
actions/setup-node action.yml 中 `always-auth` 命中数：
  v6.0.0 → 2
  v6.1.0 → 0
  v7.0.1 → 0
  v7.1.0 → 0
```

`v6.1.0` release note：`Remove always-auth configuration handling by @priyagupta108 in …/pull/1436`。
`v7.0.0` release note：ESM 迁移（#1574）、依赖升级、`cache-primary-key`/`cache-matched-key` 输出（#1577）、去掉 dummy `NODE_AUTH_TOKEN`（#1558）——与 `improvement.md:284` 逐条相符。

“本工作流从未使用”成立：`release.yml` 的 `with:` 只有 `node-version: 20` 与 `cache: npm`；`git log --all -p -- .github/workflows/release.yml | grep always-auth` 零命中。原错误句已从 P3-9 的“流程项”（`improvement.md:277`）删除，现在全文件只有 `:284` 一处提到 `always-auth`，且是纠正后的说法。

### 3.3 P4-2 — 差一断言的判别力

副本内逐条变异（每次只改一处，跑完 `cp` 回原文件并核对 sha256）：

| 变异 | 结果 |
| --- | --- |
| `chars.length > NOTE_DETAIL_LIMIT + 1`（任务指定的那个） | **红**，3 pass / 1 fail，`AssertionError: one code point over is truncated to the limit plus the ellipsis` |
| `chars.length > NOTE_DETAIL_LIMIT + 2` | 红（同一断言） |
| `chars.length > NOTE_DETAIL_LIMIT + 5` | 红（同一断言） |
| `chars.length > NOTE_DETAIL_LIMIT - 1` | 红 |
| `chars.length >= NOTE_DETAIL_LIMIT` | 红 |
| 切片 `chars.slice(0, NOTE_DETAIL_LIMIT + 1)` | 红（`limit plus the ellipsis`） |
| 切片 `chars.slice(0, NOTE_DETAIL_LIMIT - 1)` | 红（`limit plus the ellipsis`） |
| 切片 `last.slice(0, NOTE_DETAIL_LIMIT)`（UTF-16 码元切） | 红 |
| 完全截断（`return last;`） | 红（`limit plus the ellipsis`） |
| 截断但丢省略号 | 红（`limit plus the ellipsis`） |
| **`last.length > NOTE_DETAIL_LIMIT + 1`（度量 + 边界同时错）** | **绿 4/4（残留）** |
| **`last.length >= NOTE_DETAIL_LIMIT + 2`（等价写法）** | **绿 4/4（残留）** |

最后两行是**同一格**：`overByOne = "a"×140 + 𝄞` 是 142 码元，`142 > 141` 为真，于是走截断分支、`chars.slice(0,140)` 正好给出期望的 `"a"×140 + "…"`，所以绿。要杀它必须有一条**纯 BMP 的 141 码点/141 码元**夹具（`"x".repeat(141)`），而那样输入下 `141 > 141` 为假、不截断，才会与期望的截断结果冲突。这正是我在 0-8-22 §六 第 1 条给出的 5 行建议，本轮**没有**加，因此该残留原样保留。**它不是本轮引入的新问题**，0-8-22 §四 P4-2 已经把它记录为“残留 P4，不建议再压一轮”，`code-review-commit.md:53` 也只说“差一夹具已补、实测 `+1` 即红”，没有声称这一格已关闭。

我也确认了一个**看起来像残留但其实是等价实现**的写法：`chars.length >= NOTE_DETAIL_LIMIT + 1` 绿，但它与正确实现的判定边界完全相同（141 >= 141 截断、140 >= 141 不截断），属于**等价而非存活**，不算变异体。

### 3.4 P4-3 — 注释主语与数值

```text
输入  𝄞×145                → 145 码点 / 290 码元
正解输出                    → 141 码点（140 + …）
UTF-16 切片输出             →  71 码点 / 141 码元
codePointLimit = a×139+𝄞   → 140 码点 / 141 码元
overByOne      = a×140+𝄞   → 141 码点 / 142 码元
140 码元前缀的孤立代理检查：纯 astral → false；混合串 → true
```

注释现在把 145 / 290 明确标成**输入**，把 141 / 71 明确标成**输出**（正解 vs 切片），并保留“纯 astral 上不触发的是孤立代理断言、长度断言仍会杀”这一正确区分。与 `improvement.md:252` 的表述一致。

### 3.5 P4-5 — 记录与事实

`nodejs/Release/schedule.json`（评审时拉取）：
```text
v20  start 2023-04-18  end 2026-04-30
v22  start 2024-04-24  end 2027-04-30
v24  start 2025-05-06  end 2028-04-30
```
与 `improvement.md:289-290` 写的三个日期**完全一致**；复选框为 `[ ]`，正文两次写明“不阻塞本次提交”。`node-version: 20` 在 `release.yml` 中一字未动。

### 3.6 bundle 不变与“无夹带”的证据链

**证据一（源码层）**：把 `git show 783dac7:src/ui/rebasePresentation.ts` 与工作树文件都去掉注释块与整行 `//` 注释、去空行、trim 后比较 → **完全相同**（脚本输出 `COMMENT-ONLY: stripped sources identical`）。所以 `src/` 的 18 行新增全是 JSDoc。

**证据二（产物层）**：`node esbuild.js` 重建 → sha256 `793c27fa035270698ce1aa0731faa7c7ed59969059f666961be51b780517f50a`，与重建前 `cmp` 逐字节相同。若有人偷偷改了逻辑，esbuild 的输出几乎必然变化，两条证据会打架；现在两条互相印证。

**证据三（非 src 的语义差异）**：`media/main.js` 去注释后与基线比较，**唯一**差异是 `filteredCommits()` 去掉了 `?? []`（`media/main.js:305`）。唯一调用点 `:367` 在 `renderList`（`:355`）内，且在 `if (!commits.length) { …; return; }` 之后——与上一轮用 7 条动态路径证明“不可达”的结论一致，本轮静态复核仍成立（`grep filteredCommits` 只有 `:305` 定义与 `:367` 调用两处）。`release.yml` 只把两行 `uses` 换成 `@v7` 并加了一段注释，`node-version: 20`、`cache: npm` 与其余步骤一字未改。

### 3.7 测试计数、文档与账本

- 静态计数：47 个 `test/*.test.ts`，逐文件 `^test\(` 加总 = **324**。
- 文档四处一致：`RELEASE.md:136` = 324、`docs/summary/summary.md:150` = 324、`docs/release-notes/0.8.3.md:44` = 324、`improvement.md:264`/`:278` = 324（并注明“条数不变”“47 个文件”）。
- 定向运行：`rebasePresentation` 4/4、`webviewDom` 13/13，与 `improvement.md:278` 的“17/17”一致。
- 账本第 53 行：SHA 列为“（未提交）”，正文明确不写臆造 SHA，**不含 40 位十六进制串**；引用的 `code-review-0-8-22.md` 存在；“P4-1/2/3/4 已改完、P4-5 记入 0.9.0”与工作树一致。

### 3.8 VSIX

```text
node scripts/package-vsix.js --verify-only
→ VSIX contents match the allowlist (12 entries).
```
解包 `dist-vsix/git-rebase-visual-0.8.3.vsix` 后 12 个条目，8 个 payload 文件逐个 `cmp` 全部 **SAME**；包内 `dist/extension.js` sha256 = `793c27fa…`。`dist-vsix/` 被 `.gitignore:11` 忽略（`git check-ignore` 命中），不会误提交。

---

## 四、新发现（按严重度）

本轮**没有 P0/P1/P2，也没有新缺陷**。只有一条**沿用上一轮、仍未关闭**的 P4，和两条观察。

### P4（沿用 0-8-22 §四 P4-2，未关闭，不阻塞）`last.length > NOTE_DETAIL_LIMIT + 1` 仍存活

- 现象：把度量换成 UTF-16 码元、同时把边界放宽一格，整个文件仍 4/4 绿；此时一条**纯 BMP 的 141 码点行不会被截断**。
- 为什么本轮的 `overByOne` 夹具关不掉它：`overByOne` 是 142 码元，`142 > 141` 为真，恰好走了截断分支并给出正确结果。
- 关闭方法（与上一轮相同，5 行）：加一条 `const bmpOverByOne = "x".repeat(NOTE_DETAIL_LIMIT + 1);`（141 码点/141 码元），断言输出恰为 `"x"×140 + "…"`。
- **判定**：这是“双重叠加”的窄窗口，维护者上一轮已明确选择不加，且它不影响今天的任何用户可见行为（实现本身正确）。**不阻塞本次提交**；若 0.9.0 顺手清理，按上面 5 行即可。

### 观察 1（不计入清单）`improvement.md:284` 的“上一段已按此改写”指代略显模糊

`:277`（P3-9 流程项）确实已删掉错误的 `always-auth` 归因，`:284`（P3-10 P4-1）说“上一段已按此改写”在文意上成立，只是两次整改之间隔了一个小节标题，粗读会以为指 `:283`。纯行文，不影响事实。

### 观察 2（不计入清单）`src/git/pushGuard.ts:44` 仍引用 `docs/improvement/improvement.md`

`grep -rn "docs/review" src/` 零命中（P4-4 的目标已达成），但 `pushGuard.ts` 的注释里有一处 `docs/improvement/` 引用，`scripts/run-tests.js:25` 也引用了 `docs/research/`。两者**都是基线 `783dac7` 就存在的**（`git show 783dac7:src/git/pushGuard.ts` 同一行；两个文件本轮均未修改），且 `docs/improvement/`、`docs/research/` 是**活文档**而非不可修改的审计快照，与 P4-4 针对的 `docs/review/` 不是一回事。P4-4 的验收口径就是 `docs/review`，因此不构成未关闭项。

---

## 五、我没有验证的部分

1. **完整 324 项套件不是我跑的。** 按约束另一进程正在跑全量，我没有启动第二个。文档与账本里的“324 项 / 47 文件全绿”是 A 的运行结果；我独立复核的是**静态计数**（324/47）、**四处文档一致**，以及 `rebasePresentation`（4/4）与 `webviewDom`（13/13）两个定向文件。
2. **升级后的 release 工作流仍未真实跑过。** 我确认了 YAML 结构、两个 `@v7` tag 存在且 `runs.using` 为 `node24`、`node-version: 20` 未改动；但“告警消失、`npm ci`/`test:release`/打包/发布全部成功”要等升级后第一次真实发布才有最终证据。
3. **P4-4 的五种形态是在 Git 2.53.0.windows.2 上采的**，项目声明下限 **2.31.0** 的 stderr 措辞（尤其用法提示）没有实测；注释里“形态”这层结构大概率稳定，逐字措辞不保证。
4. **`docs/review/code-review-0-8-23.md` 尚未进入账本。** 按任务约束我没有编辑 `docs/review/code-review-commit.md`。项目规则要求“完成评审后在同一个变更里追加台账行”，所以**需要维护者在提交前为本报告补一行**（SHA 列同样先写“（未提交）”，提交时换成真实 SHA）。这不是我能在本轮代做的动作。
5. **没有验证已发布 0.8.3 资产的签名/发布元数据**，只做了本地 VSIX 的 12 条目、白名单与逐字节 payload 比对。
6. **没有独立验证 `improvement.md` / 账本里关于“B 已确认”的转述是否与我本意逐字一致**——那些段落是 A 写的；我以本报告为准，若措辞有出入，以本报告为准。

---

## 六、给 A 的清单（全部 P4，不阻塞本次提交）

1. **（可选，5 行）** 加纯 BMP 141 夹具，关掉 §四 那条 `last.length > NOTE_DETAIL_LIMIT + 1` 的残留。上一轮已提过，维护者选择不加，本轮维持“可选”。
2. **（提交时必做，不是我做的）** 把账本第 53 行的“（未提交）”换成真实 SHA；并**为本报告 `code-review-0-8-23.md` 追加一行**（同样先“（未提交）”，提交时填 SHA）。
3. **（0.9.0，政策项）** `node-version: 20` 已于 2026-04-30 过 EOL，升 22/24 时同步评估 `scripts/run-tests.js` 是否还要手写枚举（`improvement.md:289-290` 已记）。

---

## 七、裁决与覆盖范围（重述）

- **裁决：批准提交并 push。** 四项全部关闭且我用独立证据复核：P4-1 用 setup-node 各 tag 的 `action.yml` 与 release note；P4-3 用数值复算；P4-4 用五种真实 Git 形态；P4-2 用 11 种变异，目标变异与 `+2`/`+5`/`-1`/`>=`/三种切片错法全红。
- **bundle 未变**：`793c27fa…`，`node esbuild.js` 重建后逐字节相同；且 `src/` 去注释后与基线逐字符相同——两条独立证据共同证明 `src/` 只是 JSDoc。
- **没有新缺陷**：`media/` 的唯一语义差异是已审的不可达守卫删除，`release.yml` 只换 `uses`，其余在文档/账本/测试里。
- **未关闭的唯一一项是沿用上一轮的 P4 残留**（`last.length > NOTE_DETAIL_LIMIT + 1`），维护者已明确选择不加那 5 行，**不阻塞**。
- **覆盖范围**：本报告覆盖基线 `783dac7` 之上的未提交工作树（6 个修改文件，sha256 见 §二.3，与 0-8-22 记录相同）与 `dist-vsix/git-rebase-visual-0.8.3.vsix` 的当前内容。**这一轮不改变对已发布 0.8.3 的批准**（`code-review-0-8-20.md` / `0-8-21.md` 仍然有效）。提交之后，仍需由后续独立评审按**真实 SHA** 覆盖这次清理提交——本报告不能替代那一步。
