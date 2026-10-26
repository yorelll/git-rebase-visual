# code review 0.8.0 — Agent B 独立终审（round 6）

> 独立评审代理 B，发布前最终门禁。本报告由评审代理撰写，未修改任何产品代码、测试或发布说明。

## 一、评审基线

| 项目 | 值 |
|---|---|
| 仓库 | `D:\work\tools\git plugin` |
| 分支 | `main` |
| 基线 commit | `4a1e2088ee5c83202eab9e17ad83f5372dbf21e3`（`chore: release v0.7.1`，tag `v0.7.1`） |
| 评审范围 | `git diff 4a1e2088ee5c83202eab9e17ad83f5372dbf21e3` + 全部 untracked 文件 |
| 评审日期 | 2026-10-26 |
| 工作树状态 | **0.8.0 的改动尚未提交**；工作树内没有新的 SHA 可记录 |
| 起始 / 结束 `git status --short` 条目数 | 44 / 46（增量恰为本报告 `code-review-0-8-0.md` 与本台账 `code-review-commit.md` 的修改，未触碰任何产品代码/测试/发布说明） |

**重要说明（基线性质）**：本次评审的对象是 0.8.0 的**未提交工作树**，不是任何已存在的 commit。因此台账中本次记录只能以基线 SHA `4a1e208` 作为覆盖锚点，并在备注里注明"被评审材料为未提交的 0.8.0 工作树，暂无 commit SHA"。待这些改动被提交后，应由后续独立评审按其真实 SHA 覆盖。

**范围外**：v0.7.2 的 editor-area inspector（把 commit 详情迁移到编辑器区）实现已保留在分支 `native-treeview-v0.7.2`，**不在本次评审范围内**，也不应进入 0.8.0 发布物。

**评审过程中工作树被并发修改**：评审期间存在另一个进程同时编辑 `docs/`、`src/` 并重建产物（详见 F-1 的记录）。所有结论均以最终稳定状态为准，凡涉及"产物是否最新"的结论都给出了时间戳证据。

---

## 二、结论摘要

**发布判定：批准发布（Approve）。** 未发现 P0/P1/P2；发现 2 个 P3（F-2 产品文案缺陷、F-3 发布说明措辞），另记录 1 个已自愈的构建竞态（F-1，非产品缺陷）。用户范围裁决所要求的核心不变量——**插件永不自动删除 stash**——在结构上和实证上都成立。

| 严重级别 | 数量 |
|---|---|
| P0 | 0 |
| P1 | 0 |
| P2 | 0 |
| P3 | 2（F-2、F-3） |

---

## 三、第 5 轮整改项复核

第 5 轮结论为"批准发布，3 个 P2 + 1 个 P3"；实施者随后整改，但会话在汇报前中断。本轮逐项独立复核。

| # | 第 5 轮整改项 | 判定 | 证据 |
|---|---|---|---|
| R5-1 | 移除 `stash:<sha>` 回退；槽位无法解析时 `apply` 回退到原始 sha，并**省略** `drop` 步骤 | **已修复** | 见 3.1 |
| R5-2 | 横幅每轮重新解析 `stash@{n}`；sha 是稳定身份；保留关闭状态 | **已修复** | 见 3.2 |
| R5-3 | `gitRunner.integration.test.ts` 用 `/proc/$!/winpid` 写出真实 Windows pid | **已修复且非空洞** | 见 3.3 |
| R5-4 | 删除 `reconcileKeepsRecord` | **已修复** | `grep -rn reconcileKeepsRecord src test` → 0 命中 |

### 3.1 R5-1：`stash:<sha>` 回退已移除，`drop` 在槽位未知时被省略

`src/git/pendingRecovery.ts:990-1006`：

