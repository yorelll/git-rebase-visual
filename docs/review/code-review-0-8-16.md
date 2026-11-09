# Code Review 0-8-16 — 0.8.3 第四轮复核（新发现 1–6 逐项实证、变异 1 复杀、新缺陷）

- 评审日期：2026-11-06
- 评审角色：独立评审（Agent B，第四轮）
- 基线 commit：`577ce8766a46707a60c471cf8090e9f63cd8d49c`（`test: run each file in its own process and split the slowest suite`）
- 被评审材料：基线之上的**未提交工作树**——`git diff 577ce87`（15 个修改文件）+ 7 个 untracked 文件（`src/ui/pushNotification.ts`、`test/pushNotification.test.ts`、`test/restoreFileProtocol.test.ts`、`docs/review/code-review-0-8-13/14/15.md`、`docs/release-notes/0.8.3.md`）。无新的可记录 commit SHA，本报告不改变这一事实。
- 评审对象包含发布产物 `dist-vsix/git-rebase-visual-0.8.3.vsix`。
- 本报告**不修改** `code-review-0-8-13/14/15.md`，也不修改账本；账本行需由维护者在同一次提交中补写（见 §六）。
- 环境：Windows 11 + MSYS Git `git version 2.53.0.windows.2`，Node `v24.16.0`（`/d/Program Files/nodejs/node`，`npm` 在该 shell 里解析不到 node，全部直接调用 `node`）。

---

## 一、结论摘要

| 项 | 结论 |
| --- | --- |
| 新发现 1（P2，pruned upstream 无反馈） | **已修复**，(a)(b)(c)(d) 四个子问题逐一实测通过；但 (c) 确有可测成本（见 §三.1） |
| 新发现 2（P3，`branch.<b>.remote = "."`） | **已修复**，确认框与通知共用同一份远端名单，`./other` 不再出现 |
| 新发现 3（P3，删除型 refspec 声称 HEAD 的标题） | **已修复**，真实删除走 `删除远端 ref` 措辞；普通推送未改口径 |
| 新发现 4（P3，`symbolic-ref` 恒不生效） | **已修复**，调用已删、`branch` 为必填、两个调用点（含 detached-HEAD）均通过 |
| 新发现 5（P3，`test-performance.md` 横幅） | **已修复**，横幅不再写死数字 |
| 新发现 6（P3，`gitRunner.ts` 审计表） | **已修复**，`pushRefspec` 归 prose 并注明 `LC_ALL=C`，`getUpstream` 归 structural |
| 变异 1（N-2 未被钉住） | **死亡**：把 `pushSource(refspec)` 改成常量 `"HEAD"` 后 `HEAD~1` 用例变红，恢复后 sha256 逐字节一致 |
| 本轮是否又引入新缺陷 | **是**。第四轮仍是"修一处、带一处"（见 §四） |

### 裁决：**不批准**

不批准 0.8.3 以当前工作树发布，**因此本评审不覆盖（不批准）`dist-vsix/git-rebase-visual-0.8.3.vsix`**。理由不是 A 的六项修复没做好——六项都真的修好了——而是本轮把 `pushSource(refspec)` 接进了 `git log` 的位置参数（`src/ui/rebaseViewProvider.ts:3083`），使一个**工作区设置即可控制的字符串**变成了 `git log` 的选项，实测可覆盖/截断任意可写文件（含 `.git/config`，把仓库写坏）。该缺陷已进入打包产物：VSIX 内的 `dist/extension.js`（sha256 `7d64b6c1…`）逐字节等于当前工作树构建结果，且其中**不含** `--end-of-options`。

同样需要说明的是一条**基线就存在**、本轮未引入但依然随 VSIX 出货的同类问题：`src/git/pushGuard.ts:176` 把 refspec 原样作为 `git push` 的位置参数，实测 `--receive-pack=<本地程序>` 会**执行本地程序**（§四.2）。它与本轮新缺陷同源（refspec 未与选项隔离），修复手段同样是 `--end-of-options`。

---

## 二、我实际跑了什么（以及没有跑什么）

**明确声明：完整套件（299 项）不是我跑的。** 我接手时另有一轮完整套件正在运行，按任务约束我没有启动第二个全量运行——这些用例会 spawn 真实 Git 与对时序敏感的子进程，并发跑曾产生假失败。我跑的是**定向文件**与真仓库探针：

