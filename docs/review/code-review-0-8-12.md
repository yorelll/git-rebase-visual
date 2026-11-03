# Code Review 0-8-12 — 测试基础设施：拆分 pendingRecovery、移除聚合器、按文件并发 3

- 基线：`main` @ `0541b55f6ddf9cef49f9766bcbff2c8aa9be9849`（`fix: release 0.8.2 — append restore, own-stash cleanup, abort never deletes`）+ 未提交工作树（11 项：4 个已跟踪文件修改、2 个删除、5 个新增）
- 评审性质：**测试基础设施**。本次不改变任何产品行为；`src/` 无改动（`git status` 中无 `src/` 条目）。
- 方法：Node `v24.16.0`、`tsx 4.23.13`、Git `2.45.0.windows.1`。破坏性探针全部在 OS 临时目录内执行（`probe_glob*`、`probe_runner`、`probe_npm`、`probe_gate`、`probe_spawnerr`、`oldtree`、`oldcount`），结束前已全部删除；探针产生的 `grv-test-*` 临时仓库残留 0 个。
- 工作树：`git status --short` 开始时 **11** 项，结束时 **12** 项。多出的 1 项是本报告 `docs/review/code-review-0-8-12.md`（本次唯一允许写的文件）。`HEAD` 未变，`git stash list` 为空。
- **评审期间发生了并发改动**（另一个代理，非我）。我出具初稿后，`scripts/run-tests.js` 在 `13:47` 被修改（实现了 P2-1 的守卫与 P3-3 的 `error` 监听），`docs/research/test-performance.md` 在 `13:42` 加了 superseded 横幅，`docs/review/code-review-commit.md` 在 `13:46` 登记了 `0541b55`。这些改动**我未参与**；第十一节记录了我在这些改动之后对运行器新代码的**复核**结果。三条我在本报告中记下的 P2/P3 因此已从"待办"变为"已实现并复验"。
- **完整套件未运行**（规则要求）。我独立运行的是三个拆分包各自的**完整文件**，以及用于评估门禁的三次 `npm` 级探针；实现者的 275/275 全量与 684 s 计时我未独立复核，报告中凡引用其数字处均已标注。

---

## 一、结论摘要

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 拆分是否真正机械 | **通过**。60 个函数体逐个 sha256 比对，**全部字节相同**；无重名、无遗漏、无新增；275 总数前后一致；6 个 helper 仅差 `export` |
| 2 | 运行器能否静默漏跑 | **通过（含评审后补强）**。初审时发现顶层枚举会静默跳过子目录测试文件（P2-1）；评审期间该守卫已被实现，我复验：子目录/深层嵌套 → 列出文件名并 **exit 1**，零文件 → exit 1，import 抛错 → 失败且 exit 1，真实树无误报 |
| 3 | 退出码传播 | **通过**。失败探针在 `npm test` / `test:coverage` / `test:release` 三级全部 exit 1；typecheck 单独为 0，归因清晰；换回通过探针三级全部 exit 0 |
| 4 | 覆盖率可达范围 | **通过**。旧聚合器与新枚举所达 `src/` 模块**完全相同（34/34，增 0 减 0）**；`src/extension.ts` 在 `0541b55` 时同样未被覆盖，实现者的说法**属实** |
| 5 | 并发安全 | **通过**。无 `process.chdir`、无测试内 `process.env` 赋值、无固定临时路径；5 处 `setGitInvocationObserver` 全部在 `t.after` 清除；三个包各自独立运行全绿 |
| 6 | CI 兼容 | **通过**。`npm ci` 干净克隆可用；脚本只用 Node 标准库 + `node_modules/tsx`（devDependency）；枚举在 Node 内完成，不依赖任何 shell 的 `*`/`**` 语义 |
| 7 | 文档 | **通过**。`README.md` / `RELEASE.md` / `docs/summary/summary.md` 已更新；**没有任何活文档仍指向被删的两个文件**；`275` 计数仍成立 |
| 8 | 研究报告的错误 | **(a) 属实**（严重过时）；**(b) 已过时**——在当前树上不成立，见 P3-1。报告已由另一代理加 superseded 横幅，理由写的是 Node 20 不认 glob 参数（与我的独立结论一致） |

