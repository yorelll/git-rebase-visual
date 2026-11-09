# Code Review 0-8-17 — 0.8.3 第五轮复核（四.1–四.6 逐项实证、注入探针 before/after、新缺陷）

- 评审日期：2026-11-06
- 评审角色：独立评审（Agent B，第五轮）
- 基线 commit：`577ce8766a46707a60c471cf8090e9f63cd8d49c`（`test: run each file in its own process and split the slowest suite`）
- 被评审材料：基线之上的**未提交工作树**——`git diff 577ce87`（16 个修改文件）+ 9 个 untracked 文件（`src/ui/pushNotification.ts`、`test/pushIsolation.test.ts`、`test/pushNotification.test.ts`、`test/restoreFileProtocol.test.ts`、`docs/review/code-review-0-8-13/14/15/16.md`、`docs/release-notes/0.8.3.md`）。无新的可记录 commit SHA。
- 本轮**回答** `code-review-0-8-16.md` 的第四节（四.1 P2、四.2 P1、四.3–四.6 P3），并按要求检查本轮是否又引入新缺陷、安全修复是否完整、计数与文档、以及重建后的 VSIX。
- 环境：Windows 11 + MSYS Git `git version 2.53.0.windows.2`，Node `v24.16.0`（`/d/Program Files/nodejs/node`、`npm` 在该 shell 里解析不到 node，全部直接调用 `node`）。
- 本报告**不修改** `code-review-0-8-13/14/15/16.md`，不修改账本。

---

## 一、结论摘要

| 项 | 结论 |
| --- | --- |
| 四.1（P2，`git log` 选项注入） | **已修复**。`--end-of-options` 实测挡住 `--output=`；把标记去掉后**同一个端到端探针立刻重新写出文件**，证明挡住它的正是这行修复，而不是旁路。合法源（`HEAD`/`HEAD~0`/`HEAD~1`/`refs/heads/master`/`master`/40-hex sha/tag）全部照常返回标题。失败是**可见**的（`refspec 的源端 … 不是可解析的 commit`），不再是静默空标题。 |
| 四.2（P1，`git push` 选项注入） | **已修复**。直接调用 `pushRefspec` 的探针里：`--receive-pack=<脚本>` 得到 `fatal: invalid refspec`，**脚本没有执行**；`--mirror` 得到 `error: src refspec --mirror does not match any`，远端 ref 列表不变。把标记去掉后**脚本被执行（`marker exists: true`）、`--mirror` 成功不报错**。普通推送仍可用。 |
| 四.3（P3，存在性检查用了拼出来的 ref） | **已修复**。五种形状全部实测：`plain` / `renamed`（`refs/remotes/upstream/*`）/ `nested`（`refs/remotes/origin/nested/*`）/ `refs/mirror/*` 全部解析为健康，`pruned`（`[gone]`）与 `"."` 仍返回 `undefined`。provider 级：renamed 与 nested **真的推送成功且远端前进**，pruned 与 `"."` 仍给出可见的 `分支 master 未配置 upstream。`，且任何可见文本都不含 `./other`。 |
| 四.4（P3，`getUpstream` 两次 spawn） | **已修复且可复现**。同机 15 次实测：当前实现 `374.0 ms/call`，复原的旧两次 spawn 实现 `736.0 ms/call`，**差额 −361.9 ms**，与上一轮测到的 +330 ms 同量级。调用计数断言为 **1**。 |
| 四.5（P3，`symbolic-ref` 旧文案） | **已修复**。`RELEASE.md` 与 `docs/improvement/improvement.md` 中 `symbolic-ref` 只剩「已删除」的说明，与新写法（一次 `for-each-ref` 取四个 atom）一致，不再自相矛盾。 |
| 四.6（P3，pruned vs 未配置的文案边界） | **决定合理**。两者合并为一句是有意的，理由写进了 `getUpstream` 的文档注释（同一个下一步、需要第三态穿两个调用点），`docs/improvement/improvement.md` 同记录。我认可这个取舍。 |
| 本轮是否引入新缺陷 | **是，一处 P2**：`recentN` 提交范围被标记打断（见 §四.1）。 |
| 安全修复是否完整 | **基本完整**，但 A 在 `pushRefspec` 里对残余风险的解释**恰好说反了**（见 §四.2，P3 文案/认知）。其余站点我已逐条排查（§五）。 |