```ts
export function recoveryCommands(name: string | undefined, sha: string): RecoveryCommand[] {
  const applyTarget = name ?? sha;
  const steps: RecoveryCommand[] = [
    { label: "恢复暂存区与工作区改动", command: `git stash apply --index ${applyTarget}` },
    { label: "只恢复工作区改动（不改动暂存区）", command: `git stash apply ${applyTarget}` },
  ];
  if (name) {
    steps.push({ label: `确认 ${name} 仍是 ${sha.slice(0, 7)} 后删除`, command: `git stash drop ${name}` });
  }
  return steps;
}
```

- `applyTarget` 回退到 **sha 本身**，不再拼接 `stash:<sha7>`。
- `drop` 步骤只在 `name` 存在时加入——Git 没有按 sha 寻址的 `stash drop`，因此槽位未知时不提供会必然失败的命令。
- 全仓搜索 `stash:` 只命中注释（`rebaseViewProvider.ts:739`）与一处 **UI 测试夹具的展示文本**（`test/webviewDom.test.ts:348`），没有产品代码再构造该引用。

**实证（真实 Git，临时仓库，已删除）**：

```text
sha=d139929d89e20b3c76bbabb0d2d6684ce3f9721f short=d139929
--- apply with stash:<sha7> (the removed fallback) ---
error: stash:d139929 is not a valid reference
exit=1
--- apply with raw sha (the current fallback) ---
On branch master
...
exit=0
```

即旧回退确实必然失败，新回退在真实 Git 上可用。

**测试是否真的执行命令**：`test/pendingRecovery.integration.test.ts:771-783`（`runOneCommandPerRepo`）把横幅打印的字符串 `replace(/^git /, "").split(" ")` 之后交给 `runGit(...)`，在**每个命令一个独立临时仓库**中真实执行并断言 `res.code === 0`；`:785`（已解析槽位）与 `:804`（未解析槽位）两个用例都走这条路径。这不是字符串比较。

**测试是否会在回退复现时失败**：在临时副本中把 `applyTarget` 改回 `` `stash:${sha.slice(0, 7)}` ``，运行 `pendingRecovery.integration.test.ts`：

```text
✖ an unresolvable slot falls back to commands that Git can still run
ℹ tests 35  pass 34  fail 1
```

判定：**测试非空洞，能捕获该回归**。

### 3.2 R5-2：横幅每轮重新解析槽位，关闭状态保留

`src/ui/rebaseViewProvider.ts:1561-1579`（`applyPendingOutcome` 的 `pending` 分支）每轮都调用 `stashNameForSha(root, outcome.stashSha)` 重新解析槽位，再构造文本并交给 `observePendingWarning`；`pendingWarningText()`（`:1605-1619`）对未解析槽位打印 sha 与"请先执行 `git stash list`"的提示，且不提供 `drop`。

`src/ui/pendingRecoveryPolicy.ts:46-67` 的实现与注释一致：同一 key 已出现时**不重复通知**，但若横幅仍处于装填状态且文本变化，则刷新文本；若横幅已被关闭（`banner === undefined`），则原样返回，不会复活。

**四项风险逐条核查**：

1. **是否重新引入 toast/refresh 抖动**：不会。`shouldNotify` 仍由 `(sha, reason)` key 决定，文本刷新不触发 toast（`rebaseViewProvider.ts:1572` 的 `if (observed.shouldNotify)` 分支）。provider 级用例断言"改述同一记录不再弹窗"（`test/recoveryProvider.test.ts:377-381`）。
2. **是否破坏关闭语义**：不会。关闭后 `banner === undefined`，`observePendingWarning` 直接返回原 state；`rebaseViewProvider.ts:382` 的 `refresh()` 从持久化的 `pendingWarnings` 读取，而不是从记录重新推导。provider 级用例（`test/recoveryProvider.test.ts:385-392`）覆盖"移动槽位不会复活已关闭横幅"。
3. **是否每次轮询都查 Git**：是，但仅限**每轮恢复 pass**，且只在记录处于 `pending` 时发生一次 `stashNameForSha`（一条 `git stash list`）。恢复 pass 本身已因单飞 + mutation lock + 失败退避（最长 30 s）而受限（`rebaseViewProvider.ts:1460-1484`），不会因渲染而额外放大。
4. **文本未变化时是否避免 churn**：`observePendingWarning` 在 `state.banner.text === text` 时返回**同一实例**，调用方可据此跳过重渲染（`test/pendingRecoveryPolicy.test.ts:58-59` 断言 `same.state === shifted.state`）。

