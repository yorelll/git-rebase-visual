# Git Rebase Visual — 代码评审报告（0.7.0）

> **评审基线**：`f4045ea9163014389ef0406cae4d56bd527d9ddf`（v0.6.3）。
>
> **本次覆盖提交**：`40d5dd3ceda710ba253c9624cc827af99b462f49` — `feat: implement 0.7 rebase interactions`。
>
> **输入与范围**：`pic_ref/review3/` 六张交互参考图、`pic_ref/review4/` 的原生 SCM/左右 Diff 参考图、三轮 `suggestion*.md`、0.5/0.6/0.6.2/0.6.3 UI 记录，以及本提交的实现、真实 Git 集成测试和构建结果。重点审查 selection/右键、搜索与 IME、SCM 文件操作、pointer/Alt reorder、rebase 暂停协议、生成 Diff、作者可访问性及测试可靠性。
>
> **结论**：发现 6 项 **P1 发布阻止问题**，没有发现新的 P0。当前 0.7.0 **不可发布**；必须修复 R70-1 至 R70-6，并由独立 reviewer 复核。SCM porcelain v2、路径边界、左右 Diff、批量 lock/drop 的 host 端重验等基础设计整体良好，但不能抵消下面的历史改写、Diff 选择语义和测试确定性问题。

---

## 1. 发布结论

- [ ] **不可发布。** R70-1 至 R70-6 必须完成实现、针对性回归测试和独立复核。
- [x] **未发现 P0。** 本次没有发现 pathspec 命令拼接、可伪造的 rebase todo、或未经 host 端完整 hash/current snapshot 校验即可直接开始历史重写的路径。
- [ ] **发布前人工验收仍必需。** 在真实 VS Code 中走查微软拼音/第三方 IME、鼠标/触控 pointer drag、编辑器点击关闭菜单、Staged/Changes/rename/delete 的左右 Diff 与确认文案，以及 High Contrast Dark/Light 和屏幕阅读器。Node 测试不能替代这些交互验收。

---

## 2. Findings

### R70-1 — P1：拖拽期间的 deferred refresh 丢弃了 drag session snapshot，旧手势会在新列表上重新解释并启动 rebase

- [ ] **未修复；发布阻止。**

**位置**：`media/main.js` 的 `startDrag()`、pointer/native drop handler、`endDrag()`、`reorder()`（约 353–443 行）。

**根因**：开始拖拽时已正确捕获 `revision` 和 `canonicalOrder`：

```js
drag = { sourceHash: c.hash, revision: state.canonicalRevision,
  canonicalOrder: [...state.canonicalOrder], ... };
```

但 pointer `pointerup` 与 native `drop` 都先调用 `endDrag(false)`；该函数会立即应用 `deferredState` 并 `render()`，清空 `drag` 后才调用 `reorder()`。`reorder()` 从**刷新后的** `state.canonicalOrder` 和 `state.canonicalRevision` 重新构造请求。因此捕获的旧 revision/order 实际从未用于消息。`src/ui/rebasePointerDragState.ts` 和它的测试验证的是另一套纯函数模型，不能证明实际 DOM 路径。

这与源码注释“preserving its revision guard”和 0.7 记录“deferred refresh…由 host revision/hash/lock 验证”不一致。host 会忠实验证这个被替换成新 revision 的请求，因而无法拒绝手势起点已过期的操作。

**复现**：

1. 在 A、B、C 均可重排的列表中，从 C 的 grip 开始 pointer 或 native 拖拽到 A 前。
2. 在按下到放开之间令宿主发送 `state`（外部 Git 改写、刷新 generation 改变，或更新 canonical order）；webview 将其存入 `deferredState`。
3. 放开 pointer / drop。`endDrag(false)` 先用新 state 替换旧 state，随后 post 的 `reorder` 带新 revision 和按新顺序算出的 order，而非开始手势时的 session。
4. 若 source/anchor hash 仍存在，host 会接受并显示确认；用户的旧手势可在不同的 canonical 顺序上改写不同范围的提交。

