# Git Rebase Visual — 代码评审报告（0.5.1）

> **评审基线**：`v0.5.0`（`b6f2c7f`）之后至 `v0.5.1` 发布候选。
>
> **覆盖提交**：
>
> - `e54c03b fix: avoid optional index lock contention`
> - `819d4fb chore: release v0.5.1`
>
> **评审方式**：审查 Linux 仓库中 `.git/index.lock` 的真实 inotify 观测、状态轮询调用链、Git optional-lock 语义、回归集成测试、发布 workflow 与版本化 Release body 机制。
>
> **验证**：`npm run typecheck`、`npx tsx --test test/commitLog.integration.test.ts`、`npm run compile`、`git diff --check` 均通过；完整发布门禁见本版本发布前验证。

---

## 1. 总体结论

0.5.1 是一个针对后台状态轮询与终端 Git 写操作竞争的可靠性热修复。

在 Linux 工作树中观察到：Git Rebase Visual 面板可见时，`.git/index.lock` 会出现 `CREATE → CLOSE_WRITE → MOVED_FROM`，这是 Git 对 index 的原子刷新流程。插件的周期性 `git status --porcelain` 是可能触发 optional index metadata refresh 的后台路径；它会与用户在终端执行 `git switch`、`git stash`、`git add` 或 `git commit` 争用短暂的 index lock。

修复以最小边界应用 `GIT_OPTIONAL_LOCKS=0`：

- 仅用于后台只读 `workingStatus()` 与 `isDirty()`；
- 不改变 Git 状态结果；
- 禁止 Git 为可选 index cache refresh 获取 lock；
- rebase、stash、commit、push、apply、switch 等写操作仍使用 Git 标准 lock。

未发现阻止 0.5.1 发布的代码问题。

---

## 2. 已确认并修复的问题

### LOCK-1. 后台 `git status` 可与终端 Git 写操作争用 optional `index.lock`

- [x] **已修复。**

**触发证据**：Linux 仓库监控在面板可见时观察到：

```text
CREATE             index.lock
CLOSE_WRITE,CLOSE  index.lock
MOVED_FROM         index.lock
```

`MOVED_FROM index.lock` 对应 Git 将 lock 原子 rename 为 index 的正常过程。`git switch` 若刚好落在这个短暂窗口会报：

```text
fatal: Unable to create '.git/index.lock': File exists.
```

**实现**：`src/git/commitLog.ts` 新增 `BACKGROUND_STATUS_ENV`：

```ts
const BACKGROUND_STATUS_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
};
```

并只用于：

- `workingStatus()` 的 `git status --porcelain --untracked-files=all`；
- `isDirty()` 的 `git status --porcelain`。

不扩散到历史改写、stash、commit、push 或其它写操作。

**测试证据**：`test/commitLog.integration.test.ts` 新增真实临时仓库测试，预先创建 `index.lock`，验证 `workingStatus()` 仍正确报告 unstaged 文件数、`isDirty()` 仍返回 true。

### RELEASE-1. Release body 依赖 GitHub 自动 notes，无法保证版本功能说明是最终版

- [x] **已修复。**

**原问题**：workflow 使用 `gh release create --generate-notes`，Release body 仅由 GitHub 提交索引自动生成；每版修复/功能说明不能在 tag 时作为最终发布记录保证，容易依赖事后 `gh release edit`。

**实现**：

- 新增 [`../release-template.md`](../release-template.md)，规定标准 body：版本摘要、功能、修复、可靠性、使用方式、功能总览、文件、系统要求；
- 每版 tag 提交 `docs/release-notes/<version>.md`；
- workflow 在发布前校验该文件存在、标题版本正确、没有 `{{...}}` 占位符；
- `gh release create` 改用 `--notes-file docs/release-notes/$version.md`，不再使用 `--generate-notes`。

**0.5.1 证据**：[`../release-notes/0.5.1.md`](../release-notes/0.5.1.md) 已按模板填入最终说明。

---

## 3. 评审边界与未改动项

- [x] **不全局设置 `GIT_OPTIONAL_LOCKS=0`。**
  - 原因：写操作必须保留 Git 的标准 lock 语义。只读 status 是最小且有证据的竞争面。
- [x] **不将短暂 `index.lock` 一概归因于本插件。**
  - 原因：VS Code 内置 Git 扩展、Git GUI、终端脚本也可能运行 status；本修复降低本插件的竞争面，但不声称排除所有外部来源。
- [x] **不把 `index.lock` 缺失当成错误。**
  - 原因：用户复查时 lock 已不存在且 `git status` 成功，说明是短暂 lock，不是需手动删除的 stale lock。

---

## 4. 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过，0 TypeScript 错误 |
| `npx tsx --test test/commitLog.integration.test.ts` | 12/12 通过，含 optional index lock 回归测试 |
| `npm run compile` | 通过 |
| `git diff --check` | 通过，无空白错误 |

发布前完整门禁将再次执行：

```bash
npm run test:release
npm run package
```

---

## 5. 最终结论

- [x] optional index lock 竞争路径已在插件后台 status 查询中被最小化修复；
- [x] Git 写操作 lock 语义未被削弱；
- [x] 0.5.1 引入发布 body 模板和 tag 时最终说明校验；
- [x] 可以进入 0.5.1 发布流程。
