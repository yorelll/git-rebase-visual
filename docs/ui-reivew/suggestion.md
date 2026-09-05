# Git Rebase Visual — UI 评审与改进建议

先给结论：功能覆盖度已经很完整，**当前 UI 的主要瓶颈不是"缺功能"，而是三件事**：

| 问题 | 表现 | 影响 |
|---|---|---|
| 🔴 信息密度失衡 | 侧边栏 ~330px，一行既放 hash 又放 message，导致 message 全被截断成 `change(cif): use Stern-Brocot for s...` | 用户必须靠 hover 才能读懂列表，列表本身失去导航价值 |
| 🔴 时间轴方向与直觉冲突 | 顶部=最旧、底部=最新，但 `git log` / GitLens / SCM 面板全是顶部=最新 | 拖拽重排时容易搞反方向，是最高风险的误操作源 |
| 🟠 破坏性操作缺"退路" | 无 undo、无进度、无"改写了哪些 hash"的回溯 | rebase 是改写历史，用户心理负担高，会不敢用 |

下面按屏逐个给建议。

---

# 一、Commits 列表（截图 2）

## 1️⃣ 行布局：改成两行 + 时间轴

侧边栏宽度是硬约束，把 hash 和 message 挤在一行必然牺牲 message。建议：

```
┌────────────────────────────────────────────┐
│ ⋮⋮ ●  change(cif): use Stern-Brocot for    │  ← message 主行，可 2 行省略
│ │     source rate calc                     │
│ │     cff3b53 · lawrence · 2h ago  +42 -3  │  ← 元信息副行（暗色、小一号）
│ │                                          │
│ ⋮⋮ ●  feat(cif): update mipi regs      🔒  │
│ │     e93fba3 · yucheng · 5w ago   +223-12 │
│ ├──────── ↑ 未推送 / origin/dev ↓ ────────│  ← upstream 分界线
│ ⋮⋮ ●  feat(cif): update cif regs           │
└────────────────────────────────────────────┘
```

要点：
- 🔹 **message 优先级最高**，允许换行 2 行（`-webkit-line-clamp: 2`），hash 降级到副行
- 🔹 **左侧连成竖线**（`●` 之间用 1px 竖线连接），视觉上明确"这是一条历史链"，而不是一堆无关卡片
- 🔹 提供 `gitRebaseVisual.density: comfortable | compact` 设置，compact 回退到当前单行模式
- 🔹 `+42 −3` 用 `--vscode-gitDecoration-addedResourceForeground` / `deletedResourceForeground`，比"1 file changed, 223 insertions" 更省空间

## 2️⃣ 排序方向：必须给出方向感知

这是我认为**优先级最高的一条**。当前列表没有任何视觉线索告诉用户"哪头是旧的"，而拖拽重排一旦搞反，代价是重跑一次 rebase。

建议三件套：
- ✅ 列表**顶部加一条固定 hint 行**：`⬆ 最早 (base)`，底部：`⬇ 最新 (HEAD)`
- ✅ 提供 `gitRebaseVisual.order: oldest-first | newest-first`(提供用户可配置的方向，上层为最新和下层为最新，默认下层最新)
- ✅ 拖拽时在被拖行上显示浮动提示：`将移动到 e93fba3 之后（更新）`，用文字消除方向歧义

## 3️⃣ 彩色圆点：语义要说清

现在圆点由 hash 生成 → 用户看到 8 种颜色但**推断不出含义**，属于"装饰性色彩占用了语义通道"。两种更好的用法（选一）：

| 方案 | 含义 | 好处 |
|---|---|---|
| A（推荐） | 颜色 = **作者**（author email 哈希） | 一眼看出"哪些是别人的 commit"，与锁定功能天然呼应 |
| B | 颜色/形状 = **状态**（未推送=空心、已推送=实心、锁定=🔒、drop 预览=虚线） | 圆点承担状态而非身份 |

> 这里如果两个信息都包含是否可以？即包含作者信息也包含状态信息？

## 4️⃣ 拖拽可发现性

- 🔹 hover 时行首出现 **`⋮⋮` grip 把手**，明确"这一行可拖"；同时避免"整行可拖"与单击选中/双击 reword 的手势冲突
- 🔹 拖拽中：被拖行 `opacity: .5`，插入线用 `--vscode-focusBorder`，**并且把受影响的后续 commit 整体染色**（提示"这些 commit 会被改写 hash"）

