# Git Rebase Visual — 代码评审报告（0.6.3）

> **评审基线**：`d0bc9683d934e7fadcb6a6c4698df4268c231621`（v0.6.2 review/documentation baseline）。
>
> **本次覆盖提交**：`828bd4cfa7e62e4dc90f5c3b899c3d0ebde72992` — `feat: implement 0.6.3 rebase interactions`。
>
> **范围**：porcelain v2 `-z` worktree 状态/单文件 stage，公开 VS Code diff content provider，搜索与 IME，branch toast，edit-stop AI draft-only guard，pointer/Alt reorder/refresh defer，webview runtime 与 host protocol，以及测试有效性。
>
> **结论**：发现 2 项 **P1 发布阻止问题**。在修复并由独立复核验证前，0.6.3 不应进入 release。其余主要实现路径的安全设计和编译/现有测试结果良好。

---

## 1. 发布结论

- [ ] **不可发布：R63-1、R63-5 必须修复。** R63-1：已暂存 rename 又在工作区修改时，点击该工作区条目的“暂存”会稳定失败；这正是 UI 所承诺的 staged+unstaged 同文件、rename、单文件 stage 组合。R63-5：右键菜单“打开变更…”仍打开单一只读 patch 文档，未使用新建的 VS Code 左右 Diff 能力。
- [x] 未发现 P0（任意路径命令注入、rebase 中绕过 Git 写入 guard、host 崩溃）问题。
- [ ] 真正 VS Code 图形环境下的 binary viewer、IME、pointer/touch 与辅助技术仍需人工验收；不能由当前 Node 测试替代。

---

## 2. Findings

### R63-1 — P1：已暂存 rename 的后续工作区修改无法单文件暂存

- [ ] **未修复；发布阻止。**

**位置**：`src/git/worktreeChanges.ts` 的 `stageWorktreeChange()`（当前约 185–193 行）。

**根因**：对所有拥有 `originalPath` 的记录都执行：

```ts
git add -A -- <current-path> <original-path>
```

但在 `git mv old.txt new.txt` 已写入 index 后，`old.txt` 不再是工作树 pathspec。若随后编辑 `new.txt`，porcelain v2 返回一条 `XY=RM` 的 type-2 rename 记录（`path=new.txt`、`originalPath=old.txt`、`staged=true`、`unstaged=true`）。此时 `git add -A -- new.txt old.txt` 失败：`fatal: pathspec 'old.txt' did not match any files`。用户因而无法将 `new.txt` 的 working-tree 一侧加入已暂存 rename；按钮也没有在 host 层被安全降级。

**可复现场景**：

1. 创建并提交 `old.txt`。
2. 执行 `git mv old.txt new.txt`（此时 rename 已暂存）。
3. 修改 `new.txt`，打开扩展的 Changes；同一条目同时显示 `Staged Changes: Rename` 和 `Changes: Modify`。
4. 点击 Changes 行的“暂存”。
5. 实际调用失败，保持 `RM`；扩展显示 Git pathspec error，而不是完成暂存。

独立复现使用真实临时 Git 仓库，得到：

```text
2 RM ... R100 new.txt\0old.txt\0
fatal: pathspec 'old.txt' did not match any files
```

**修复建议**：单文件 stage 应按“待 stage 的 worktree side”选择 pathspec，而不是无条件附带 rename 的 index-side original path。至少应覆盖：

- `change.staged && change.unstaged && change.indexKind === "rename"`：只传 `change.path`，使 `new.txt` 当前内容更新 index；
- 未暂存 rename（Git 若拆为 delete + untracked，则每个 UI entry 仍只 stage 其自身 path）以及真正需要 old path 的情况要用真实 Git 集成测试确定；
- 若保留双路径策略，先过滤不存在/不属于当前 worktree side 的 original path，且不得将 Git 的 rename detection 作为调用前提。

修复后应新加真实 Git 回归：已暂存 rename + 工作区修改 → `stageWorktreeChange` 成功，最终不存在 unstaged side，index 包含预期新路径内容。还应断言其他未相关条目没有被 stage。

**测试缺口**：`test/worktreeChanges.integration.test.ts` 只覆盖“纯 staged rename”与 deletion/space path；没有覆盖 `XY=RM`。现有“single-file stage”测试也只覆盖 deletion 和 untracked 文件，因此绿灯未覆盖此失败路径。

---

