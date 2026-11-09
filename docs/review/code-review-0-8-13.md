# Code Review 0-8-13 — 四项 UI 修复（恢复侧别协议、draft 入口、锁定摘要、Push 三要素）

- 基线：`main` @ `577ce8766a46707a60c471cf8090e9f63cd8d49c`（`test: run each file in its own process and split the slowest suite`）+ 未提交工作树（12 项：8 个已跟踪文件修改、4 个新增）
- 评审性质：四个用户报告的 UI 缺陷修复 + 版本 0.8.3 发布候选。范围含 `src/ui/pushNotification.ts`（新增纯函数）、`src/ui/rebaseViewProvider.ts`（Push 通知与错误路径）、`media/main.js`（恢复协议、draft 入口、锁定摘要）、两个新测试文件与 `webviewDom.test.ts`。
- 方法：Node `v24.x`、`tsx`（仓库内 `node_modules`）、Git `2.45.0.windows.1`。真实 Git 仓库与真实 JSDOM 驱动；破坏性探针全部在 OS 临时目录内执行（`grv-probe*`、`grv-vsix`），结束前已删除。
- 工作树：`git status --short` 开始时 **12** 项，结束时 **13** 项。多出的 1 项是本报告 `docs/review/code-review-0-8-13.md`（本次唯一允许写的文件）。`HEAD` 未变（`577ce87`），`git stash list` 为空，未做任何 commit/tag/checkout/stash/reset。
- **完整套件未由我运行**（规则要求，约 14 分钟不重跑）。我独立运行的是 `test/restoreFileProtocol.test.ts`、`test/pushNotification.test.ts`（6/6 通过）与 `test/webviewDom.test.ts`（10/10 通过），并两次独立执行 `tsc --noEmit` / `tsc -p tsconfig.test.json --noEmit`（均为 0 输出、exit 0）。实现者的 **283/283 全绿我未独立复核**；`283` 这个数字我用静态枚举独立核对过（见第五节），与实现者一致。

---

## 一、结论摘要

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 项 3 恢复侧别协议（真实宿主 + 真实 Git） | **通过**。三条消息的 `side` 均为宿主词表 `working`/`staged`；真实 repo 上 `⌫` 真的删文件、Changes 的 `↶` 真的丢弃工作区改动、Staged 的 `↶` 真的只撤销暂存。旧形状 `side:"unstaged"` 在真实宿主上复现 `缺少要恢复的文件状态` 且文件保留，证明用例非空转 |
| 2 | 项 2 移除普通面板 draft 入口 | **移除本身正确，但理由不成立**，且**确实丢失了一个唯一入口**。见 P1-2 |
| 3 | 项 5 锁定摘要空格 | **通过**。`🔒 : 3 lock · no push · la ×1 · sa ×1 · yu ×1 · replay`，`aria-label` 完整独立；测试钉的是整行精确匹配而非子串 |
| 4 | 项 9 Push 三要素 | **部分通过**。三要素、无 40 位 hash、码点截断、回退、取消路径都对；但**失败路径同时弹出"已推送"成功提示**（P0-1），且**目标分支恒为 upstream，自定义/评审 refspec 指向别的分支时会撒谎**（P1-1） |
| 5 | 版本与文档 | **通过**。`package.json` / `package-lock.json` 两处 / release notes 标题 / `RELEASE.md` 均为 0.8.3；无 `{{…}}`；`283` 静态核对一致；`275` 只出现在 0.8.2 的历史段落里（正确） |
| 6 | VSIX | **通过**。12 条目、白名单通过、manifest `Version="0.8.3"`、包内 `extension.js`/`main.js`/`readme.md` 与工作区逐字节相同；重新构建 `dist/extension.js` 后 sha256 仍为 `132ef1e2…b639b`，证明包内就是当前源码 |
| 7 | 回归 | **两处回归**：P0-1（失败仍报成功）、P1-2（draft 唯一入口丢失）。`side` 翻译对既有 `"working"`/`"staged"` 调用者行为不变；无死代码（`changeButton` 在 HEAD 就已是死代码，非本次引入） |

