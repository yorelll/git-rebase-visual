# Git Rebase Visual — UI 交互手感评审（0.8.6）

> 本文件是 **设计/交互评审**，不是 `docs/review/code-review-*.md` 版本的代码审查报告，
> 因此不写入 `docs/review/code-review-commit.md` 台账，也不改变任何已发布版本的评审基线。
> 本文件只给方案，不含实现提交。

## 0. 基线与范围

| 项 | 值 |
| --- | --- |
| 版本 | `0.8.6`（`package.json`） |
| 基线 commit | `c1922984ef99658efa230e0488cfc0223ee4b3f4`（`fix: restore append-staged on Git 2.31-2.34`） |
| 评审对象 | `media/style.css`（838 行）、`media/main.js`（706 行）、`src/ui/rebaseViewProvider.ts` §webview HTML（3339–3380 行） |
| 评审依据 | `emil-design-eng` skill：Animation Decision Framework + Review Checklist + Performance Rules |
| 未覆盖 | `src/ui/composePanel.ts`（独立 editor panel，自带内联样式，不在侧边栏 webview 内） |

`composePanel.ts` 的 `style.css` 复用情况已确认：它**不加载** `media/style.css`，全部样式在自身 HTML 内联。这一点对本报告第 3.3 节的死代码判定是关键证据。

## 1. 现状测量

| 指标 | 实测值 | 含义 |
| --- | --- | --- |
| `transition` 声明 | **0** | 没有任何属性做过渡 |
| `@keyframes` / `animation` | **0** | 没有任何关键帧动画 |
| `:active` 按压态 | **0** | 所有可点元素按下无反馈 |
| `@starting-style` | **0** | — |
| `prefers-reduced-motion` | **0** | 无减弱动效分支 |
| `prefers-contrast` / `forced-colors` | 2 处 | 高对比度已有基础处理 |
| `:focus-visible` | 7 处 | 键盘可达性底子不错，**不要动** |
| 自绘浮层 | tooltip、menu、inline-toast、banner | 均为 `display:none` ↔ `block` 瞬时切换 |

结论：这个 UI 的**静态设计已经相当成熟**（作者色圆点、折叠锁定区、批量菜单、a11y 标签都在），缺口 100% 集中在 **"状态变化如何被感知"** 这一层——按压、悬停、浮层出现、拖拽反馈。

## 2. 核心判断：这是高频 IDE 界面，方案必须是"减"而不是"加"

`emil-design-eng` 的第一道判断标准是使用频率：

| 频率 | 该怎么做 |
| --- | --- |
| 每天 100+ 次 | **永远不做动画** |
| 每天几十次 | 删除或大幅削弱 |
| 偶发（弹窗、toast） | 标准动画 |
| 首次/罕见 | 可以加惊喜 |

按这个标尺逐面归类：

| UI 面 | 频率 | 决策 |
| --- | --- | --- |
| 提交行选择 / 过滤输入 / 列表刷新 | 每次操作都触发，`renderList()` 会重建整个列表 | **绝对不做入场动画**（见 2.1） |
| 拖拽重排（含 Alt+↑↓） | 高频且关键 | **不做 FLIP 位移动画**，只做抓取态 + 插入指示 |
| 右键菜单 | 每天几十次 | 仅做 150ms 出现，**关闭保持瞬时** |
| Hover tooltip | 浏览列表时连续触发 | 首次延迟保留，**后续立即出现** |
| 按钮按压 | 高频 | 100–160ms 的 `scale(0.97)`，这是唯一"纯收益"的动效 |
| inline toast / banner / 变基横幅 | 偶发 | 可以做 150–180ms 的淡入 |
| 文件行 hover 动作条 | 高频 | **不加过渡**（见 2.2） |

### 2.1 这个代码库的头号陷阱：不要给列表行加入场动画

`renderList()` 与 `renderChanges()` 都是 `innerHTML = ""` 后整表重建，而 `selectRow()` / `selectContextTarget()` 每次点击都调用 `renderList()`。因此：