**发布裁决：批准。** 测试基础设施的这一改动可以随 0.8.2 之后的版本发布，**发布门禁仍然可信**。初审发现 1 个 P2、3 个 P3，均不阻塞发布；其中 P2-1、P3-1、P3-2、P3-3 在评审期间已由另一代理实现，我在第十一节做了独立复验（P3-2 因 `core.autocrlf` 归一化而无需动作，见该节）。

---

## 二、第 1 项：拆分确实机械（通过）

### 2.1 方法与结果

用脚本把 `test("...")` 到闭合 `});` 的整段（含签名行、函数体、内部注释）切出，按**测试名**建立映射并逐体计算 sha256，两侧统一 CRLF→LF 后比较。

```
ORIG count: 60
pendingRecovery.settle.integration.test.ts   18
pendingRecovery.append.integration.test.ts   17
pendingRecovery.residual.integration.test.ts 25
NEW total: 60
Missing from new: []      Extra in new: []      BODY DIFFERS: []      DUP ACROSS SHARDS: (none)
```

18+17+25 = 60，与实现者声明一致。**60/60 函数体哈希相同**，因此"没有断言被改、没有测试被丢、没有测试被复制"三项同时成立。

### 2.2 总数

| 来源 | 顶层 `^test(` 计数 |
|---|---|
| `0541b55` 树（除 `index.test.ts`） | **275** |
| 当前工作树（43 个文件） | **275** |

两侧均为 275，与实现者、`RELEASE.md`、`docs/summary/summary.md:146` 的记录一致。

### 2.3 helper 抽取

原文件恰好声明 6 个模块级函数，`test/helpers/pendingRecoveryFixtures.ts` 恰好导出同名的 6 个；剔除 `export` 前缀后逐个 `IDENTICAL`：`cleanup`、`deleteLooseObject`、`pushUserStash`、`runOneCommandPerRepo`、`stashShaSet`、`stashSnapshot`。没有遗漏，也没有多余。

`runOneCommandPerRepo` 从原文件搬进 helper 是**行为等价**的：它只依赖 `createRepo`/`commitFile`/`removeRepo`/`stashSnapshot`/`stashNameForSha`/`runGit`，这 6 个在 helper 文件中都可解析（helper 自己 import 了 `gitTestRepo` 的 4 个与 `pendingRecovery`/`worktree`/`gitRunner` 的 3 个）。

### 2.4 导入

四个文件均**无未使用的命名导入**（逐个符号在去掉 import 区后的正文中出现）。三个包内无 `test.skip`、无 `todo`、无子测试。两个类型检查零输出（`tsc --noEmit`、`tsc -p tsconfig.test.json --noEmit` 均 exit 0）。

> 注：在本次评审的默认 shell 中直接跑 `npm run typecheck` 会因该 shell 的 `PATH` 含有 cmd.exe 无法解析的 MSYS 路径（且含一处游离引号）而报 `'node' 不是内部或外部命令`。这不是仓库缺陷——把 Node 正确放入 `PATH` 后两条命令均 exit 0。CI 的 `ubuntu-latest` 不受影响。

---

## 三、第 2 项：运行器能否静默漏跑（初审 1 个 P2，评审期间已修复并复验）

在隔离目录中把 `scripts/run-tests.js` 原样复制，配上**真实 `tsx`**，逐项构造：

| 探针 | 结果 | 判定 |
|---|---|---|
| 零个测试文件 | `No test files found under ...`，**退出码 1** | ✅ 不会绿 |
| 失败用例 | `fail 1`，**退出码 1** | ✅ |
| 文件在 **import 期**抛错 | 该文件被记为 `✖ ... 'test failed'`，**退出码 1**（不是跳过） | ✅ |
| 非 `.test.ts` 的 `.ts` 文件抛错 | 不被收集，套件仍绿 | ⚠️ 设计如此（helpers 同规则），可接受 |
| 运行中途新建 `.test.ts` | 本次不计入，**下次运行计入** | ✅ 只影响并发窗口，不是"永久漏跑" |
| 名字叫 `weird.test.ts` 的**目录** | 不被收集（`isFile()` 过滤） | ✅ |
| 子目录 `test/sub/nested.test.ts` | **不被收集** | ⚠️ 见 P2-1 |
| 符号链接的 `.test.ts` | 因 `Dirent.isFile()` 对 symlink 为 `false` 而**不被收集**（Windows 下无法创建符号链接实测，依 Node `Dirent` 的 lstat 语义判断） | ⚠️ 见 P2-1 |
| `node_modules/tsx` 缺失 | `MODULE_NOT_FOUND`，**退出码 1** | ✅ 失败关闭 |
| `spawn` 本身 ENOENT | 未处理的 `'error'` 事件使进程崩溃，**退出码 1** | ✅ 失败关闭（只有报错不友好） |

