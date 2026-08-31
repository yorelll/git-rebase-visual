# Git Rebase Visual — 复核与整改报告

> 复核基线：v0.3.0 P1 功能开发工作树。
>
> 复核方法：逐项阅读实现、以临时 Git 仓库执行 stash/rebase/edit 流程、运行 TypeScript 类型检查和逻辑/边界/Git/HTTP 集成测试。
>
> 状态含义：`[x]` 已确认问题并完成整改；`[ ]` 结论不成立或暂不整改，紧随其后的“未修改原因”说明原因；`[-]` 是设计建议而非缺陷。

## 复核结果摘要

| 分类 | 结果 |
|---|---|
| v0.2.1 已完成 | Git 输出限制/超时/取消、绝对 git-path、输入校验、历史操作互斥、append 锁定/已推送保护、trailer 修复、Release 测试门禁 |
| v0.3.0 P1 已完成 | LLM deadline/脱敏/流式、可取消 Push + OutputChannel、自动暂存状态刷新、drop 确认、edit 指引、冲突文件打开 |
| P2 保留 | stash 恢复可见性、多仓库/搜索/squash/撤销、性能、架构拆分、安全迁移与发布增强 |

当前测试套件共 **26** 项，涵盖纯逻辑、边界、真实 Git 临时仓库和 LLM HTTP mock。

---

## 1. 已确认并整改的问题

### R-1. Git 子进程无输出上限、超时和取消能力

- [x] **已修复。**

`src/git/gitRunner.ts` 现在具有默认 50 MiB 输出上限、120 秒超时和 `AbortSignal` 支持。超出输出限制、超时或取消时会终止子进程并返回明确失败结果。

**验证：**`test/gitRunner.integration.test.ts` 覆盖非零返回、输出限制和取消。

### R-2. 非标准 Git 目录下的 rebase 路径解析

- [x] **已修复。**

`rebasingBranch`、`isRebaseInProgress` 和 `rebaseStoppedSha` 使用 `--path-format=absolute --git-path`，避免相对路径与工作目录拼接造成的误判。

**验证：**`test/commitLog.integration.test.ts` 在真实 rebase edit 停靠状态验证路径和 stopped SHA。

### R-3. reorder 未校验完整提交集合

- [x] **已修复。**

拖拽顺序必须与当前 commit 快照等长、无重复、均为 40 位 SHA、且集合完全一致；不满足时取消历史改写并刷新 UI。

### R-4. Webview hash 消息缺少当前快照与格式校验

- [x] **已修复。**

copy/detail/drop/rebase/lock/unlock/append 前都会验证 SHA 格式以及它是否仍属于当前快照，避免过期消息导致状态脱节。

### R-5. LLM 超时、错误响应正文与 streamChat 未接入

- [x] **已在 0.3.0 修复。**

- 新增 `gitRebaseVisual.llm.timeoutMs`，默认 120 秒；
- 401/403、429、5xx 使用分类、安全的错误文案，不回显服务端正文；
- `streamChat` 的 SSE delta 实时回填 webview message textarea；
- 用户取消仍会立即终止请求。

**验证：**`test/llmClient.test.ts` 覆盖 SSE chunk、`[DONE]`、畸形事件、deadline、取消和认证错误脱敏。

### R-6. Trailer 处理会错误丢弃原 trailer 块

- [x] **已修复。**

`applyTrailers` 区分“用户显式提供新的结尾 trailer 块”和“需要保留原 trailer 块”两种情况，避免编辑 commit message 时意外丢失原有 `Change-Id` 等 trailer；相邻标准 `Key: Value` 行也会被保留。

**验证：**`test/message.test.ts`。

### R-7. 运行中的 push 无独立取消 UI

- [x] **已在 0.3.0 修复。**

Push 使用 cancellable `withProgress`，取消 signal 传递给 `pushRefspec` 和 Git runner。新增 **Git Rebase Visual** OutputChannel，记录 Push 开始、成功和失败摘要。

### R-8. refresh 竞态与写操作并发

- [x] **已修复。**

刷新使用 generation token，只有最新请求可提交 state；历史改写、生成和 Push 使用 provider busy 互斥。自动刷新在 busy 期间合并为一个完成后的 refresh 请求。

### R-9. append 已锁定 commit 使 patch-id 锁失效

- [x] **已修复。**

append 前计算 patch-id 并检查锁定状态；锁定目标必须先显式解除锁定。

### R-10. append 已推送 commit 没有明确风险提示

- [x] **已修复。**

append 前检测 upstream 是否已经包含目标 commit。若已推送，确认框会明确提示公开历史改写及 `--force-with-lease` 要求。

### R-13. 暂存后菜单状态需刷新

- [x] **已在 0.3.0 修复。**

workspace 文件事件与 1.5 秒节流 index 轮询结合，覆盖终端 `git add` 的 index-only 变更；400ms debounce、busy 合并和 generation token 避免刷新风暴。

### R-16. 缺失自动化测试

- [x] **已修复并扩充。**

测试体系当前含 26 项测试：trailer、todo/refspec、Git 输出/取消、stash、status、rebase edit、完整 staged append、冲突查询，以及 LLM SSE/deadline/cancel/错误脱敏。

