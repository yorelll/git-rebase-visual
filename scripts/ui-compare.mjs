#!/usr/bin/env node
/**
 * Builds a single self-contained HTML review page: before | after | diff for
 * every scenario, with the changed pixels painted over a dimmed original.
 *
 * Why a pixel diff instead of hand-drawn arrows: the review question is "what
 * actually moved", and a hand-placed callout can be wrong or stale. The diff
 * marks exactly the pixels that changed; the legend explains why each region
 * was expected to change. Anything highlighted that no legend entry explains is
 * a regression the reviewer should look at.
 *
 * Usage:
 *   node scripts/ui-compare.mjs --before DIR --after DIR --out FILE.html
 */

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const beforeDir = path.resolve(flag("before", "D:/tmp/cmp/before"));
const afterDir = path.resolve(flag("after", "D:/tmp/cmp/after"));
const outFile = path.resolve(flag("out", "docs/ui-reivew/compare-0-8-6.html"));
const title = flag("title", "Git Rebase Visual — UI 0.8.6 修改前后对比");

/** Every change shipped in batches 1–5, A–C, with the numbers that justify it. */
const changes = [
  ["P0-1", "拖拽提示行常驻", "空闲时 `display:none`，抓取瞬间出现，把列表顶下 24px", "常驻一行，空闲显示「拖动 ⋮⋮ 重排 · Alt+↑↓ 移动一位」", ["drag", "list-idle", "filter"]],
  ["P0-2", "插入指示线", "`border-top: 2px`，拖拽时行高 +2px、下方行跳动", "`inset box-shadow`，零布局影响", ["drag"]],
  ["P0-3", "作者圆点描边", "常规主题回落到 `focusBorder`，每个圆点都像被选中", "`1px solid transparent`，HC 仍由媒体查询接管", ["list-idle", "menu"]],
  ["P0-4", "浮层阴影", "硬编码 40% 黑", "`--vscode-widget-shadow`", ["menu", "tooltip"]],
  ["P0-5", "按钮 hover", "`opacity: 0.9`（文字一起变淡）", "`button-*HoverBackground` token", ["menu", "rebase-conflict"]],
  ["P1-6", "按压反馈", "无 `:active`", "`scale(0.97)` 160ms", ["focus-btn"]],
  ["P1-14", "拖拽抓取态", "只降透明度", "虚线 outline + 120ms 过渡", ["drag"]],
  ["P1-7~13", "浮层出现动画", "瞬时出现", "菜单/tooltip 从触发点生长；toast/banner 淡入；键盘菜单免动画", ["menu", "tooltip"]],
  ["P2-17", "数字等宽", "轮询刷新时 `↑12 ↓3` 左右抖", "`tabular-nums`", ["list-idle"]],
  ["P2-19", "分组标题", "全大写 + 字间距", "正常大小写、正常字距", ["list-idle", "menu"]],
  ["V1/C1", "菜单选中项图标与快捷键", "灰字压蓝底 1.67:1", "`color: inherit` → 4.53 / 6.31", ["menu", "menu-hover", "menu-hover-danger"]],
  ["C2", "危险项 hover", "红字压蓝底 1.35:1", "选中态用 `menu-selectionForeground` → 4.53 / 6.31", ["menu-hover-danger"]],
  ["V8", "菜单 emoji 被裁", "14px 盒装 17–18px 字形", "`1.4em`，`scrollWidth` 18→18", ["menu", "menu-batch"]],
  ["V2", "tooltip 徽标", "`badge-background` 配 `descriptionForeground` 2.28:1", "`badge-foreground` → 5.83", ["tooltip"]],
  ["V3", "改动列表 M 标记", "`editorWarning` 2.93:1", "`gitDecoration.modifiedResourceForeground` → 5.88", ["more-options", "rebase-edit"]],
  ["V7", "过滤框双清除入口", "Chromium 原生 × 与页面「清除」并存", "隐藏原生取消按钮", ["filter"]],
  ["C3", "primary 焦点环", "环与按钮同色，键盘用户看不到焦点", "环移入填充并用 `button-foreground` → 4.53 / 6.31", ["focus-btn"]],
  ["C4", "超长错误横幅", "594px 高，列表只剩 15px", "高度上界 + 内部滚动", ["error-long"]],
  ["C5", "待重放行", "`opacity: 0.62` 把 meta 压到 3.31", "`0.8`，有效对比度 ≥4.5", ["pending"]],
];

const list = (dir) => {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const theme of fs.readdirSync(dir)) {
    const themeDir = path.join(dir, theme);
    if (!fs.statSync(themeDir).isDirectory()) continue;
    for (const file of fs.readdirSync(themeDir)) {
      if (file.endsWith(".png")) found.push(`${theme}/${file.replace(/\.png$/, "")}`);
    }
  }
  return found.sort();
};

const before = new Set(list(beforeDir));
const after = new Set(list(afterDir));
const keys = [...new Set([...before, ...after])].sort();