- 任何挂在 `.commit` / `.change-file` 上的 `@starting-style` 或 `animation`，**会在每一次点击、每一次选择时重播**；
- 20 行的列表每次点击闪一下，比没有动画糟糕一个数量级；
- 同理不要用 `transition` 去"平滑"列表重排——真实重排在 host 确认后由新 state 重建，不是同一批 DOM 移动，过渡无从谈起。

这条必须写进方案约束，否则"美化"的第一步就会踩进去。

### 2.2 文件动作条不加过渡

`.file-actions` 与 `.file-group-actions` 是 `opacity: 0 → 1` 的绝对定位覆盖层，位于 `.change-file` 内部，鼠标移进动作条时行仍处于 `:hover`，**不存在闪烁**。给它们加 120ms 淡入只会让"我要点的 + 号"晚到 120ms。保持瞬时。

## 3. 评审表

### 3.1 P0 — 交互缺陷（与动效无关，但直接毁掉手感）

| # | Before | After | Why |
| --- | --- | --- | --- |
| 1 | `renderDirection()` 用 `classList.toggle("hidden", !dragHint)`，空闲时 `#direction` 为 `display:none` | `#direction` 常驻可见，空闲时显示静态提示（如 `拖动 ⋮⋮ 重排 · Alt+↑↓ 移动`），拖拽时原地替换为实时目标 | `#direction` 在 `#list` 之上且参与文档流。抓取瞬间它出现，**整个提交列表被顶下约 24px**，光标下的行在按下的一刻改变，`elementFromPoint` 的命中目标随之跳变。同一文件内的 `.inline-toast` 已经用 `position:absolute` 规避了这个问题（第 22–23 行注释写明了原因），`#direction` 是漏网的那个 |
| 2 | `.commit.drop-before { border-top: 2px solid … }`（485–491 行）、`.locked-run.drop-before { border-top: 2px solid … }`（338–344 行） | `box-shadow: inset 0 2px 0 var(--vscode-focusBorder)` / `inset 0 -2px 0 …` | `.commit` 与 `.locked-run` 都是 `content-box` 且原本无 `border-top`。悬停插入点时行高 +2px，**下方所有行位移一次**，正好发生在拖拽过程中 |
| 3 | `.commit .dot { border: 1px solid var(--vscode-contrastBorder, var(--vscode-focusBorder)) }`（528 行） | `border: 1px solid transparent`（高对比度仍由既有 `forced-colors` / `prefers-contrast` 分支接管） | `--vscode-contrastBorder` 只在 HC 主题定义，常规主题回落到 `--vscode-focusBorder`——**每个作者圆点都套了一圈焦点蓝**，等于"所有行都是当前焦点"，焦点环失去语义 |
| 4 | `.tooltip` / `.menu` 的 `box-shadow: … rgba(0,0,0,0.4)`（357、618 行） | `box-shadow: 0 3px 10px var(--vscode-widget-shadow, rgba(0,0,0,0.36))` | 亮色主题下 40% 黑阴影过重，浮层像贴了张脏纸；`--vscode-widget-shadow` 是 VS Code 自带的主题感知阴影 |
| 5 | `.btn:hover:not(:disabled) { opacity: 0.9 }`（809–811 行） | `.btn:hover { background: var(--vscode-button-secondaryHoverBackground, …) }`，`.btn.primary:hover { background: var(--vscode-button-hoverBackground, …) }` | `opacity` 把文字一起变淡，等于**悬停时按钮变暗**；且绕过了 VS Code 自己的 hover token |

### 3.2 P1 — 动效与反馈（真正"看得见"的打磨）

