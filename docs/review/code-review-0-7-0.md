# Git Rebase Visual — 代码评审报告（0.7.0）

> **评审基线**：`f4045ea9163014389ef0406cae4d56bd527d9ddf`（已发布 v0.6.3）。
>
> **最终覆盖的候选提交**：
>
> 1. `499dfc1053f69a392bbf0da72b7fe2df2dab37fc` — `feat: implement 0.7 rebase interactions`；
> 2. `2711b66681ca20e530a94651a1dca702234de12f` — `fix: address 0.7 interaction review findings`；
> 3. `ee85a85c208a44a491e6b228415362bd45c4025c` — `fix: complete LLM safe port policy`；
> 4. `715234af9794d369fae724620e299a371741dd41` — `fix: align LLM ports with Fetch standard`。
>
> 四个重建后的**功能实现**提交逐字节等价于已独立评审的原始实现/整改提交 `40d5dd3`、`ed9c11c`、`147f76b`、`371aafb`；仅因从已发布 `origin/main` 线性重建而使用新的 SHA。发布准备另包含本报告及版本文档、generated-Diff 注释准确性修正和一条 staged-restore 回归断言，均在本次本地门禁和最终独立审查中复核。此报告将内部审查轮次的发现和证据统一归档为未发布版本 **0.7.0**，不代表存在或发布过 0.7.1 / 0.7.2。
>
> **范围**：review3/review4 参考图与建议、selection/右键、中文 IME 搜索、SCM 文件级 stage/restore 与左右 Diff、pointer/native/Alt reorder、暂停 rebase 协议、只读 generated Diff、作者 High Contrast 文本区分、LLM Fetch bad-port test transport、VSIX 发布边界。
>
> **最终结论**：**自动化实现审查通过。** 初始评审发现的 R70-1 至 R70-6、复核发现的 R71-1 和 R72-1 均已修正并由不同于实现者的独立 reviewer 复核；最终安全端口修正也已独立核验。未发现剩余 P0/P1 自动化发布阻止问题。真实 VS Code 的 IME、指针/触控、SCM、High Contrast 和 screen reader 人工验收，以及本次发布门禁，仍是实际发布前必须如实执行的边界，不能由 Node/jsdom 或历史审查结果替代。

---

## 1. 发布裁决

- [x] **自动化审查通过。** R70-1 至 R70-6、R71-1、R72-1 全部修正，最终候选内容已与独立评审过的实现逐字节核对一致；是否实际发布仍取决于下列人工验收和最终发布门禁。
- [x] **未发现 P0/P1。** 未发现可伪造的 rebase todo、未经完整 hash/current snapshot 校验的历史重写、pathspec shell 拼接、可编辑的 generated Diff，或 Fetch 禁用端口导致的 LLM 测试随机失败残留。
- [ ] **发布前人工验收仍必需。** 必须在真实 VS Code 中走查微软拼音/第三方 IME、鼠标和触控/触笔 pointer drag、编辑器区域关闭菜单、Staged/Changes 的 rename/delete/untracked stage/restore/Diff、High Contrast Dark/Light 和屏幕阅读器。以下自动化批准不替代这些运行时验收。

---

## 2. 发现、整改与独立复核

### R70-1 — P1：deferred refresh 可能让旧 drag 手势按新列表重解释

- [x] **已修正并独立复核。**

**初始问题**：pointer/native drop 在发送重排 intent 前先应用 `deferredState`，导致开始拖拽时捕获的 revision 和 canonical order 被刷新后的列表替换；host 会验证错误的“新”请求，无法拒绝旧手势。

**最终实现**：`media/main.js` 在 pointer/native drop 应用 deferred state 前，以 drag session 的 immutable `{ sourceHash, revision, canonicalOrder }` 构造完整 `reorder` payload；键盘 Alt 路径也使用触发时的 canonical session。host 的 `validateReorderRequest()` 继续在确认和 Git 写入前重验完整 revision/order/lock。

**独立证据**：实际 jsdom webview 回归覆盖 pointer start → deferred changed order/revision → pointerup 与 native dragstart → deferred state → drop，断言 payload 保留旧 session，而不是刷新后的 state。

### R70-2 — P1：右击未选行可能执行旧多选集合

- [x] **已修正并独立复核。**

**初始问题**：A+B 多选后直接右击未选 C 时，菜单仍以 A+B 作为批量操作目标，与鼠标所在行不一致。

**最终实现**：`selectContextTarget()` 统一供鼠标 contextmenu 和键盘 Context Menu/Shift+F10 使用：右击未选行先清空旧 selection 并建立 C 的 single target；右击已选行才保留当前 batch。

**独立证据**：DOM 回归覆盖 A+B → 右击 C、右击已选行、单项/批量 action payload、空白 contextmenu 清选及批量菜单禁用项。