**发布裁决：不批准。** 0.8.3 不能以当前形态发布。P0-1 是一处用户可见的假成功提示（"推送失败"红色错误与"已推送"绿色成功同时出现），P1-2 是"用户知道要不要应用"这一前提在产品上不成立时丢失的唯一入口。两者都不是文案问题，需要改代码。

---

## 二、P0-1 — Push 失败后仍然弹出"已推送"成功提示

### 2.1 现象（真实 provider + 真实不可达远端）

`src/ui/rebaseViewProvider.ts` 把原先的 `throw error` 改成了 `toast(...)` + `return`：

```ts
} catch (error: any) {
  const message = String(error.message ?? error);
  this.log("push", `失败 ${message}`);
  if (controller.signal.aborted) {
    throw new Error("推送已取消。");   // 取消仍然 throw —— 正确
  }
  toast("error", `推送失败：${described}。${message}`);
  return;                              // 3076 行：只退出了 withProgress 回调
}
```

`return` 只结束 `withProgress` 的任务回调，**不会**结束外层的 `pushBranchInternal`。回调正常 resolve 之后，3080 行照常执行：

```ts
toast("info", `已推送：${described}`);   // 3080 行
```

探针（`grv-probe/failpush.ts`，远端已配置但不存在，与实现者自己的失败用例同一形状）：

```
THROWN: (none)
INLINE_TOASTS: ["已推送：普通推送：\"fix: reject an unreadable stash list\" → origin/master"]
STUB_MESSAGES: ["推送失败：普通推送：\"fix: reject an unreadable stash list\" → origin/master。
                 git push --force-with-lease=master origin HEAD:refs/heads/master failed (128): fatal: …"]
```

用户同时看到：红色错误通知 `推送失败：…` 和绿色面板内提示 `已推送：…`。推送**没有发生**（`git rev-parse origin/master` 未前进），但界面说了两遍相反的话。

### 2.2 为什么测试没抓到

`test/pushNotification.test.ts:143` 的失败用例只断言"存在 `推送失败` 的 error 消息"，**没有断言成功提示不存在**。同一文件的成功用例用 `harness.toasts.at(-1)` 取最后一条——在失败路径里 `toasts.at(-1)` 恰好就是那条假的"已推送"，但失败用例没有读 `toasts`。这是一条**能被现有测试形状轻易补上**的缺口：`assert.equal(harness.toasts.filter(t => t.text.startsWith("已推送")).length, 0)`。

### 2.3 修复建议

在 `catch` 里不要 `return`，而是把失败状态带出去，例如：

```ts
let failed = false;
await vscode.window.withProgress(…, async (_p, token) => {
  try { await pushRefspec(…); }
  catch (error: any) {
    if (controller.signal.aborted) throw new Error("推送已取消。");
    toast("error", `推送失败：${described}。${String(error.message ?? error)}`);
    failed = true;
    return;
  }
});
if (failed) { await this.refresh(); return; }
toast("info", `已推送：${described}`);
```

并补一条"失败时不得出现 `已推送`"的断言。注意 0.8.2 及更早的行为是 `throw error`，由 `handleMessage` 的统一 catch 报错并 `refresh()`；本次改动把"抛错"换成"自己 toast + return"，**顺带丢掉了 `refresh()`**——失败后视图也不会刷新（旧路径会刷新）。

---

## 三、P1-1 — 三要素里的"目标分支"取自 upstream，而不是实际推送的 refspec

`describePush(kind, subject, up.ref)`（3052 行）的第三个参数是 `up.ref`，即 `<remote>/<upstream 分支>`。但 `refspec` 在评审/自定义分支里**可以与 upstream 无关**。

探针（`grv-probe/custom-target.ts`）：把 `push.refspecTemplate` 设为 `HEAD:refs/heads/hotfix`，quick pick 选"自定义"，输入同一 refspec，推送真实 bare 远端：