**当前树上没有漏跑**：递归扫描 `test/**/*.test.ts` 得 **43**，运行器枚举得 **43**，差集为空。三个拆分包目录形态（`test/helpers/`、`test/tarot-flow/`）均不含 `.test.ts`。

---

## 四、第 3 项：退出码传播（通过）

在 `0541b55` 的干净克隆上叠加本次改动、`npm ci` 后植入一个必然失败的 `test/zz-probe-fail.test.ts`：

| 命令 | 未知探针时 | 通过探针时 |
|---|---|---|
| `npm test` | **exit 1** | exit 0 |
| `npm run test:coverage` | **exit 1** | exit 0 |
| `npm run test:release` | **exit 1** | exit 0 |
| `npm run typecheck`（单独） | exit 0 | exit 0 |

typecheck 单独为 0，说明 `test:release` 的 exit 1 **可归因于测试**而不是先失败于类型检查。"门禁永远绿"的担忧不成立。

> 过程中有一次 `test:coverage EXIT=0` 是我的操作失误造成的假象：我在后台任务两次 npm 调用之间删掉了探针文件。隔离重做后三级均为 exit 1。特此记录，避免后续读者误读。

`--experimental-test-coverage` 在 Node 24 上仍正常产出报告（我实测到一个非空报告；实现者的 `all files 73.37%` 未复核）。该 flag 若在未来 Node 版本被移除，`test:release` 会以参数错误失败关闭，而不是静默跳过覆盖率——这是可接受的失效方向。

---

## 五、第 4 项：覆盖率可达范围（通过）

从 `git archive 0541b55 test src` 导出旧树，用同一套 import 图遍历（同时识别 `from "..."` 与裸 `import "..."`）对比：

```
                        旧（仅 index.test.ts 入口）   新（43 个 test 文件入口）
测试文件图规模           44                          46
src 模块可达数           34                          34
LOST                     []                          —
GAINED                   []                          —
从未被覆盖的 src         config.ts, diagnostics.ts, extension.ts, messageGen.ts,
                        composePanel.ts, generatedDiffProvider.ts, rebaseViewProvider.ts, worktreeDiff.ts
```

两侧"从未覆盖"集合**完全相同**。`src/extension.ts` 在旧聚合器下同样不可达——**实现者的说法属实**。拆分与去聚合器**没有丢失任何用于覆盖率的模块**。

---

## 六、第 5 项：并发安全（通过）

### 6.1 进程边界

每个 `*.test.ts` 由 Node 的 test runner 在**独立子进程**中执行，`--test-concurrency=3` 只限制同时运行的文件数。因此 `src/git/gitRunner.ts:118` 的模块级 `invocationObserver`、`commitLog.ts` 的 `cachedGitVersion` / `patchIdCache`、`secretsAccess.ts` 的 `current` 等进程内可变状态**不跨文件共享**。旧聚合器把 41 个文件塞进一个进程，反而让这些状态**跨文件共享**；去掉聚合器是降低了这类耦合，不是引入。

### 6.2 逐项扫描

| 危险源 | 结果 |
|---|---|
| `process.chdir` | `test/` 与 `src/` 中**零处** |
| 测试内 `process.env.X =` | **零处** |
| 固定临时路径 | 仅 `fileLogger.test.ts:183`（`.../readonly/<pid>`，且注入的 `io.mkdirSync` 直接抛错，不落盘）与 `:202`（注入 `appendFileSync` 直接抛错）。其余全部 `mkdtempSync`，且 `createRepo()` 用 `os.tmpdir()` + 随机后缀 |
| `setGitInvocationObserver` | 5 处，**全部**在 `t.after` 中 `setInvocationObserver(undefined)`：`gitRunner.integration.test.ts:119/238`、`pendingRecovery.residual.integration.test.ts:210/395`、`recoveryProvider.test.ts:323`。同文件内测试顺序执行，无泄漏窗口 |
| 依赖"别的测试先跑过" | 未发现。三个包内**无模块级可变声明**（无顶层 `const/let` 数组/对象），每个用例自建仓库并 `t.after` 清理 |
| 模块级可变状态（测试侧） | 仅 `llmClient.test.ts:6` 等**只读**常量 |