1. `tsx --test test/pushNotification.test.ts test/restoreFileProtocol.test.ts` → **21 项通过、0 失败、0 跳过、144.2 s**（`pushNotification` 20 项 + `restoreFileProtocol` 1 项）。
2. 两个类型检查：`tsc --noEmit` 与 `tsc -p tsconfig.test.json --noEmit` → **均 exit 0、零输出**。
3. 两次变异实验（见 §三.7、§三.1），均先备份、后按字节还原，`sha256sum` + `cmp` 复核。
4. 真实临时 Git 仓库探针（含 bare 远端）约 25 个，覆盖：普通上游、被 prune 的上游、`branch.<b>.remote = "."`、自定义 `remote.<r>.fetch` 命名空间（两种）、嵌套命名空间、detached-HEAD 停在 `edit` 步的 rebase、重名 ref、`--mirror=fetch` 远端、选项注入路径。
5. 用真实 `RebaseViewProvider`（`test/helpers/vscodeStub.ts` + JSDOM 桩）驱动 `refresh()` / `pushBranch()`：健康推送、取消、失败、pruned、命名空间偏移、注入模板。
6. 构建与打包核对：`node esbuild.js` 重建、`node scripts/package-vsix.js --verify-only`、解包逐个 `cmp`。

**我修改过的文件**：只有本报告。`src/`、`test/`、`media/`、`docs/` 与仓库根目录均未留下任何改动（两次变异已按字节还原，见 §三.7）。为验证"建议的修复能不能真的挡住注入"，我把 `src/`+`test/` 复制到系统临时目录后**只改副本**再跑探针，工作树未被触碰。

评审结束时的状态与开始时一致：`git status --short` 仍是 **22 行**（15 修改 + 7 untracked），`git stash list` 为空，无 `git add` / commit / tag / push，账本未改。

---

## 三、逐项复核（证据均为本轮实测输出）

### 1. 新发现 1（P2）pruned upstream + 存在锁 → 推送完全没有用户反馈

**(a) `[gone]` 形状现在有可见中文提示 —— 通过。**
真实 provider + bare 远端：删掉远端分支 → `git fetch --prune` → 加一把真锁 → `pushBranch()`。可见面只有
`error: 分支 master 未配置 upstream。`，进度标题 0 条、toast 0 条、确认框 0 次（`titles: []`）。用例 `test/pushNotification.test.ts:445` 断言的正是这个形状。

我还确认了该用例**不是空转**：把存在性检查改成恒不生效（`exists.code !== 0 && false`），该用例立刻变红，报错正是 `git rev-list origin/master..HEAD failed (128): fatal: ambiguous argument ...`；还原后 sha256 与备份一致（§三.7）。

**(b) 未 prune 的正常上游照常推送，没有过度修正 —— 通过。**
同一 harness：`titles: ["推送中：普通推送：\"second\" → origin/master"]`、`toasts: ["已推送：普通推送：\"second\" → origin/master"]`、远端 `refs/heads/master` 真的前进到本地 HEAD。

**(c) 额外 `rev-parse --verify` 的成本：不是"可以忽略"，是每次 refresh +330 ms 左右 —— 见 §四.3。**
`getUpstream` 现在一次调用 spawn 两个 Git 进程（`for-each-ref` + `rev-parse --verify`）。同机实测（每项 15 次、预热 3 次）：

```
新 getUpstream 平均   680.5 ms
旧单次 rev-parse 平均  350.5 ms
仅 for-each-ref 平均   344.4 ms
增量                  ≈ 330 ms / 调用
```

`getUpstream` 由 `refresh()` 调用（`src/ui/rebaseViewProvider.ts:407`），而 `refresh()` 本身在本机 10 commit 的仓库上实测 **3823 ms**（5 次：3707 / 3828 / 3955 / 3751 / 3875 ms），轮询间隔 **1500 ms**（`:295`，防抖 400 ms，`:313`）。所以：功能正确，但把"一次刷新 3.8 s、每 1.5 s 轮询"推得更接近饱和。这不是拒绝理由，但值得在下一版与既有性能问题一起处理（`%(upstream:track)` 的 `[gone]` 判定可以只用一个进程，见 §四.1）。