**测试是否会在修复被回退时失败**：在临时副本中回退该分支（直接 `return { state, ... }`）：

```text
budgetRecoveryPolicy：✖ an armed banner updates its slot text without re-toasting   (10 项中 1 失败)
recoveryProvider：  ✖ the banner re-describes a stash whose slot moved, and stays dismissed after a dismissal
                    Error: recovery pass did not produce the expected state
```

判定：**单元级与 provider 级都有真实覆盖，非空洞**。

### 3.3 R5-3：`winpid` 判活测试非空洞

`test/gitRunner.integration.test.ts:83-93` 的 hook 写出 `$(cat /proc/$child/winpid 2>/dev/null || echo $child)`；`:164-171` 的 `isProcessAlive` 用 `process.kill(pid, 0)`。

**"真的能看见活进程"先被断言**（`:134-138`）：用例先要求该 pid 在 hook 阻塞期间是活的，否则直接失败并给出"would be vacuous"的说明——这堵死了"pid 从来无效、于是'已回收'断言因错误原因通过"的空洞路径。

**`|| echo $child` 回退路径的行为**：

- 在 Git-Bash / MSYS 且 `/proc` 可用时：`/proc/<msys>/winpid` 给出真实的 Windows pid（本环境实测：`$!` = MSYS pid，映射到的 pid 经 `Get-Process` 确认为 `sh` 存活）。
- 在 Linux：无 `/proc/<pid>/winpid`，回退到 `$child`；Linux 上 `$!` 与 `process.kill` 使用**同一命名空间**，因此仍然正确。
- 在既非 Git-Bash 又非 Linux 的 POSIX 环境（例如 macOS）：无 `/proc`，回退到 `$!`，而 `process.kill` 同样使用该 pid 命名空间，仍然正确。
- 唯一"可能变空洞"的组合是 Windows + 非 MSYS shell：但该用例的 hook 是 `#!/bin/sh`，由 Git for Windows 的 MSYS `sh` 执行（`/proc` 必存在），因此不会落到回退；即便回退，`$child` 是 MSYS pid，`process.kill` 看不到它，第一个"必须存活"的断言会**失败而不是空过**。

**测试是否会在 kill 顺序回退时失败**：在临时副本中把 `directKill()` 移到 `taskkill` 之前（即基线顺序），运行 `gitRunner.integration.test.ts`：

```text
✖ a timeout settles exactly once and reaps the grandchild
  Error: the grandchild process was reaped
ℹ tests 7  pass 6  fail 1
```

失败点正是"孙进程被回收"这条断言（`:156`），不是别的偶发原因。

**独立的进程级对照实验**（最小复现，非产品代码，临时目录，已删除）：

```text
mode=baseline msys=2012 winpid=36064 -> ALIVE      (taskkill exit: 128)
mode=fixed    msys=3646 winpid=3646  -> DEAD       (taskkill exit: 0)
```

即"先直接 kill 再 taskkill"会让 `taskkill` 以 128 退出、孙进程存活；当前实现（先 `taskkill`、`then` 再直接 kill）能真正回收。

### 3.4 R5-4：`reconcileKeepsRecord` 已删除

`grep -rn "reconcileKeepsRecord" src test` → 0 命中。判定：**已修复**。

---

## 四、发布不变量复核（自动删除 stash）

### 4.1 结构性核查：`src/` 中全部 stash argv