### R70-3 — P1：stage/restore 实际写 Git 却绕过 mutation gate

- [x] **已修正并独立复核。**

**初始问题**：`stageFile` 被错分为 read、`restoreFile` 落为 ui，因而绕过 busy 串行化和 paused-rebase policy；停靠中的允许行为来自分类漏网而非可审计 allow-list。

**最终实现**：`src/ui/webviewProtocolState.ts` 将两者归类为 `mutation`；`mutationGateDecision()` 先处理 busy，再按明确的 `allowedPausedRebaseMutation()` 放行 edit stop 文件操作。read/UI traffic 保持无告警。

**独立证据**：protocol 和 mutation gate tests 覆盖分类、paused allow-list、busy serialization、unsafe reorder 拒绝和 scroll/pointer/selection/IME/refresh/toast/open Diff 的无 warning 行为。

### R70-4 — P1：生成 Diff 曾使用可编辑 `untitled:` 文档

- [x] **已修正并独立复核。**

**初始问题**：`openTextDocument({ content })` 创建可编辑、可 dirty 的 `untitled:`，与“只读 snapshot”承诺冲突。

**最终实现**：新增 `GeneratedDiffProvider` 与 `GeneratedDiffSnapshotStore`，注册 `git-rebase-visual-generated-diff:` 私有 provider。URI 只有随机 opaque token，不含 repository/ref/path/Git command；store 在生成时复制冻结 content，并具有 repository invalidation、10 分钟 TTL、64-entry LRU 与 extension dispose cleanup。

**独立证据**：provider/snapshot 测试断言非 `untitled:` URI、内容冻结、opaque repository scope、TTL/LRU/cleanup；extension 注册及 host 调用路径也已复核。

### R70-5 — P1：非连续多选曾生成离散 patch 拼接

- [x] **已修正并独立复核。**

**初始问题**：选择 1/2/4 时菜单仍可生成仅含 1、2、4 的 patch stream，虽不悄悄纳入 3，但不符合“一个连续 commit 区间”的产品语义。

**最终实现**：`generatedDiffCommits()` 仅接受完整当前 hash 的无空洞连续区间，并标准化为 oldest-first。webview 对非连续多选禁用“生成 Diff…”并提供可访问原因；host 在任何 Git 输出或 document opening 前独立拒绝 gapped/unknown/duplicate/stale payload 和 revision 不匹配。

**独立证据**：状态与 jsdom tests 覆盖 single、连续两项、多项、无序连续 payload、1/3 空洞、unknown/duplicate、revision 改变、UI disabled 和无 host message 发送。

### R70-6 / R71-1 / R72-1 — P1：LLM HTTP tests 的 Fetch bad-port 策略曾不完整

- [x] **已修正并经两轮后续独立复核。**

**初始问题**：Windows 动态 TCP 范围可分配给 Fetch 在 handler 前拒绝的端口。共享 `listen(0)` helper 曾依赖随机端口，后续分两次发现 policy 漏掉 5060/5061 和 6000，且集合含非标准 4333。

**最终实现**：`test/llmClient.test.ts` 使用 Fetch Standard bad-port table 作为唯一 policy：包含标准 83 项中的 `0`、`5060`、`5061`、`6000`、`6667`、`10080`，不含非标准 `4333`。`listenOnFetchSafePort()` 实行 listen → inspect → close → retry；`withServer()` 无论 run、listen 或 retry 异常都在 `finally` 清理 listener。

**独立证据**：完整 table exact-equality 与逐项 predicate regression；真实 `http.Server` 复现首个分配模拟为 6000、确认 close 后才可 second listen；已独立确认 Node Fetch 对 5060/5061/6000 等端口在 HTTP handler 前报 `bad port`。最终修正提交 `715234a` 与经批准的 `371aafb` 内容逐字节一致。

### R70-7 — P2：High Contrast 作者 dot 可能仅靠颜色区分

- [x] **实现已补齐；人工主题验收待执行。**

`authorLabel()` 现对同 initial 的可见不同身份使用最短唯一文字前缀（不少于两个字符），不再按 palette key 才分辨。forced-colors 折叠 palette 时点内仍有文本差异；DOM test 覆盖不同 palette 的同 initial。真实 High Contrast Dark/Light 和 screen reader 验收保留在发布前人工走查。

### R70-8 — P2：纯函数测试无法证明 webview 事件路径

- [x] **本次 P1 路径已补最小 DOM/provider 回归。**

关键事件不再只由平行纯函数测试背书：R70-1、R70-2、R70-5 由 jsdom 执行 `media/main.js`；R70-3 由 protocol/mutation gate 测试；R70-4 由 provider/snapshot 测试。更广泛的真实 VS Code 端到端 harness 仍是后续质量演进项。