### 6.3 实测

三个包**各自单独**运行（各自独立进程，无并行）：

```
settle   EXIT=0   407 s
append   EXIT=0   492 s   （复跑确认：tests 17 / pass 17 / fail 0）
residual EXIT=0   548 s   （复跑确认：tests 25 / pass 25 / fail 0）
```

三者都独立全绿，说明包之间没有隐藏的顺序依赖。

### 6.4 一次由我造成的 `EXIT=1`，以及它反过来说明的事

评审收尾阶段有一个后台任务报告 `append EXIT=1`、`residual EXIT=1`。**这是我自己的操作失误**，不是缺陷：该后台任务在循环里反复跑全量套件，而我在同一时间执行 `rm -rf` 清理 `grv-test-*` 临时仓库，**删掉了它正在使用的仓库**。同样的两个包在无干扰下复跑均为 `17/17` 与 `25/25` 全绿。

这反而是一条正面的证据：**当测试所依赖的外部状态被破坏时，套件以非零退出码失败，而不是假装通过。** 与第四节的失败探针一致，门禁在"环境被破坏"这一维度上也是失败关闭的。

### 6.5 一处需要留意的（非本次引入）

`gitRunner.integration.test.ts` 有两条**上界型**计时断言：`elapsed < 10_000`（`:84`）与 `elapsed < 20_000`（`:167`），`llmClient.test.ts:249` 有下界 `>= 900`。并发 3 会抬高机器负载，上界型断言在极端负载下理论上可能变脆。但：① 20 s 的上界对应"hook 睡 30 s"，余量 10 s；② 这些断言在旧聚合器下同样受外部负载影响；③ 我三次独立运行与实现者的全量运行都未复现失败。**不构成缺陷，记录备查。**

---

## 七、第 6 项：CI 兼容（通过）

`.github/workflows/release.yml`：`runs-on: ubuntu-latest`、`node-version: 20`、`npm ci` → `npm run test:release`。

- **干净克隆 `npm ci`**：在临时克隆上执行成功（325 包，exit 0）。
- **依赖**：`scripts/run-tests.js` 只 `require` 了 `fs` / `path` / `child_process`（Node 标准库），以及 `node_modules/tsx/dist/cli.mjs`；`tsx` 在 `devDependencies`（`^4.20.0`），`npm ci` 默认安装 devDependencies。**没有额外依赖**。
- **POSIX sh**：脚本**不做任何 shell glob**，枚举发生在 Node 内，因此 `*` / `**` 的展开规则差异与它无关。`spawn(process.execPath, args)` 在 Linux 上直接执行 node，不经过 shell。
- **Windows 无依赖**：脚本里没有 `.cmd`、反斜杠硬编码或 `cmd.exe` 调用；`path.join` 由 Node 按平台拼。注释中指出的"`node_modules/.bin/tsx` 在 Windows 是只有 `cmd.exe` 能启动的 `.cmd` 垫片"正是它选择 `process.execPath` 的原因——这是**去掉**平台依赖，不是引入。
- **Node 20 上的 `--test` 参数**：见 P3-1。枚举方案恰好规避了 Node 20 对 glob 参数支持不足的问题，这一点是**加分项**。

---

## 八、第 7 项：文档（通过）

- `README.md:106`、`RELEASE.md:118`、`docs/summary/summary.md:120` 均已写明新入口与并发 3；`summary.md:143` 的"恢复集成"行已拆成三行并标注共用夹具。
- **活文档中已无** `test/index.test.ts` 或 `test/pendingRecovery.integration.test.ts` 的引用（`README.md` / `RELEASE.md` / `docs/summary/summary.md` 三处 grep 均为空）。
- `docs/summary/summary.md:146` 的 **275** 仍准确（实测 275）。
- 历史评审文档（`code-review-0-3-0.md` 等）中的旧文件名属于**审计记录**，按 `CLAUDE.md` 不得改写，保留正确。
- `docs/research/test-performance.md` 见 P3-2。

---

## 九、第 8 项：研究报告的错误

### (a) 报告写于过时的树 —— **属实**

| 报告声称 | 当前实际 |
|---|---|
| 217 个测试 | **275** |
| 41 个测试文件 | **43** |
| `pendingRecovery.integration.test.ts` 内 36 个测试 | 拆出后 **60** 个 |
| `test/index.test.ts` 是入口 | 已删除 |

