# Git Rebase Visual — 复核与整改报告

> 复核基线：当前工作树（基于 v0.2.0 / `a6a31fd` 后的整改）
>
> 复核方法：逐项阅读实现、以临时 Git 仓库执行 stash/rebase/edit 流程、运行 TypeScript 类型检查和逻辑/边界/Git 集成测试。
>
> 状态含义：`[x]` 已确认问题并完成整改；`[ ]` 结论不成立或暂不整改，紧随其后的“未修改原因”说明原因；`[-]` 是设计建议而非缺陷。

## 复核结果摘要

原报告包含 20 个编号问题、若干 CI/安全/并发观察项。复核后结论如下：

| 分类 | 数量 | 结果 |
|---|---:|---|
| 已确认且已修复 | 8 | R-1、R-2、R-3、R-4、R-6 的数据丢失分支、R-8、R-9、R-10、R-16、CI-C |
| 已确认但暂不整改 | 5 | R-5、R-7、R-11、R-13、R-15 |
| 结论不成立 / 仅建议 | 7 | R-12、R-14、R-17、R-18、R-19、R-20、CI-D |

> 注：R-6 与 R-16、CI-C 分别含多个子结论，因此表中项目数与编号数不一。测试套件目前有 **21** 个测试，覆盖逻辑、边界和真实 Git 临时仓库集成路径。

---

## 1. 已确认并整改的问题

### R-1. Git 子进程无输出上限、超时和取消能力

- [x] **已修复。**

**核验结论：正确。** 原实现在 `runGit` 中累积 stdout/stderr，没有上限；远端 push 或受阻文件系统也可能长时间不返回。

**整改：**[`src/git/gitRunner.ts`](../../src/git/gitRunner.ts) 增加：

- 默认 50 MiB 的 stdout/stderr 合并输出上限；
- 默认 120 秒超时；
- `AbortSignal` 取消支持；
- 输出越界、超时或取消时终止 Git 子进程并返回明确失败结果。

**验证：**`test/gitRunner.integration.test.ts` 覆盖非零返回、输出限制和已取消 signal。

### R-2. 非标准 Git 目录下的 rebase 路径解析

- [x] **已修复。**

**核验结论：正确。** `git rev-parse --git-path` 默认可以返回相对路径；原实现以工作目录拼接，虽然普通仓库通常可用，但 worktree 或特殊 git-dir 布局中不够稳健。

**整改：**[`src/git/commitLog.ts`](../../src/git/commitLog.ts) 对 `rebasingBranch`、`isRebaseInProgress`、`rebaseStoppedSha` 使用 `--path-format=absolute --git-path`，直接消费绝对路径。

**验证：**`test/commitLog.integration.test.ts` 在真实 rebase `edit` 停靠状态验证检测与 stopped SHA。

### R-3. reorder 未校验完整提交集合

- [x] **已修复。**

**核验结论：正确。** 原实现会把 webview 传来的数组直接写进 todo；缺项即等同于静默 drop。

**整改：**[`src/ui/rebaseViewProvider.ts`](../../src/ui/rebaseViewProvider.ts) 现在要求 `order`：

- 是数组；
- 长度与当前 commit 集合一致；
- 不含重复项；
- 每项是 40 位 SHA 且属于当前快照。

失败时取消操作并刷新 UI。

### R-4. Webview hash 消息缺少当前快照与格式校验

- [x] **已修复。**

**核验结论：正确。** 虽然 `spawn` 参数数组不存在 shell 注入，但过期或畸形 hash 会造成锁状态或历史操作与 UI 脱节。

**整改：**对 copy/detail/drop/rebase/lock/unlock/append 使用 `isCurrentCommitHash`，同时校验 40 位 SHA 与当前 `this.commits` 集合。

### R-6. Trailer 处理会错误丢弃原 trailer 块

- [x] **已修复（确认的数据丢失分支）。**

**核验结论：部分正确。** 原 `applyTrailers` 只要编辑结果含任意已识别 trailer，就直接返回整个编辑文本；这确实可能丢弃原先的 `Change-Id` 等 trailer。原报告关于“必须完全改用 `git interpret-trailers`”属于实现建议，不是该缺陷唯一或必要的修复方式。

**整改：**

- `applyTrailers` 现在在编辑内容确实提供结尾 trailer 块时，规范化保留该编辑块；否则追加原 trailer 块；
- trailer 扫描可在已识别 trailer 相邻时保留任意标准 `Key: Value` 行，例如 `Bug:`。

**验证：**`test/message.test.ts` 覆盖原 trailer 保留、显式替换、相邻通用 trailer、无 trailer 和边界文本。

### R-8. refresh 竞态与写操作并发

- [x] **已修复。**

**核验结论：正确。** 原 `refresh()` 可并发运行并覆写共享 `this.commits`；多个历史改写动作也可同时开始。

**整改：**

- 刷新使用 generation token，仅最新请求可以更新 `this.root`、`this.commits` 和 webview state；
- rebase、锁、compose/apply、append、continue/abort 等写操作经 `busy` 串行化；忙碌时拒绝新的写请求。