## 5️⃣ 面板头部：补上"我在哪"

当前只有 `GIT REBASE: COMMITS` + 4 个图标，缺关键上下文：

```
 feature/isp-dma  →  origin/feature/isp-dma   ↑11 ↓0
```

- 分支名 / upstream / ahead-behind，点击可切换 base 范围
- 4 个工具栏图标必须有 **tooltip + 明确图标语义**：Push=`$(repo-push)`、Stash=`$(archive)`、Pop=`$(inbox)`、Refresh=`$(refresh)`。建议 Stash/Pop 合并为一个带 badge 的按钮（`$(archive)` + 角标显示 stash 数量），腾出位置给 **`$(discard)` 撤销上次变基**

## 6️⃣ "未提交的改动"区

现在只有一个按钮，且没有任何"改了什么"的信息。建议：

```
▸ 未提交的改动   ● 3 staged  ○ 5 unstaged
  [✨ 为暂存区生成并提交]  [▾]     ← ▾ 内含"为工作区生成并提交"
```

- 🔹 显示 staged / unstaged **文件数**，让用户在点之前就知道范围
- 🔹 两个按钮语义相近且都是危险度不低的"直接 commit"，用 **主按钮 + 下拉** 收敛，避免误点"工作区"（会 `git add -A`）
- 🔹 未配置 LLM 时不要隐藏该区，而是显示 `⚙ 配置 LLM 以启用 AI message`（隐藏式失效是常见可发现性问题）

## 7️⃣ 空状态 / 加载态

- 无未推送 commit：`✅ 与 origin/xxx 已同步` + 「切换范围」链接，而不是空白
- 首次加载/rebase 执行中：骨架行 + 顶部细进度条（`--vscode-progressBar-background`）

---

# 二、右键菜单（截图 4）

当前 10 项平铺、纯文字、无图标、无 hash 上下文，且"删除 commit"与普通项等权重。

## 建议的重排结构

```
┌ 062d05e · fix(isp): hack enable inter frame   ← ① 上下文标题（灰色只读）
├───────────────────────────────────────────
  $(copy)      复制 hash
  $(copy)      复制 message
  $(diff)      查看变更…                  ← ② 新增：直接开 VSCode diff
├───────────────────────────────────────────
  $(edit)      编辑 message…              Enter
  $(sparkle)   AI 生成 message…
  $(add)       追加暂存区 (3 个文件)      ← ③ 禁用时把原因写进标签
├───────────────────────────────────────────
  $(debug-pause) 停靠在此 (edit)
  $(fold-up)   合并到上一个 (squash)      ← ④ 新增，rebase -i 核心动作缺失
├───────────────────────────────────────────
  $(unlock)    解除锁定
├───────────────────────────────────────────
  $(trash)     删除 commit (drop)         ← ⑤ 红色 errorForeground
└
```

要点：
- ① **菜单顶部显示目标 commit**：右键菜单最容易的错误就是"点错了行"，一个只读标题成本极低
- ② 「查看变更」是当前完全缺失的高频需求 —— 用户在决定 reword / drop 前想看 diff
- ③ 禁用项**必须解释原因**：`将暂存区文件添加到此 commit` 灰掉时改为 `追加暂存区（暂存区为空）` 或加 tooltip；被锁定时改为 `追加暂存区（已锁定，需先解锁）`
- ④ **补 squash / fixup**：这是 `rebase -i` 使用率最高的动作之一，目前只有 reorder/edit/drop/reword，缺一块
- ⑤ 危险项**独立分组 + 语义色 + 放最末**，并保留你已有的二次确认
- 🔹 术语统一：菜单里同时出现「变基到此 commit」「更改此 commit message」「为此 commit 生成 AI message」句式不一致。统一成 **动词 + 宾语 + 省略号（表示会开弹窗）**：`停靠在此`、`编辑 message…`、`AI 生成 message…`

---

# 三、Compose 弹窗（截图 1）

这是全插件**唯一需要认真"写字"的界面**，但目前它被塞进 330px 的侧边栏里，原始 message 只能看到 2 行。

## 1️⃣ 换容器（最重要）