报告标题自述"2026-10-30"，而 `0541b55` 已把套件从 217 扩到 275。四个数字全部对不上。

### (b) 报告的 glob 会重复收集 —— **在当前树上不成立，实现者的说法已过时**

我实测了三种情形：

1. **有聚合器时**：目录含 `a.test.ts`、`b.test.ts`、`agg.test.ts`（后者 import 前两者），`tsx --test "*.test.ts"` → `tests 5`（A、B 各跑两遍）。**重复收集确实发生**，实现者"某次 glob 得到 tests 550"的测量在这个前提下是真实的。
2. **无聚合器时**：同样目录删掉 `agg.test.ts` → `tests 2`，**不重复**。
3. **在真实仓库上**（聚合器已删）：`node node_modules/tsx/dist/cli.mjs --test "test/**/*.test.ts"` 收集到 **43** 个文件，与运行器枚举的 43 **完全一致**，没有翻倍。

结论：**重复收集的成因是"glob 匹配到了聚合器文件"，而不是 `**` 本身。** 聚合器一删，这个具体危害就消失了。因此运行器注释里那句"any file that imports every other file would then be collected as well … measured: `tests 550`"是**对旧树的测量**，在当前树上无法复现。见 **P3-1**。

但**枚举的设计仍然是对的**，理由与注释所写不同（而且更强）：见 P3-1 的建议改法。

### (c) 2.6x 投影未复现 —— 未独立复核

实现者 1.73x、评审者 2.53x，我未复跑全量，不表态。

---

## 十、新发现（按严重度排序）

> 本节的四条发现均为**初审结论**；其中 P2-1、P3-1、P3-3 在评审期间已被另一代理实现或改写，我的独立复验见**第十一节 bis**。保留原文以便审计"发现→修复"的对应关系。

### P2-1：运行器只枚举 `test/` **顶层**，新增子目录测试文件会被静默跳过

`scripts/run-tests.js:26-31`：

```js
fs.readdirSync(testDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
```

`entry.isFile()` 为假即跳过。两条后果：

1. 任何 `test/<子目录>/*.test.ts` **不会被运行，也不会报错**。当前树无此情况（递归 43 = 枚举 43，差集为空），但 `test/` 下已存在 `helpers/` 与 `tarot-flow/` 两个子目录，未来把集成测试按目录分组是很自然的演进。
2. 符号链接的 `.test.ts` 同样被跳过（`Dirent` 基于 lstat，symlink 的 `isFile()` 为 `false`）。

这**不是回归**（旧聚合器同样只登记顶层文件），但**旧的"登记"是显式清单，新增文件不登记会立刻被 review 发现；新的"枚举"看起来是自动的，漏掉反而更隐蔽**。用户最关心的正是"套件跑得很快但漏了测试"。

**建议**（3 行，零风险）：

```js
const strays = fs.readdirSync(testDirectory, { recursive: true })
  .filter((p) => p.split(path.sep).length > 1 && p.endsWith(".test.ts"));
if (strays.length > 0) {
  console.error("Test files outside the enumerated top level:", strays);
  process.exit(1);
}
```

不阻塞发布：当前树已验证 43 = 43，无遗漏。

### P3-1：运行器注释与研究报告对 glob 的判断已过时，可能诱导后人改回 glob 而在 Node 20 上失败

`scripts/run-tests.js:8-13` 用"会重复收集、实测 tests 550"作为不使用 glob 的理由。该测量**只在聚合器存在时成立**（第九节 (b) 已实测）。一位后人若按当前树验证"glob 也不会重复"，很可能把 `package.json` 改回 `tsx --test "test/**/*.test.ts"`——**而在 CI 的 Node 20 上这会失败或找不到文件**，因为 `node --test` 接受 glob 参数是较新版本才有的能力，Node 20 把参数当字面路径。同样的风险存在于 `docs/research/test-performance.md:289` 的候选 B 建议。

**建议**：
1. 把注释的理由改成真实的那一条（枚举不依赖 Node 版本对 glob 参数的支持、不依赖 shell 对 `**` 的展开、零文件可报错），并保留 historical 的 550 测量作为"当时"的注记；
2. 给 `docs/research/test-performance.md` 顶部加一行 superseded 横幅：说明实际实施的是枚举而非 glob、当前为 275 测试 / 43 文件 / `pendingRecovery` 已拆为三份 60 个测试，且**不要照抄 §候选 B 的 `test/**/*.test.ts`**。报告的测量方法与结论（拆分收益、并发 3 上限）仍然有效，不必重写；但它不能再被当作可直接执行的实施方案。