### R63-5 — P1：commit 右键“打开变更…”仍是单一只读 patch，而非同样的 VS Code 左右 Diff

- [ ] **未修复；发布阻止。**

**位置**：`media/main.js` 的右键菜单 `openDiff` 消息、`src/ui/rebaseViewProvider.ts` 的 `openDiffDocument()`（当前约 2017–2035 行）。

0.6.3 已为“更多提交选项”的 worktree 文件实现 `vscode.diff` + public `TextDocumentContentProvider`，但 commit 行右键菜单、hover 和 Compose 的“打开变更…”仍走 `openDiffDocument()`：执行 `git show --binary --format=fuller <hash>`，再将完整 patch 作为一个 read-only text document 打开。它不是一个可比较、可在编辑器内逐行导航的左右版本 Diff，也与新增工作区 Diff UX 不一致。

**可复现场景**：右键任意 commit → 点击“打开变更…”。当前只显示一个含 commit metadata/patch 的 diff 文本编辑器；不会调用 `vscode.diff`，也不会将父版本置左、commit 版本置右。

**必须修复的实现要求**：

1. 把 commit 右键菜单、hover 与 Compose 的 commit diff 入口切换为真实 `vscode.diff` 左右编辑器，不能再只显示单一 patch 文档；
2. 与 worktree Diff **复用或抽象同一受控 diff resolver/provider 架构**，避免两套无关 URI/版本选择和安全策略；
3. 正确表达每个文件的 **commit parent ↔ commit**：一个多文件 commit 必须有可操作的文件选择或等价的 VS Code 文件级左右 Diff 流程，不能将多文件 patch 偷换成一个文本；
4. 明确处理并测试 root commit（empty ↔ commit）、binary（明确 binary-safe viewer/fallback，不能 UTF-8 损坏）、rename（old path 左 ↔ new path 右）、delete/add、以及多文件 commit；
5. provider URI 必须是受控请求，且有 cache/cleanup/invalidations 的明确生命周期。R63-2 的 repository authority/URI cleanup 要求应在此共享抽象中一并解决；
6. 保留现有完整 patch 文本如有价值时，可将其降为显式“查看原始 patch”辅助入口，但不得再是“打开变更…”的唯一实现。

**建议架构**：将 `worktreeDiff.ts` 提升为受控 Git content/diff resolver：opaque request id → allow-listed repository、resolved Git object/spec、path、生命周期；由它生成 `vscode.diff` 的左右 URI。worktree 传 index/working/HEAD/empty spec；commit 文件传 parent/tree object（或 empty）spec。先获取并结构化列出 commit 的 changed files，再由用户/QuickPick 选择文件打开左右 Diff。不可用的 binary 或 merge-parent 歧义必须有明确 fallback，而非回退为错误的单一文本。

**测试证据缺口**：当前没有 `openDiffDocument`/provider integration test，也没有 commit parent vs commit、root/binary/rename/multi-file resolver test。`test/worktreeContentUriState.test.ts` 仅验证 JSON encode/decode，不能证明上述用户路径。

---

### R63-2 — P2：worktree content provider 未限制请求 repository 到当前工作区，也没有 URI/request cache 或 cleanup 策略

- [ ] **延后；不阻止本次 P1 整改，但应纳入后续 hardening。**

**位置**：`src/ui/worktreeContentUriState.ts`、`src/ui/worktreeDiff.ts`、`src/extension.ts`。

`GitContentProvider.provideTextDocumentContent()` 接受 URI query 中任意字符串 `repository` 并直接将其作为 `runGit(..., { cwd })` 的 cwd；decode 只验证类型和 version。扩展自身生成的 URI 来自已解析的 repo root，正常 UI 流程没有问题，但全局注册的 content provider 公开处理该 scheme，任何能构造该 URI 的 VS Code 调用都可触发本扩展在任意本地 Git 仓库读取 `HEAD:<path>` 或 `:<path>`。这不是 shell 注入（参数使用 spawn），但违反了“受控当前 repository”的 provider 声明，也使 URI identity 依赖内含绝对路径。

此外，每次点击都产生新的由完整 JSON query 表示的 URI；provider 没有可撤销/失效的 request registry、cache 上限或 `onDidChange`/dispose cleanup。当前实现不会保存 content，所以不是直接内存泄漏；但也没有满足需求中 URI cache/cleanup 的明确定义，反复打开会重复 Git `show`，且历史 URI 将继续可解析读取当时 cwd 的当前 HEAD/index。