### 裁决：**不批准**

不批准 0.8.3 以当前工作树发布，**因此本评审不覆盖（不批准）`dist-vsix/git-rebase-visual-0.8.3.vsix`**。

理由**不是**安全修复没做好——四.1 与四.2 的两条注入通道，我都用自己写的探针、在去掉标记的对照下验证过：它们是**真的被关上了**，而且是标记本身关上的。这一轮的安全工作应当被明确认可。

不批准的唯一原因是一个**新引入的功能回归**：`getCommits` 把 `--end-of-options` 插在所有位置参数之前，而 `recentN` 的范围字符串是 `-n <N> <tip>`，于是那个 `-n` 落到了标记**之后**，被 Git 当成位置参数拒绝。

```
$ git log --date=short --pretty=format:%s --end-of-options -n 3 HEAD
fatal: option '-n' must come before non-option arguments      (exit 128)
```

端到端确认（真实 `RebaseViewProvider` + 真实仓库，`commitRange=recentN`）：

```
range=upstream : postedCommits=0  errors=[]                 （该仓库无 upstream，属预期）
range=all      : postedCommits=8  errors=[]
range=recentN  : postedCommits=0  errors=["git log … --end-of-options -n 20 HEAD failed (128): fatal: option '-n' must come before non-option arguments"]
range=mainBranch: postedCommits=0 errors=["Base branch 'main' not found."]
```

`commitRange: "recentN"` 是 `package.json` 里一个**有文档、有默认值 20、有 README 表格**的公开设置。选它的人会得到一条 Git 英文报错、列表为空；这是**上一次能正常工作、这次不能**的回归，属于发布阻断项，且已进入打包产物。

严重度按 **P2** 计（不是 P1）：范围本身有限（只有 `recentN` 这一个枚举值中招），失败方向安全（只读查询失败，不写、不删、不推送），有可见错误横幅而不是静默错误数据。但它必须修，且修法必须避免"下一个枚举值再踩一次"。

---

## 二、我实际跑了什么（以及没有跑什么）

**明确声明：完整套件（308 项）不是我跑的。** 按任务约束，另有一轮完整套件正在运行，我没有启动第二个全量运行——这些用例会 spawn 真实 Git 与对时序敏感的子进程，并发跑曾产生假失败。我跑的是**定向文件**、两个类型检查、以及大量真实仓库探针：

1. `node node_modules/typescript/bin/tsc --noEmit` → **exit 0、零输出**。
2. `node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit` → **exit 0、零输出**。
3. `test/pushIsolation.test.ts` → **9/9 通过**（A 本轮新增的注入与命名空间用例，`70.9 s`）。
4. `test/commitLog.integration.test.ts` → **12/12 通过**（`58.7 s`）。**注意**：它全绿，而 `recentN` 是坏的——见 §四.1。
5. 我自己写的端到端探针（放在 OS 临时目录，不属仓库）：`four1` / `four1b` / `four2` / `four2direct` / `normalPush` / `four3` / `four3b` / `recentn-provider`，全部用**真实 `RebaseViewProvider` + 真实 bare 远端 + 真实 Git 仓库**（`test/helpers/gitTestRepo` + `test/helpers/vscodeStub`）。
6. **变体对照**：把 `src/`+`test/` 复制到系统临时目录，**只在副本里**删除两处 `withPositionals` 后重跑同一组探针（§三.1、§三.2 的 before 列即来自副本）。工作树未被触碰。
7. 性能实测：当前 `getUpstream` vs 复原的两次 spawn 实现，各预热 3 次、计时 15 次。
8. 重建与打包：`node esbuild.js` 重建、`node scripts/package-vsix.js --verify-only`、解包逐字节比对。

**我修改过的文件**：只有本报告。`src/`、`test/`、`media/`、`docs/` 与仓库根目录均未留下改动；`dist/extension.js` 被 `node esbuild.js` 重写，但**重建前后 sha256 均为 `a7b1f909…`**，内容不变。评审结束时 `git status --short` 仍是 **25 行**（16 修改 + 9 untracked），`git stash list` 为空，无 `git add` / commit / tag / push，账本未改。