| argv | 位置 | 是否自动可达 | 说明 |
|---|---|---|---|
| `stash push` | `src/git/worktree.ts:35` | 是 | 创建快照，不删除 |
| `stash list` | `worktree.ts:45,71,97`、`pendingRecovery.ts:129,158`、`rebaseViewProvider.ts:2674,2696` | 是 | 只读 |
| `stash apply` / `apply --index` | `worktree.ts:62`、`pendingRecovery.ts:619,922` | 是 | 只写工作区/索引，**保留** stash |
| `stash pop` | `worktree.ts:101`（`stashPopManual`） | **否（仅用户显式命令）** | 见下 |
| `stash drop` | **仅** `pendingRecovery.ts:1002` 的**字符串**（打印给用户） | **否** | 不产生 argv |
| `stash clear` | 无 | — | — |

`stashPopManual` 的唯一调用点是 `rebaseViewProvider.ts:2710` 的 `popChanges()`，而 `popChanges` 只由 `extension.ts:64-66` 注册的命令 `gitRebaseVisual.stashPop`（"Pop Stash"）触发；`popChanges` 内部先弹**模态确认**（`rebaseViewProvider.ts:2699-2706`，文案明确"会……从 stash 列表中删除该条目"），未确认则直接返回。该路径**不在**任何恢复/轮询/渲染调用链上。用户显式点击 Pop 属于用户动作，符合"扩展不得自动删除 stash"的裁决。

### 4.2 结构性核查：不可达的旧 auto-drop 实现

| 符号 | 命中数 |
|---|---|
| `stashDropBySha` | 0 |
| `stashPopBySha` | 0 |
| `dropConfirmed` | 0 |
| `dropListedStash` | 0 |
| `pathEverHeldBlob` | 0 |
| `blobIntroducedInRange` | 0 |

### 4.3 实证核查：完整恢复 pass 的 Git 调用观察器

`test/pendingRecovery.integration.test.ts:941-1004` 构造"追加快照 + keep-index 工作区快照"两条分支（正是旧实现会走 drop 的路径），通过 `setGitInvocationObserver` 观察**真实 argv**，断言：

- `observed.length > 0`（观察器确实看到这一轮）；
- `drop`/`pop`/`clear` 的 argv 列表为**空**；
- 两条 stash 在 pass 结束后**都仍在列表里**；
- 工作区-only 内容确实被恢复。

本轮在真实工作树上单独运行该用例：

```text
✔ a full recovery pass invokes no stash-removing Git command (30467ms)
ℹ tests 1  pass 1  fail 0
```

**测试非空洞验证**：在临时副本中往"已结算"路径注入一条 `runGit(["stash", "drop", "stash@{0}"])`，同一测试文件出现 **6 处失败**，包含该不变量用例：

```text
✖ an index-only match never resolves the record while untracked content is still only in the stash
✖ an append whose amend landed resolves on a confirmed tree match and keeps the stash
✖ a completed append whose content matches HEAD resolves and keeps the stash
✖ a mode-only append that landed resolves on the tree mode, not the blob id
✖ a full recovery pass invokes no stash-removing Git command
✖ a conflicting worktree restore never removes the stash it failed to apply
```

判定：**不变量在结构上成立，在实证上与测试上都成立**。

---

## 五、发现

### F-1（过程性，非产品缺陷，已自愈）产物在评审期间一度落后于源码

**现象**：评审开始后、13:59:11 生成的 `git-rebase-visual-0.8.0.vsix` 中，`extension/dist/extension.js` 缺少第 5 轮"横幅文本每轮刷新"的三行分支：

```js
// 交付物（13:58:40 构建）中缺失：
if (state.banner && state.banner.key === key && state.banner.text !== text) {
  return { state: { seen: state.seen, banner: { key, text } }, shouldNotify: false, key };
}
```

当时 `dist/extension.js` 的 mtime 为 13:58:40，而 `src/ui/pendingRecoveryPolicy.ts`（14:00:36）与 `src/git/gitRunner.ts`（14:01:12）都更新。用 esbuild 把当时的源码打包到临时路径与交付物对比，差异**恰好只有这 3 行**。