| # | Before | After | Why |
| --- | --- | --- | --- |
| 6 | `.btn` 无 `:active` | `transition: transform 160ms var(--grv-ease-out)`；`:active:not(:disabled) { transform: scale(0.97) }` | 按下必须有确认感；`0.95–0.98` 是安全区间，且 `scale` 不触发布局 |
| 7 | 右键菜单瞬时出现（`classList.remove("hidden")`） | `animation: grv-pop-in 150ms var(--grv-ease-out) both`，`from { opacity: 0; transform: scale(0.97) }`，`transform-origin: var(--grv-origin)` | 从 `scale(0)` 进入会显得"凭空冒出"；从 `0.97` 起步才有实体感 |
| 8 | 菜单恒为 `transform-origin: center` | JS 在 `openMenu()` 定位后写入 `--grv-origin: <x-left>px <y-top>px` | 浮层应从**触发点**放大，而不是从自己中心。点击点在菜单右上角附近时差异尤其明显 |
| 9 | 键盘打开的菜单与鼠标菜单动画一致 | `rowKeydown` 的 `ContextMenu` / `Shift+F10` 路径传 `{ instant: true }`，CSS `[data-instant="true"] { animation: none }` | 键盘触发的操作每天重复上百次，任何延迟都会被感知为卡顿；这条是 skill 的硬性规则 |
| 10 | 每次 hover 都等满 400ms 才请求详情（`scheduleTooltip`） | 首次仍 400ms；`hideTooltip()` 记录 `tipInstantUntil = now + 800`，窗口内再次 hover 直接 `setTimeout(…, 0)` | 浏览列表时挨个悬停，每次都等 400ms 会让整条时间轴显得迟钝。延迟只需防"误触"，不需要重复收税 |
| 11 | tooltip 无动画、`transform-origin` 默认 center | `[data-instant="false"]` 时 125ms `grv-pop-in`，origin 按实际方位取 `left top`（在行下方）或 `left bottom`（翻到行上方） | 浮层贴着某一行出现，必须从那一行的边生长出来 |
| 12 | `.inline-toast` 瞬时覆盖（`showInlineToast`） | `animation: grv-toast-in 180ms var(--grv-ease-out) both`，`from { opacity: 0; translateY(-4px) }` | 它是绝对定位覆盖层，动画不影响布局；偶发操作，标准动画允许 |
| 13 | `.banner` 瞬时出现 | `animation: grv-fade-in 150ms ease both`（**只淡入，不位移**） | banner 参与文档流，位移会推动列表；淡入足以消除"闪一下"的突变 |
| 14 | `.commit.dragging { opacity: 0.5 }` 瞬时 | `transition: opacity 120ms ease`，并加 `outline: 1px dashed var(--vscode-descriptionForeground); outline-offset: -1px` | 抓起的行需要明确"我是被拿起来的那一个"，而不只是"变淡了" |
| 15 | `.commit .grip` 从 `opacity .7` 瞬变到 `1` | `transition: color 120ms ease, opacity 120ms ease` | 悬停时把手显形，瞬间跳变会让鼠标扫过列表产生噪点 |
| 16 | 无减弱动效分支 | `@media (prefers-reduced-motion: reduce)`：所有 `animation-name` 换成纯 `grv-fade-in`，`transform` 类动画与 `:active` 缩放关闭 | 减弱动效是"减少位移"，不是"清零"；透明度类过渡保留 |

### 3.3 P2 — 密度、一致性与清理

| # | Before | After | Why |
| --- | --- | --- | --- |
| 17 | `↑12 ↓3`、`ab12cd34`、`+3 −1` 用比例字宽 | `.branch-context`、`.commit-meta`、`.tip-stat` 加 `font-variant-numeric: tabular-nums` | 定时刷新让 ahead/behind 数字变化时，整行文字左右抖动 |
| 18 | `.dialog*` / `.pane*` / `.ai-block` / `.trailer` / `.btn.small` / `.tip-author` / `.tip-date` / `.link-btn` 共约 120 行（680–820 行） | 删除；`#dialog` 标记（provider 3346–3378 行）一并删除 | 已核实：`main.js` 完全不引用这些类，compose 已迁至 `composePanel.ts` 自带内联样式。留着会让后续维护者以为侧边栏还有一个 modal，且该 overlay 一旦被误显示会盖住整个列表 |
| 19 | `.file-group-label` / `.changes-label` / `.menu-group-label` 为 `text-transform: uppercase` + `letter-spacing: 0.4~0.5px` | 可选：改为正常大小写，与 VS Code 原生 SCM 分组（`Changes` / `Staged Changes`，11px 正常字重）对齐 | 大写+字间距是营销页的典型手法；这里是 IDE 侧栏，原生 SCM 面板本身不用它。属于口味项，可与用户偏好共同决定 |

## 4. 实现方案

### 4.1 动效令牌（`media/style.css` `:root`）