**(d) 取消仍静默，已报告的失败不二次报告 —— 通过。**
- 取消：抛 `推送已取消。`，toast **0** 条，远端 ref 未变。
- 真失败（把远端目录删掉再推送）：恰好 **1** 条错误消息（`推送失败：普通推送："second" → origin/master。git push … failed (128): …`），成功提示 0 条、toast 0 条，`pushBranch` 正常返回（`PushAlreadyReported` 被吞，随后补一次 `refresh()`）。

### 2. 新发现 2（P3）`branch.<b>.remote = "."`：对话框与通知不再互相矛盾

真实仓库（`git branch --set-upstream-to=other master`）：`git for-each-ref` 返回 `%(upstream:remotename)` = 字面量 `"."`。实测 `getUpstream` → `undefined`，`pushBranch()` 只给出 `分支 master 未配置 upstream。`，**确认框 0 次**，全部可见文本不含 `./other`。`pushDestination` 也独立拦截 `"."`，因此不论调用方是否传入远端名单都不会打印 `./other`。四处 `pushDestination` 调用点现在共用同一个 `remotes`（`rebaseViewProvider.ts:3018` 取一次，三处确认框 + 通知共用）。通过。

### 3. 新发现 3（P3）删除型 refspec 不再声称推送了 HEAD 的 commit

`test/pushNotification.test.ts:571` 真实远端用例：`:refs/heads/obsolete` → 提示为 `自定义推送：删除远端 ref → origin/obsolete`，远端 ref 真的消失，提示中不含 HEAD 的标题。普通推送与评审推送的措辞未受影响（§三.1(b)、`:211`、`:246` 均绿）。`isDeletionRefspec` 只认定"目的端非空 + 源端为空"，`+` 前缀与空白已处理。通过。

### 4. 新发现 4（P3）`symbolic-ref` 已删、`branch` 必填、两个调用点都成立

- `grep symbolic-ref src/` 无命中；`getUpstream(cwd, branch: string)` 的 `branch` 无默认值，因此"再传 `HEAD`"会在编译期报错。
- 两个调用点：`rebaseViewProvider.ts:407`（`currentBranch()` 的短名）与 `:2987`（`rebasingBranch()` 的短名，函数内再归一化 `refs/heads/`）。
- detached-HEAD-mid-rebase 实测：`git rebase -i HEAD~1` 停在 `edit` 步（`symbolic-ref -q HEAD` exit 1、`.git/rebase-merge` 存在、`status` 为 detached），`pushBranch()` 仍解析到 `origin/master`，标题/成功提示为 `普通推送："third-to-edit" → origin/master`，远端前进到该 commit。通过。

### 5. 新发现 5（P3）`docs/research/test-performance.md` 横幅

横幅现状：不再写死文件数/用例数，改为"当前测试数与文件数以 `scripts/run-tests.js` 的实时枚举为准（不再在此处写死数字，否则这份'纠正过时数字'的横幅自己也会过时）"。通过。

### 6. 新发现 6（P3）`src/git/gitRunner.ts` 审计表

现在两行且如实：`pushRefspec` = **prose**（`Everything up-to-date` / `deleting a non-existent ref`），注明 `LC_ALL=C` 已传；`getUpstream` = structural（上游名由 Git 解析，`rev-parse --verify` 只看退出码）。与实现一致。通过。

### 7. 变异 1：端到端用例存在、非空转、且真的能杀死变异

- **变异 A（N-2 的 wiring）**：`src/ui/rebaseViewProvider.ts:3083` 的 `sourceRev` → 常量 `"HEAD"`。`--test-name-pattern="HEAD~1"` 立刻红：

  ```
  ✖ a custom refspec publishing HEAD~1 names that commit, not HEAD
    + '推送中：自定义推送："feat: something HEAD says" → origin/older'
    - '推送中：自定义推送："fix: keep the abort path read-only" → origin/older'
    at test\pushNotification.test.ts:561:10
  ```

  还原后 `sha256 = eec88dd14145228ea2f903a16954d25c276eef443c97cb19361cf6135247d3a3`，与备份 `cmp` 一致。
- **变异 B（新发现 1 的修复）**：把 `exists.code !== 0` 改成永假。pruned 用例红（`git rev-list origin/master..HEAD failed (128)`）。还原后 `sha256 = 2fe0ae8f53316b234cc92037a97802f99d068679bf77fb477afa4ae913c15342`，`cmp` 一致。