```
TITLES: ["推送中：自定义推送：\"second: change\" → origin/master"]
TOASTS: ["已推送：自定义推送：\"second: change\" → origin/master"]
REMOTE BRANCHES: "refs/heads/hotfix\nrefs/heads/master"
hotfix sha: 2b2b7a1…   HEAD: 2b2b7a1…
```

实际上 `refs/heads/hotfix` 才是被更新的分支，`refs/heads/master` 根本没动，但通知说 `→ origin/master`。评审推送同理（`grv-probe/review-target.ts`）：

```
TITLES: ["推送中：评审推送：\"review target subject\" → origin/master"]
REMOTE REFS: "refs/for/master\nrefs/heads/master"
```

推的是 `refs/for/master`，通知说 `origin/master`。

这正是 release notes 自己声称已经避免的那类错误："推送方式与 refspec 一起在决定的那一步确定，二者不会出现'提示说普通推送、实际推的是评审 refspec'的分叉。" **推送方式确实没有分叉，但目标分支分叉了**——而"推到哪个分支"恰恰是用户报告的第二个诉求。

严重性定 P1 而非 P0：推送本身正确，不丢数据、不改错分支；但通知对评审推送（Gerrit `refs/for/*`）这个**最常见的使用场景**给出了错误的落点，且新写的文档把它当作已验证的事实。

修复方向：`kind` 之外再带出"用户可读的落点"。最小改法是从实际 refspec 的目标端推导（`HEAD:refs/heads/hotfix` → `origin/hotfix`；`HEAD:refs/for/master` → `origin/refs/for/master` 或 `refs/for/master`），拿不到时回退到 `up.ref`，并在 `pushNotification.test.ts` 里加一条"自定义 refspec 指向其它分支"的真实推送用例——现有测试只覆盖了"普通推送"（模板为空）这一条路径（`stub` 里 `getConfiguration` 恒返回 fallback，因此 `template` 永远为空，**评审/自定义分支在测试中从未被走到**）。

---

## 四、P1-2 — 项 2 的移除理由不成立，且丢失了唯一入口

### 4.1 "唯一不碰 Git 的路径"只在 edit 停靠时为真，而该入口在**所有**暂停状态都存在

我在真实 JSDOM 上同时加载 HEAD 的 `media/main.js` 与当前版本，按四种状态统计"仅生成 message"入口的数量（`grv-probe/headpaths.ts`）：

```
state      HEAD(changes/banner)     NOW(changes/banner)
idle       1/0                      0/0
conflict   1/0                      0/0
paused     1/0                      0/0
edit       1/1                      1/1
```

HEAD 上这个入口在 **idle、conflict 暂停、rebase 进行中（非 edit）** 都渲染一次，本次全部删除，只保留 edit 停靠。实现者的修正确实说对了"HEAD 上是渲染一次而不是两次"，但**由此推出的结论只对 edit 停靠状态成立**：

- edit 停靠：Amend 会改写、"新建 commit"会提交，draft 入口确实是唯一不写 Git 的路径。**保留它是对的。**
- conflict 暂停 / 普通 paused：Amend 与"新建 commit"**根本不存在**（横幅只有 Continue/Skip/Abort，见上面的 banner 列）。那里被删掉的入口**也是**唯一不写 Git 的路径，而不是"功能重复"。

### 4.2 删除后确实出现"无草稿入口"的状态

`hasStaged === false` 时，HEAD 的入口 post 的是 `mode:"working"`（探针 `grv-probe/nostaged.ts`）：

```
HEAD idle/no-staged -> {"found":true,"last":{"type":"openCompose","mode":"working","ai":true,"thenEdit":false,"messageOnly":true}}
NOW  idle/no-staged -> {"found":false,"last":{"type":"ready"}}
```