**成因**：这是并发编辑与构建的时序竞态，不是源码缺陷——评审期间另一个进程正在修改 `src/`、`docs/` 并重建产物（`docs/*` 的 mtime 在 14:04:40–14:04:55 之间连续变化）。

**最终状态（已复核）**：`dist/extension.js` 于 **14:29:38** 重建、VSIX 于 **14:30:28** 重新打包；当前 VSIX 内 `extension/dist/extension.js` 与 `dist/extension.js` 的 MD5 一致（`3689fbc2554cea1f854202182cd3a71c`），且把当前源码重新打包到临时路径后与交付物**逐字节相同（diff 0 行）**；`find src media -newer dist/extension.js` 为空。

**结论**：F-1 不是需要整改的代码缺陷，但说明"打包必须在源码冻结之后执行"。**发布建议**：在打 tag 前重新执行一次 `npm run compile && npm run package`，并确认 `dist/extension.js` 的 mtime 晚于所有 `src/` 文件、VSIX 的 mtime 晚于 `dist/`。当前工作树已满足该条件。

### F-2（P3，文案）`restoreAppendSnapshot` 的冲突提示把 sha 占位符写成了字面量 `sha sha`

**位置**：`src/ui/rebaseViewProvider.ts:1715`

```ts
toast("warn",
  `恢复原始改动时有冲突：${outcome.reason}。安全副本 ${label}（sha sha）仍保留，可手动执行：${steps[0].command}`
);
```

**基线对照**：`4a1e208` 的同类提示会插入真实短 sha（`…（stash: ${sha.slice(0, 7)}）…`）。0.8.0 重写该提示时，把插值写成了字面量 `sha sha`。

**触发场景**：追加（append）操作在 `--amend` 之前失败、且 rebase 已不在进行中时，走 `rebaseViewProvider.ts:2155-2156` → `restoreAppendSnapshot()`；若此时 `reconcilePendingStash` 判定 `pending`（例如 apply 冲突），用户会看到 `…安全副本 stash@{0}（sha sha）仍保留…`。

**影响**：仅文案。`label` 已包含 `stash@{n}`，`steps[0].command` 已包含完整可执行命令，因此用户仍能完成恢复；stash 本身与记录均不受影响。不影响不变量，不影响发布功能。

**修复建议**（一行）：把 `（sha sha）` 改为 `（sha ${sha.slice(0, 7)}）`，或在 `label` 已含 sha 时直接去掉该括号。现有测试未覆盖该字符串（`grep -rn "安全副本" test/` → 0），建议同时补一条断言。

**是否阻塞发布**：不阻塞。建议在 0.8.0 或紧随的 0.8.1 修正。

### F-3（P3，文档措辞）发布说明对槽位重解析时机的描述略强于实现

**位置**：`docs/release-notes/0.8.0.md:30`

> 槽位名在**每次渲染时重新解析**……

**实现**：`rebaseViewProvider.ts:1563` 的注释与代码是"**每轮恢复 pass** 重新解析"，即恢复 pass 产出一条新横幅文本后才进入渲染。渲染本身（`refresh()`，`:382`）只是从持久化状态读取文本，不查 Git。

**实际差异**：用户可见结果一致（横幅始终显示当前槽位）；差异只在"哪一步查 Git"的措辞。后果是，如果用户完全不触发恢复 pass（记录已不再是 pending），横幅文本就不会刷新——但那种情况下也没有横幅可刷新。

**建议**：把"每次渲染时"改为"每轮对账时"，或在同一句里说明解析发生在对账阶段。非阻塞。

---

## 六、发布完整性核查