### P3-2：行尾声明不准确（不影响提交内容）

实现者称"行尾统一为 CRLF 以匹配仓库"。实测：

| 文件 | 磁盘 |
|---|---|
| 三个拆分包 | CRLF |
| `test/helpers/pendingRecoveryFixtures.ts` | LF |
| `scripts/run-tests.js` | LF |
| `test/recoveryProvider.test.ts`（未改动） | CRLF |
| `test/worktree.integration.test.ts` 等多数文件 | LF |
| `0541b55` 的原始 `pendingRecovery.integration.test.ts` | LF |

仓库本身是**混排**的，没有一个统一的"仓库风格"。且 `core.autocrlf=true`、无 `.gitattributes`，`git` 在入库时会把 CRLF 归一为 LF——我用 `git hash-object --path` 验证了三个拆分包会被 normalize，因此**提交后的 blob 不会是 CRLF，也不会有混合行尾入库**。属于措辞问题，不是缺陷。

### P3-3：`spawn` 无 `'error'` 监听器（失败方向正确，只是信息不友好）

`child.on("close", ...)` 存在，`child.on("error", ...)` 不存在。若 `process.execPath` 本身无法执行，Node 以未处理的 `'error'` 事件崩溃。我实测退出码为 **1**，即**失败关闭**，门禁安全。只是输出是原始堆栈而非一行 `Test runner could not start: ...`。可选改进，不影响发布。

---

## 十一、其他已核实项

- **VSIX**：`node scripts/package-vsix.js --verify-only` → `VSIX contents match the allowlist (12 entries)`，exit 0。解包比对：`extension/dist/extension.js` 与仓库 `dist/extension.js` 的 sha256 **均为 `3f2dc7d2…80f77`，字节相同**；12 个条目中无 `src/`、`test/`、`docs/`、`node_modules/`、`tsconfig` 或 sourcemap。
- **两个类型检查**：均 exit 0（绕过本 shell 的 `PATH` 问题后）。
- **台账**：`0541b55` 目前**不在** `docs/review/code-review-commit.md` 中。按 `CLAUDE.md`，本次评审完成后应把该 SHA 与 `code-review-0-8-12.md` 一并登记。**本次评审只被允许写本报告文件，未改动台账**——此项留给主 agent 在同一次变更中补齐。

---

## 十一bis、评审期间由另一代理实现的三项修复的独立复验

我的初稿出具后，`scripts/run-tests.js` 与两份文档被另一代理修改。为避免"报告描述的还是旧代码"，我对新代码逐条复验。

### P2-1 顶层枚举守卫 — **已实现，实测有效**

新增 `collectStrays()`：递归下探所有子目录，发现 `*.test.ts` 即收集；顶层"像测试文件但不是常规文件"（如符号链接）也收集；任一命中则打印相对路径并 `process.exit(1)`。

实测（隔离目录 + 真实 `tsx`）：

| 场景 | 结果 |
|---|---|
| 干净树（仅顶层 `a.test.ts`） | `tests 1`，**exit 0** |
| `test/sub/nested.test.ts` | 打印 `test\sub\nested.test.ts`，**exit 1** |
| `test/a/b/c/deep.test.ts`（三层） | 打印该路径，**exit 1** |
| 零个测试文件 | `No test files found under ...`，**exit 1** |
| **真实仓库**（43 文件，含 `test/helpers/`、`test/tarot-flow/`） | **无任何误报**，exit 0 |

对我的 P2-1 建议的改进：我没有要求递归**下探**所有层级，实现做得更彻底（任意深度）。真实树上 `test/helpers/` 与 `test/tarot-flow/` 都不含 `*.test.ts`，所以零误报——这条设计是安全的，因为**只有看起来像测试套件的文件才会中止**。

**一个遗留的过宽之处（P3-4，新增，不阻塞）**：`collectStrays` 的 `if (entry.isSymbolicLink())` 分支对**任何**符号链接都会中止，不管它是否像测试文件。今天 `test/` 下符号链接数为 **0**（`find test -type l` 为空），所以是潜在问题而非现实问题。若将来为夹具加入一个符号链接（例如把 `test/tarot-flow/.git` 或某张图片链出去），运行器会拒绝运行并报一个与测试无关的路径。建议把该分支收窄为"符号链接且名字以 `.test.ts` 结尾，或链接目标是目录"。**该分支在本环境无法实测**（Windows 不允许创建符号链接，`EPERM`），以上为代码推理，据实标注。