而当前 `media/main.js` 里**唯一**会 post `mode:"working"` 的地方就是被删的那一行（edit 停靠的分支用 `state.hasStaged ? "staged" : "working"`，但只在 edit 停靠可达）。也就是说：**无暂存改动、不在 edit 停靠**的用户，现在没有任何入口能对工作区改动生成草稿。用户在报告里说的"文件管理区已经覆盖了这个需求"——文件管理区只能 stage/restore/unstage，**不能生成 message**；"AI-message 面板本身可以不应用就生成"——Compose 面板的"复制 message"按钮只在 `messageOnly === true` 时显示（`src/ui/composePanel.ts:158`：`$('copy').style.display=m.messageOnly?'':'none'`），而 Staged Changes 的 `✦` 打开的是 `messageOnly: false`，那个按钮是**隐藏**的。

### 4.3 对用户报告的判断

用户的原话是"用户总归是知道自己要不要应用的"。该前提只对"打开了 Compose 面板"的用户成立；对"根本进不去 Compose"的状态不成立。实现者的移除对 **edit 停靠**合理，对 **conflict / paused / 无暂存的 idle** 是净损失。建议：

- 要么把入口恢复到 conflict 与普通 paused 两种状态（那里同样没有第二个不写 Git 的路径）；
- 要么在 `hasStaged === false` 的 idle 状态补一条进入 `mode:"working"` 草稿的入口；
- 至少要修正 `README.md:113`（"这个入口只出现在 edit 停靠的横幅里"——横幅里确实如此，但 Changes 分组里也有一个，见下）与 `README.md:55`（仍把"顶部 **未提交的改动** 区的 **仅生成 message（不提交）**"列为 Compose 弹窗的入口之一，**已经不存在了**）。

### 4.4 文档自相矛盾（P3，随 P1-2 一起修）

`README.md:113` 说"这个入口只出现在 edit 停靠的**横幅里**"，但同一句话后面又承认 edit 停靠时 Changes 分组也有一个。实测 edit 停靠是 2 处（横幅 1 + Changes 分组 1），其余状态 0 处。`docs/release-notes/0.8.3.md:26` 与 `RELEASE.md:126` 的措辞（"横幅与 Changes 分组各出现一次"）是对的；`README.md:113` 的"只出现在横幅里"是错的。

---

## 五、逐项验证证据

### 5.1 项 3：恢复侧别协议（通过，非空转）

代码侧（`media/main.js:227`）：

```js
const restoreSide = side === "staged" ? "staged" : "working";
const untracked = restoreSide === "working" && change.worktreeKind === "untracked";
```

宿主侧（`src/ui/rebaseViewProvider.ts:2700`）仍然只接受 `"working"` / `"staged"`，**没有**增加 `unstaged` 别名——单一词表，符合"在边界翻译一次"的说法。

真实驱动（我独立运行 `test/restoreFileProtocol.test.ts`，1/1 通过）：把 webview **自己发出的**三条消息原样送进 `handleMessage`，在真实临时仓库上验证：

- `⌫` untracked → 文件从磁盘消失，toast 为 `已删除未跟踪文件 …`
- Changes 的 `↶` → `modified.ts` 内容回到 `base\n`
- Staged 的 `↶` → `staged.ts` 的 `staged` 变 `false`、`unstaged` 变 `true`、内容仍为 `changed\n`

**非空转证明**（`grv-probe/oldsideshape.ts`）：把旧形状 `{side:"unstaged", deleteUntracked:true}` 直接喂给真实宿主：

```
OLD SHAPE ERROR: ""
file still exists: true
STUB msgs: ["error:缺少要恢复的文件状态。 "]
```

即把 webview 改回发送分组键，这条用例会红（文件不会被删、错误信息正是用户报告的那句）。

**兄弟字段审计**（要求 1 的第二问）：用脚本枚举 `media/main.js` 里所有 `postMessage` 携带的枚举字段，与宿主 `switch` 的 `case` 集合求差：

```
webview literal types: abortRebase, bulkDrop, …, unstageAllFiles        (22 个)
dynamic send types:    appendStaged, copyHash, …, unlock                (10 个)
MISSING HOST CASE: (none)
```