两处还原都用 `sha256sum` + `cmp` 复核，工作树 `git status --short` 行数未变（22）。结论：**变异 1 已死，新发现 1 的用例也不是空转。**

---

## 四、本轮新发现（按严重度）

### 四.1（P2，**本轮引入**）`pushSource(refspec)` 被接进 `git log` 的位置参数 → 任意文件覆盖/截断

```ts
// src/ui/rebaseViewProvider.ts:3079-3083
const sourceRev = pushSource(refspec);
const subject = deletion || !sourceRev
  ? ""
  : await git(["log", "-1", "--pretty=%s", sourceRev], { cwd }).catch(() => "");
```

`sourceRev` 直接来自 refspec 的源端；refspec 的两个来源是**工作区设置** `gitRebaseVisual.push.refspecTemplate`（`src/config.ts:48`）和"自定义 refspec"输入框的初始值（`value: template`）。`git log` 接受 `--output=<file>`，于是源端为 `--output=…` 时这一行不再是"读标题"，而是**截断并写入该文件**。

实测（`git log -1 --pretty=%s --output=…`，与产品代码同形）：

| 探针 | 结果 |
| --- | --- |
| `--output=inj-a.txt` | 在当前目录创建文件，内容 = HEAD 的 commit 标题（`INJECTED-SUBJECT`） |
| `--output=.git/config` | `.git/config` 从 **164 字节截断到 17 字节**，内容变成 `INJECTED-SUBJECT`；此后该仓库所有 Git 命令报 `error: key does not contain a section: injected-subject`（**仓库写坏**） |
| `--output=C:/…/abs-target.txt` | **写到仓库之外**（绝对路径生效） |
| `--output=README.md` | 覆盖工作树里的既有文件（内容被替换为标题） |
| `--output=../../escaped.txt` | 相对路径可越出仓库 |

端到端（真实 `RebaseViewProvider` + `stub.config["gitRebaseVisual.push.refspecTemplate"]`）：

```
模板         : --output=.git/hooks/pre-commit
文件被写入   : true
文件内容     : "SUCCESSFUL-HIJACK\n"
可见消息     : ["评审推送到 （无法确定目标分支）？（--output=.git/hooks/pre-commit）",
                "推送失败：… git push … --output=.git/hooks/pre-commit failed (129): error: unknown option `output=…`"]
```

几点必须说清的边界，我不夸大：

- **需要用户点 Push 并在确认框里确认**。把确认按钮设为"未点击"再跑，文件不会被写（`file written: false`）。所以不是"打开仓库就中招"。
- **内容不完全可控**：写入内容是"该次推送的 commit 标题"（一行）。因此主危害是**破坏/覆盖既有文件**（`.git/config`、工作树文件、任意可写路径），而不是"写入任意内容"。
- **不是干净的 RCE**：写 `.git/hooks/pre-commit` 实测**没有执行**（`error: cannot spawn .git/hooks/pre-commit: No such file or directory`；Git for Windows 需要可执行位，而 `git log --output=` 落盘为 `644`，覆盖既有可执行 hook 也会把模式改成 `644`）。请勿把这条当成"能执行任意代码"来宣传，它是"能毁掉你任意可写文件"。
- **同一通道在基线就已有更严重的问题**：见四.2。所以对"克隆一个恶意仓库"这一威胁模型来说，本轮没有抬高天花板；但 `--output=` 是**新增的破坏面**，而且它出现在一次最日常的操作（推送）上，`git push` 的失败至少还会弹红字，`git log` 的写入**完全静默**（`.catch(() => "")` 连失败都吞掉）。

**已实测的修复**：`--end-of-options` 一个参数即可，且不改变合法输入的行为。

```text
git log -1 --pretty=%s --end-of-options "--output=inj-c.txt"
  → fatal: option '--output=inj-c.txt' must come before non-option arguments   (exit 128, 无文件)
git log -1 --pretty=%s --end-of-options HEAD / HEAD~0 / refs/heads/master / master
  → 全部正常返回标题
```

我在临时副本里打上这一行后重跑同一个端到端探针：`file written: false`，三份关键用例（`HEAD~1` / pruned / deletion）仍全绿。**建议**：`git(["log", "-1", "--pretty=%s", "--end-of-options", sourceRev], …)`，并同时处理四.2。