**必须修复**：

1. pointer、native DnD、keyboard 三条路径必须明确使用各自开始/触发时的 immutable canonical session；pointer/native drop 不得在构建并发送 intent 前应用 deferred state。
2. 更保守且可验证的方案是：drag 期间只要收到 generation/order 刷新即取消本次拖拽，提示“列表已刷新，请重新拖拽”；不得把旧 DOM target 解释成新列表操作。
3. host 必须继续以该原始 revision/full order 重新验证；过期请求必须在任何 confirmation/Git 写入前拒绝。
4. 增加实际 webview/DOM 协议回归：drag start → deferred state（相同 revision 增量及不同 canonical order）→ pointerup/native drop，断言 payload 保留旧 session 或根本不发送；并覆盖 host 的 stale rejection。纯 `pointerDropIntent()` 测试不能替代此路径。

---

### R70-2 — P1：右击未选中的行仍执行旧多选集合，危险批量操作的目标与鼠标目标不一致

- [ ] **未修复；发布阻止。**

**位置**：`media/main.js` 的 row `contextmenu` handler、`selectRow()`、`openMenu()`（约 387、393–407、457–480 行）。

**根因**：普通 click 会清空 `selectedHashes`，但右键事件只执行：

```js
openMenu(event.clientX, event.clientY, c, row);
```

它没有经过 `selectRow()`，也没有检查右击的 `c` 是否属于当前 selection。`openMenu()` 只要 `selectedHashes.size >= 2` 就显示多选菜单，`bulkLock`/`bulkDrop`/`bulkGenerateDiff` 直接发送旧的 `[...selectedHashes]`。

**复现**：

1. Ctrl/Cmd 点击 A、B，建立两项 selection。
2. 不左击 C，直接右击未选中的 C。
3. 菜单标题显示“已选择 2 个 commit”，批量删除/锁定/Diff 的目标是 A、B，而不是指针下的 C；随后用户面对的确认是一个与右击目标不一致的批量操作。

host 的 exact-hash 重验和 drop 的确认能减少最终损失，但不能修复该明显的目标错配，且违反本次“单 commit 右键以右击目标为准”的实现声明。

**必须修复**：

1. 右击未被选中的行时，原子地清空旧 selection、将该行作为 active/single target，再展示单项菜单；右击已选中的行可以保留当前多选集合。
2. 保持空白区域清选、正常左击只设置 active context、Ctrl/Cmd 多选的现有语义一致。
3. 添加 DOM 交互测试，至少覆盖上述 A+B→右击 C、右击已选行、空白清选、单项/多项菜单 payload 和批量菜单禁用项。

---

### R70-3 — P1：`stageFile` 与 `restoreFile` 是真实 Git 写入，却被协议错误标为 read/ui，绕过写入串行化和暂停策略审计

- [ ] **未修复；发布阻止。**

**位置**：`src/ui/webviewProtocolState.ts` 19–33 行；`src/ui/rebaseViewProvider.ts` 486–509、553–581、612–616、1984–2026 行。

**根因**：`webviewMessageIntent()` 把 `stageFile` 放入 `read` 集合，遗漏 `restoreFile`（于是它落入 `ui`）。但二者实际分别执行 `git add -A -- <path>`、`git restore`，或经确认后 `fs.rm()` 删除未跟踪文件。只有 intent 为 `mutation` 才会进入 `onMessage()` 的 `busy` 串行化和 paused-rebase mutation 判定。

暂停分支中声明的局部 `allowed` 集合包含 `stageFile`/`restoreFile`，但变量没有被使用；真正的 `allowedPausedRebaseMutation()` 只在 mutation classifier 命中时才生效。这使“允许 edit-stop 文件区的显式写入”成为意外 fall-through，而非可审计的 allow-list；Output 也会错误记录 `stageFile intent=read`、`restoreFile intent=ui`。