`placement` 的 `"before"/"after"` 与 `src/ui/rebaseReorderState.ts:59` 的校验一致；`mode` 的 `"commit"/"staged"/"working"` 与 `openCompose`/`generate` 的 `["commit","staged","working"].includes(mode)` 一致；`restoreWorktreeChange` 是本次唯一一处"消息词表 ≠ 宿主词表"的地方，已修。Compose 面板的 `composeDraft`/`composeReady` 由 `ComposePanel` 自己消费（`src/ui/composePanel.ts:63,68`），不进 `handleMessage`，不是漂移。

`source` 字段：`sourceForAction` 对 `restoreFile` 返回 `webview:worktree-mutation`，与宿主的 `shortSource` 诊断口径一致，翻译后未改变。

### 5.2 项 5：锁定摘要（通过）

真实 JSDOM（`grv-probe/replay.ts`，3 个 locked commit + `pendingHashes` 命中）：

```
VISIBLE: "🔒 : 3 lock · no push · la ×1 · sa ×1 · yu ×1 · replay"
ARIA   : "已锁定 3 个 commit，不会被推送；lawrence_v 1 个，sally_peng 1 个，yucheng_xiang 1 个；拖入上半部…"
```

- 空格正确（`🔒 : 3`），作者列表与 ` · replay` 后缀拼接未受影响。
- `aria-label` 仍由独立的 `runSummaryAria` 生成，不读紧凑文本，内容完整。
- `test/webviewDom.test.ts:461` 用的是**整行锚定**正则 `/^🔒 : 3 lock · no push · la ×1 · sa ×1 · yu ×1$/`，不是子串——`🔒 :3` 会失败。这是钉住真实字符串，不是宽松匹配。唯一小缺口：该用例没有覆盖 ` · replay` 后缀（`state()` 不带 `pendingHashes`），但后缀拼接代码本次未改动，风险可忽略（P3）。

### 5.3 项 9：Push 三要素（部分通过，见 P0-1 / P1-1）

用真实 provider + 真实 bare remote 逐条核对：

| 要求 | 结果 | 证据 |
|---|---|---|
| 无 40 位 hash | **通过** | 成功/失败通知均只含 subject；`test/pushNotification.test.ts:115-117` 同时断言 40 位与 7 位短 hash 都不出现 |
| 推送方式不因 refspec 相同而错 | **通过** | `kind` 由 quick pick 分支直接赋值（3019/3030 行），不从字符串反推；`describePush('custom',…)` 返回 `自定义推送`，与 refspec 内容无关 |
| 60 码点截断不切代理对 | **通过** | `Array.from` + `slice`；`✨×65` 截断后 `Array.from(...).length === 61`（60+省略号），`✨×60` 原样保留 |
| 恰好等于上限不触发 | **通过** | `points.length <= limit` 为闭区间；`"x".repeat(60)` 输出 60 码点且无 `…`，`repeat(61)` 才截断 |
| 不可读 subject 有回退 | **通过** | `shortenSubject("")` 为空 → `describePush` 用 `PUSH_SUBJECT_UNKNOWN`，不会出现 `""`；测试 `doesNotMatch(unreadable, /""/)` |
| 失败路径仍显示 Git 错误 | **通过** | `推送失败：…。<message>`，探针可见 `fatal: … does not appear to be a git repository` |
| 取消仍说"推送已取消" | **通过** | 探针 `grv-probe/cancel.ts`：`THROWN: 推送已取消。`，`INLINE_TOASTS: []`（没有误报成功） |

`60` 是码点而非 UTF-16 码元：`Array.from` 按码点迭代，路径正确。

### 5.4 版本与文档（通过）

```
package.json:5          "version": "0.8.3"
package-lock.json:3     "version": "0.8.3"     (顶层)
package-lock.json:9     "version": "0.8.3"     (packages[""])
docs/release-notes/0.8.3.md:1   "## Git Rebase Visual 0.8.3"
RELEASE.md:122          "- **0.8.3** — …"
```

