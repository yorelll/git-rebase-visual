# Git Rebase Visual — 评审回复（0-4-0）

> 本文件对应 `code-review-0-3-0.md` 之后的 **0-4-0 迭代**：主流程对 `docs/improvement/improvement.md` 的 P2 规划逐条裁决并落地。它不是对新评审的回复，而是对「改进项评估 → 子 agent 实施 → 子 agent 评审 → 主 agent 复核」这一轮产出的版本化记录。
>
> 对应评审/规划来源：[`../improvement/improvement.md`](../improvement/improvement.md)（P2 裁决已内嵌标注）。

---

## 0-4-0 回复（对应本轮 P2 改进项评估与实施）

**评审基线：** `main` 工作树。功能基线与 `c4d0ce1`（v0.3.0）之后的 `78bf1f1`（CR 整改）一致；本轮新增 0.4.0 功能。

**处理流程：**
1. **子 agent A** 评估 `docs/improvement/improvement.md` 全部 P2 建议的正确性与必要性，对「正确且必要」的条目实施，对不实施的条目在 improvement.md 内嵌 `> 裁决` 标注原因。
2. **子 agent B** 对 A 的改动做独立 code review（重点：patch-id cache/root 修复、streamChat 竞速加固、SecretStorage 管线、stash 可见性、append 二次确认、测试质量），发现错误直接修复。
3. **主 agent** 复核两者：probe 验证 streamChat 竞态、运行完整测试与 release 门禁，确认全绿后 release 0.4.0。

### 逐项裁决

| P2 条目 | 裁决 | 说明 |
|---|---|---|
| P2-1 Stash 恢复可见性 | ✅ 已实施 | 冲突提示精确到 `stash@{n}` + 短 sha + 可执行命令；新增 `stashList` 命令 |
| P2-2 Commit 历史功能（squash/多选合并/搜索/diff/撤销/多远端） | ❌ 未实施 | 全新建交互特性，需新 webview UI + 回滚语义，保留为后续迭代 |
| P2-3 大仓库性能 | ✅ 部分实施 | patch-id session cache、`--numstat` 结构化 hover 已实施；`all` 虚拟滚动/性能仓库未实施并注明原因 |
| P2-4 架构与类型（discriminated union / 拆类 / stash 模块） | ❌ 未实施 | 需同步重构 media/main.js 与大量 vscode mock，建议随 P2-2 一并做 |
| P2-5 安全与可移植性 | ✅ 部分实施 | Git 版本检查、SecretStorage 管线已实施；API key 完整读写迁移 / CSP / l10n 未实施并注明原因 |
| P2-6 测试覆盖扩展 | ✅ 已实施 | bare-remote 推送/锁定、append 守卫、streamChat 中途取消/超时测试全部新增，并据此加固 streamChat |
| P2-7 发布增强 | ❌ 未实施 | 现有 release.yml 已具备 generate-notes + RELEASE.md 门禁；签名/同步/手动 CI 属流程决策 |

### 已实施的代码/测试证据

**源码：**

- `src/git/commitLog.ts`
  - `patchId` 增加 `<repoRoot>:<hash>` session cache（`clearPatchIdCache` 导出供测试重置）；
  - **修复根提交 patch-id 恒为空**：`diff-tree --root`（此前 root commit 的 diff-tree 输出为空，锁定/去重在根提交上失效）；
  - 新增 `gitVersion` / `checkGitFeature`（最低 2.31.0）/ `isAncestor` / `summarizeNumstat`；
  - `commitDetail` 改用 `--numstat` 结构化解析，`--shortstat` 仅作降级。
- `src/llm/client.ts`：加固 `streamChat`——每轮 `reader.read()` 与取消/超时竞速（`abortOrTimeout`），吸收进行中 read 的取消拒绝、撤销时清理计时器，杜绝挂死与 unhandled rejection。
- `src/ui/rebaseViewProvider.ts`：`refresh()` 启动 `checkGitFeature`；append 用 `isAncestor` 判定已推 upstream 并强二次确认；三处 stash 冲突提示精确化；`showStashList` 命令（优先 `git.openStash`，降级 Output）；评审推送时若 API key 未入 SecretStorage 提示迁移。
- `src/ui/secretsAccess.ts`（新）：SecretStorage 注入桩；fallback 安全 no-op。
- `src/git/worktree.ts`：`stashPush` 消息参数化；新增 `StashEntry` / `stashList()`。
- `src/extension.ts`：注册 `gitRebaseVisual.stashList`；激活时注入 `context.secrets`。

**测试（13 项新增，共 40 项，全部通过）：**

- 新文件 `test/pushGuard.integration.test.ts`（bare-remote：`--force-with-lease` 并发拒绝 + `lockedInPush` 拦截/解锁放行）、`test/appendGuard.integration.test.ts`（已推 upstream 守卫 + 锁定 commit patch-id 跨重写稳定）、`test/secretsAccess.test.ts`。
- 扩展 `commitLog.integration.test.ts`（cache/clear/numstat）、`llmClient.test.ts`（中途取消 / 超时）、`worktree.integration.test.ts`（stashList）。
- `test/index.test.ts` 同步登记。

**此前保留的 0-3-0 / CR-4 测试缺口**在本轮补齐：`lockedInPush`/`pushRefspec` bare remote、append 锁定拒绝与已推送检测、`streamChat` 流读取途中取消与 deadline。

### 验证

已执行（release 门禁）：

```bash
npm run typecheck        # 通过，0 错误
npm run test             # 40 / 40 通过
npm run test:coverage    # 40 / 40 通过，全文件行覆盖 85.13%
```

streamChat 竞态另经独立 probe（真实 SSE 服务器分多 chunk 发送后挂起）验证：三个 chunk 全部接收、超时正确触发、无 chunk 丢失。

### 发布 CI 复核：patch-id 测试时序稳定性

首次 v0.4.0 tag 的 GitHub Actions 在测试阶段失败（39/40），但未创建 GitHub Release。失败项 `patchId is stable across a cherry-pick and served by the session cache` 错误地假设 `git cherry-pick` 一定产生新 hash。Linux 快速 runner 中，原提交与 cherry-pick 若在同一秒内完成，tree、parent、message、author/committer 元数据均相同，Git 合法生成相同 hash，导致 `assert.notEqual` 时序 flaky。

- [x] **已修复。**测试改为使用 `git commit-tree` 构造相同 tree/diff、不同 message 的确定性 clone：hash 必不同、patch-id 必相同；不再依赖 wall-clock 时间。
- [x] **已验证。**修改后的单文件测试 8/8 通过，`npm run test:release` 40/40 通过，coverage 85.13%。

---

## 当前 P2 规划（0-4-0 之后）

仍有条目保留为 P2，见 [`../improvement/improvement.md`](../improvement/improvement.md)：

- **P2-2**：squash/fixup + ctrl 多选合并、搜索过滤、双 commit diff、历史撤销、多远端选择。
- **P2-3（剩余）**：`all` 模式虚拟滚动/默认上限、性能测试仓库。
- **P2-4**：webview discriminated union、provider 拆类、stash 工具拆模块（建议与 P2-2 一并做）。
- **P2-5（剩余）**：API key 完整读写迁移到 SecretStorage（当前仅管线 + 提示）、CSP 收紧、l10n。
- **P2-7**：Release notes 同步脚本、产物签名策略、手动触发完整 CI。