| 检查项 | 结果 | 证据 |
|---|---|---|
| `package.json` version | `0.8.0` | 直接读取 |
| `package-lock.json` 根 `version` | `0.8.0` | `l.get("version")` |
| `package-lock.json` `packages[""].version` | `0.8.0` | 同时确认 `name` 为 `git-rebase-visual` |
| VSIX 内 `extension/package.json` version | `0.8.0` | 解包读取 |
| 发布说明标题 | `## Git Rebase Visual 0.8.0` | 首行 |
| 发布说明占位符 | `{{…}}` 0 处 | `grep -cE '\{\{[A-Z_]+\}\}'` → 0 |
| `RELEASE.md` 的 `**0.8.0**` 条目 | 存在 | `RELEASE.md:108` |
| 测试计数 213 与真实套件一致 | 一致 | `grep -rhoE '^\s*test\(' test/*.test.ts \| wc -l` → **213** |
| 陈旧 "208" | 无（命中的都是 40 位 SHA 片段） | `grep -rn 208 docs README.md RELEASE.md` |
| 陈旧"自动 drop"表述 | 无 | 文档中的 `drop` 均为"已退役/仅用户可执行"的说明 |
| VSIX 文件数 / 大小 | 12 / 142,606 字节 | `unzip -l` |
| VSIX 不含 `.map` / `src/` / `test/` / `docs/` / `node_modules/` / `tsconfig` | 全部 0 命中 | 逐项 `unzip -Z1 \| grep -c` |
| `.map` 门禁 | 工作流有，`.vscodeignore` 无 | 依赖 `esbuild.js` 在不生成 sourcemap 时删除残留 `.map`，工作流再断言 VSIX 无 `.map`；两道防线中工作流那道是有效的 |
| 工作流 `Verify tag matches extension version` | tag 版本必须等于 `package.json` 版本 | `.github/workflows/release.yml` |
| 工作流 `Verify packaged VSIX` | 断言 4 个必需文件存在、5 类禁止内容不存在、无 `.map` | 同上 |
| 工作流 `Verify final release body` | 断言发布说明存在、标题正确、无占位符、`RELEASE.md` 含 `**<version>**` | 同上 |
| 工作流构建顺序 | `npm run test:release` → `npm run package` | `release.yml:40,43`；`package` 会经 `vscode:prepublish` 触发 `compile`，因此 CI 产物不会出现 F-1 的陈旧问题 |

**关于 `.vscodeignore` 没有 `.map` 规则**：这不构成缺陷。`.vscodeignore` 的职责是排除不必要的文件；`.map` 的存在与否由构建脚本决定（`esbuild.js:38-41` 在非 sourcemap 构建中删除残留文件），发布工作流再单独断言 VSIX 内无 `.map`。当前 `dist/` 与 VSIX 内均无 `.map`。建议（非阻塞）可在 `.vscodeignore` 加一行 `**/*.map` 作为第三道保险。

---

## 七、测试质量专项

### 7.1 重点用例是否"回退后仍通过"

| 用例 | 回退操作 | 结果 |
|---|---|---|
| 不变量用例（完整恢复 pass 无 stash 删除 argv） | 注入 `stash drop stash@{0}` | **6 项失败**，含该用例 |
| 命令执行用例（未解析槽位） | 恢复 `stash:<sha7>` 回退 | **失败**（`an unresolvable slot falls back to commands that Git can still run`） |
| `winpid` 判活用例 | 把 `directKill()` 移到 `taskkill` 之前 | **失败**，失败点为"the grandchild process was reaped" |
| 横幅关闭用例 | 回退 `observePendingWarning` 的文本刷新分支 | 单元级 **失败**；provider 级 **失败** |

四个重点用例**全部**在对应修复被回退时失败。判定：**测试有效，不存在"修不修都通过"的空洞**。

### 7.2 唯一发现的无覆盖文案

F-2 的 `安全副本 …（sha sha）` 字符串**没有**任何测试断言（`grep -rn "安全副本" test/` → 0）。这是本轮唯一发现的测试缺口，与 F-2 的严重级别一致（P3）。

### 7.3 未重复运行全量套件

按要求未重跑 17 分钟的全量套件（协作方已报告 213/213 通过）。本轮只做定向运行：`gitRunner.integration.test.ts`（7/7 通过）、不变量用例（1/1 通过），以及在临时副本上的回退对照实验。