> 建议：把 compose 从侧边栏 webview 改为**编辑器区的 Webview Panel**（`vscode.window.createWebviewPanel`，`ViewColumn.Active`），或者干脆复用 VSCode 原生的 `COMMIT_EDITMSG` 文本编辑器 + CodeLens 按钮。

理由：
- commit message 编辑是**并排对照 + 长文本**任务，侧边栏宽度天生不合适
- 放到编辑器区后可直接获得：原生自动换行、多光标、拼写检查、`Ctrl+Z`、以及**与 diff 并排**

## 2️⃣ 若保持在侧边栏，至少做这些

```
┌ 编辑 message · 062d05e ····························· ┐
│                                                      │
│ ▸ 原始 MESSAGE                        $(copy) $(diff)│ ← ① 默认折叠，只显示首行
│                                                      │
│ MESSAGE                                              │
│ ┌──────────────────────────────────────────────────┐ │
│ │ fix(drm): use GEM DMA VMAP driver ops        50/72│ │ ← ② subject 独立输入框 + 计数
│ └──────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────┐ │
│ │ Switch DRM_GEM_DMA_DRIVER_OPS to ...             │ │ ← ③ body 多行，72 列标尺
│ │                                                  │ │
│ │ IPCSDK-31606                                     │ │
│ └──────────────────────────────────────────────────┘ │
│                                                      │
│ 🔒 Trailer 将原样保留  ⓘ                        ▸ 2 条│ ← ④ 收成一行 + 折叠
│                                                      │
│                          [取消]  [应用 ⌘⏎]           │ ← ⑤ 主按钮 + 快捷键
└──────────────────────────────────────────────────────┘
```

| # | 建议 | 理由 |
|---|---|---|
| ① | 「原始 MESSAGE」默认**折叠为单行**，展开才占高度；旁边加 `$(diff)` 做新旧对比 | 现在它吃掉 1/3 高度却只能看 2 行，收益/成本倒挂 |
| ② | **subject / body 拆成两个输入框**，subject 显示 `50/72` 字符计数（>50 变黄、>72 变红） | 强化 Git 约定；同时天然解决"第一行后必须空行"的常见错误 |
| ③ | body 框内画 **72 列参考线**，`min-height` 至少 8 行 | 现在 5 行可视区，写 body 很局促 |
| ④ | Trailer 区标题 `保留的 TRAILER（CHANGE-ID / SIGNED-OFF-BY，不会被修改）` 太长，压缩成 `🔒 Trailer 将原样保留 ⓘ`，明细折叠 | 把说明性文字放 tooltip，界面留给内容 |
| ⑤ | 「应用」用主按钮色（`--vscode-button-background`），「取消」用 secondary；绑定 `Ctrl/Cmd+Enter` 提交、`Esc` 取消并在按钮上显示 | 现在两个按钮视觉等权重，看不出哪个是默认动作 |

> 建议换容器以突破侧边栏，且布局需要仔细考虑以符合用户交互。

## 3️⃣ AI 模式的专属 UI

文档里 AI 模式是同一个弹窗，但截图未体现。建议：

- 🔹 「补充信息给 AI」用 **placeholder 给例子**：`可填 Issue 号 / 设计背景 / 关联 CL 链接…`
- 🔹 生成按钮三态清晰：`✨ 生成` → `⏳ 生成中… [取消]` → `↻ 重新生成`
- 🔹 **流式写入时把 message 框设为只读 + 打字光标**，避免用户在流式追加过程中编辑造成光标跳动
- 🔹 生成完成后提供 `↶ 恢复到生成前`（本地一次性 undo），比"重新生成"更轻
- 🔹 AI 结果**不要直接覆盖**已有手写内容：若 message 框已被用户修改过，改为 `[替换] / [追加到正文]` 二选一
- 🔹 在弹窗底部灰字标明当前模型，例如 `模型: xxx · 上下文: diff 1.2k tokens`，建立信任感

## 4️⃣ 一个 reword 场景的小遗漏

reword 模式下也应该有 `✨ AI 生成` 入口（现在要靠右键选另一个菜单项才能进 AI 模式）。把模式做成**弹窗内的 tab/按钮**，而不是两个入口，可以少一个菜单项。

---

# 四、Hover 详情浮层（截图 3）

内容质量已经很好（作者/时间/统计/trailer/复制），主要问题在**交互形态**。