**复现**：

1. 对任何 working-tree 条目快速重复点击 `+`，或从 webview 连续发送两个 `stageFile`；两个 Git index 写入不会由 `busy` 串行化，可能竞争 index lock/状态刷新。
2. 在 rebase 暂停时发送 `restoreFile`。它不会经过 `pausedUnsafeMutation`；是否允许此 destructive action 完全取决于分类漏网，而非明确的 paused 写入策略。
3. 对纯函数断言 `webviewMessageIntent("stageFile") === "mutation"` 与 `webviewMessageIntent("restoreFile") === "mutation"`，当前均失败。

这不是要求在 edit stop 禁止 stage/restore；它们可以是有用且明确允许的操作。问题在于 Git 写入必须先被正确分类、串行化，并由明确 allow-list 决定暂停时是否可做。

**必须修复**：

1. 将所有会写 Git/index/worktree/磁盘的 webview action（至少 `stageFile`、`restoreFile`）分类为 `mutation`。
2. 用一个实际被调用的 paused-rebase policy 明确逐项允许/拒绝，并保留 edit stop 的 stage/restore 功能；不要依赖 classifier 漏网或未使用的 `allowed` 变量。
3. 将读取、scroll、pointer、selection、composition、refresh、toast、open Diff 保持为非 mutation，避免恢复此前的 warning spam。
4. 为 classifier 和 provider 路径补测试：合法的 paused stage/restore 不产生“unsafe” warning 但会被 busy 串行化；不在 allow-list 的写入会被阻止；所有上述非写入流量不产生 warning。

---

### R70-4 — P1：所谓“只读”生成 Diff 实际打开可编辑 untitled 文档

- [ ] **未修复；发布阻止。**

**位置**：`src/ui/rebaseViewProvider.ts` 的 `generateCommitDiffDocument()`，约 2083–2121 行。

**根因**：实现正确地重新验证完整选中 hash、按 oldest-first 拼接非连续选择、使用 `--binary --find-renames --no-ext-diff`，并标明截断；但最后调用的是：

```ts
vscode.workspace.openTextDocument({ language: "diff", content: output })
```

该 API 创建的是可编辑的 `untitled:` 文本文档，不是只读 virtual document。紧随其后的 toast “已生成只读 Diff 文档”与 0.7 记录的只读承诺不成立。用户可编辑内容、产生 dirty 状态并被提示保存，虽然不会直接改写 Git，但这不满足“生成 Diff 是只读快照”的要求。

**复现**：右击单一 commit 或多选后选择“生成 Diff…”；在打开的 untitled diff 编辑器中输入任意字符即可修改文档并使其 dirty。

**必须修复**：

1. 以扩展私有、受控的 `TextDocumentContentProvider` URI（或等价只读 API）提供精确生成时的 snapshot，而非 `openTextDocument({ content })`。
2. snapshot store 必须有 repository authority、TTL/LRU/cleanup，并冻结生成时的 output，不能在后续 Git 刷新后改变内容；可复用现有 opaque request-store 原则，但不可把 URI 参数当作未授权 Git 命令。
3. 保留单选、经连续性验证后按时间轴 oldest-first 的多选、binary/truncation 注记、stale selection 拒绝行为，并补 provider/host 测试，断言 URI 非 `untitled:`、文档不可编辑、非连续选择不会生成、过期 selection 不生成。

---

### R70-5 — P1：非连续多选仍会生成拼接 patch；“生成 Diff…”没有阻止语义不成立的选择

- [ ] **未修复；发布阻止。**

**位置**：`media/main.js` 的 `openMenu()` 多选菜单（约 457–475 行）；`src/ui/rebaseViewProvider.ts` 的 `generateCommitDiffDocument()`（约 2088–2121 行）。