### P3-3 `spawn` 的 `error` 监听 — **已实现**

`child.on("error", ...)` 现在打印 `Test runner could not start (<node>): <message>` 并 `process.exit(1)`。此前我实测未监听时退出码也是 1（失败关闭），所以这是**信息改进**而非安全性修复——现在失败时给出一行可读原因，而不是原始堆栈。

### P3-1 运行器注释的理由 — **已改写，且与我的结论一致**

新注释把理由改为三条：① CI 固定 Node 20，而 `node --test` 接受 glob 参数是 Node 22 起的能力，Node 20 会把 `test/**/*.test.ts` 当字面路径；② bash 与 cmd.exe 的 `*`/`**` 展开规则不同；③ 空枚举报错而不是零测试绿。

并把 `tests 550` 的重复收集**明确降级为历史注记**，写明"聚合器删掉后 glob 不再重复计数，这正是必须把理由记准确、而不是凭记忆复述的原因"。这与我在第九节 (b) 的独立实测**完全一致**。`docs/research/test-performance.md` 也加了 superseded 横幅，同样以 Node 20 为核心理由。

### P3-2 行尾 — **无需动作**

拆分包在磁盘上仍是 CRLF（439/716/910 行，零裸 LF），helper 与脚本仍是 LF。但由于 `core.autocrlf=true` 且无 `.gitattributes`，`git` 在入库时归一为 LF（我已用 `git hash-object --path` 逐个验证会被 normalize）。因此**提交后的 blob 不会混入 CRLF**，这条只是措辞不精确，不构成缺陷。无需改动。

### 复验后的净结论

初审的 P2/P3 **全部有了着落**：P2-1 与 P3-3 已实现并有我的独立实测背书，P3-1 已改写且与我的实测一致，P3-2 经核实无需动作。新增仅一条 P3-4（符号链接分支过宽，当前零触发）。**裁决不变：批准。**

---

## 十二、发布裁决

**批准。** 理由：

1. **拆分是真正机械的**——60/60 函数体 sha256 相同，是本次改动唯一可能引入"测试语义悄悄变化"的地方，已排除。
2. **发布门禁仍然可信**——这是本次最关键的结论。我用三种独立方式验证：失败用例让 `npm test`、`test:coverage`、`test:release` **三级全部 exit 1**；import 期抛错让运行失败而非跳过；零文件显式 exit 1；`node_modules/tsx` 缺失也 exit 1。换回通过探针后三级全部 exit 0，且 typecheck 单独为 0 使归因清晰。**"跑得快但测试失败也绿"的情形没有出现。**
3. **覆盖率没有缩水**——旧新两侧可达 `src/` 模块集合完全相同（34/34），`extension.ts` 本来就没被覆盖。
4. **并发是安全的**——无共享临时路径、无 `chdir`/`env` 突变、观察器全部在 `t.after` 清除，且三个包各自独立运行全绿。
5. **CI 可用**——干净 `npm ci` + POSIX 下可运行，且枚举方案恰好规避了 Node 20 不支持 glob 参数的问题。

唯一的 P2 不阻塞：当前树已验证**递归扫描 43 = 枚举 43，零遗漏**；它描述的是"未来新增子目录测试文件"的隐患。该守卫在评审期间已被另一代理实现，我复验有效（见第十一节 bis）。

**评审期间被并发修改，需主 agent 知悉**：`scripts/run-tests.js`、`docs/research/test-performance.md`、`docs/review/code-review-commit.md` 在我的初稿之后由另一代理改动，**我未参与**。我在第十一节 bis 对其中的运行器代码做了独立复验（通过）。`code-review-commit.md` 已登记本报告的条目，其中"P2-1/P3-1/P3-2/P3-3 已在本轮一并修正"的说法，就 P3-2 而言偏宽（该条经核实无需动作），其余与我的复验一致。

**未独立确认的**：275/275 全量、684 s 计时、覆盖率 `73.37%`。我实际运行的是三个拆分包各自的完整文件（18/17/25 全部通过，各自 exit 0）。
