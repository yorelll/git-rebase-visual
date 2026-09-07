# Git Rebase Visual — 评审回复（0-5-1）

> 对应评审报告：[`code-review-0-5-1.md`](code-review-0-5-1.md)
>
> 评审基线：`v0.5.0`（`b6f2c7f`）之后的 optional index lock 热修复与发布说明机制升级。

---

## 0-5-1 回复（对应 `code-review-0-5-1.md`）

### LOCK-1：后台状态轮询与终端 Git 写操作的 `index.lock` 竞争

- [x] **结论正确，已修复。**

Linux 真实仓库观测到面板打开后出现 `.git/index.lock` 的 `CREATE → CLOSE_WRITE → MOVED_FROM`。插件后台状态刷新调用 `git status --porcelain`，Git 可以为可选 index metadata refresh 短暂创建 lock；终端 `git switch` / `git stash` 等写 index 操作若碰巧重叠会失败。

**修改：**

- `workingStatus()` 和 `isDirty()` 的只读 status 调用显式传入 `GIT_OPTIONAL_LOCKS=0`；
- 不将该设置扩散到 rebase、stash、commit、push、apply、switch 等写操作；
- 增加真实临时仓库测试：手工创建 `index.lock` 后，后台 status 仍正确返回工作区状态。

**边界说明：**这降低 Git Rebase Visual 的后台竞争面，但不声称所有 index lock 都由本插件产生；VS Code 内置 Git、GUI、脚本和其他终端也可能创建 lock。

### RELEASE-1：GitHub Release body 不能保证是 tag 时的最终功能说明

- [x] **结论正确，已修复。**

原 workflow 使用 `--generate-notes`，只生成提交索引，不能保证每个版本的功能/修复说明在发布当时即完整确定。

**修改：**

- 新增 [`../release-template.md`](../release-template.md)；
- 每版提交 `docs/release-notes/<version>.md`；
- workflow 校验 notes 文件、版本标题和未替换占位符；
- Release 用 `gh release create --notes-file` 创建，不再使用 `--generate-notes`，也不依赖事后编辑。

**0.5.1 证据：**[`../release-notes/0.5.1.md`](../release-notes/0.5.1.md)。

### 最终验证

```bash
npm run typecheck                                  # 通过
npx tsx --test test/commitLog.integration.test.ts # 12 / 12 通过
npm run compile                                    # 通过
git diff --check                                   # 通过
```

发布前仍会执行完整：

```bash
npm run test:release
npm run package
```

**结论：**0.5.1 已在最小范围内修复后台 status 的 optional lock 竞争，并建立以后 tag 发布即带最终 Release body 的机制。