- ❌ 从截图看它像是**内联插入在行下方**，把下面的 commit 推走了 → 布局跳动（layout shift），鼠标稍微移动就可能触发列表重排，误点风险高
  - ✅ 改成**绝对定位浮层**（`position: fixed`）覆盖在列表上方，带 1px 边框 + `--vscode-widget-shadow`，不影响文档流
  - ✅ 或者更省事：直接用 VSCode 原生 `TreeItem.tooltip = MarkdownString`（免维护、自动适配主题和高对比度）—— 但会失去"复制按钮"，需权衡
- 🔹 `6c710eb270 · 1 file changed, 223 insertions(+), 12 deletions(-)` 太长，改为 `6c710eb  1 file  +223 −12`（带色）
- 🔹 「复制完整 message」从底部链接改成 **右上角图标组** `$(copy) $(diff) $(terminal)`，位置稳定、不随 message 长度上下漂移
- 🔹 文件数可点：`1 file` → 点开列出文件名，点文件名直接开 diff
- 🔹 浮层内的 trailer 建议**灰化**，与正文区分（现在 `Change-Id` 和正文同权重，视觉上噪音较大）
- 🔹 触发延迟 0.4s 合理，但需要 **200ms 的关闭宽容期 + 安全三角**，否则鼠标斜向移入浮层会闪退

---

# 五、变基进行中横幅（截图 5）

当前横幅信息量偏低：`变基进行中。如有冲突请在编辑器中解决后：`——用户此刻最焦虑，最需要的三个信息全都缺。

## 建议

```
┌──────────────────────────────────────────────┐
│ ⏸ 变基进行中 · 停靠于 edit         3 / 11    │ ← ① 状态类型 + 进度
│    31fe2ce  change(cif): split vc shift      │ ← ② 当前 commit
│    ⚠ 2 个文件存在冲突                        │ ← ③ 冲突文件数（可点，跳转)
│                                              │
│  [Continue]  [Skip]  [Abort]      ⓘ 帮助     │ ← ④ 补 Skip；Abort 次要+确认
└──────────────────────────────────────────────┘
```

| # | 建议 |
|---|---|
| ① | 区分 **两种暂停原因**：`edit 停靠`（你主动停的，安全）vs `冲突`（需处理）。用不同底色：edit → `editorInfo`，冲突 → `editorWarning/Error`。现在两者共用同一句文案，语义混淆 |
| ② | 显示**进度 `3/11`**，让用户知道还剩多少；可加细进度条 |
| ③ | **有冲突时 Continue 应禁用**，tooltip：`还有 2 个文件未解决`；解决完自动变可点（你已有暂存状态自动刷新，可复用） |
| ④ | 补 **Skip**（`git rebase --skip`）；`Abort` 降为 secondary/危险色 + 二次确认（"将丢弃本次变基的所有中间结果"） |
| 🔹 | **同步到状态栏**：`$(git-branch) rebase 3/11 ⏸`，用户切到别的文件时也能看到自己处于 rebase 中间态 — 这是防止"忘了自己在 rebase"的关键 |
| 🔹 | 「⏸ 停在此」徽章很好；建议同时把**该行以下（未应用）的 commit 半透明化**，直观表达"这些还没重放" |

---

# 六、跨界面的系统性建议

## 1️⃣ 加一个"撤销"安全网（P0）

> rebase 类工具最能建立信任的功能不是"能改"，而是"改错了能回来"。

- 每次改写历史前记录 `ORIG_HEAD` / 自建 ref（`refs/gitRebaseVisual/undo/<n>`）
- 操作成功后的通知里带 **`[撤销]` 按钮**（`window.showInformationMessage(msg, '撤销')`）
- 工具栏加 `$(discard)` **撤销上次变基**，`...` 菜单里放「最近操作历史」列表（显示 `重排 3 个 commit · 2 分钟前 · abc1234 → def5678`）

## 2️⃣ 通知策略：10 秒太长、位置太远

VSCode 通知在右下角，而用户视线在左侧面板 —— 距离远 + 会堆叠。建议：

- **成功类**（复制成功、stash 完成）→ 面板内顶部 **inline toast，2–3 秒**自动消失，不用系统通知
- **失败/需决策类** → 保留系统通知，且**不自动消失**（错误信息 10 秒消失反而让人来不及读），附 `[查看输出]` 按钮直达 `Output → Git Rebase Visual`
- 长任务（Push / AI 生成 / rebase）→ 用 `ProgressLocation.SourceControl` 或面板内进度条，而不是通知