**根因**：多选菜单只要 `selectedHashes.size >= 2`，就无条件启用“生成 Diff…”并发送整个集合。host 用 current snapshot 重新验证 hash 后执行：

```ts
const order = [...this.commits].reverse();
const selectedSet = new Set(selected);
const commits = order.filter((commit) => selectedSet.has(commit.hash));
```

它不验证 selected hashes 在 canonical timeline 中连续；随后逐个 `git show` 拼接。实现还专门写入“选择不是连续范围时，不包含中间未选择的 commit”的文案。这不是连续选择的 range diff，也不是一个可被误解为范围 diff 的安全替代：它向用户提供了一个名为“生成 Diff…”的单一工件，却允许用户以 1/2/4 选择得到仅含 1、2、4 的异构 patch stream。中间的 3 没有被悄悄纳入是必要但不充分的；靠文案声明“未包含”不能避免选择本身不成立及后续审阅/应用时的语义混淆。

**复现**：

1. 将时间轴中连续的四个 commit 记为 1、2、3、4（oldest-first）。选择 1/2，右键“生成 Diff…”；当前实现按 1、2 生成，连续选择应继续被支持。
2. 清空后选择 1/2/4，右键菜单中的“生成 Diff…”仍可点击，并发送三项 `bulkGenerateDiff`。
3. host 不检查 1/2/4 的索引空洞，生成只包含 1、2、4 的拼接输出；它不报错、不置灰、不要求用户修正选择，只在 header 中用一句“不包含中间未选择”的说明轻描淡写。

用户要求的产品语义是：多选“生成 Diff…”仅代表一个连续 commit 区间。对非连续选择，功能必须不可用而不是静默改为“若干离散 patch 的串接”。若今后需要导出离散 commit patch，应另设明确命名和独立确认的动作，不能复用 range-oriented 菜单项。

**必须修复**：

1. 用 canonical timeline order 判断多选 selected hashes 是否为一个无空洞的连续区间；单选必须仍可用，连续 1/2、2/3/4 等多选必须可用。
2. 非连续多选时，webview 中“生成 Diff…”必须 disabled，并给出简短原因，例如“仅支持连续 commit；请取消未连续选择或使用单项 Diff”。控制区若有同类入口也必须一致。
3. host 必须独立重复连续性验证，不能信任 webview disabled state；非连续或 stale selection 必须拒绝，且不得打开任何 document 或执行 Git 输出。
4. 将输出改为实际连续范围的明确语义/标题（例如显示首末 commit），或保留逐 commit 输出但只允许经连续性验证的集合；不得以“未包含中间 commit”的说明取代约束。
5. 加入 UI 与 host 测试：单选、连续两项、连续多项、非连续 1/2/4、无序 payload、stale selection。测试应断言非连续菜单 disabled 且 host 拒绝绕过 UI 的消息；连续路径必须按 timeline oldest-first 输出准确 commit 序列。

---

### R70-6 — P1：LLM deadline 测试确有 Windows/Undici forbidden-port 随机失败；本次偶然绿灯不能作为发布证据

- [ ] **未修复；发布阻止。**

**位置**：`test/llmClient.test.ts` 8–20 行的 `withServer()`。

**根因与证据**：测试以 `server.listen(0, "127.0.0.1")` 获取任意 ephemeral port，并将该 port 交给 Undici `fetch`。本环境 TCP dynamic range 为 **1024–15000**，其中包含 Fetch forbidden ports（例如 6667）。直接执行：

```text
fetch("http://127.0.0.1:6667")
→ TypeError: fetch failed
  cause: bad port
```

失败发生在发送 HTTP 请求之前，因此 deadline 测试会得到 `fetch failed: bad port` 而非期望的 `timed out`。这与 A 的 0.7 记录中“104/106、deadline 以 bad port 失败”的现象完全吻合；它是测试环境的真实随机 flaky，不是可按“与本次改动无关”忽略的发布例外。