**建议**：在 provider 注册处注入一个受限 request store：随机 opaque request id 映射到 `{ repository, version, path }`，仅由 `openWorktreeDiff` 创建；验证 repository 是当前可用 workspace/repo root，使用后 TTL/LRU 清理，provider/dispose 时清空。若必须支持稳定 URI，应至少 allow-list repository roots 并明确 index/HEAD 的动态语义。补 mock/provider 单测：伪造 query 不能运行 Git；cache 命中、过期、dispose 均不能继续服务。

**现有证据**：`test/worktreeContentUriState.test.ts` 仅测试 JSON 编解码和拒绝 `working` version，未测试 provider 调用、repository authority、binary/error 内容、URI reuse 或 cleanup。

---

### R63-3 — P2：binary 文件被作为 UTF-8 text content 送入 TextDocumentContentProvider，不能保证“binary 表现”

- [ ] **延后；需人工与自动验证后决定呈现策略。**

**位置**：`src/ui/worktreeDiff.ts`（当前约 27–35 行）。

`runGit` 将 `git show HEAD:path` / `:path` 的 stdout Buffer 用 `data.toString()` 累加，再作为 `string` 交给 TextDocumentContentProvider。对 NUL 或非 UTF-8 binary，这会转码为 replacement character；右侧 working file 是 `file:` URI 时 VS Code 可能做 binary 检测，左侧 virtual text 则已丢失 bytes，左右表现不对称，也不等价于 VS Code SCM binary diff。

**可复现场景**：提交含 NUL/非 UTF-8 bytes 的 `image.bin`，修改并暂存或保持未暂存，在文件列表点击 Diff。左侧 provider 会返回转码后的 string，而非 binary editor 或明确 fallback。

**建议**：预先检测 Git blob 类型/内容（例如 `git cat-file --batch-check` + NUL 检测且有输出上限），对 binary 返回明确 fallback toast/打开工作树文件，或选择 VS Code 认可的 binary-capable content mechanism；不要把二进制 Buffer 静默 `toString()`。补真实二进制 fixture 测试，断言不发生损坏性 text conversion，且 UI 得到可预期 fallback。

---

### R63-4 — P2：实现存在良好的纯逻辑测试，但 browser/host protocol 测试仍没有覆盖新增 UI 消息链

- [ ] **延后；建议随 P1 修复补齐关键路径。**

新增的 `commitSearch.ts`、`inlineToastState.ts`、`rebasePointerDragState.ts` 将部分逻辑抽成纯函数，测试有效地覆盖了 parser、IME reducer、过期和 canonical intent。`media/main.js` 却保留独立实现（例如 `queryMatch` 和 Alt-arrow reorder），没有由这些 pure helpers 驱动，因此测试不能证明真正 webview 的 event listener、DOM lifecycle 或 postMessage payload 正确。

当前没有测试以下 host/webview 协议：

- `openWorktreeDiff` / `stageFile` 从 DOM 到刷新后 fresh status lookup；
- pointer `pointerup` 后 `deferredState` 应用及 native drag/pointer 两种 payload 是否同一 canonical intent；
- edit-stop AI draft session 的 `openCompose → generate → conflict/revision rejection` host 路由；
- inline toast 覆盖 context 后 branch text 保留、列表 top offset 不变；
- main.js 在真实最小 DOM 下各新增 element id 存在且无 `ReferenceError`（本次 `node --check media/main.js` 仅检验语法）。

**建议**：不要为了虚高覆盖率复制业务逻辑；可抽离可复用的 webview protocol reducer，或建立最小 DOM harness 后执行 `main.js`，至少断言上述 `postMessage` payload 和 refresh defer 行为。P1 中新增的 `RM` 集成测试必须直接调用真实 `stageWorktreeChange`。

---

## 3. 已审查且确认的实现