### 四.2（P1，**基线即存在**，随 VSIX 出货）`git push` 的 refspec 同样未与选项隔离

```ts
// src/git/pushGuard.ts:176
args.push(up.remote, refspec);
```

`git push` 接受 `--mirror`、`--receive-pack=<cmd>`、`--exec=<cmd>` 这类选项形式的参数（选项允许出现在位置参数之后）。实测：

- `git push --force-with-lease=master origin --receive-pack=/tmp/fakerecv.sh` → **本地程序被执行**（探针文件被创建）；不加 `GIT_EXEC_PATH` 等任何技巧也成立。
- `git push --force-with-lease=master origin --mirror` → exit 0，且**真的改动了远端**（在远端创建了 `refs/remotes/origin/*`）。
- 加 `--end-of-options` 后：`error: src refspec --mirror does not match any`（远端 refs 前后一致，未被改动）；`--receive-pack=` 变成 `fatal: invalid refspec '--receive-pack=…'`，程序未执行；普通 `HEAD:refs/heads/master` 推送照常成功。

基线 `577ce87` 的 `pushRefspec` 也是同样的 `args.push(up.remote, refspec)`，所以**不是本轮引入**；但本轮改写了这段代码（返回值、`LC_ALL=C`、错误处理），却没有顺手隔离参数，而它随 0.8.3 VSIX 出货。威胁模型与设置项 `gitRebaseVisual.push.refspecTemplate` 相同：克隆来的仓库可以在 `.vscode/settings.json` 里预设该模板；`package.json` 未声明 `capabilities.untrustedWorkspaces` / `restrictedConfigurations`，按 VS Code 的默认语义该扩展被视为支持不受信任工作区、工作区设置会被读取（**这一点我没在真实 VS Code 里验证，见 §七**）。修复同上：`args.push("--end-of-options", up.remote, refspec)`，或把模板限制为 refspec 语法白名单。

### 四.3（P3，**本轮引入**）`getUpstream` 的存在性检查用了**拼出来的**路径，而不是 Git 报告的上游

```ts
// src/git/pushGuard.ts:66-83
const remoteBranch = remoteRef.startsWith("refs/heads/") ? … : ref.slice(remote.length + 1);
const exists = await runGit(["rev-parse", "--verify", "--quiet",
  `refs/remotes/${remote}/${remoteBranch}`], { cwd, env: C_LOCALE });
```

只要 `remote.<r>.fetch` 把远端分支落到**别的命名空间**，拼出来的 `refs/remotes/<remote>/<branch>` 就不存在，而 Git 报告的上游是好的。实测两种健康的仓库：

| 形状 | `git status -sb` | 范围查询 | `getUpstream` | 真实 `pushBranch()` |
| --- | --- | --- | --- | --- |
| `+refs/heads/*:refs/remotes/upstream/*`（远端仍叫 `origin`） | `## master...upstream/master` | `rev-list @{upstream}..HEAD` = 0 | **undefined** | `titles: []`、`toasts: []`、只有 `error: 分支 master 未配置 upstream。`，远端**未前进** |
| `+refs/heads/*:refs/remotes/origin/nested/*` | `## master...origin/nested/master` | `rev-list origin/nested/master..HEAD` = 0 | **undefined** | 同上 |

两条仓库里 `git push origin master` 都成功——这是"健康的仓库"，而界面断言它"未配置 upstream"并拒绝推送。这与新发现 2 是同一类错误（**错误的消息用在真实存在的配置上**），但成因相反：新发现 2 是"把本地跟踪当远端"，这里是"把非标准命名的真远端当不存在"。

诚实的量化：这两种形状在**基线**下也不能推送（基线用 `rev-parse --abbrev-ref --symbolic-full-name master@{upstream}` 再按第一个 `/` 切，形状 1 得到不存在的远端 `upstream`，形状 2 得到 `origin` + 错误的分支名 `nested/master`）。所以它不是"把能用的功能弄坏了"，而是"把一个混乱的失败换成了更肯定的错误说法"，严重度按 P3 计。

**已实测的修复**：多取一个 atom `%(upstream)`，对 Git 报告的字符串做存在性检查。我在临时副本里按此改写后：

