## 0-8-0 回复（对应 `code-review-0-8-0.md`）

### 评审基线

- 基线 commit：`4a1e2088ee5c83202eab9e17ad83f5372dbf21e3`（`chore: release v0.7.1`，tag `v0.7.1`）+ 0.8.0 的**未提交工作树**（`git diff` + untracked）。
- 0.8.0 的这些改动**尚无任何 commit SHA**：本回复与评审报告一样只能以基线 SHA 为覆盖锚点；提交后必须由后续独立评审按真实 SHA 再覆盖一次。
- 本文件只处理 `code-review-0-8-0.md` 的 F-1/F-2/F-3，不修改 B 的报告、不改写 `code-review-commit.md`、不创建任何 tag/release。

### 逐项决定

| 编号 | 级别 | 决定 | 说明 |
| --- | --- | --- | --- |
| F-1 | 过程性（非产品缺陷） | 已处置，不持有异议 | 属构建与并发编辑的时序竞态；已按报告建议在源码冻结后重新 `compile && package`，产物晚于全部源码（见“修复证据”），未改代码。 |
| F-2 | P3 | **已修复**（由协调 agent 修复，非本实施 agent） | `restoreAppendSnapshot` 的冲突提示不再出现字面量 `sha sha`。本实施 agent 复核后确认修复正确、未重复修改，并用回退实验证明新增用例非空洞。 |
| F-3 | P3 | **已修复** | 发布说明措辞改为“每一轮恢复检查时重新解析”，并显式说明“不是每次界面重绘都去查询 Git”，与实现一致。 |

- [x] F-1 已复核（产物新鲜度重新验证通过）
- [x] F-2 已修复并验证（修复者为协调 agent；回归用例在还原缺陷后确实变红）
- [x] F-3 已修复（文档措辞与实现对齐）

### 修复证据

#### F-1 产物新鲜度

- 处置：报告发布建议为“打 tag 前重跑 `compile && package`，确认 VSIX 晚于源码”。协调 agent 于 15:57 重建。
- 证据：`dist/extension.js` mtime `15:57:14`；`git-rebase-visual-0.8.0.vsix` mtime `15:57:36`（142,615 字节，12 文件）；`find src test media docs README.md RELEASE.md package.json package-lock.json esbuild.js .vscodeignore .github -newer git-rebase-visual-0.8.0.vsix -type f` 仅命中 `docs/release-notes/0.8.0.md`（16:03 的文档措辞修改，不参与打包，`.vscodeignore` 已排除 `docs/`）。
- VSIX 内 `extension/package.json` 版本为 `0.8.0`；`dist/extension.js` 内含 `TASKKILL_TIMEOUT_MS`、`taskkill /pid … /T /F` 与 `const applyTarget = name ?? sha`。

#### F-2 冲突提示的字面量 `sha sha`

- 位置：`src/ui/rebaseViewProvider.ts:1715`（`restoreAppendSnapshot` 的 pending 分支）。
- 当前实现：

  ```ts
  `恢复原始改动时有冲突：${outcome.reason}。安全副本 ${name ?? "（当前槽位无法解析）"}（sha ${sha.slice(0, 7)}）仍保留，可手动执行：${steps[0].command}`
  ```

- 修复者：**协调 agent**（本实施 agent 未重复修改该行；复核时 `diff` 确认与协调 agent 的版本一致）。
- 回归用例：`test/recoveryProvider.test.ts:402` —— `a conflicted restore names the recovery stash by slot and by sha`。该用例构造真实冲突（worktree 内容与 stash 冲突），直接调用 `restoreAppendSnapshot`，然后断言：无 `sha sha`、含真实短 sha、含解析出的 `stash@{0}` 槽位、含可执行命令、`refs/stash` 仍等于原 sha（副本未被删除）。
- 非空洞验证（在 OS 临时目录的独立副本中，把该行改回字面量 `（sha sha）`）：

  ```text
  ✖ a conflicted restore names the recovery stash by slot and by sha
    AssertionError [ERR_ASSERTION]: no unfilled placeholder reaches the user
  ℹ tests 1  pass 0  fail 1
  ```

  恢复后同一用例通过（`✔ … 15680.6ms`，`ℹ tests 1  pass 1  fail 0`）。临时副本已删除，工作树未被改动。

#### F-3 发布说明措辞

- 位置：`docs/release-notes/0.8.0.md:30`。
- 现文：槽位名在**每一轮恢复检查时重新解析**（不是缓存在首次出现的值上）……“注意这是按恢复检查的节奏刷新，不是每次界面重绘都去查询 Git。”
- 与实现一致：`src/ui/rebaseViewProvider.ts:1548` 的 `applyPendingOutcome` 每轮调用 `stashNameForSha`；`refresh()` 只从持久化状态读取文本。
- 同时复核 `src/ui/rebaseViewProvider.ts:1605` 的 `pendingWarningText` 与 `resetExtensionState` 的保留消息：两者都已插值真实短 sha，未发现残留字面量。