- [x] **porcelain v2 -z 基础解析**：type-1/type-2/untracked/unmerged record 使用 NUL，而非按换行分隔；固定头字段后保留 pathname，支持空格、tab、引号和允许的换行路径。工作树 status summary 与列表共享 parser；`GIT_OPTIONAL_LOCKS=0` 延续后台读取避免 index lock 竞争。
- [x] **路径与命令注入边界**：stage 和 `git show` 经 `spawn` 参数数组且用 `--`；working URI 再由 `path.resolve`/`relative` 拒绝 repository 外路径。R63-1 是合法 pathspec 生命周期错误，不是注入。
- [x] **worktree 左右版本选择基本语义**：unstaged 是 index ↔ working、staged 是 HEAD ↔ index、untracked/add 为 empty 左侧、delete 为 empty 右侧、rename 选 original path、conflict 有 SCM fallback。root/add 的 empty 左侧设计正确；provider registration 已推入 ExtensionContext subscriptions，因此 extension disposal 会 unregister。注意 commit 右键入口未复用此能力，见必须整改的 R63-5。
- [x] **搜索与 IME**：`author:`/`msg:`/`hash:` 与 `hash:0x` 语义正确；未知 prefix 保留全文搜索。实际 webview 在 composition 中不 render，compositionend 一次提交且渲染后恢复 search focus/selection，避免中文 IME 被 DOM replacement 打断。
- [x] **branch context toast**：toast 成为固定高度 `.branch-context` 内的 absolute overlay，不插入新 document-flow 节点；超时只隐藏 overlay，底层 context text 不被清空。
- [x] **rebase edit-stop AI**：host 仅对 active session、draft-only staged/working 和无 conflict 放行 generate；apply 始终拒绝 rebase 中写入；amend/new 仍经 `ensureEditStop`、stopped target、conflict/staged/session 验证。Compose 页面也清晰标记“仅生成，不提交”。
- [x] **reorder 意图/host 防线**：pointer/native/Alt 都发送 source/anchor/placement/revision/full order；host 用 canonical order、current generation、locked source 重新推导和确认后再验证。拖拽期间 state refresh defer 至 session end，避免 DOM 被重建。
- [x] **webview static sanity**：`node --check media/main.js` 通过；HTML 中新增的 `context-text`、`inline-toast`、changes/list/menu 等 main.js 所取元素均存在。未发现本次新增立即触发的 static ReferenceError。

---

## 4. 验证证据

| 命令 / 方法 | 结果 |
|---|---|
| `npm run typecheck`（Agent A worktree） | 通过 |
| `npm test`（Agent A worktree） | **98/98 通过**，约 335 秒 |
| `npm run compile`（Agent A worktree） | 通过 |
| `git diff --check 828bd4c^ 828bd4c` | 通过 |
| `node --check media/main.js` | 通过 |
| 真实临时 Git repo：staged rename + later modification + single-file stage | **失败，复现 R63-1** |
| commit 右键“打开变更…”源码路径审查 | **失败，复现 R63-5**：仍走 `git show` 单一 patch 文本，未调用 `vscode.diff` |
| 真实临时 Git repo：delete/untracked/space path；parser/左右 diff spec | 基础路径正常；与现有 integration tests 一致 |

`npm test` 的通过不能覆盖 R63-1：新增 worktree integration test 没有制造 type-2 `XY=RM`，故没有执行会传入已经不存在的 `originalPath` 的实际 `git add -A`。

---

## 5. 整改与复核要求

Agent A 必须先阅读本报告并在其独立 worktree 修复 **R63-1 和 R63-5**，随后提供版本化 review response（按项目流程）与以下证据，方可进入主 agent/release：

1. 真实 Git integration test 覆盖 staged rename + unstaged modify 的单文件 stage 成功、内容正确、无 unrelated entry 被 stage；
2. 对 delete、untracked、纯 rename、staged+unstaged 普通 modify 的既有行为回归通过；
3. commit 右键“打开变更…”实际进入 `vscode.diff` 的 host/resolver 测试；真实 Git fixtures 至少覆盖 parent ↔ commit、root、add/delete、rename、多文件选择以及 binary 的明确安全 fallback；
4. worktree 与 commit 两类入口复用同一受控 diff resolver/provider，且补 repository authority、URI cache/cleanup/invalidations 测试；
5. `npm run typecheck`、`npm test`、`npm run compile`、`git diff --check` 全部通过；
6. 独立 reviewer 对修复 commit 复核 R63-1 和 R63-5。

R63-2 至 R63-4 可以作为后续改进或在本轮一并整改；但 R63-2 中 provider authority 与 URI lifecycle 的核心要求已被纳入 R63-5 的共享 resolver 必须整改范围。任何项目不得标记为已验证完成，除非加入对应 provider/binary/protocol 测试并由复核确认。