---

## 八、第 1–5 轮整改项汇总判定

| 轮次 | 主要发现 | 本轮判定 |
|---|---|---|
| 第 1 轮 | 侧栏 tooltip/右键菜单、写锁可解释、文件日志 | 已落地，证据见 0.8.0 发布说明与 `test/webviewDom.test.ts`、`test/mutationLock.test.ts`、`test/fileLogger.test.ts` |
| 第 2 轮 | 探测失败被当作"已恢复"、失败的 `stash list` 被当作"已消失" | 已修复：三部分默认 `"unknown"`；`stashShas()` 区分"未知"与"空" |
| 第 3 轮 | 仅凭祖先关系判定已并入 amend；索引匹配即清记录 | 已修复：`stagedSnapshotInHead` 用 `git ls-tree` 比对 mode + object；要求全部正面证据 |
| 第 4 轮 | 永久 pending 无出口；自动 drop 可能删除唯一副本 | 已修复：横幅给出可执行命令；**自动删除整体退役** |
| 第 5 轮 | `stash:<sha>` 回退、槽位冻结、空洞 winpid 判活、死代码 | **本轮复核：全部已修复且测试有效**（见第三节） |

---

## 九、发布判定

**批准发布。**

理由：

1. **核心不变量成立**：`src/` 中不存在任何自动可达的 `stash drop` / `pop` / `clear` argv；唯一的 `stash pop` 位于用户显式点击并经模态确认的 "Pop Stash" 命令。实证上，一次覆盖两条恢复分支的完整 pass 经 Git 调用观察器确认零删除 argv，且两条 stash 均存活。误判的最坏结果确为"多留一个 stash"。
2. **第 5 轮 4 项整改全部落实**，且对应测试在回退时会真实失败（非空洞）。
3. **发布完整性全部通过**：版本号三处一致、发布说明标题与占位符合规、`RELEASE.md` 条目存在、测试计数 213 与真实套件一致、VSIX 12 文件且无源码/测试/文档/依赖/`.map`、工作流门禁覆盖版本匹配与产物内容。
4. 未发现 P0/P1/P2。仅 2 个 P3（F-2 产品提示文案、F-3 发布说明措辞），均不影响功能、安全与不变量。

**放行条件（建议，非阻塞）**：

- 打 tag 前重跑一次 `npm run compile && npm run package`，确认 VSIX 晚于源码（当前工作树已满足：`dist` 14:29:38 < VSIX 14:30:28，且无 `src/` 文件晚于 `dist`）。这是针对 F-1 的流程性保险。
- F-2、F-3 可在 0.8.0 内顺手修正，或留给 0.8.1；不构成阻塞。

**结论**：0.8.0 可以在用户授权后进入打 tag 与发布流程。

---

## 十、评审方法与限制

- **未修改任何产品代码**：所有回退对照实验都在 OS 临时目录的独立副本中进行（`$TEMP/policy-revert`），完成后连同其子进程一并删除；临时仓库（`grv-test-*`、探针目录）均已清理。
- **进程卫生**：每次涉及进程的断言前都检查过进程表；只清理了本评审创建的进程。评审结束时的 hook/sleep 残留属于并发运行的另一个 agent 的全量套件，不是本轮产物。
- **未运行全量套件**：按要求只做定向运行，因此本报告不对"213/213"做独立背书，该数字由协作方的干净进程表运行提供；本报告只独立验证了"静态用例计数确为 213"。
- **本轮额外验证**：`tsc --noEmit` 与 `tsc -p tsconfig.test.json --noEmit` 均以退出码 0 通过（在工作树最终稳定状态上执行）。
- **F-1 的时间线**：评审期间工作树被并发修改，因此 F-1 记录的是"某一时刻产物落后"的事实与其自愈后的最终状态；最终状态已用 MD5 与字节级 diff 复核。