const dataUri = (file) => {
  if (!fs.existsSync(file)) return "";
  return `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
};

const notesFor = (scenario) =>
  changes.filter(([, , , , scenarios]) => scenarios.includes(scenario)).map(([id, name]) => `${id} ${name}`);

const panels = keys.map((key) => {
  const theme = key.split("/")[0];
  const scenario = key.split("/")[1];
  const beforeSrc = dataUri(path.join(beforeDir, `${key}.png`));
  const afterSrc = dataUri(path.join(afterDir, `${key}.png`));
  const notes = notesFor(scenario);
  return `<section class="shot" data-key="${key}">
  <h3>${theme} / ${scenario}${notes.length ? "" : ' <span class="quiet">（预期无变化）</span>'}</h3>
  <p class="notes">${notes.length ? notes.join(" · ") : "本场景不在任何改动的影响范围内，像素差异应接近 0。"}</p>
  <div class="row">
    <figure><figcaption>改前</figcaption>${beforeSrc ? `<img src="${beforeSrc}">` : "<div class=missing>无</div>"}</figure>
    <figure><figcaption>改后</figcaption>${afterSrc ? `<img src="${afterSrc}">` : "<div class=missing>无</div>"}</figure>
    <figure><figcaption>差异<span class="pct"></span></figcaption><canvas></canvas></figure>
  </div>
</section>`;
}).join("\n");

const legend = changes
  .map(([id, name, beforeText, afterText]) => `<tr><th>${id}</th><td>${name}</td><td>${beforeText}</td><td>${afterText}</td></tr>`)
  .join("\n");

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --fg:#1f2328; --bg:#fff; --muted:#656d76; --line:#d0d7de; --hit:#d1242f; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e6edf3; --bg:#0d1117; --muted:#8d96a0; --line:#30363d; --hit:#ff7b72; } }
  body { margin:0; padding:24px 28px 64px; background:var(--bg); color:var(--fg);
         font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:16px; margin:32px 0 8px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  .sub { color:var(--muted); margin:0 0 24px; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th,td { border-bottom:1px solid var(--line); padding:6px 10px; text-align:left; vertical-align:top; }
  th { font-weight:600; white-space:nowrap; }
  td:nth-child(3), td:nth-child(4) { color:var(--muted); }
  .shot { margin:28px 0 36px; }
  .shot h3 { font-size:14px; margin:0 0 2px; font-family:ui-monospace,Consolas,monospace; }
  .quiet { color:var(--muted); font-weight:400; }
  .notes { color:var(--muted); font-size:12px; margin:0 0 10px; }
  .row { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; align-items:start; }
  figure { margin:0; }
  figcaption { font-size:12px; color:var(--muted); margin-bottom:4px; }
  img, canvas { width:100%; height:auto; display:block; border:1px solid var(--line); border-radius:4px; background:#000; }
  .missing { border:1px dashed var(--line); border-radius:4px; padding:24px; text-align:center; color:var(--muted); }
  .pct { color:var(--hit); font-weight:600; margin-left:6px; }
  .badge { display:inline-block; padding:1px 6px; border-radius:10px; background:var(--hit); color:#fff; font-size:11px; }
</style></head>
<body>
<h1>${title}</h1>
<p class="sub">左：改动前（c192298，0.8.6 原始）。中：改动后。右：<span class="badge">像素差异</span>
灰色为未变区域，<span style="color:var(--hit);font-weight:600">红色</span>为发生变化的像素。两侧使用同一套渲染场景，宽度 340px、2× 像素密度。</p>

<h2>改动清单</h2>
<table><thead><tr><th>编号</th><th>项</th><th>改前</th><th>改后</th></tr></thead><tbody>
${legend}
</tbody></table>

<h2>逐场景对比</h2>
${panels}

<script>
// Paint the diff in the browser: unchanged pixels are dimmed to a grey
// backdrop, changed pixels keep a saturated red so the eye lands on them.
for (const section of document.querySelectorAll('.shot')) {
  const images = section.querySelectorAll('img');
  const canvas = section.querySelector('canvas');
  if (images.length < 2) { canvas.replaceWith(document.createElement('span')); continue; }
  const [a, b] = images;
  const draw = () => {
    const w = a.naturalWidth, h = a.naturalHeight;
    if (!w || !h) return;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(a, 0, 0, w, h);
    const beforeData = ctx.getImageData(0, 0, w, h);
    ctx.drawImage(b, 0, 0, w, h);
    const afterData = ctx.getImageData(0, 0, w, h);
    const out = ctx.createImageData(w, h);
    let changed = 0;
    for (let i = 0; i < beforeData.data.length; i += 4) {
      const delta = Math.abs(beforeData.data[i] - afterData.data[i])
        + Math.abs(beforeData.data[i + 1] - afterData.data[i + 1])
        + Math.abs(beforeData.data[i + 2] - afterData.data[i + 2]);
      if (delta > 24) {
        changed++;
        out.data[i] = 220; out.data[i + 1] = 30; out.data[i + 2] = 40; out.data[i + 3] = 255;
      } else {
        const grey = (afterData.data[i] * 0.299 + afterData.data[i + 1] * 0.587 + afterData.data[i + 2] * 0.114);
        const dim = grey * 0.18 + 18;
        out.data[i] = dim; out.data[i + 1] = dim; out.data[i + 2] = dim; out.data[i + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);
    const pct = (changed / (w * h) * 100);
    section.querySelector('.pct').textContent = pct === 0 ? "0%" : pct.toFixed(2) + "%";
  };
  if (a.complete && b.complete && a.naturalWidth) draw();
  else { a.addEventListener('load', draw); b.addEventListener('load', draw); }
}
</script>
</body></html>`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`wrote ${outFile} (${keys.length} panels, ${(fs.statSync(outFile).size / 1048576).toFixed(1)} MB)`);