```text
mirror/* 命名空间（健康）   -> {"remote":"mirror","branch":"master","ref":"mirror/master"}
重命名命名空间（健康）      -> {"remote":"origin","branch":"master","ref":"upstream/master"}
嵌套命名空间（健康）        -> {"remote":"origin","branch":"master","ref":"origin/nested/master"}
被 prune（必须 undefined）  -> undefined
本地跟踪 "."（必须 undefined） -> undefined
未配置上游（必须 undefined） -> undefined
普通 origin（健康）         -> {"remote":"origin","branch":"master","ref":"remotes/origin/master"}
```

pruned 与 `"."` 两种必须拒绝的形状仍然拒绝。附带的好处：`rev-parse --verify` 与 `for-each-ref` 可以合并成一个进程，§三.1(c) 的 +330 ms 也就随之消失。

### 四.4（P3，**本轮引入**）`getUpstream` 每次 `refresh()` 多 spawn 一个 Git 进程

见 §三.1(c)：+330 ms/次，`refresh()` 实测 3823 ms、轮询 1500 ms。功能正确，但把已经在临界点上的刷新推得更近饱和。与四.3 一起改即可顺手消掉。

### 四.5（P3，文档）`RELEASE.md:129` 与 `docs/improvement/improvement.md:147` 仍在描述已删除的 `symbolic-ref` 步骤

同一份 0.8.3 更新记录里，`:129` 写"现在改为问 Git 自己：**先 `git symbolic-ref --short` 解析分支**，再用 `for-each-ref …`"，而 `:135` 的新发现 4 条目写"`symbolic-ref` 那次调用**已删除**"。两句在同一版本条目内自相矛盾；`docs/improvement/improvement.md:147` 重复了 `:129` 的旧说法。新发现 4 的代码改动是对的，只是这两处文案没跟着改。

### 四.6（P3，文案边界）pruned 与"未配置"仍合并为同一句提示

`getUpstream` 对"被 prune"和"从未配置"都返回 `undefined`，用户看到的都是 `分支 master 未配置 upstream。`。前者其实可以靠重新推送重建分支，后者不行。`docs/improvement/improvement.md` 已把这条列为遗留边界，我确认代码确实如此——不是缺陷，只是提示精度问题；若要分开需要一个新返回值（`"gone"`）并同步两个调用点。

---

## 五、计数、文档与账本核对

- **299 项**我做了独立的静态枚举：`test/*.test.ts` 共 **45 个文件、299 个顶层 `test(`**（脚本直接读文件计数，不执行）。这与 `RELEASE.md:136`、`docs/summary/summary.md:150`、`docs/release-notes/0.8.3.md:44` 的 299 一致。**但"全绿"不是我的结论**：我没有跑全量（见 §二），我跑的两份定向文件共 21 项全绿，且这两个文件正是本轮新增/改动的主体。
- `RELEASE.md:136` 的其余可核对项我逐条验了：两个类型检查零输出（是）、VSIX 12 个条目（是）、白名单通过（是）、包内文件与工作区逐字节相同（是）。"从**删除后的** `dist-vsix/` 重建"属于历史操作，无法从我看到的产物反推。
- **账本**（`docs/review/code-review-commit.md`）：`0-8-13/0-8-14` 与 `0-8-15` 两行都在，SHA 写的是基线 `577ce87`，并明确注明"被评审材料为未提交工作树、无 commit SHA 可记录"——描述准确，没有把某次提交错记成已评审。**本报告（`code-review-0-8-16.md`）的行尚不存在**；任务约束禁止我编辑账本，而项目 `CLAUDE.md` 要求评审者在同一次变更里补写，两者冲突，我按任务约束执行：**请维护者在提交 0.8.3 时补一行**（基线 SHA、报告文件名、状态、日期，并同样注明被评审材料是未提交工作树）。

---

## 六、发布产物（VSIX）核对