```css
:root {
  color-scheme: light dark;
  /* VS Code 内置 ease 曲线对 UI 反馈太弱；只用自定义强 ease-out。 */
  --grv-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
}
```

只引入一条曲线。本次方案里没有任何"屏幕内位移/形变"的场景，`ease-in-out` 用不上——少一个令牌就少一个误用点。

### 4.2 关键帧（放文件末尾，统一前缀 `grv-`）

```css
@keyframes grv-pop-in { from { opacity: 0; transform: scale(0.97); } }
@keyframes grv-toast-in { from { opacity: 0; transform: translateY(-4px); } }
@keyframes grv-fade-in { from { opacity: 0; } }
```

### 4.3 为什么用 `animation` 而不是 `@starting-style` / `transition`

`package.json` 的 `engines.vscode` 是 `^1.85.0`。VS Code 1.85 / 1.86 使用的 Electron 25/27 对应 Chromium 114/118，其中 **`@starting-style` 需要 Chromium 117+**，1.85 用户会静默失效。

而 `.hidden { display: none !important }` 的显隐切换，正是 `transition` 无法覆盖的场景（`display` 从 `none` 到 `block` 不会产生过渡起点）。**`animation` 会在元素从 `display:none` 变为可见时重新开始**，是唯一在 1.85 上也能稳定工作的方案。

结论：**显示切换用 `animation`，属性渐变（hover/press）用 `transition`**。不要引入 `@starting-style`。

### 4.4 CSS 补丁要点

```css
/* 菜单 / tooltip：从触发点生长 */
.menu, .tooltip { transform-origin: var(--grv-origin, left top); }
.menu:not(.hidden) { animation: grv-pop-in 150ms var(--grv-ease-out) both; }
.tooltip:not(.hidden) { animation: grv-pop-in 125ms var(--grv-ease-out) both; }
.menu[data-instant="true"], .tooltip[data-instant="true"] { animation: none; }

/* toast / banner */
.inline-toast:not(.hidden) { animation: grv-toast-in 180ms var(--grv-ease-out) both; }
.banner:not(.hidden) { animation: grv-fade-in 150ms ease both; }

/* 按压 */
.btn { transition: transform 160ms var(--grv-ease-out); }
.btn:active:not(:disabled) { transform: scale(0.97); }

/* 拖拽 */
.commit { /* 不改 */ }
.commit.dragging {
  transition: opacity 120ms ease;
  outline: 1px dashed var(--vscode-descriptionForeground);
  outline-offset: -1px;
}
.commit .grip { transition: color 120ms ease, opacity 120ms ease; }

/* 插入指示：不改变盒模型 */
.commit.drop-before { box-shadow: inset 0 2px 0 var(--vscode-focusBorder); }
.commit.drop-after { box-shadow: inset 0 -2px 0 var(--vscode-focusBorder); }
.locked-run.drop-before { box-shadow: inset 0 2px 0 var(--vscode-focusBorder); }
.locked-run.drop-after { box-shadow: inset 0 -2px 0 var(--vscode-focusBorder); }

/* 减弱动效：保留淡入，去掉位移与缩放 */
@media (prefers-reduced-motion: reduce) {
  .menu:not(.hidden), .tooltip:not(.hidden), .inline-toast:not(.hidden) { animation-name: grv-fade-in; }
  .btn:active:not(:disabled) { transform: none; }
  .commit.dragging, .commit .grip { transition-duration: 0ms; }
}
```

注意 `.commit.selected` 用的是 `outline`，与 `drop-*` 的 `box-shadow` 不冲突；`.commit.locked` 用的是 `border-left-color`，也不冲突。

### 4.5 JS 补丁（`media/main.js`，共 3 处、约 15 行）

**a) 菜单原点 + 键盘免动画**（`openMenu()` 与 `rowKeydown()`）

```js
function openMenu(x, y, c, origin, options = {}) {
  /* …构造菜单不变… */
  menuEl.classList.remove("hidden");
  const mw = menuEl.offsetWidth; const mh = menuEl.offsetHeight;
  const left = Math.max(4, Math.min(x, window.innerWidth - mw - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - mh - 4));
  menuEl.style.left = left + "px"; menuEl.style.top = top + "px";
  // 从实际触发点放大，而不是从菜单中心。
  menuEl.style.setProperty("--grv-origin", `${Math.max(0, x - left)}px ${Math.max(0, y - top)}px`);
  // 键盘打开的菜单不做动画：按键本身已经提供了反馈。
  if (options.instant) menuEl.dataset.instant = "true"; else delete menuEl.dataset.instant;
  /* …keydown / focusMenu 不变… */
}
```

