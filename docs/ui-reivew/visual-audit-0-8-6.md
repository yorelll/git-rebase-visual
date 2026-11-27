# Git Rebase Visual — 视觉验证评估报告（0.8.6）

> 基线：`main@3e5526c`（五批 UI 改造已合并）。本报告只描述"渲染出来是什么样、量出来的数是多少"，
> 不改代码。复现命令见 §7。

## 1. 工具选型

| 候选 | 安装量 / 仓库 | 结论 |
| --- | --- | --- |
| **cursor/plugins@control-ui** | 2.6K / 19.8k stars（Cursor 官方） | **采用**。唯一为 "web、IDE、Electron UI" 写的：CDP 连接、稳定标记选页、一次一个结构动作 + 前后快照、a11y/perf 采集、以及"不要用过期元素引用/不要坐标点击"的护栏。 |
| affaan-m/ecc@browser-qa | 12.3K / 311k stars | 不采用。面向 Web 应用 + 浏览器 MCP 的部署后冒烟（console error、Core Web Vitals）。本项目是被 VS Code 承载的 webview，没有 dev server 可连。 |
| browser-use/browser-use@qa | 1.7K / 122k stars | 不采用。同样是 Web 站点评分，驱动不到 Electron 面板。 |
| **vercel-labs/agent-skills@web-design-guidelines** | 911K（已装） | **采用为规则清单**（焦点、对比度、语义、目标尺寸）。 |

关键判断：**没有 skill 能自己把 VS Code webview 渲染出来**，control-ui 给的是方法，渲染器仍要用仓库自己的
`scripts/ui-screenshot.mjs`（它按 control-ui 的"复用仓库已有 harness"一条来用）。

## 2. 覆盖矩阵

9 个场景 × 2 套主题，dark_modern / light_modern，340×720 @2x。

| 场景 | 覆盖的组件 |
| --- | --- |
| `list-idle` | 分支上下文栏、direction 行、搜索栏、提交行、作者圆点、锁定行与锁图标、时间轴端点 |
| `tooltip` | 悬浮详情卡（作者、日期、stat 徽标、message 块、动作图标） |
| `menu` | 右键菜单（分组标题、图标、快捷键提示、危险项） |
| `menu-batch` | 批量选择菜单（禁用项与禁用原因） |
| `drag` | 拖拽抓取态（虚线）、插入指示线、direction 实时文案 |
| `rebase-conflict` | 冲突横幅、Continue/Skip/Abort、进度 |
| `rebase-edit` | edit 停靠横幅、amend/新建按钮、自动展开的改动列表 |
| `empty` | 空时间轴文案 |
| `filter` | 过滤输入、结果计数、清除按钮、过滤态文案 |

## 3. 度量结果

`--audit` 对每个场景的**全部有文本节点**计算前景色、最近绘制背景与 WCAG 对比度，共 **1314** 个节点。

汇总：**105 个低于 AA**（正文 4.5:1 / 大字号 3:1），**0 个未被裁剪的横向溢出**，**8 个非省略号裁切**。

### 3.1 需要修的（按严重度）

| # | 组件 | 实测 | 根因 | 建议 |
| --- | --- | --- | --- | --- |
| V1 | 菜单项图标（高亮时） | **1.67:1**（dark）/ 1.78:1（light） | `.menu .menu-icon` 自己写了 `color: var(--vscode-descriptionForeground)`，不随 `.item:hover` / `:focus-visible` 的 `menu-selectionForeground` 变化，于是灰图标压在蓝底上 | `.menu .item:hover .menu-icon, .menu .item:focus-visible .menu-icon { color: inherit; }` |
| V2 | tooltip 的 `tip-stat` 徽标 | **2.28:1**（dark） | 背景用 `--vscode-badge-background`（#616161），文字却用 `--vscode-descriptionForeground`（#9D9D9D）；VS Code 的徽标配对是 `badge-foreground` | 文字改 `var(--vscode-badge-foreground)` |
| V3 | 改动列表的 `M` 标记 | **2.93:1**（light） | `.file-state-modify` 优先用 `--vscode-editorWarning-foreground`（#BF8803），而 VS Code 为文件状态提供的 `gitDecoration.modifiedResourceForeground` 是 #895503 | 改用 `gitDecoration.modifiedResourceForeground`（A/D/R 已经用它） |
| V4 | 菜单危险项文字 | **3.35:1**（light） | `.menu .item.danger` 用 `errorForeground` 配菜单背景 | 与已记录的 `.danger-btn` 同源，一起定危险色方案 |
| V5 | 作者圆点首字母 | **3.59:1**（light，白字压 charts.blue） | 圆点文字用 `--vscode-editor-background`，浅色主题下是白色 | 按背景亮度选前景，或给 charts.* 配固定的深色字 |
| V6 | `⏸ 停在此` 徽标 | **3.64:1**（dark） | 背景 `focusBorder`，文字 `editor-background` | 同 V5，改用固定的对照色 |
| V7 | 过滤框两个清除入口 | — | `input[type=search]` 自带 Chromium 的 `::-webkit-search-cancel-button`，页面又渲染了一个「清除」按钮 | 隐藏原生按钮：`input[type=search]::-webkit-search-cancel-button { display: none; }` |
| V8 | 菜单图标被裁 | `menu-icon` 14×17，`scrollWidth 17` | `.menu .menu-icon { width: 14px }` 装不下 `🔒`/`⌫` 这类 emoji | 宽度改 `1.2em` 或 `font-size` 与宽度解耦 |