---

## 三、逐项复核（证据均为本轮实测输出）

### 1. 四.1（P2）`--output=` 不再能通过 `git log` 写文件

**裸 Git 对照（同一个仓库、同一个 commit 标题）：**

```
--- BEFORE（无标记，即 0.8.16 报的形态）---
$ git log -1 --pretty=%s --output=inj-before.txt
exit=0
-rw-r--r-- 1 … 17 inj-before.txt
content: [INJECTED-SUBJECT]
--- AFTER（加标记，即当前实现）---
$ git log -1 --pretty=%s --end-of-options --output=inj-after.txt
fatal: option '--output=inj-after.txt' must come before non-option arguments   (exit 128)
ls: cannot access 'inj-after.txt': No such file or directory
--- .git/config 截断（BEFORE）---
162 字节 → 17 字节，内容变成 INJECTED-SUBJECT
```

**端到端（真实 provider，`push.refspecTemplate` = `--output=<相对路径>:refs/heads/pwned`）：**

```
4.1 target file exists: false
4.1 cwd/pwned exists:    false
4.1 titles:              []
4.1 visible: ["warn:评审推送到 origin/pwned？（--output=…:refs/heads/pwned）",
              "error:refspec 的源端 --output=… 不是可解析的 commit：
                      fatal: option '--output=…' must come before non-option arguments。未执行推送。"]
4.1 remote pwned: 1        （即 rev-parse --verify 失败：远端没有这个 ref）
```

**手输输入框 + `.git/config`（第二条通道）：**

```
4.1b .git/config unchanged: true  bytes 402 -> 402
4.1b repo still parses:     true
4.1b visible: ["warn:自定义推送到 origin/pwned？（--output=.git/config:refs/heads/pwned）",
               "error:refspec 的源端 --output=.git/config 不是可解析的 commit：…。未执行推送。"]
```

**对照实验（证明挡住注入的就是这行修复）：** 在临时副本里把该行改回旧形态 `runGit(["log","-1","--pretty=%s", sourceRev])`，同一个探针立刻变成：

```
4.1 target file exists: true          ← 文件真的被创建
4.1 titles: ["推送中：评审推送：\"（无法读取 commit 标题）\" → origin/pwned"]
```

即：**旧形态可写文件、且走的是"读不到标题"的静默分支；新形态不可写、且可见报错。** 这条修复不是装饰。

**合法源不受影响（逐个实测）：**

```
HEAD               -> exit=0  subject=[local-side]
HEAD~0             -> exit=0  subject=[local-side]
HEAD~1             -> exit=0  subject=[c1]
refs/heads/master  -> exit=0  subject=[local-side]
master             -> exit=0  subject=[local-side]
b86ac2a4…（40-hex）-> exit=0  subject=[local-side]
t1（tag）          -> exit=0  subject=[c1]
```

一个**次要**观察（不是缺陷）：`git rev-parse --abbrev-ref --symbolic-full-name --end-of-options 'HEAD@{upstream}'` 会把 `--end-of-options` **回显到 stdout**（本机实测 stdout 是两行：`--end-of-options` 与 `origin/master`）。当前调用点只读 `res.code`，`revRange` 是用模板串重新拼的，所以无害。但如果将来有人改成读 stdout，会把标记当成 ref。属于"知道就好"的备注，不进跟进清单。

### 2. 四.2（P1）`git push` 的 refspec 不再被当成选项

provider 级（`--receive-pack` / `--mirror` 走自定义 refspec 输入框）：

```
4.2 receive-pack marker exists: false
4.2 visible: ["warn:自定义推送到 origin:…sh？（--receive-pack=…sh）",
              "error:refspec 的源端 --receive-pack=C 不是可解析的 commit：…。未执行推送。"]
4.2 mirror remote unchanged: true ["refs/heads/master"]      ← 没有被塞进 refs/remotes/*
```

**但 provider 级是被"源端不是 commit"提前拦下的**（注意它把 `C:/…` 在冒号处切成 `C`），并没有真正走到 `git push` 的 argv。所以要钉住标记本身，必须直接调用 `pushRefspec`——A 也这么做了，我独立复跑：