`rowKeydown` 的键盘分支改为：

```js
openMenu(r.left + 8, r.bottom, c, event.currentTarget, { instant: true });
```

`closeMenu()` **不动**——菜单关闭保持瞬时，与原生一致，同时避免为等 `transitionend` 而改动 `menuClosing` 语义（`webviewDom.test.ts` 依赖它）。

**b) tooltip 首次延迟、后续即时**（`scheduleTooltip` / `hideTooltip`）

```js
let tipInstantUntil = 0;
function scheduleTooltip(c, row) {
  if (tipTimer) clearTimeout(tipTimer); if (tipHideTimer) clearTimeout(tipHideTimer);
  tipHash = c.hash; tipAnchor = row;
  // 400ms 只用来防第一次误触；已经显示过之后，相邻行立即响应。
  const instant = Date.now() < tipInstantUntil;
  tipTimer = setTimeout(() => vscode.postMessage({ type: "requestDetail", hash: c.hash }), instant ? 0 : 400);
}
function hideTooltip() {
  tooltipEl.classList.add("hidden"); tipHash = null; tipAnchor = null;
  tipInstantUntil = Date.now() + 800;
}
```

**c) tooltip 方位与即时标记**（`showDetail` 末尾）

```js
let topPos = r.bottom + 4; const above = topPos + th > window.innerHeight - 4;
if (above) topPos = Math.max(4, r.top - th - 4);
tooltipEl.style.left = Math.max(4, Math.min(r.left, window.innerWidth - tw - 4)) + "px";
tooltipEl.style.top = topPos + "px";
tooltipEl.style.setProperty("--grv-origin", above ? "left bottom" : "left top");
// 只有第一次出现才播动画；连续浏览时直接切换内容。
tooltipEl.dataset.instant = Date.now() < tipInstantUntil ? "true" : "false";
```

**d) `#direction` 常驻**（`renderDirection()`）

```js
function renderDirection() {
  // 常驻一行：出现/消失会顶动整个列表，而它正好在拖拽开始时切换。
  directionEl.textContent = dragHint || "拖动 ⋮⋮ 重排 · Alt+↑↓ 移动一位";
  directionEl.classList.remove("hidden");
}
```

取样时顺手把空态的静态提示写进去——原本是空白，现在是免费的功能发现入口。HTML 里 `#direction` 初始不带 `hidden`，`renderDirection()` 在启动时已调用，无需改模板。

## 5. 明确不做的事

写清楚"不做什么"，避免后续把这份方案理解成"给所有东西加动画"：

| 不做 | 原因 |
| --- | --- |
| 不给 `.commit` / `.change-file` 加入场动画或 stagger | `renderList()` 每次点击都整表重建，动画会随每次选择重播（见 2.1） |
| 不给列表重排做 FLIP 动画 | 重排在 host 确认后由新 state 重建，不是同批 DOM 位移；要做得引入会话级快照记账，与现有 revision guard 逻辑纠缠，收益/风险不成比例 |
| 不给 `.file-actions` / `.file-group-actions` 加淡入 | 行内 hover 不闪烁，加过渡只会让动作按钮迟到 |
| 不给 `.commit:hover` / `.commit.selected` 加背景过渡 | 高频 + 原生列表本身就是瞬时高亮，加了反而"粘手" |
| 不给过滤输入、键盘 Alt+↑↓ 重排、刷新任何反馈动画 | 高频键盘/输入操作，任何延迟都被感知为卡顿 |
| 不引入 `@starting-style` | VS Code 1.85（Chromium 114）不支持，见 4.3 |
| 不引入动画库（Motion / GSAP 等） | 纯 CSS 已足够；webview 体积与 CSP 都不值得 |

## 6. 验收

自动化：

```bash
npm run typecheck
npm test
```