**已知项**：`Skip（丢弃 patch）`/`Abort` 的 danger 按钮 2.66:1（light）/ 3.88:1（dark），已在
`docs/improvement/improvement.md` 记录，本报告不重复立项。

### 3.2 临界（不单独立项）

| 组件 | 实测 |
| --- | --- |
| 提交行 hover 态下的 `commit-meta` / `grip` | 4.36:1（dark，`descriptionForeground` 压 hover 背景 #37373D） |
| 冲突横幅的「步骤 4 / 8」 | 4.48:1（dark） |

两者都只差一点点，属于主题 token 的既有边界；改善 V2/V3 后可一并复核。

## 4. 布局与溢出

| 项 | 结果 |
| --- | --- |
| 未裁剪的横向溢出 | **0**：`#context-text` 的 414px 宽度被 `.branch-context` 的 `overflow: hidden` 正确裁剪，不是缺陷 |
| 非省略号裁切 | **8**，全部是 V8 的菜单 emoji |
| 右键菜单宽度 | 340px 视口下 322px（贴合边缘）；**300px 默认侧边栏下溢出 26px**，已记录在 `improvement.md` |
| 行高变化 | batch 5 前后 PNG 尺寸一致，diff 只落在分组标题行（评审方独立复现） |

## 5. 逐组件结论

| 组件 | 结论 |
| --- | --- |
| 分支上下文栏 | 单行、ellipsis 正确；`tabular-nums` 生效 |
| direction 行 | 常驻、单行、状态文案正确（空闲 / 拖拽中 / 过滤 / 变基 / 加载） |
| 搜索栏 | 计数与过滤正确；**V7 双清除入口** |
| 提交行 | 两行布局、2 行截断、hover/选中/键盘拾取区分清楚 |
| 作者圆点 | 颜色区分正确、无焦点蓝描边；**V5 浅色对比度** |
| 锁定行 | 橙色左条 + 锁图标正确；折叠摘要可读 |
| 停靠徽标 | 位置正确；**V6 对比度** |
| 未提交改动 | 分组标题正常大小写；**V3 的 M 颜色** |
| 右键菜单 | 分组/快捷键/危险色/禁用原因完整；**V1、V4、V8、300px 溢出** |
| tooltip | 层级、origin 正确；**V2 徽标对比度** |
| 冲突横幅 | 信息完整、Continue 在冲突时禁用、Skip/Abort 危险色可见 |
| 空 / 过滤态 | 文案正确，无残留控件 |

## 6. 局限

- 没有 VS Code 外壳（活动栏、标题栏、真实滚动条），也没有真实字体回退。
- High Contrast 只作参考：HC 主题 JSON 本身稀疏，多数颜色来自 registry 的 `null`/计算值。
- 拖拽是合成 pointer 事件：能验证视觉状态，验证不了时序手感与边缘滚动。
- `disabled` 元素的实测对比度不含 `opacity: 0.5` 的叠加，真实观感更低。
- 审计以"最近绘制祖先背景"近似合成背景；半透明叠加（如 hover 渐变）按最近不透明层计算。

## 7. 复现

```bash
node scripts/ui-screenshot.mjs --theme dark_modern,light_modern --out D:\tmp\grv-visual --audit
node scripts/ui-screenshot.mjs --width 300 --only menu --out D:\tmp\grv-visual-300
```

输出：`<out>/<theme>/<scenario>.png` 与 `<out>/audit.json`。审计末尾会打印
`N text nodes · M below AA · K clipped · J overflowing`。