- 0.8.3 release notes 无 `{{…}}`（脚本 `/\{\{[^}]*\}\}/` 为 false）。
- `283`：我用脚本对 `test/*.test.ts` 逐个统计行首 `test(`，合计 **283**，与 `RELEASE.md:127`、`docs/summary/summary.md:149` 一致；逐文件明细（`webviewDom` 10、`pushNotification` 5、`restoreFileProtocol` 1 等）与实现者声明的"275 → 283，新增 8"吻合（`webviewDom` 8 → 10，其余两个文件共 6 条）。
- `275` 只出现在 `RELEASE.md:145` 的 **0.8.2** 历史段落中——那是历史事实，正确。
- `0.8.2` 的残留：`RELEASE.md:129` 是 0.8.2 的历史条目（正确）；`docs/summary/summary.md:3` 提到"以及 0.8.2 的追加恢复…"是把 0.8.2 的内容作为 0.8.3 基线的一部分陈述（正确）。
- "渲染两次"措辞：`RELEASE.md:126`（"在 HEAD 上只渲染一次"）、`docs/release-notes/0.8.3.md:26`（"横幅与 Changes 分组各出现一次（HEAD 起即如此）"）、`test/webviewDom.test.ts:334`（"appears twice"）三处一致。四处中唯一不一致的是 `README.md:113` 的"只出现在 edit 停靠的横幅里"（见 4.4）。

### 5.5 VSIX（通过）

```
node scripts/package-vsix.js --verify-only  ->  "VSIX contents match the allowlist (12 entries)."
```

解包后逐文件核对：

```
[Content_Types].xml, extension.vsixmanifest, extension/.gitignore, extension/LICENSE.txt,
extension/package.json, extension/readme.md, extension/dist/extension.js,
extension/dist/seq-editor.js, extension/media/{extension-icon.png,icon.svg,main.js,style.css}
= 12
```

- `extension.vsixmanifest`: `<Identity … Version="0.8.3" …>`；包内 `package.json` 版本 0.8.3。
- 字节一致：`dist/extension.js`、`media/main.js`、`README.md` 与工作区的 sha256 **完全相同**。
- 包不是旧的：源文件 mtime 15:22–15:38，`dist/extension.js` 16:50，VSIX 16:50；我**重新执行** `node esbuild.js` 后 `dist/extension.js` 的 sha256 仍为 `132ef1e2…b639b`，说明包内 bundle 是当前源码的忠实构建（不是缓存）。
- 新代码确实在包里：bundle 里中文以 esbuild 的 `\uXXXX` 转义存放，按转义形式检索 `普通推送` / `评审推送` / `自定义推送` / `推送失败：` / `推送中：` / `已推送：` / `无法读取 commit 标题` / `推送已取消` **全部命中**；旧字符串 `推送中：${refspec}` 已不存在。包内 `media/main.js` 含 `restoreSide`（3 处）。
- 未打包评审文档：`docs/review/*`、`test/` 均不在 12 条目内，符合 `CLAUDE.md` 的"不得把评审文档/测试/本地工具状态打进 VSIX"。

### 5.6 回归

- `side` 翻译对既有调用者的行为：翻译只作用于 webview → 宿主的边界；宿主 `restoreChangedFile` 的签名与校验**未改**，任何本来就发 `"working"`/`"staged"` 的调用者行为不变。`deleteUntracked` 的判定从 `side === "unstaged"` 改为 `restoreSide === "working"`，对未跟踪文件（分组键 `unstaged` → `working`）语义等价。
- 死代码：`changeButton`（`media/main.js:253`）在 HEAD 就已是零调用点的死代码，不是本次引入；本次删除的 `if (!atEditStop)` 分支没有留下不可达代码。
- 文档一致性：`docs/summary/summary.md` 更新了 push 行、文件级 SCM 恢复行、源码树与测试表，与代码一致。
- `README.md:55` 仍把已删除的入口列为 Compose 弹窗来源（P3，见 4.3）。

---

## 六、发现清单（按严重性）