```
4.2d receive-pack threw: git push --force-with-lease=master --end-of-options origin --receive-pack=…sh
                         failed (128): fatal: invalid refspec '--receive-pack=…sh'
4.2d execution marker exists: false
4.2d mirror threw:       git push --force-with-lease=master --end-of-options origin --mirror
                         failed (1): error: src refspec --mirror does not match any
```

**对照实验**（临时副本里把 `args.push(...withPositionals([], [up.remote, refspec]))` 改回 `args.push(up.remote, refspec)`）：

```
4.2d receive-pack threw: git push --force-with-lease=master origin --receive-pack=…sh
                         failed (128): fatal: Could not read from remote repository.
4.2d execution marker exists: true      ← 脚本真的被执行
4.2d mirror: NO THROW (bad)             ← --mirror 成功且不报错
```

两条攻击在旧形态下都成立、在新形态下都不成立，且失效点就是标记。**四.2 的修复是真的。**

**普通推送未受影响：**

```
P normal titles:  ["推送中：普通推送：\"second\" → origin/master"]
P normal visible: ["已推送：普通推送：\"second\" → origin/master",
                   "warn:推送到 origin/master？（HEAD:refs/heads/master）"]
P remote tip == local: true
```

### 3. 四.3（P3）存在性改由 Git 的 `%(upstream:track)` 回答

五种形状（`getUpstream` 直接调用）：

```
4.3 plain       : {"remote":"origin","branch":"master","ref":"origin/master"}
4.3 renamed     : {"remote":"origin","branch":"master","ref":"upstream/master"}        （+refs/heads/*:refs/remotes/upstream/*）
4.3 nested      : {"remote":"origin","branch":"master","ref":"origin/nested/master"}   （refs/remotes/origin/nested/*）
4.3 mirror      : {"remote":"origin","branch":"master","ref":"mirror/master"}          （refs/mirror/*）
4.3 local-dot   : undefined                                                            （branch.<b>.remote = "."）
4.3 pruned      : undefined    （status: ## master...origin/master [gone]）
```

provider 级（真的推送）：

```
4.3b renamed titles:        ["推送中：普通推送：\"second\" → origin/master"]
4.3b renamed remote advanced: true
4.3b nested titles:         ["推送中：普通推送：\"second\" → origin/master"]
4.3b nested remote advanced:  true
4.3b pruned titles: []   visible: ["error:分支 master 未配置 upstream。"]
4.3b dot    titles: []   visible: ["error:分支 master 未配置 upstream。"]   contains ./other: false
```

即：上一轮报的"健康的仓库被判成未配置 upstream"确实消失了，而两种**必须**拒绝的形状仍然拒绝、且提示可见。A 的注释里写明的边界我也复现了（`git status` 相同形状下 `[gone]` 出现、`track` 为空串的"配置了但从未 fetch"确实**不会**被判成 gone）——所以实现必须是"只有 `[gone]` 才拒绝"，不能反过来写"空即不存在"。当前实现正是前者。

### 4. 四.4（P3）`getUpstream` 现在只 spawn 一次

同机、同仓库、各预热 3 次后计时 15 次：

```
current (1 spawn) : 374.0 ms/call
previous (2 spawn): 736.0 ms/call
delta current - previous: -361.9 ms
result current : {"remote":"origin","branch":"master","ref":"origin/master"}
result previous: {"remote":"origin","branch":"master","ref":"origin/master"}
```

与上一轮测到的 +330 ms 同量级，方向相反。A 的"折叠成一次 `for-each-ref` 消掉了 +330 ms"**成立，我实测确认**（没有采信声明）。用例层也有 `setGitInvocationObserver` 断言恰好 1 次调用且是 `for-each-ref`（`pushIsolation.test.ts:347`，我复跑通过）。

### 5. 四.5（P3）`symbolic-ref` 旧文案已清

```
$ grep -rn "symbolic-ref" RELEASE.md docs/improvement/improvement.md
RELEASE.md:135:  - **`symbolic-ref` 那次调用已删除**：…
docs/improvement/improvement.md:159: * **新发现 4（…`symbolic-ref` 恒不生效…）**——…已**删除这次调用**…
```