---

## 3. 已审查并确认的基础设计

- [x] **porcelain v2 与路径安全**：状态解析使用 `git status --porcelain=v2 -z`，不按换行解析路径；单文件 stage 使用 argv 和 `--` pathspec。`XY=RM` 仅暂存 working-side 现存路径；真实 Git 测试覆盖 modify/add/delete/rename/untracked、空格/方括号路径、RM、stage 和 staged/working restore。
- [x] **公开 VS Code 左右 Diff**：工作区 Diff 按 index ↔ working、HEAD ↔ index、empty ↔ content 等正确版本对比；commit Diff 支持 parent ↔ commit、root、add/delete/rename、multi-file QuickPick、binary/merge fallback。opaque request resolver 不把 repo/ref/path 放到 URI query。
- [x] **历史改写防线**：bulk lock/drop、reorder、generated Diff 均以 40 字符 hash、当前 snapshot/revision、canonical order 和 lock 状态在 host 重验；drop/reorder 仍要求明确确认。
- [x] **搜索/IME/菜单关闭**：scoped whitespace、`hash:0x` 与 unknown prefix fallback 的 parser 合理；composition 期间不 render，结束仅处理最终值；编辑器区域通过公开 VS Code window/editor events 发 `closeMenu`，不伪造跨 webview DOM 点击监听。
- [x] **Diff snapshot 的资源生命周期**：generated Diff 和 Git content request store 均具备 bounded opaque request design；repository 切换或 extension dispose 时清理，普通刷新不会改写已打开的 frozen generated snapshot。

---

## 4. 验证与重建一致性证据

| 命令 / 方法 | 结果 |
| --- | --- |
| `git diff --quiet 40d5dd3..499dfc1` | 无差异：初始实现与重建后的候选提交一致。 |
| `git diff --quiet ed9c11c..2711b66` | 无差异：R70 整改与重建后的候选提交一致。 |
| `git diff --quiet 147f76b..ee85a85` | 无差异：R71 safe-port 整改与重建后的候选提交一致。 |
| `git diff --quiet 371aafb..715234a` | 无差异：R72 最终标准表整改与候选提交一致。 |
| 历史独立审查：`npm run typecheck` | 通过（最终候选实现）。 |
| 历史独立审查：`npm test` | **120/120 通过**（最终候选实现；包含真实 Git、webview DOM、generated Diff、mutation gate 与 LLM tests）。 |
| 历史独立审查：`npm run compile` | 通过（最终候选实现）。 |
| 历史独立审查：`node --check media/main.js` | 通过（最终候选实现）。 |
| 历史独立审查：`git diff --check` | 通过，无空白错误。 |
| 历史独立审查：`npx tsx --test test/llmClient.test.ts` 连续运行 | 每轮 **8/8 通过**；覆盖 server lifecycle、SSE、deadline、caller/mid-stream cancellation 和完整 port policy。 |
| 本次发布准备：`npm run typecheck`、`git diff --check` | 通过。 |
| 本次发布准备：`npx tsx --test test/worktreeChanges.integration.test.ts` | **4/4 通过**；补强验证 staged restore 不会覆盖仍存在的 working-side 内容。 |
| 本次发布准备：`npm ci` | 通过；按当前 lockfile 重新安装 326 个依赖。 |
| 本次发布准备：`npm run test:release && npm run package` | 已通过：类型检查、**120/120** 覆盖率测试（约 406 秒）、编译和 VSIX 打包；本轮已包含 staged-restore 补强断言。 |

---

## 5. 发布前人工验收清单

下列检查是对自动化结论的必要补充，不应勾选为已自动验证：

- [ ] 在真实 VS Code 中用微软拼音和至少一个第三方中文 IME 输入 `author:`、`msg:`、`hash:0x...`，验证 composition 期间 Space/Arrow/Enter/Alt+Arrow 不执行重排。
- [ ] 用鼠标、触控板/触笔完成 pointer/native drag，确认 deferred refresh 的提示、插入位置和 rebase confirmation 与实际目标一致。
- [ ] 对 modify/add/delete/rename/untracked 逐项验证 Staged Changes / Changes、stage、working/staged restore、删除未跟踪文件确认和左右 Diff 文案。
- [ ] 在编辑器区域点击、切换 active editor/selection/window focus，确认右键菜单关闭且不产生 paused-rebase warning。
- [ ] 在 High Contrast Dark/Light 中检查 author label、M/A/U/D/R 状态字母、focus ring；以 screen reader 走查菜单、disabled reason 和 generated Diff 入口。
- [ ] 对二进制文件和超过 2,000,000 字符的连续 multi-commit Diff 确认 binary/truncation 说明可见，且生成文档不可编辑。