### 未修改/延后项的具体理由

无。F-1/F-2/F-3 均已处置，没有延后或拒绝项。

### 最终验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `tsc --noEmit`（`node ./node_modules/typescript/bin/tsc --noEmit`） | 退出码 **0**，无输出 |
| `tsc -p tsconfig.test.json --noEmit` | 退出码 **0**，无输出 |
| 全量套件（`tsx --test test/index.test.ts`，从干净进程表启动） | **214 tests / 214 pass / 0 fail**，退出码 **0**，`duration_ms 999785`（约 16 分 40 秒） |
| 静态用例计数（`grep -rcE "^\s*test\(" test/*.test.ts` 求和） | **214**，与套件、发布说明一致；`208` 只命中 40 位 SHA 片段 |
| VSIX | `git-rebase-visual-0.8.0.vsix`，**12 文件 / 142,615 字节（约 139.27 KB）**；无 `.map`、无 `sourcesContent` / `sourceMappingURL`、无 `src/` / `test/` / `docs/` / `node_modules/` / `tsconfig*`；包内版本 `0.8.0` |
| 工作树 | 未提交；HEAD `4a1e208`，tag `v0.7.1`，`package.json` 版本 `0.8.0` |

### 本轮之后仍需独立复审的改动

B 的评审时间戳为 **2026-10-26 14:43:20**。以下文件在其后仍有改动，现有 `code-review-0-8-0.md` 未覆盖它们，需由下一份独立、按版本命名的 review 复核：

| 文件 | mtime | 改动内容 | 评审归属 |
| --- | --- | --- | --- |
| `test/gitRunner.integration.test.ts` | 15:04:32 | 测试侧进程泄漏修复：exit 结算用例的 hook 等待循环加上限（`i -lt 200`），清理时先等孙进程退出；超时用例的休眠改为有界 `0.1s` 循环 | 本实施 agent（第 5 轮响应内） |
| `src/git/gitRunner.ts` | 15:06:52 | 该 mtime 是**还原时间戳，不是内容变更**：15:06:25 备份、插入临时 `directKill(); return` 做回退验证、观察到 `✖ the grandchild process was reaped`、15:06:49 还原。`taskkill` 先行的顺序与 `TASKKILL_TIMEOUT_MS = 5_000` 早在第 6 轮评审快照（14:43）之前就已存在，已由 `code-review-0-8-0.md` 覆盖。 | 本实施 agent（仅回退验证，无净变更） |
| `test/recoveryProvider.test.ts` | 15:35:56 | 新增 F-2 回归用例 `a conflicted restore names the recovery stash by slot and by sha` | 协调 agent |
| `src/ui/rebaseViewProvider.ts` | 15:38:48 | F-2 修复：`restoreAppendSnapshot` 冲突提示插入真实短 sha | 协调 agent |
| `docs/summary/summary.md` | 15:39:15 | 测试计数与恢复横幅/进程回收用例描述同步 | 第 5 轮收尾 |
| `RELEASE.md` | 15:39:16 | 同上（214 项、winpid、测试侧泄漏说明） | 第 5 轮收尾 |
| `docs/release-notes/0.8.0.md` | 16:03:02 | F-3 措辞修正 + 计数 214 | 本回复 |

说明：

- `gitRunner.ts` 与 `rebaseViewProvider.ts` 的两处源码改动都是第 5 轮整改的**直接后续**：前者是“测试能否真正验证回收”的前提（先 taskkill 再直接 kill），后者是 F-2 文案。两者都已在定向用例与全量套件中通过，且全量套件的“超时只结算一次并回收孙进程”与“冲突恢复按槽位与 sha 命名”两条用例分别覆盖。未包含任何未获授权的产品行为变更。
- 本回复中的全部数字均为在最终工作树上实际运行所得，未沿用前一次运行的计数。
- 全量套件结束后复查进程表：无 `sh`/`sleep`/`git` 残留（`grv-test`、`sleep 0.1`、`sleep 30` 均 0 命中）。产品侧的限制如实记录在发布说明中：`taskkill /T /F` 只能沿树根枚举，**已脱离**或回收期间新建的孙进程可能存活——那是进程泄漏，但不再阻塞结算，也不再泄漏监听器/定时器/Promise。测试侧原先两处自泄漏（无限等待循环、单个 `sleep 30`）已修复。