- 条目：**12**，`node scripts/package-vsix.js --verify-only` → `VSIX contents match the allowlist (12 entries).`
- 包内 payload 与工作树逐字节比对：`readme.md`、`package.json`、`.gitignore`、`media/style.css`、`media/main.js`、`media/icon.svg`、`media/extension-icon.png`、`dist/seq-editor.js`、`dist/extension.js` **全部 SAME**；`extension/LICENSE.txt` 与工作树 `LICENSE` 同 sha256（`5b78c0db…`），即改名打包、内容一致。
- `dist/seq-editor.js` 与 `src/git/seq-editor.js` `cmp` 一致；`dist/extension.js` 是构建产物（`.gitignore` 忽略 `dist/`）。
- **可重现**：包内 `dist/extension.js` sha256 = `7d64b6c19c0560ea6380486232c15a838e302dd2accac78d4030799e6524217c`；重新 `node esbuild.js` 后工作树 `dist/extension.js` 的 sha256 与之**相同**，重建前后按字节一致。
- 版本：`package.json` `0.8.3`，`extension.vsixmanifest` `Id="git-rebase-visual" Version="0.8.3"`。
- 源码一致性：包内 bundle 里含 `await git(["log", "-1", "--pretty=%s", sourceRev], { cwd })`（`end-of-options` 不存在于 bundle），即 **§四.1 的缺陷已进入发布产物**。
- VSIX 文件本身 sha256：`3c2e6b5cd5fee1ebcf7600afe7ce0127280773160999a374835d300f8f49bc79`（与本轮开始时相同，我没有重新打包）。

---

## 七、我没有验证的（明确声明）

1. **完整 299 项套件是否全绿**——按约束没有跑，且当时另有一轮在跑。我用 21 项定向用例 + 两个类型检查 + 独立静态计数替代，不能等同。
2. **真实 VS Code 里的行为**：模态确认框的真实阻塞/焦点/IME、`ProgressLocation.SourceControl` 的可见性、**Restricted Mode（不受信任工作区）下 `.vscode/settings.json` 是否真的被读取**（§四.2 的威胁模型依赖这一点，我只有 `package.json` 未声明 `capabilities` 这一间接证据）。
3. **其他 Git 版本**：全部实测在 `2.53.0.windows.2`。`--end-of-options` 对 `git log` 的可用版本、`%(upstream)` atom 的行为在旧版本上的差异，我没有逐一验证（扩展声明最低 Git 2.31.0）。
4. **真实 Gerrit / `refs/for/*` 服务端**：只用本地 bare 远端模拟 refspec 目的端，没有对接真实评审服务器。
5. **`--output=` 在 Linux/macOS 上的可执行位行为**：hook 不执行这一点是在 Windows/MSYS 上测的；POSIX 上 `--output=` 落盘的权限位我没有测（可能仍是 644，也可能受 umask 影响）。
6. **其他 locale 下的 `git push` 散文判定**：`LC_ALL=C` 已传，但我没有在非 C locale 环境里反证（这是设计上的保证，不是我的实测）。
7. **磁盘上的真实诊断日志文件内容**（`warnDiagnostic("push", …)` 写到哪里、写成了什么）——我只验证了 UI 可见面与 `pushBranch` 的抛/吞行为。
8. **两个图标（PNG/SVG）的像素内容**，以及 `dist/seq-editor.js` 的"重新构建"可重现性（它是直接拷贝，拷贝本身已 `cmp` 一致）。
9. **依赖与 `package-lock.json` 的审计**（`package-lock.json` 有 4 行改动，我没有审）。

---

## 八、建议的最小跟进清单（不阻塞"修复是否有效"的判断，但阻塞发布）

1. **（必须）** `src/ui/rebaseViewProvider.ts:3083` 加 `--end-of-options`（已实测有效且不影响合法 rev）。
2. **（必须，同一类）** `src/git/pushGuard.ts:176` 加 `--end-of-options`，或对 refspec 做语法白名单；`--receive-pack` 的本地程序执行已实测。
3. **（应该）** 考虑 `package.json` 声明 `capabilities.untrustedWorkspaces.restrictedConfigurations`，把 `gitRebaseVisual.push.refspecTemplate` 等会进入命令行参数/外部进程的设置列为"不受信任工作区不生效"。
4. **（应该）** `getUpstream` 的存在性检查改验 `%(upstream)`（已实测：三种健康命名空间 + pruned/`."`/未配置 全部正确），并合并成一个 Git 进程，消掉 +330 ms。
5. **（可选）** `RELEASE.md:129`、`docs/improvement/improvement.md:147` 的 `symbolic-ref` 旧描述；pruned 与未配置的提示是否分开。
6. **（流程）** 维护者补 `code-review-commit.md` 的 0-8-16 行。

**给下一轮评审的一句话**：六项修复是真的、变异 1 是真的死了；但本轮的"修一处带一处"模式同样是真的——新带的这一处就在推送路径上，并且已经进了 VSIX。