`test/webviewDom.test.ts:226` 断言首次 hover 仍需 ≥400ms（等待 420ms），本方案保留首次延迟，用例不受影响；该用例不覆盖后续即时路径，建议补一条"第二次 hover 在 0ms 内发出 requestDetail"的用例。

人工（按 skill 的调试方法）：

1. **慢放检查**：临时把 150ms 改成 1500ms，逐项看菜单/tooltip 的 origin 是否落在触发点、是否有两个状态重叠；
2. **Chromium 114 回退**：用 VS Code 1.85 或 `window.navigator.userAgent` 确认无 `@starting-style` 依赖；
3. **拖拽全程**：抓取瞬间列表不得位移（P0-1、P0-2 的验证点）；
4. **系统减弱动效开启**：只剩淡入，无缩放/位移；
5. **亮色 + High Contrast Light/Dark**：圆点不再有焦点蓝描边（P0-3），菜单阴影不过重（P0-4）。

## 7. 建议实施顺序

| 阶段 | 内容 | 风险 |
| --- | --- | --- |
| 第 1 步 | P0-1（`#direction` 常驻）、P0-2（插入指示改 `box-shadow`） | 纯呈现，无状态机改动；直接影响拖拽手感 |
| 第 2 步 | P0-3/P0-4/P0-5（圆点描边、阴影 token、按钮 hover） | 纯 CSS |
| 第 3 步 | P1-6/P1-14/P1-15（按压、抓取态、把手） | 纯 CSS |
| 第 4 步 | P1-7~P1-13（菜单/tooltip/toast/banner） | 需 4.5 的 JS 补丁，改动 3 处 |
| 第 5 步 | P2-17/P2-18 | 死代码删除建议单独提交，便于回滚 |

## 8. 视觉验证管线（`scripts/ui-screenshot.mjs`）

jsdom 只能断言"类名/文本变了"，计算样式只能证明"某个颜色是 X"。两者都回答不了"看起来对不对"。这个脚本补上这一环：用 headless Chrome 渲染**真实的 webview**，每个场景输出一张 PNG。

```bash
node scripts/ui-screenshot.mjs                       # dark_modern + light_modern × 全部场景
node scripts/ui-screenshot.mjs --theme hc_black --only menu
node scripts/ui-screenshot.mjs --width 300 --only drag   # 默认测 340px，这里模拟窄侧栏
```

默认输出到 `D:\tmp\grv-ui-shots`（不污染工作区），可用 `--out` 改。

**为什么截图是可信的**

- body 标记从 `src/ui/rebaseViewProvider.ts` 里**切出来**，不是手抄；缺任一 id 直接抛错，避免渲染一个不存在的界面。
- `media/style.css` 与 `media/main.js` 原样加载，`acquireVsCodeApi` 用桩替代，场景只通过 `postMessage` 与真实事件驱动，不触碰内部状态。
- `--vscode-*` 变量来自**已安装 VS Code 的主题 JSON + workbench bundle 里的 color registry 默认值**（`charts.*`、`list.hoverBackground` 等都不在主题 JSON 里）。解析不到的 token 会打印告警——静默回退到 CSS fallback 会产生"假截图"。
- 2× 像素密度，340×720 视口（侧边栏实际尺寸）。

**已知局限**

- 没有 VS Code 外壳（活动栏、标题栏、真实字号缩放的滚动条）。
- High Contrast 主题的 JSON 本身很稀疏，多数颜色靠 registry 的 `null`/计算值回退，HC 截图只能作参考，不能作为对比度判定依据。
- 拖拽是合成 pointer 事件，能验证视觉状态，验证不了真实拖拽的时序手感。
- `gitDecoration.*`、`debugTokenExpression.*`、`terminal.ansiBright*` 等 token 仍未解析，相关颜色在截图里是 CSS fallback。

**第一次跑就发现的问题**

在 300px（VS Code 默认侧边栏宽度）下，右键菜单实测宽 **322px**，右侧溢出 26px，快捷键提示（`Enter` / `Delete`）与长标签尾部被裁掉。菜单是 `position: fixed` 且位于 webview 内部，无法逃出面板边界；`.menu` 只有 `min-width: 200px`，没有 `max-width`。已记录到 `docs/improvement/improvement.md`。