### P0-1 — Push 失败后仍弹"已推送"成功提示
`src/ui/rebaseViewProvider.ts:3076` 的 `return` 只退出 `withProgress` 回调，3080 行照常执行。真实探针证据见 2.1。附带影响：失败后不再 `refresh()`（旧行为是 `throw`，由 `handleMessage` 统一 catch 里刷新）。测试缺口：`test/pushNotification.test.ts` 的失败用例只断言错误存在，未断言成功提示不存在。

### P1-1 — 目标分支取自 upstream，与自定义/评审 refspec 的实际落点不符
`describePush(kind, subject, up.ref)`（3052 行）。真实推送探针显示 `refs/heads/hotfix` 与 `refs/for/master` 都被报成 `origin/master`。现有测试从未覆盖 `getPushRefspecTemplate()` 非空的路径（stub 的 `getConfiguration` 恒返回 fallback）。

### P1-2 — draft 入口在 conflict / paused / 无暂存 idle 状态被一并删除，且那是唯一入口
证据见第四节。`hasStaged === false` 且不在 edit 停靠时，当前没有任何 UI 能打开 `mode:"working"` 的草稿；Compose 的"复制 message"仅对 `messageOnly` 面板可见，而 `✦` 打开的是 `messageOnly: false`。

### P3-1 — `README.md:113` "只出现在 edit 停靠的横幅里"与实现不符
edit 停靠时实测 2 处（横幅 + Changes 分组，`RELEASE.md` 与 release notes 的措辞是对的），其余状态 0 处。

### P3-2 — `README.md:55` 仍把已删除的入口列为 Compose 弹窗来源
"顶部 **未提交的改动** 区的 **仅生成 message（不提交）**"——普通面板已无此入口。

### P3-3 — 锁定摘要测试未覆盖 ` · replay` 后缀
`test/webviewDom.test.ts:461` 的 `state()` 不带 `pendingHashes`，整行正则不含 ` · replay`。后缀拼接代码本次未改，风险低。

### P3-4 — 失败路径不再刷新视图
与 P0-1 同源：旧代码 `throw` 后由 `handleMessage` 的 catch 执行 `await this.refresh()`；新代码 `return` 跳过了刷新。

---

## 七、发布裁决

**0.8.3 不批准发布。**

- **不批准项 9 的当前实现**：P0-1 让用户在推送失败时同时看到"推送失败"和"已推送"，这是会误导用户重试或误以为远端已更新的可见缺陷；P1-1 让评审推送（本项目明确支持的 Gerrit 场景）把落点报成 upstream 分支。两项都在 `pushBranchInternal` 的同一个函数里，修复面很小。
- **不批准项 2 的当前形态**：P1-2 是功能删除，不是文案错误。若坚持删除，至少要把 conflict / paused 两个状态的入口补回，或在无暂存时提供 `working` 草稿入口，并修正 `README.md:55` / `README.md:113`。
- 项 3 与项 5 **通过**，且项 3 的修复质量高于本轮其他改动：真实宿主 + 真实 Git 的用例、以及"旧形状必然变红"的可证伪性都做到了。

**关于 VSIX**：`dist-vsix/git-rebase-visual-0.8.3.vsix` 本身**构建正确**（12 条目、白名单通过、manifest 与包内文件版本 0.8.3、与工作区逐字节一致、由当前源码重新构建可复现同一 sha256）。但因为 P0-1 / P1-1 / P1-2 是**产品行为缺陷**而不是打包缺陷，这个 VSIX **不应被发布**；批准发布不等于批准这个产物。修复后需要重新执行 `npm run package` 并重新校验（重新打包会改变 `extension.js` 之外的 mtime，但内容应由同一 `esbuild.js` 产出）。

**未独立复核的部分**：完整套件 283/283（我只跑了三个文件：6/6 + 10/10）；实现者记录的全量日志 `%TEMP%/grv-full-083-final.log` 显示 `tests 283 / pass 283 / fail 0`，我读了该日志但未重跑。`npm run test` 的约 14 分钟开销按规则跳过。