本 reviewer 在相同 target worktree 中的这一次完整 `npm test` 得到 106/106，通过后又连续运行 LLM test 8 次也通过。这只能说明本轮随机端口恰好安全，**不能**消除端口 0 分配到 forbidden port 的机制或 A 已报告过的失败。

**必须修复**：

1. 修改 `withServer()` 使每次端口都确定性避开 Fetch forbidden-port 集合；例如监听后检查端口并在 forbidden 时关闭重试，或改用可控/mock fetch 测试传输层。不得依赖一次随机 `listen(0)`。
2. 该 helper 被六个 LLM 测试共享，修复必须覆盖全部调用点，而非只给 deadline case 加 skip/retry。
3. 新增针对安全/禁用端口策略的 regression，或把端口选择抽成可单测 helper；至少证明 deadline case 不会在请求前以 `bad port` 失败。
4. 修复后提供完整 `npm test` 的全绿结果及多轮 LLM 测试压力结果。不能再以 104/106 或“既有失败”作为 release evidence。

---

### R70-7 — P2：作者 dot 的 collision 规则依赖颜色，在 High Contrast 下仍会失去点内身份区分

- [ ] **延后实现，但发布前必须完成 High Contrast 人工验收。**

**位置**：`media/main.js` 的 `authorLabel()`（250–255 行）和 `media/style.css` 的 author palette/`forced-colors`（455–486 行）。

`authorLabel()` 只在“首字母相同 **且** palette key 相同”时升级为两个字符。两个不同作者若均以 L 开头而 palette key 不同，在普通主题看似借颜色区分；但 `forced-colors` 会把所有 dot 变为 `Canvas/CanvasText`，点内均只剩 `L`。行内完整作者文本和 title 仍提供辅助信息，因此这不是颜色作为唯一全行身份信息的 P0/P1 安全问题；但与“High Contrast 下同样可辨”和 collision 处理的要求不一致。

**建议**：按 author email/稳定 identity（而非 palette 相同）检测可见同 initial 的歧义，升级点内文本；在 High Contrast Dark/Light、屏幕阅读器中逐屏验证当前作者、非当前作者、同 initial、palette 碰撞的组合。

---

### R70-8 — P2：新增 webview 主路径主要由重复的 DOM 实现承载，纯函数测试不能覆盖 R70-1/R70-2/R70-4/R70-5 的真实协议

- [ ] **延后，但 R70-1 至 R70-5 修复必须随实现补齐对应的端到端/DOM 回归。**

`test/rebasePointerDragState.test.ts`、`test/webviewProtocolState.test.ts` 和 `test/commitSearch.test.ts` 对纯状态函数有价值；但 `media/main.js` 自行实现 pointer session、contextmenu selection、IME listener 和 payload，不调用这些 helpers。当前也没有生成 Diff readonly/provider 或连续 selection gate 的测试。因此单元绿灯不能证明 webview event handler、deferred refresh、host message 分类、Diff selection 语义或 VS Code document 形态正确。

建议为关键安全路径建立最小 DOM/webview harness，并为 host/provider 建立可替代 VS Code API 的集成测试；不要只复制纯函数逻辑来取得表面覆盖率。

---

## 3. 已审查且确认的实现

