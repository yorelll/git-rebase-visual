# Git Rebase Visual — 功能、架构与测试总结

> 当前基线：v0.3.0 P1 功能开发工作树。本文同步描述现有功能、核心保护机制、测试体系和发布门禁。

## 1. 项目定位

Git Rebase Visual 是一个 VS Code 扩展：将原生 `git rebase -i` 封装成侧栏中的可视化提交时间线。用户可以拖拽排序、修改或删除 commit、锁定依赖提交、生成 AI commit message、管理 stash/push，并将暂存区内容追加到已有 commit。

```text
Webview (media/main.js)
  └─ postMessage
       └─ RebaseViewProvider
            ├─ git/       Git 命令、rebase、stash、push
            ├─ lock/      patch-id 锁定
            ├─ llm/       OpenAI 兼容消息生成
            └─ ui state   refresh、互斥、webview 状态同步
```

## 2. 核心功能

| 功能 | 行为与保护 |
|---|---|
| 拖拽重排 | 通过 scripted interactive rebase 重排 oldest-first todo；后端验证 webview 提交集合完整，防止缺项导致静默 drop。 |
| edit / reword / drop | 在原生 rebase 中执行；暂停时提供 Continue / Abort。 |
| commit 锁定 | 使用稳定 `patch-id`，重排/cherry-pick 后仍能识别同一修改；push 前阻止包含锁定 commit 的范围。 |
| AI message | 对 commit、暂存区或工作区 diff 流式生成可编辑消息；保留常见 trailer，支持取消与可配置 deadline。 |
| stash | autoStash 以 stash commit SHA 持久化定位，避免 `stash@{0}` 因外部操作漂移。 |
| push | 普通分支使用 `--force-with-lease`；可选评审 refspec；可取消进度和 OutputChannel 诊断；rebase edit 停靠时仍可推送。 |
| 自动状态同步 | 文件事件与节流 index 轮询自动刷新 staged/unstaged 状态，终端 `git add` 后无需手动刷新。 |
| 危险操作 UX | drop 前显示 commit 与历史改写确认；edit 停靠横幅展示目标和 Continue/Abort 指引。 |
| staged append | 目标 commit `edit` 停靠后恢复初始 index，`--amend --no-edit`，再重放其后的提交。 |

## 3. 「将暂存区文件添加到此 commit」事务

用户在 VS Code SCM（或终端）执行 `git add` 后，右键一个 commit 选择该命令。

```text
确认 staged 存在
  ├─ 拒绝被锁定的目标 commit
  ├─ 若目标已在 upstream，明确警告需要 force-with-lease
  ├─ stashPush(-u) 保存完整初始快照
  ├─ interactive rebase：目标 action = edit
  ├─ 校验 stopped SHA 是目标 SHA
  ├─ stash apply --index 恢复初始 staged 内容
  ├─ git commit --amend --no-edit
  ├─ 若原来有 unstaged：stash push --keep-index -u
  ├─ 持久化 pendingAppend（含原目标 SHA；跨刷新时区分完成与外部 Abort）
  ├─ git rebase --continue 重放后续 commit
  └─ pop 未暂存 stash、drop 初始 snapshot stash
```

### 关键边界

- 暂存区为空：菜单禁用，后端也会复查并拒绝。
- 目标已锁定：必须先解除锁定，避免 amend 改变 patch-id 后失去推送保护。
- 目标已推送：确认框明确提示公开历史将被改写，后续需 `--force-with-lease`。
- 发生重放冲突：保持 Git 原生 rebase 状态，面板 Continue/Abort 负责恢复 pending append stash。
- 所有写操作由 provider 互斥；refresh 采用 generation token，避免旧请求覆盖当前 commit 快照。

## 4. 模块地图

```text
src/
├─ extension.ts                    激活、命令注册
├─ config.ts                       VS Code settings 读取
├─ git/
│  ├─ gitRunner.ts                 spawn Git + 超时/输出上限/取消
│  ├─ commitLog.ts                 log/range/status/rebase 元数据
│  ├─ rebaseEngine.ts              todo、execute/continue/abort rebase
│  ├─ worktree.ts                  stash 按 SHA apply/pop/drop、提交
│  ├─ message.ts                   message trailer 拆分与保留
│  ├─ pushGuard.ts                 upstream/refspec/锁定范围检查
│  └─ seq-editor.js                Git 调用的 sequence editor
├─ lock/lockStore.ts               patch-id 持久化锁
├─ llm/client.ts                   OpenAI-compatible chat / streamChat、deadline、错误脱敏
├─ llm/messageGen.ts               diff 和提示词构造、流式生成入口
└─ ui/rebaseViewProvider.ts        webview 协调、状态机、历史操作、OutputChannel、自动刷新

media/main.js                      webview DOM、拖拽、菜单、弹窗
.github/workflows/release.yml      tag 发布门禁与 GitHub Release
```

## 5. 测试体系

使用 Node 内置 `node:test`，由 `tsx` 直接执行 TypeScript。

| 层级 | 文件 | 覆盖内容 |
|---|---|---|
| 逻辑 | `test/message.test.ts` | trailer 拆分、保留、显式替换、通用 trailer |
| 逻辑 | `test/rebaseEngine.test.ts` | todo 顺序、各种 rebase action、空 todo |
| 逻辑 | `test/pushGuard.test.ts` | 默认/refspec 模板/空白模板 |
| 边界 | `test/gitRunner.integration.test.ts` | 非零 Git 结果、输出上限、取消信号 |
| Git 集成 | `test/commitLog.integration.test.ts` | staged/unstaged 状态、commit 顺序、absolute git-path、edit stop |
| Git 集成 | `test/worktree.integration.test.ts` | stash apply/pop/drop、keep-index、外部删除 stash |
| 功能集成 | `test/appendStaged.integration.test.ts` | staged append、amend、后续重放、未暂存恢复、stash 清理 |
| LLM HTTP mock | `test/llmClient.test.ts` | SSE delta/`[DONE]`/畸形事件、deadline、取消、错误正文脱敏 |

当前测试套件含 26 项测试。

命令：

```bash
npm run typecheck       # TypeScript 严格检查
npm run test            # 逻辑、边界、Git 集成与功能测试
npm run test:coverage   # 同上，并输出 Node coverage 报告
npm run test:release    # Release 门禁：typecheck + coverage tests
npm run package         # 编译并生成 VSIX
```

## 6. Release 门禁

`v*.*.*` tag 触发 GitHub Actions，依次执行：

1. `npm ci`；
2. 校验 tag 版本等于 `package.json.version`；
3. `npm run test:release`；
4. 打包 VSIX；
5. 验证 VSIX 含必要 runtime 文件，不含 `src/`、`test/`、`docs/`、`node_modules/`；
6. 验证 `RELEASE.md` 包含对应版本；
7. 创建 GitHub Release 并上传 VSIX。

任一环节失败均不会发布。

## 7. 已知后续工作（P2 规划）

- 多根工作区、列表虚拟化、provider 模块拆分、SecretStorage 和完整 l10n；
- append/stash 恢复可见性与一键打开 stash 列表；
- squash/fixup、多选、搜索、diff 比较、撤销和多远端；
- 大仓库 patch-id 缓存、结构化变更统计和性能基准；

详细结论、已修复项与未修改原因见 [`../review/review-report.md`](../review/review-report.md)。