只剩两处"已删除"的说明，与相邻的 新发现 4 条目一致；`RELEASE.md` 的正文里现在写的是"一次 `for-each-ref` 取 `%(upstream:short)` / `%(upstream:remotename)` / `%(upstream:remoteref)` / `%(upstream:track)`"，不再描述一个不存在步骤。**通过。**

### 6. 四.6（P3）pruned 与未配置仍合并，但理由成立

`getUpstream` 的文档注释现在明确写了三条返回 `undefined` 的理由，并解释了**为什么** pruned 与"从未配置"共用一句：两者都让用户没有可推送的上游、下一步相同（重建或配置），分开需要第三态穿过两个调用点。`docs/improvement/improvement.md` 的四.6 条目重复了同一理由并给出"若将来要分开该怎么做"。

我的判断：**这是正确的取舍**，而且比"分开"更诚实——分开会让 `getUpstream` 的返回值变成一个调用方必须记住处理的联合类型，而两个调用点当前的渲染是同一条 toast。我不把它列为缺陷。

---

## 四、本轮新发现

### 四.1（P2，**本轮引入**）`recentN` 的 `-n` 落在 `--end-of-options` 之后，提交列表整段失效

```ts
// src/git/commitLog.ts:131-132
case "recentN":
  return { revRange: `-n ${Math.max(1, cfg.count)} ${tipRef}`, hasBase: false };

// src/git/commitLog.ts:186-189
const args = withPositionals(
  ["log", "--date=short", `--pretty=format:${format}`],
  revRange.split(" ")
);
```

`withPositionals` 把标记插在**位置参数之前**，于是 `-n` 与 `<N>` 都成了位置参数：

```
$ git log --date=short --pretty=format:%s --end-of-options -n 3 HEAD
fatal: option '-n' must come before non-option arguments      (exit 128)

$ git log --date=short --pretty=format:%s -n 3 --end-of-options HEAD
c7
c6
c5                                                           (exit 0)  ← 正确形态
```

通过真实 provider（`commitRange=recentN`，8 个 commit 的仓库）：

```
range=recentN: postedCommits=0 errors=["git log … --end-of-options -n 20 HEAD failed (128): fatal: option '-n' must come before non-option arguments"]
```

用户看到的是面板上一条 Git 原始英文错误、列表为空。`package.json` 的 `gitRebaseVisual.commitRange` 枚举里 `recentN` 是一个公开选项，`recentCount` 默认 20，README 与设置描述都写了它。

**为什么测试没抓到**：`test/commitLog.integration.test.ts:96` 只断言 `resolveRange` 的**字符串形状**：

```ts
assert.deepEqual(await resolveRange(cwd, { kind: "recentN", count: 0 }), {
  revRange: "-n 1 HEAD",
  hasBase: false,
});
```

它从不把该字符串交给 `getCommits`。这与上一轮"变异 1 存活"是同一类缺口——**测了拼装、没测执行**。改回旧形态之前，该字符串是能被 `git log` 吞下的；加上标记之后它就不是了，而没有用例跨过这条缝。我实跑 `commitLog.integration.test.ts` 是 **12/12 全绿**，`recentN` 仍然坏着。

**修法（我没有改源码，只指出最小形态）**：不要把一个"已经是 argv 片段"的字符串当位置参数传。可选：
- 让 `resolveRange` 的 `recentN` 返回不含 `-n` 的形式（`{ revRange: tipRef, limit: n }`），由 `getCommits` 把 `-n <n>` 放进 `options` 数组；
- 或给 `getCommits` 一个"位置参数只允许 revision"的入口，`-n` 只在 `options` 里拼。

两种都要**新增一条真正执行 `getCommits(cwd, range.revRange)` 的用例**（断言返回的 commit 数与标题），否则下一个这类字符串还会再踩一次。

### 四.2（P3，**认知/注释错误**，不是新的注入面）`pushRefspec` 对 `up.remote` 以 `-` 开头的残余风险被说反了

A 在 `src/git/pushGuard.ts:200-205` 写：

> `--end-of-options` 必须自己是最后一个选项，因此 `up.remote`/`up.branch` 若以 `-` 开头仍会被当选项读。二者都来自 Git（**远端名不以 `-` 开头**，分支名由 Git 自己校验过），所以该路径不是设置可达的。

实测这两句都不准确：