- [x] **SCM parser 与路径边界**：`git status --porcelain=v2 -z --untracked-files=all` 不按换行拆路径；stage 使用 argv 和 `--` pathspec；删除未跟踪文件先将 resolved path 限制在 repository 内。真实 Git 集成测试覆盖 modify/add/delete/rename/untracked、空格/方括号路径、RM、stage 和 staged/working restore 语义。
- [x] **SCM 呈现与左右 Diff 架构**：Staged Changes/Changes 分侧呈现，M/A/U/D/R 有文字/ARIA；worktree diff 使用公开 `vscode.diff` 与受控 opaque content request store，处理 empty/index/working/commit 版本和 binary fallback。stage/restore 还会在 host 端重新读取 status，并有 webview + host 的 destructive confirmation。
- [x] **selection/batch host 防线**：bulk lock/drop/Diff 的 full 40-char hash selection 会再次按当前 snapshot 验证；drop 在确认前后验证 lock 状态并使用一份 rebase plan。问题仅在 R70-2 的 webview 右键目标选择，不是 host 批处理本身缺失原子性。
- [x] **搜索与 IME 静态实现**：scoped whitespace、`hash:0x`、unknown prefix fallback 的 parser 合理；实际 search listener 在 composition 期间不 render，结束时只应用最终值，并对 editable/composing input 阻止全局重排快捷键。
- [x] **菜单关闭与 Push hint**：编辑器/selection/window 变化通过公开 VS Code window API 发送 `closeMenu`，subscriptions 由 extension context 管理；scroll 只关闭本地 DOM 菜单。Push confirmation 中原有无关的 LLM/SecretStorage migration hint 已移除。
- [x] **生成 Diff 的部分内容安全边界**：current snapshot revalidation、binary patch 标记和 2,000,000 字符截断提示正确；R70-4 否定其 document readonly 形态，R70-5 否定非连续多选的当前语义，但不否定这些内容生成边界。

---

## 4. 验证证据

所有命令均在目标 worktree `D:\work\tools\git plugin\.claude\worktrees\agent-a6fea5ad466242226`、提交 `40d5dd3ceda710ba253c9624cc827af99b462f49` 上独立执行。

| 命令 / 方法 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run compile` | 通过 |
| `npm test` | **106/106 通过**，约 372 秒 |
| `git diff --check f4045ea..40d5dd3` | 通过，无空白错误 |
| `node --check media/main.js` | 通过 |
| `npx tsx --test test/llmClient.test.ts` 连续 8 次 | 每次 6/6 通过；不能排除 R70-6 的随机 forbidden-port 分配 |
| Windows TCP dynamic port range | 1024–15000；覆盖 Fetch forbidden ports |
| `fetch("http://127.0.0.1:6667")` | `TypeError: fetch failed`，cause 为 `bad port`，确认 R70-6 的机制 |
| 源码/事件路径审查 | 复现 R70-1 至 R70-5：deferred drag 先应用 state、右击不更新 selection、write actions 错分 intent、generated Diff 使用可编辑 `untitled` 文档，且 1/2/4 非连续 selection 仍被无条件发送/拼接 |

`npm test` 的本轮绿灯是积极信号，但不能覆盖 R70-1/R70-2 的实际 DOM 事件路径，也不能使已证明的 R70-6 随机端口机制变为确定性测试。

---

## 5. 整改与独立复核要求

Agent A 应先阅读本报告，在其独立 worktree 修复 R70-1 至 R70-6，并创建对应版本化回复文件；不得修改本报告。提交独立复核时至少提供：

1. drag session 在 deferred refresh 下的真实 DOM/webview payload 与 host stale rejection 测试；
2. A+B 多选后右击未选 C、右击已选行、空白清选的 DOM 回归；
3. `stageFile`/`restoreFile` 正确 mutation classification、busy 串行化及 paused allow-list 的 provider/protocol 测试，同时证明 scroll/pointer/selection/IME/refresh 不告警；
4. 非 `untitled:` 的只读 generated-Diff provider 测试，覆盖单选、连续两项、连续多项按 timeline oldest-first 输出、1/2/4 非连续 selection 的 UI disabled 与 host 拒绝、无序 payload、stale selection、binary/truncation；
5. 无 forbidden port 的 LLM helper regression、完整全绿测试和多轮压力结果；
6. `npm run typecheck`、`npm test`、`npm run compile`、`git diff --check` 全部通过；
7. High Contrast Dark/Light 与屏幕阅读器的人工验收记录；
8. 独立 reviewer 对修复 commit 和版本化 response 的再次复核。