### R-9. append 已锁定 commit 使 patch-id 锁失效

- [x] **已修复。**

**核验结论：正确。** amend 会改变 diff 和 patch-id；原锁记录将不再匹配，确会削弱后续 push guard。

**整改：**append 前计算 patch-id 并调用 `LockStore.isLocked`；已锁定目标必须先显式解除锁定，不能继续追加。

### R-10. append 已推送 commit 没有明确风险提示

- [x] **已修复。**

**核验结论：正确。** `all` 与 `mainBranch` 范围可以显示 upstream 已包含的提交，append 会重写公开历史。

**整改：**append 前验证 upstream 是否包含目标 SHA；确认文本明确提示需要 `--force-with-lease` 更新远端。

### R-16. 缺失自动化测试

- [x] **已修复。**

**核验结论：正确。** 原仓库没有可执行测试源码。

**整改：**新增 `node:test` + `tsx` 测试体系：

- 逻辑：trailer、rebase todo、refspec；
- 边界：空 todo、无 trailer、空白模板、输出上限、取消、失效 stash；
- Git 集成：status、stash apply/pop/drop、keep-index、rebase edit 停靠、完整 append staged 事务。

`npm run test` 与 `npm run test:coverage` 可执行。当前 21 项测试通过。

### CI-C. Release notes 双信息源漂移

- [x] **已修复。**

**核验结论：正确。** `--generate-notes` 与 `RELEASE.md` 独立维护时可能漂移。

**整改：**Release 工作流在创建 GitHub Release 前检查 `RELEASE.md` 中存在当前版本条目；没有记录就失败，不发布 VSIX。

---

## 2. 已确认但本次不修改的问题

### R-5. LLM 超时、错误响应正文与 streamChat 未接入

- [ ] **本次不修改。**

**核验结论：部分正确。** `fetch` 没有独立超时，错误正文可能过于详细，`streamChat` 目前未被调用，三个观察都成立。

**未修改原因：**这涉及 LLM 产品交互和错误信息策略，不能只在底层机械加 timeout：需要决定生成时长、是否重试、用户可见的流式增量协议、以及错误分类文案。当前 `withProgress` 已提供用户取消能力；将其列为下一轮独立需求，避免把未经 UX 设计的流式行为混入本次历史操作与测试整改。

### R-7. 运行中的 push 无独立取消 UI

- [ ] **本次不修改。**

**核验结论：部分正确。** Push 没有在 UI 中暴露单独取消按钮；但 R-1 已使底层 Git 有 120 秒超时，避免无限挂起。

**未修改原因：**将 Push 包进 cancellable `withProgress` 需要梳理确认弹窗、错误 toast 与 `AbortSignal` 的用户语义。当前底层超时已消除报告声称的“永远挂住”风险，独立取消体验留待 UX 迭代。

### R-11. append Abort 时两个 stash 的提示粒度

- [ ] **本次不修改。**

**核验结论：正确但低优先级。**原实现会在原 index 恢复失败时保留两份可恢复 stash，后续 refresh 重试；提示可更精细。

**未修改原因：**当前行为优先保证数据不丢失，且 message 已说明 stash 保留并需手动恢复。增加“打开 stash 列表”等操作需新增 VS Code 命令/UX，不应在本次修复中引入未经验证的新界面。

### R-13. 暂存后菜单状态需刷新

- [ ] **本次不修改。**

**核验结论：正确。**Webview 依赖上一次 `state.hasStaged`；外部 `git add` 后需要 refresh 才会解禁菜单。

**未修改原因：**扩展没有稳定、公开的 VS Code Git SCM 状态事件可直接跨所有 Git 扩展实现使用；轮询会带来频繁 Git 调用。菜单本身不会因此误操作（后端仍二次 `workingStatus` 校验）。下一步可设计基于文件系统监听与节流的刷新策略。

### R-15. commitDetail 的 shortstat 文本解析

- [ ] **本次不修改。**

**核验结论：正确但影响范围有限。**对 merge 或特殊 Git 输出，取最后一个匹配统计行的方式可能不够结构化。

**未修改原因：**结果仅用于 hover 展示，不驱动历史改写或数据保护；当前 Git 常见输出下可用。改为 `--numstat` 会改变展示格式并需要单独的 merge/二进制文件 UX 定义。

---

## 3. 不成立或仅为建议的结论

### R-12. 到目标 edit 前冲突会留下“无标识且无法找回”的 changeStash

- [ ] **不修改。**

**核验结论：不成立。**原报告说用户“不知道对应哪条 stash”，但 stash message 固定为 `git-rebase-visual auto-stash`，且 rebase 保持暂停状态。更关键的是，提交前冲突并不是安全地自动 abort 的场景：保留 Git 原生冲突状态让用户选择 Continue/Abort 才能避免把其已进行的冲突解决丢弃。

**不修改原因：**当前做法保留可恢复的 snapshot，优先级正确。未来可改善文案为“运行 `git stash list` 查找 git-rebase-visual auto-stash”，但这不是数据正确性缺陷。

### R-14. `--force-with-lease=${up.branch}` 只限定分支名