1. **远端名可以以 `-` 开头。**  porcelain 就能建：

   ```
   $ git remote add -- -evil ../dash3-remote.git
   $ git remote
   -evil
   $ git push -q -u -- -evil master       # 成功，上游被记录
   $ git for-each-ref --format='%(upstream:remotename)…' refs/heads/master
   -evil
   getUpstream → {"remote":"-evil","branch":"master","ref":"-evil/master"}
   ```

2. **标记并不只是"还能被当选项读"，它恰好把这个形状修好了。** 同一个远端：

   ```
   # 无标记（旧形态）
   $ git push --force-with-lease=master -evil 'HEAD:refs/heads/yyy'
   error: unknown switch `e'                          （被当成 -e 选项）
   # 有标记（当前实现）
   $ git push --force-with-lease=master --end-of-options -evil 'HEAD:refs/heads/master'
   To ../dash3-remote.git
      0cee0e4..97d7633  HEAD -> master                （exit 0，真的推成功）
   ```

   连远端名为 `-f` 时也一样：无标记变成 `Could not resolve hostname head`（`-f` 被当 `--force`），有标记正常推送。

所以注释的实际效果是"把一个已经被修复的形状说成仍然有洞、并且用两条不成立的事实为它开脱"。**行为是对的**（标记让它更好），**文字是错的**。这一条不影响裁决，但应按 P3 修：把"远端名不以 `-` 开头"改成"远端名可以以 `-`，标记让它成为位置参数；分支名由 `git check-ref-format --branch` 保证不以 `-` 开头"。

顺带核实：分支名确实不能以 `-` 开头（`git check-ref-format --branch -- -x` → `fatal: '-x' is not a valid branch name`），所以 `up.branch` 那半句是对的。

---

## 五、安全修复的完整性：我把所有"设置/输入 → 位置参数"的站点都过了一遍

要求的不是补两处，而是审计。逐条结论：

| 站点 | 值的来源 | 结论 |
| --- | --- | --- |
| `rebaseViewProvider.ts:3091` `git log … sourceRev` | `push.refspecTemplate` / 手输 refspec | **已修**（标记 + 可见失败），§三.1 |
| `pushGuard.ts:206` `git push … up.remote, refspec` | refspec 同上；`up.remote` 来自 Git | **已修**，§三.2、§四.2 |
| `commitLog.ts:123` `rev-parse --verify --quiet <mainBranch>` | `gitRebaseVisual.mainBranch`（设置） | **已修**（标记）；实测 `--output=` 不再落盘 |
| `commitLog.ts:186` `git log … revRange.split(" ")` | `mainBranch` 拼接进的 range | **已修**，但有 §四.1 的 `-n` 回归 |
| `commitLog.ts:103` `rev-parse … 'HEAD@{upstream}'` | 常量 + `tipRef` | **已修**（标记）；`tipRef` 只会是 `"HEAD"` 或 `rebasingBranch()` 的短名 |
| `pendingRecovery.ts:348/357/773` 文件路径 | 来自 Git 输出 / 用户选择 | 已有 `--`、`GIT_LITERAL_PATHSPECS`、`--path=`；路径不进入选项位 |
| `worktree.ts` / `worktreeChanges.ts` 全部 pathspec | 来自 Git 状态枚举 | 已统一 `--` + `GIT_LITERAL_PATHSPECS` |
| `pendingRecovery.ts:882/1254` `stash apply <sha>` | 内部记录里的 sha | sha 由 Git 产生，且 `stash apply` 位置参数不接受选项形状之外的攻击面；非设置可达 |
| `rebaseEngine.ts:73` `rev-parse … <hash>^` | `this.commits` 的 hash（webview 经 `isCurrentCommitHash` 校验） | 已校验 40-hex 且在快照内 |
| `rebaseEngine.ts:121` `git rebase -i <base>` | `resolveBase` 的 Git 输出 | 来自 Git |
| `rebaseEngine.ts` 的 todo 文件 | webview 的 subject 写入 todo 文件 | 不是 argv；这是**另一类**注入面（todo 文件语法），本轮未涉及，我也没有新发现 |
| `undo.ts:77/117` `update-ref <beforeRef>` | 内部生成的 ref 名 | 内部生成，非设置可达 |
| `commitLog.ts:253` `rev-parse <sha from git-path 文件>` | rebase 的 `stop-sha` 文件 | 来自 Git 写的文件；见下 |
| `fullMessage`/`commitDetail`/`commitDetail` 的 `<hash>` | webview 经 `isCurrentCommitHash`（40-hex + 在快照内） | **有校验**，不可注入 |

一处**值得记录但不是本轮引入**的观察：`sendDetail`（`rebaseViewProvider.ts:2829`）接收 `m.hash` 走 `commitDetail`（`git show … <hash>`），而 `requiresCurrentCommitHash` 的集合**包含** `requestDetail`，因此 `m.hash` 在进入 `commitDetail` 前已被 `isCurrentCommitHash` 限定为 40-hex 且在快照内——`git show` 的位置参数因此不可注入。我用 `git show -s --pretty=format:%s HEAD --output=file` 验证了确有这个注入面（会写文件），但当前路径被上游校验挡住。**结论：安全；若将来有人放宽 `requiresCurrentCommitHash`，这里会立刻变成和四.1 一样的洞。** 建议在该处加一句注释（P3 级建议，不进跟进清单）。

**没有发现 A 漏掉的、设置可达的位置参数站点。** 我特别检查了 `recentCount`（`number` 类型，进的是 `-n <n>` 而非字符串位置参数）、`llm.skillPath`（只进 `fs.readFileSync`，不进 Git）、`llm.model/baseUrl`（只进 HTTP）、`commitRange`（枚举）、`collapseLockedRuns`/`autoStash`（布尔）。这些都不构成 argv 注入。

---

## 六、计数、文档与账本

- **静态独立枚举**（直接读文件、只数行首 `test(`）：`test/*.test.ts` 共 **46 个文件、308 个顶层 test**。这与 `docs/summary/summary.md:150`、`RELEASE.md:136`、`docs/release-notes/0.8.3.md:44` 的 **308** 一致。任务要求的"≥299"满足。
- **但"308 全部通过"不是我的结论**：我没有跑全量（§二）。我跑的两份定向文件（9 + 12 = 21 项）全绿；其中 `commitLog.integration.test.ts` 全绿而 `recentN` 是坏的——这正好说明"全绿"不等于"功能对"，我在 §四.1 里如实写明。
- `docs/research/test-performance.md` 的横幅现在不再写死数字（改为指向 `scripts/run-tests.js` 的实时枚举），与上一轮的修复一致；同句里"3 个文件共 60 个测试"仍然正确。
- **账本**（`docs/review/code-review-commit.md`）：`0-8-13/0-8-14`、`0-8-15`、`0-8-16` 三行都在，SHA 写基线 `577ce87`，并注明"被评审材料为未提交工作树、无 commit SHA 可记录"。描述准确。**本报告（`code-review-0-8-17.md`）的行尚不存在**；任务约束禁止我编辑账本，项目 `CLAUDE.md` 要求评审者在同一次变更里补写——两者冲突，我按任务约束执行：**请维护者在提交时补一行**。

---

## 七、发布产物（VSIX）核对

- 条目：**12**，`node scripts/package-vsix.js --verify-only` → `VSIX contents match the allowlist (12 entries).`
- 包内文件与工作树逐字节比对：`media/main.js`、`media/style.css`、`media/icon.svg`、`readme.md`、`package.json`、`.gitignore`、`dist/seq-editor.js` 全部 **SAME**；`extension/LICENSE.txt` 与仓库根 `LICENSE` **SAME**。
- **可重现**：包内 `dist/extension.js` sha256 = `a7b1f909ce171f550653a13e8ad9f81467d931c732863e468d5e7346f62b4141`；我在工作树跑 `node esbuild.js` 重建，**前后 sha256 完全相同**，且与包内相同。`dist/seq-editor.js` 是 `src/git/seq-editor.js` 的拷贝，`cmp` 一致。
- 版本：`package.json` `0.8.3`。VSIX 文件本身 sha256：`19b312c0c680bdd2d4e93a9efedaa0334253440f51caa1dc3a7160d1ea4d33b3`（我没有重新打包）。
- 包内 bundle 里 **6 处** `withPositionals(` 调用点全部存在（`gitRunner` 的定义 + `resolveRange` 两处 + `getCommits` + `getUpstream` + `pushRefspec` + 推送 subject），`END_OF_OPTIONS` 常量也在。**四.1 与四.2 的修复确实进了发布产物。**
- 同一份 bundle 里 `case "recentN": return { revRange: `-n ${Math.max(1, cfg.count)} ${tipRef}` }` 与 `withPositionals(["log", …], revRange.split(" "))` 同时存在——**§四.1 的回归也进了发布产物**。

---

## 八、我没有验证的（明确声明）

1. **完整 308 项套件是否全绿**——按约束没有跑，且当时另有一轮在跑。我用 21 项定向用例 + 两个类型检查 + 独立静态计数替代，不能等同。
2. **`--end-of-options` 在 Git 2.31.0（本扩展 `MIN_GIT_VERSION`）上的可用性。** 全部实测在 `2.53.0.windows.2`。我没有 2.31 的实机，也没有本地可读的 Git 发布说明来确认该标记引入的版本。**这是本轮一个真实的知识空白**：如果 `git log` 的 `--end-of-options` 晚于 2.31，那么旧 Git 上的用户会看到比现在更多的命令失败。建议维护者在 `MIN_GIT_VERSION` 附近加一句依据，或抬到确有依据的版本。
3. **真实 VS Code 图形环境**：模态确认框、进度可见性、**Restricted Mode 下 `.vscode/settings.json` 是否真的被读取**（四.2 的威胁模型依赖这一点，我只有 `package.json` 未声明 `capabilities` 这一间接证据）。
4. **真实 Gerrit / `refs/for/*` 服务端**：只用本地 bare 远端模拟 refspec 目的端。
5. **非 C locale 的实机反证**：`LC_ALL=C` 是设计上的保证；我只在 C 与（本机未安装对应 catalog 的）`de_DE`/`zh_CN` 下看过 `%(upstream:track)` 仍是 `[gone]`，不能证明别的机器上装了什么 catalog。
6. **Linux/macOS**：`--output=` 的可执行位行为、`--end-of-options` 的 argv 传递，全部只在 Windows/MSYS 上测。
7. **磁盘上真实的诊断日志内容**（`warnDiagnostic("push", …)` 落盘是什么）——只验证了 UI 可见面与 `pushBranch` 的抛/吞行为。
8. **`package-lock.json` 的 4 行改动**没有审。

---

## 九、建议的最小跟进清单

1. **（必须，阻塞发布）** `recentN`：不要把 `-n <n>` 留在位置参数里。让 `resolveRange` 不把选项拼进 `revRange`，或让 `getCommits` 只把 revision 放进位置参数。**并新增一条真正执行 `getCommits` 的用例**（断言返回的条数与标题），否则同类字符串还会再踩一次。
2. **（应该）** `pushRefspec` 的残余风险注释：把"远端名不以 `-` 开头"改正（porcelain 可建，实测 `git remote add -- -evil`），并说明标记恰好让 `-evil` 成为位置参数、推送成功；`up.branch` 那半句可保留。
3. **（应该）** 在 `MIN_GIT_VERSION` 附近注明 `--end-of-options` 的可用版本依据，或把下限抬到有依据的版本。
4. **（可选）** 在 `sendDetail` / `commitDetail` 加一句"hash 已由 `requiresCurrentCommitHash` 限定为 40-hex"的注释，防止将来放宽校验时无声地把 `git show` 变成四.1 的形状。
5. **（流程）** 维护者补 `code-review-commit.md` 的 0-8-17 行。

---

## 十、给下一轮评审的一句话

这一轮**值得肯定**：四.1 与四.2 的两条注入通道，我用自己的探针、在"去掉标记"的对照下验证过——它们是**真的**关上了，而且是标记本身关上的；四.3/四.4 的命名空间与性能修复也都可复现。但"修一处、带一处"的模式**第五轮仍在**：这次带坏的是 `recentN`，而它之所以能溜过去，是因为上一轮刚补的"端到端护栏"只补在推送路径上，`getCommits` 那边仍然只有"拼装字符串"的断言。修 `recentN` 时请顺手补一条**执行**用例——这正是这一轮唯一被漏掉的东西。