### CI-C. Release notes 双信息源漂移

- [x] **已修复。**

Release 工作流在创建 Release 前验证 `RELEASE.md` 含当前版本记录；测试、VSIX 内容或记录任一步失败都会阻止发布。

### UX-1 / UX-2 / UX-3. 高风险操作、诊断与停靠引导

- [x] **已在 0.3.0 完成。**

- drop 前显示 short hash、subject 和历史重写确认；
- edit 停靠 banner 展示当前目标以及 Continue / Abort 指引；
- rebase/push/provider 失败写入 OutputChannel；rebase 冲突时枚举并自动打开冲突文件。

---

## 2. 已确认但保留为 P2 的问题

### R-11. append Abort 时两个 stash 的提示粒度

- [ ] **保留规划。**

**核验结论：正确但低优先级。**恢复失败时安全副本会保留，现有提示仍可更精细。

**未修改原因：**当前行为优先保证数据不丢失；“打开 stash 列表”和精确恢复向导需要独立 UX/命令设计，列入 P2 stash 可见性。

### R-15. commitDetail 的 shortstat 文本解析

- [ ] **保留规划。**

**核验结论：正确但影响范围有限。**merge 或特殊 Git 输出的统计展示可以更结构化。

**未修改原因：**仅影响 hover 展示而非历史正确性；改为 `--numstat` 需要定义 merge/二进制文件的展示格式，列入 P2 性能/展示改进。

---

## 3. 不成立或仅为建议的结论

### R-12. 到目标 edit 前冲突会留下“无标识且无法找回”的 changeStash

- [ ] **不修改。**

**核验结论：不成立。**内部 stash 有固定命名，且保留 Git 原生暂停状态使用户可安全 Continue/Abort；自动 abort 反而可能丢弃用户进行中的冲突解决。

### R-14. `--force-with-lease=${up.branch}` 只限定分支名

- [ ] **不修改。**

**核验结论：不成立。**当前普通 refspec 正是 `HEAD:refs/heads/<upstream branch>`，只保护该分支符合预期；评审 ref 刻意不加 lease。

### R-17. 不使用 `--no-verify` 是问题

- [ ] **不修改。**

**核验结论：不成立。**保留 commit hooks 保护 Gerrit Change-Id 和项目质量门禁，绕过它们反而更不安全。

### R-18. CSP 的 `style-src 'unsafe-inline'`

- [ ] **不修改。**

**核验结论：安全加固建议。**动态颜色使用 style 属性，用户数据用 `textContent` 渲染，无可复现 XSS 路径。收紧前需先重构动态样式。

### R-19. RebaseViewProvider 文件过大

- [ ] **保留 P2。**

**核验结论：可维护性观察。**重构面广，先有覆盖后再拆分更安全。

### R-20. 配置重复与动态导入风格

- [ ] **保留 P2。**

**核验结论：部分正确但非行为缺陷。**manifest 负责 VS Code schema，`config.ts` 负责运行时读取；单一来源生成需要独立工具链设计。

### CI-D. 产物签名 / 多平台构建

- [ ] **保留 P2。**

**核验结论：增强建议。**JS VSIX 不要求平台编译；签名需要明确分发信任模型和密钥管理。

---

## 4. 安全、并发与发布门禁

| 项目 | 当前结论 |
|---|---|
| 命令注入 | Git 通过 `spawn("git", args)` 执行，不经过 shell。 |
| Webview XSS | 用户内容使用 `textContent`；静态 banner 模板是唯一 `innerHTML` 使用点。 |
| API key | 当前仍存于 settings，SecretStorage 迁移保留 P2。 |
| 大 diff | Git runner 有 50 MiB 上限、超时、取消；列表虚拟化保留 P2。 |
| 并发 | 写操作互斥，刷新 generation token + busy 队列避免过期状态。 |
| Release | 版本一致性、typecheck、覆盖率测试、VSIX 必需/排除文件、RELEASE.md 记录均为发布门禁。 |

Release 通过的步骤：

1. `npm ci`；
2. tag 与 `package.json.version` 一致；
3. `npm run test:release`；
4. VSIX 打包和内容验证；
5. `RELEASE.md` 版本记录验证；
6. 创建 GitHub Release 并上传 VSIX。

---

## 5. 0.3.0 测试矩阵

| 类型 | 文件 | 重点 |
|---|---|---|
| 逻辑 | `message.test.ts`、`rebaseEngine.test.ts`、`pushGuard.test.ts` | trailer、todo、refspec |
| 边界 | `gitRunner.integration.test.ts` | 输出上限、取消、非零 Git 结果 |
| Git 集成 | `commitLog.integration.test.ts`、`worktree.integration.test.ts` | status、冲突查询、stash、absolute git-path、edit stop |
| 功能集成 | `appendStaged.integration.test.ts` | staged append、后续重放、未暂存恢复、stash 清理 |
| HTTP mock | `llmClient.test.ts` | SSE、畸形事件、deadline、取消、脱敏 |

P2 的完整计划见 [`../improvement/improvement.md`](../improvement/improvement.md)。