## 3️⃣ 主题与色彩合规

- ❗ 截图中的橙色锁定条、黄色横幅、彩色圆点看起来是**硬编码色值**。请全面切换到 VSCode 主题 token：

  | 用途 | 建议变量 |
  |---|---|
  | 锁定强调条 | `--vscode-editorWarning-foreground` 或 `gitDecoration-conflictingResourceForeground` |
  | rebase 横幅 | `--vscode-inputValidation-warningBackground / -warningBorder` |
  | 危险操作 | `--vscode-editorError-foreground` / `inputValidation-errorBackground` |
  | 选中/焦点 | `--vscode-list-activeSelectionBackground` / `focusBorder` |
  | hash 等宽字 | `--vscode-editor-font-family` |

- hash 生成的圆点色请用 **HSL 固定 S/L**，并根据 `light/dark/high-contrast` 调 L，否则浅色主题下亮黄绿几乎不可见
- 在 **High Contrast 主题**下逐屏过一遍（VSCode 插件市场审核和企业环境常见要求）

## 4️⃣ 无障碍与色觉友好

- 🔹 列表用 `role="listbox"` / `role="option"` + `aria-selected`，每行 `aria-label` 读出「第 3 个，共 11 个，change(cif)…，已锁定」
- 🔹 **不能只靠颜色**传达状态：锁定 = 🔒图标 + 橙条（✅ 你已做对）；但"作者/hash 圆点"只有颜色 → 补首字母或 tooltip
- 🔹 全键盘可达：`↑↓` 移动焦点、`Alt+↑↓` 重排、`Enter` reword、`Delete` drop（带确认）、`Space` 展开详情、`Shift+F10` 打开菜单
- 🔹 焦点环使用 `--vscode-focusBorder`，禁止 `outline: none`

## 5️⃣ 术语与文案一致性

当前中英混排缺规则，建议定一条**术语表**并全局遵守：

| 保持英文（Git 原语） | 用中文 |
|---|---|
| commit / message / rebase / trailer / hash / stash / Push / upstream / squash / drop | 锁定、解除锁定、暂存区、工作区、变基进行中、追加、撤销 |

同时统一：
- 会开弹窗的动作 → 末尾加 `…`
- 破坏性动作 → 括号标注原生命令，如 `删除 commit (drop)`、`停靠在此 (edit)`，帮助命令行用户建立映射
- 面板标题 `GIT REBASE: COMMITS` 里的 `COMMITS` 冗余，改为显示分支名更有信息量

---

# 七、优先级建议

| 优先级 | 事项 | 预期收益 |
|---|---|---|
| **P0** | 撤销上次变基（ORIG_HEAD + 通知内 `[撤销]`） | 最大幅降低使用心理门槛 |
| **P0** | 排序方向可配置 + 顶/底「最早/最新」标签 + 拖拽文字提示 | 直接消除最高风险误操作 |
| **P0** | hover 浮层改为绝对定位（消除布局跳动） | 修掉一个明显的交互 bug 级体验问题 |
| **P0** | 全面改用 VSCode 主题变量 + High Contrast 走查 | 主题兼容性，上架质量基线 |
| **P1** | 列表两行布局（message 优先）+ 密度开关 | 让列表本身可读，减少对 hover 的依赖 |
| **P1** | Compose 迁到编辑器区 Panel；subject/body 拆分 + 字数标尺 | 核心写作场景的体验跃升 |
| **P1** | 右键菜单分组 + 图标 + 目标 hash 标题 + 禁用原因 + 补 squash | 降低误点、补齐 rebase -i 能力 |
| **P1** | rebase 横幅：区分 edit/冲突、进度 3/11、冲突数、Continue 禁用态、Skip、状态栏同步 | 处理冲突时的关键信息补全 |
| **P2** | 通知策略分层（inline toast / 不自动消失的错误） | 减少噪音 |
| **P2** | 全键盘 + ARIA + 圆点语义化（作者色 + 首字母） | 无障碍与可推广性 |
| **P2** | 头部分支/upstream/ahead-behind + upstream 分界线 | 上下文感知 |
| **P2** | Walkthrough、空状态、骨架屏、AI 模型信息展示 | 打磨与信任感 |

---