- [ ] **不修改。**

**核验结论：不成立。**对于当前唯一的普通 push refspec `HEAD:refs/heads/<upstream branch>`，限定该分支正是正确行为；评审 ref 已刻意不加 lease。

**不修改原因：**没有当前 bug。若将来支持多 refspec，再重新评估。

### R-17. 不使用 `--no-verify` 是问题

- [ ] **不修改。**

**核验结论：不成立。**保留 commit hooks 是安全且符合 Git 预期的选择，尤其是 Gerrit `Change-Id` 与项目质量门禁。

**不修改原因：**绕过 hooks 会降低项目保护；错误会经现有 Git 错误提示返回。

### R-18. CSP 的 `style-src 'unsafe-inline'`

- [ ] **不修改。**

**核验结论：仅安全加固建议。**当前 webview 使用静态脚本 nonce，用户数据经 `textContent` 写入；`unsafe-inline` 的存在不是可复现漏洞。动态行颜色通过 JS style 属性设置，收紧 CSP 可能破坏该功能。

**不修改原因：**需先重构颜色渲染为 CSS class/CSS variable，并以浏览器/VS Code CSP 行为验证；当前没有安全漏洞证据。

### R-19. RebaseViewProvider 文件过大

- [ ] **不修改。**

**核验结论：正确观察，但不是功能缺陷。**

**不修改原因：**拆分 900+ 行协调器的回归面广，且尚无完整 extension-host UI 测试桩。先补齐纯逻辑与真实 Git 集成测试，再在独立重构任务中拆分，避免为“行数”引入行为变化。

### R-20. 配置重复与动态导入风格

- [ ] **不修改。**

**核验结论：部分正确但仅可维护性建议。**package manifest 是 VS Code 设置 schema，`config.ts` 是运行时读取，二者职责并非重复定义同一实现；动态 import 风格不统一也不构成行为错误。

**不修改原因：**没有出现默认值漂移证据。单一来源生成方案需工具链设计，不适合本次功能修复。

### CI-D. 产物签名 / 多平台构建

- [ ] **不修改。**

**核验结论：增强建议，不是当前 CI 缺陷。**VSIX 是 Node/JS 扩展产物，不需要按平台编译；GitHub Release 已提供校验 digest。

**不修改原因：**发布签名需要明确分发信任模型与密钥管理方案。

---

## 4. 安全与并发复核

| 结论 | 复核结果 | 说明 |
|---|---|---|
| S-1 命令注入无风险 | 正确 | Git 参数通过 `spawn("git", args)` 传递，不经 shell。 |
| S-2 webview XSS 风险低 | 正确 | 用户可控字段使用 `textContent`，banner 的 `innerHTML` 是静态模板。 |
| S-3 seq-editor 本地文件读取 | 正确 | 环境变量由扩展生成，写入目标由 Git 调用传入。 |
| S-4 API key 位于 settings | 正确、未改 | SecretStorage 迁移是未来安全增强。 |
| S-5 大 diff / 大列表性能 | 部分已改 | Git 输出有 50 MiB 上限；列表虚拟化仍是未来性能工作。 |
| 并发 rebase/push/apply/append | 已整改 | 写操作互斥；refresh 使用 generation token。 |
| Continue 双击 | 已整改 | Continue/Abort 已纳入互斥写操作。 |

---

## 5. 当前发布门禁与测试矩阵

Release workflow 在 tag 与 package version 一致后，依次执行：

1. `npm run test:release`：`tsc --noEmit` + `tsx --test --experimental-test-coverage`；
2. `npm run package`；
3. 检查 VSIX 必含 `dist/extension.js`、`dist/seq-editor.js`、`media/main.js`、`package.json`；
4. 检查 VSIX 不含 `src/`、`test/`、`docs/`、`node_modules/`；
5. 检查 `RELEASE.md` 含对应版本；
6. 仅所有步骤成功后创建 GitHub Release 并上传 VSIX。

| 类型 | 测试文件 | 重点 |
|---|---|---|
| 逻辑 | `message.test.ts`、`rebaseEngine.test.ts`、`pushGuard.test.ts` | trailer、todo、refspec |
| 边界 | `gitRunner.integration.test.ts`、`message.test.ts` | 输出限制、取消、无 trailer、空 todo |
| Git 集成 | `commitLog.integration.test.ts`、`worktree.integration.test.ts` | 状态、stash、absolute git-path、edit stop |
| 功能集成 | `appendStaged.integration.test.ts` | staged append、后续提交重放、未暂存改动恢复、stash 清理 |

---

## 6. 后续优先级

1. **P1：**LLM 请求超时/错误脱敏与流式输出（R-5）。
2. **P1：**Push 取消体验和 OutputChannel 诊断（R-7 / UX）。
3. **P2：**有节流的 SCM/文件变化刷新，使 append 菜单状态实时更新（R-13）。
4. **P2：**结构化 commit stat、stash 恢复引导、多根工作区、Provider 拆分和列表虚拟化。

当前版本已具备可重复的本地与 Release CI 验证路径；本次确认的历史保护、并发与输入校验问题均已整改。
