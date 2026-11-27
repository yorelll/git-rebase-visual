#!/usr/bin/env node
/**
 * Renders the real sidebar webview to PNG files, outside VS Code.
 *
 * Why this exists: the jsdom suite can prove that a class or a text node
 * changed, and CDP can prove a computed colour, but neither can answer "does
 * this look right". A screenshot can. The webview is plain HTML + CSS + one
 * IIFE, so a headless browser reproduces it faithfully — the only thing missing
 * is the VS Code chrome around it (activity bar, title bar, real sidebar
 * width), which is not what any of these changes touch.
 *
 * Everything here is taken from the real sources, so the render cannot drift:
 *   - the body markup is sliced out of `src/ui/rebaseViewProvider.ts`;
 *   - `media/style.css` and `media/main.js` are served as-is;
 *   - `--vscode-*` variables are derived from the shipped theme JSONs, walking
 *     their `include` chain, so every token the CSS falls back on is present.
 *
 * `acquireVsCodeApi` is stubbed: it records what the webview posts and lets the
 * driver push host messages back in. That is enough to reach every visual
 * state, because `main.js` only ever renders from the state it is handed.
 *
 * Usage:
 *   node scripts/ui-screenshot.mjs [--out DIR] [--theme a,b] [--only name,name]
 *                                  [--width N] [--audit] [--debug-style]
 *
 * Defaults to `D:\tmp\grv-ui-shots` so a render never dirties the working tree.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const outDir = path.resolve(flag("out", "D:/tmp/grv-ui-shots"));
const themes = flag("theme", "dark_modern,light_modern,hc_black,hc_light").split(",");
const only = flag("only", "").split(",").filter(Boolean);
// The sidebar view and the compose panel are different webviews with different
// markup, viewport and scenarios; `--surface compose` renders the second one.
const surface = flag("surface", "sidebar");
// VS Code's default sidebar is 300px; 340 leaves room for a wider panel.
const viewportWidth = Number(flag("width", "340"));

/**
 * The theme JSONs and the workbench bundle are the only authoritative sources
 * for the `--vscode-*` variables, so they come from an installed VS Code rather
 * than from a checked-in copy that would drift. `VSCODE_APP_PATH` overrides the
 * search when VS Code lives somewhere unusual.
 */
function findVSCodeRoot() {
  const candidates = [
    process.env.VSCODE_APP_PATH,
    path.join(process.env.LOCALAPPDATA || "", "Programs/Microsoft VS Code/resources/app"),
    "C:/Program Files/Microsoft VS Code/resources/app",
    "/usr/share/code/resources/app",
    "/Applications/Visual Studio Code.app/Contents/Resources/app",
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, "extensions/theme-defaults/themes")));
  if (!found) throw new Error("VS Code not found; set VSCODE_APP_PATH to its `resources/app` directory");
  return found;
}

const vscodeRoot = findVSCodeRoot();
const themeDir = path.join(vscodeRoot, "extensions/theme-defaults/themes");
const workbenchBundle = path.join(vscodeRoot, "out/vs/workbench/workbench.desktop.main.js");

// ---------------------------------------------------------------- markup

/**
 * Slice the static body out of the provider template instead of copying it.
 * The template's only interpolation is the script/style URIs in <head> and the
 * trailing <script> tag, so everything between <body> and </body> is literal.
 * A missing id is a hard failure: a silently different skeleton would produce
 * screenshots of a UI that does not exist.
 */
function readWebviewBody() {
  const source = fs.readFileSync(path.join(root, "src/ui/rebaseViewProvider.ts"), "utf8");
  const start = source.indexOf("<body>");
  const end = source.indexOf("</body>");
  if (start < 0 || end < 0) throw new Error("webview template body not found in rebaseViewProvider.ts");
  const body = source
    .slice(start + "<body>".length, end)
    .replace(/<script[^>]*><\/script>/g, "")
    .trim();
  for (const id of ["banner", "context", "context-text", "inline-toast", "changes", "direction", "list", "menu", "tooltip", "live"]) {
    if (!body.includes(`id="${id}"`)) throw new Error(`webview template lost #${id}; the screenshot harness would render a different UI`);
  }
  return body;
}

/**
 * The compose / AI-message panel lives in a single template literal inside
 * `composePanel.ts`, which is why it can be rendered the same way: its markup,
 * its inline styles and its own controller script are all literal. Only the
 * nonce attribute is interpolated, and that is stripped before serving.
 */
function readComposeDocument() {
  const source = fs.readFileSync(path.join(root, "src/ui/composePanel.ts"), "utf8");
  const start = source.indexOf("<!doctype html>");
  const end = source.indexOf("</html>", start);
  if (start < 0 || end < 0) throw new Error("compose panel template not found");
  const raw = source.slice(start, end + "</html>".length);
  // Slice with `source.slice` would hand the browser the *unescaped* template:
  // `split('\\n')` stays two backslashes instead of becoming the single
  // backslash that the shipped HTML carries, so a panel that is correct in
  // production renders as if it were broken. Evaluate the template once, with
  // the same two interpolations the extension supplies.
  let template;
  try {
    template = new Function("nonce", "webview", `return \`${raw}\`;`)("harness-nonce", { cspSource: "http://127.0.0.1" });
  } catch (error) {
    console.warn(`  ! compose template could not be evaluated (${error.message}); falling back to the raw slice, which may render escape sequences wrongly`);
    template = raw;
  }
  const style = /<style>([\s\S]*?)<\/style>/.exec(template);
  const body = /<body>([\s\S]*?)<\/body>/.exec(template);
  if (!style || !body) throw new Error("compose panel template lost its style or body");
  // Keep the panel's own controller script: it is what turns host messages into
  // the states under review. Only the nonce attribute is dropped.
  const inner = body[1].replace(/<script[^>]*>([\s\S]*?)<\/script>/, (_, script) => `<script>${script}</script>`);
  for (const id of ["subject", "body", "extra", "generate", "apply", "close"]) {
    if (!inner.includes(`id="${id}"`)) throw new Error(`compose panel lost #${id}`);
  }
  return { style: style[1], body: inner };
}

// ---------------------------------------------------------------- themes

/** Merge a theme's `include` chain: later (includer) colours win. */
function loadTheme(name, seen = new Set()) {
  if (seen.has(name)) return {};
  seen.add(name);
  const file = path.join(themeDir, `${name}.json`);
  const theme = JSON.parse(fs.readFileSync(file, "utf8"));
  const inherited = theme.include ? loadTheme(path.basename(theme.include).replace(/\.json$/, ""), seen) : {};
  return { ...inherited, ...(theme.colors || {}) };
}

/**
 * Theme JSONs only carry what a theme overrides. Everything else — charts.*,
 * gitDecoration.*, list.hoverBackground, most of the High Contrast palette —
 * comes from colour-registry defaults that the workbench registers at startup.
 * Ignoring them renders `var(--x, fallback)` and quietly screenshots the wrong
 * colours, so the bundle is parsed for those defaults once and cached.
 *
 * Minified registrations look like `V("charts.green",{dark:"#89D185",...},h(1))`,
 * or reuse another registration through a variable (`charts.blue` is `mf`,
 * which is the `editorInfo.foreground` registration).
 */
function readColorDefaults() {
  const cacheFile = path.join(outDir, ".vscode-color-defaults.json");
  if (!fs.existsSync(workbenchBundle)) return {};
  const stamp = fs.statSync(workbenchBundle).mtimeMs;
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    // `version` guards against reusing a cache written before extension colours
    // and bundle constants were added to the resolver.
    if (cached.version === 2 && cached.stamp === stamp) return cached.defaults;
  }
  const source = fs.readFileSync(workbenchBundle, "utf8");
  const spec = String.raw`(?:\{[^{}]{0,800}\}|[A-Za-z_$][\w$]*)`;
  const idPattern = String.raw`[a-zA-Z][\w-]*(?:\.[\w-]+)+|focusBorder|foreground|contrastBorder|descriptionForeground|errorForeground`;
  // The trailing `h(id, fallback)` is not always present (`debugTokenExpression`
  // is followed by its description string), so it must not be part of the match.
  const registration = new RegExp(String.raw`([A-Za-z_$][\w$]*)\(\s*"(${idPattern})"\s*,\s*(${spec})`, "g");
  // Colours are sometimes written as bundle constants (`he.white`) rather than
  // literals; `list.activeSelectionForeground` — which `menu.selectionForeground`
  // aliases — is exactly that case, and missing it makes selected menu text look
  // unreadable in the render while VS Code shows white.
  const constants = {
    "he.white": "#ffffff",
    "he.black": "#000000",
    "he.transparent": "transparent",
  };
  const parseObject = (text) => {
    const found = {};
    for (const m of text.matchAll(/(dark|light|hcDark|hcLight)\s*:\s*"(#[0-9a-fA-F]{3,8})"/g)) found[m[1]] = m[2];
    for (const m of text.matchAll(/(dark|light|hcDark|hcLight)\s*:\s*([A-Za-z_$][\w$]*\.[\w$]+)/g)) {
      const value = constants[m[2]];
      if (value && !found[m[1]]) found[m[1]] = value;
    }
    return found;
  };
  const resolve = (raw) => {
    if (raw.startsWith("{")) return parseObject(raw);
    // Follow one hop: either `name={...}` or `name=<fn>("id",{...})`.
    const escaped = raw.trim().replace(/\$/g, "\\$");
    const hit = new RegExp(String.raw`(?:^|[,;(])\s*${escaped}\s*=\s*(\{[^{}]{0,800}\}|[A-Za-z_$][\w$]*\(\s*"[^"]+"\s*,\s*\{[^{}]{0,800}\})`).exec(source);
    if (!hit) return {};
    if (hit[1].startsWith("{")) return parseObject(hit[1]);
    const nested = /\{[^{}]{0,800}\}/.exec(hit[1]);
    return nested ? parseObject(nested[0]) : {};
  };
  const defaults = {};
  let match;
  while ((match = registration.exec(source))) {
    if (defaults[match[2]]) continue;
    const parsed = resolve(match[3]);
    if (Object.keys(parsed).length) defaults[match[2]] = parsed;
  }
  // Not every colour is registered by the workbench: extensions contribute
  // their own through `contributes.colors` (gitDecoration.* lives there, which
  // is why the file-state letters rendered in fallback colours). Those use
  // `highContrast` / `highContrastLight` key names.
  const extensionsDir = path.join(vscodeRoot, "extensions");
  for (const entry of fs.existsSync(extensionsDir) ? fs.readdirSync(extensionsDir) : []) {
    const manifest = path.join(extensionsDir, entry, "package.json");
    if (!fs.existsSync(manifest)) continue;
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(manifest, "utf8")); } catch { continue; }
    for (const color of pkg.contributes?.colors || []) {
      if (!color.id || defaults[color.id]) continue;
      const value = color.defaults || {};
      const normalized = {};
      if (value.dark) normalized.dark = value.dark;
      if (value.light) normalized.light = value.light;
      if (value.highContrast) normalized.hcDark = value.highContrast;
      if (value.highContrastLight) normalized.hcLight = value.highContrastLight;
      if (Object.keys(normalized).length) defaults[color.id] = normalized;
    }
  }
  fs.writeFileSync(cacheFile, JSON.stringify({ version: 2, stamp, defaults }));
  return defaults;
}

const themeKind = (name) =>
  name.startsWith("hc_") ? (name === "hc_black" ? "hcDark" : "hcLight") : name.startsWith("light") ? "light" : "dark";

/**
 * VS Code maps `editor.background` to `--vscode-editor-background`: dots become
 * dashes, case is preserved. Precedence is registry default < theme override,
 * exactly as the workbench resolves it.
 */
function themeVariables(name, defaults) {
  const kind = themeKind(name);
  const vars = {};
  for (const [id, value] of Object.entries(defaults)) {
    if (value[kind]) vars[`--vscode-${id.replace(/\./g, "-")}`] = value[kind];
  }
  for (const [id, value] of Object.entries(loadTheme(name))) vars[`--vscode-${id.replace(/\./g, "-")}`] = value;
  // `widget.shadow` is computed in the bundle (`gt(black, .36)`), not a literal.
  if (kind === "dark") vars["--vscode-widget-shadow"] = "rgba(0, 0, 0, 0.36)";
  if (kind === "light") vars["--vscode-widget-shadow"] = "rgba(0, 0, 0, 0.16)";
  Object.assign(vars, {
    "--vscode-font-family": "'Segoe UI', 'Helvetica Neue', sans-serif",
    "--vscode-editor-font-family": "Consolas, 'Courier New', monospace",
    "--vscode-font-size": "13px",
    "--vscode-font-weight": "normal",
    "--vscode-editor-font-size": "12px",
  });
  return vars;
}

/** A token the stylesheet uses but neither the theme nor the registry defined. */
function unresolvedTokens(vars, extraCss) {
  const css = extraCss ?? fs.readFileSync(path.join(root, "media/style.css"), "utf8");
  const used = new Set([...css.matchAll(/var\((--vscode-[\w-]+)/g)].map((m) => m[1]));
  return [...used].filter((token) => !(token in vars)).sort();
}

// ---------------------------------------------------------------- fixtures

const authors = [
  { author: "lawrence", authorEmail: "lawrence@example.com", authorInitial: "L", authorColorKey: 0, isCurrentAuthor: true },
  { author: "Sally", authorEmail: "sally@example.com", authorInitial: "S", authorColorKey: 1, isCurrentAuthor: false },
  { author: "Yan", authorEmail: "yan@example.com", authorInitial: "Y", authorColorKey: 2, isCurrentAuthor: false },
];
const hashes = [
  "3f9a1c2e7b0d4a55", "8c1d44f0aa27b311", "b72e0f9c31d8a640",
  "d41a7b2c9e60f833", "e90c55a1db2740fe", "f2b83d6c04a9e711",
  "a1c9e5480b37fd22", "c6f01b73e9a2548d",
];
const subjects = [
  "feat(cif): add Stern-Brocot source rate calculation",
  "fix(isp): clamp exposure when gain is zero",
  "refactor(sensor): extract register table loading",
  "test(cif): cover the fractional-rate boundary",
  "docs: explain the rebase pointer contract",
  "fix(ui): keep the drag hint row visible",
  "chore(deps): bump esbuild to 0.20.0",
  "feat(worktree): stage deletions from the Changes group",
];

function commit(index, overrides = {}) {
  const a = authors[index % authors.length];
  return {
    hash: hashes[index].padEnd(40, "0"),
    shortHash: hashes[index],
    subject: subjects[index],
    date: `${index + 1} hour ago`,
    locked: false,
    ...a,
    ...overrides,
  };
}

const commits = [
  commit(7, { locked: true }),
  commit(6, { locked: true }),
  commit(5, { locked: true }),
  commit(4),
  commit(3),
  commit(2, { author: "Sally", authorEmail: "sally@example.com", authorInitial: "S", authorColorKey: 1 }),
  commit(1),
  commit(0),
];

const baseState = {
  type: "state",
  commits,
  canonicalOrder: commits.map((c) => c.hash),
  canonicalRevision: 7,
  branchName: "feature/cif-rate",
  upstreamRef: "origin/feature/cif-rate",
  aheadCount: 8,
  behindCount: 2,
  rangeLabel: "origin/main..HEAD",
  rebaseInProgress: false,
  // Explicitly off so every `.commit` is a direct child of #list and the
  // scenarios can address rows by index. Collapsing three locked commits would
  // move the later rows inside a <details> and make the index meaningless.
  collapseLockedRuns: false,
  llmConfigured: true,
  hasStaged: true,
  stagedCount: 2,
  hasUnstaged: true,
  unstagedCount: 3,
  changes: [
    { path: "src/cif/rate.ts", indexKind: "modify", worktreeKind: "modify", staged: true, unstaged: true },
    { path: "src/sensor/table.ts", indexKind: "add", worktreeKind: "add", staged: true, unstaged: false },
    { path: "docs/rate.md", indexKind: null, worktreeKind: "modify", staged: false, unstaged: true },
    { path: "test/tmp-output.log", indexKind: null, worktreeKind: "untracked", staged: false, unstaged: true },
    { path: "src/legacy/old_rate.c", indexKind: null, worktreeKind: "delete", staged: false, unstaged: true },
  ],
};

// ---------------------------------------------------------------- scenarios

/**
 * Each scenario drives the webview through the same entry points the host uses
 * (`postMessage`) or the same events the user generates, then the caller
 * screenshots whatever is on screen. Nothing here reaches into internal state.
 */
const scenarios = {
  "list-idle": async (page) => {
    await page.render(baseState);
  },

  tooltip: async (page) => {
    await page.render(baseState);
    await page.hoverRow(3);
    await page.wait(500);
    await page.post({ type: "detail", hash: commits[3].hash, author: "lawrence", relDate: "4 hours ago", absDate: "today", stat: "3 files changed, 42 insertions(+), 7 deletions(-)", message: subjects[3] + "\n\nExplains why the boundary is where it is, and what happens\nwhen the source rate lands exactly on a tick." });
    await page.wait(200);
  },

  menu: async (page) => {
    await page.render(baseState);
    await page.contextMenuRow(3);
    await page.wait(200);
  },

  "menu-batch": async (page) => {
    await page.render(baseState);
    await page.clickRow(3, { ctrl: true });
    await page.clickRow(4, { ctrl: true });
    await page.contextMenuRow(4);
    await page.wait(200);
  },

  drag: async (page) => {
    await page.render(baseState);
    await page.dragGrip(6, 3);
    await page.wait(120);
  },

  "rebase-conflict": async (page) => {
    await page.render({
      ...baseState,
      rebaseInProgress: true,
      conflictCount: 2,
      conflictFiles: ["src/cif/rate.ts", "src/sensor/table.ts"],
      totalSteps: 8,
      completedSteps: 3,
      pausedReason: "conflict",
      stoppedAt: commits[4].hash,
    });
  },

  "rebase-edit": async (page) => {
    await page.render({
      ...baseState,
      rebaseInProgress: true,
      conflictCount: 0,
      pausedReason: "edit",
      stoppedAt: commits[3].hash,
      totalSteps: 8,
      completedSteps: 3,
    });
  },

  empty: async (page) => {
    await page.render({ ...baseState, commits: [], canonicalOrder: [], hasStaged: false, hasUnstaged: false, changes: [] });
  },

  filter: async (page) => {
    await page.render(baseState);
    await page.typeSearch("cif");
    await page.wait(150);
  },
};

/**
 * The compose / AI-message panel is driven entirely by host messages, so each
 * scenario is one `openCompose` plus the follow-up the host would send.
 */
const composeTarget = {
  type: "openCompose",
  mode: "commit",
  hash: "e90c55a1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  subject: "docs: explain the rebase pointer contract",
  original: "docs: explain the rebase pointer contract\n\nOlder body kept here so the reader can compare.",
  trailers: "Change-Id: I0123456789abcdef\nSigned-off-by: lawrence <lawrence@example.com>",
  ai: false,
  thenEdit: false,
  sessionId: "s-1",
  revision: 3,
};

const composeScenarios = {
  "compose-edit": async (page) => {
    await page.post(composeTarget);
    await page.wait(150);
  },

  "compose-ai": async (page) => {
    await page.post({ ...composeTarget, ai: true, model: "fast" });
    await page.wait(150);
  },

  "compose-dirty": async (page) => {
    await page.post(composeTarget);
    await page.wait(80);
    await page.evaluate(`(() => {
      const subject = document.getElementById("subject");
      subject.value = subject.value.replace("docs:", "docs(ui):");
      subject.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await page.wait(80);
  },

  "compose-generating": async (page) => {
    await page.post({ ...composeTarget, ai: true, model: "fast" });
    await page.wait(80);
    await page.evaluate(`document.getElementById("generate").click()`);
    await page.wait(120);
  },

  "compose-streamed": async (page) => {
    await page.post({ ...composeTarget, ai: true, model: "fast" });
    await page.wait(80);
    await page.post({ type: "genDelta", text: "feat(ui): stream the generated message\n\n" });
    await page.post({ type: "genResult", text: "feat(ui): stream the generated message\n\nGenerate the body from the staged diff.\n" });
    await page.wait(120);
  },

  "compose-error": async (page) => {
    await page.post(composeTarget);
    await page.wait(80);
    await page.post({ type: "applyFailed", message: "应用失败：目标 commit 已被其他操作改写。" });
    await page.wait(80);
  },

  "compose-stale": async (page) => {
    await page.post(composeTarget);
    await page.wait(80);
    await page.post({ type: "staleTarget", message: "目标 commit 已变化，建议重新打开。" });
    await page.wait(80);
  },
};

// ---------------------------------------------------------------- driver

/**
 * In-page metrics probe. A screenshot shows that contrast looks wrong; this
 * says by how much, which is what a review report has to cite. Contrast is
 * computed against the nearest painted ancestor because the stylesheet paints
 * backgrounds on several layers (row, section, panel).
 */
const AUDIT_PROBE = `(() => {
  const parse = (value) => {
    const m = value.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const blend = (fg, bg) => fg.a >= 1 ? fg : {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
  const channel = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const background = (el) => {
    let node = el;
    while (node && node.nodeType === 1) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) return bg;
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const label = (el) => {
    if (el.id) return "#" + el.id;
    const cls = (el.className || "").toString().split(/\\s+/).filter(Boolean).slice(0, 2).join(".");
    return el.tagName.toLowerCase() + (cls ? "." + cls : "");
  };
  const found = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest(".hidden, .sr-only")) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
    if (!own) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || parseFloat(style.opacity) === 0) continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const fg = parse(style.color);
    if (!fg) continue;
    const bg = background(el);
    found.push({
      label: label(el),
      text: own.slice(0, 40),
      fontSize: parseFloat(style.fontSize),
      color: style.color,
      background: "rgb(" + Math.round(bg.r) + ", " + Math.round(bg.g) + ", " + Math.round(bg.b) + ")",
      contrast: Number(ratio(blend(fg, bg), bg).toFixed(2)),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      // Ellipsised text is a deliberate truncation, not a layout defect; only
      // report clipping where the stylesheet did not ask for it.
      clipped: style.textOverflow !== "ellipsis" && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1),
      // A child wider than the panel is fine when an ancestor clips it (that is
      // how the branch context line ellipsises); only unclipped overflow matters.
      overflowsViewport: (rect.right > window.innerWidth + 0.5 || rect.left < -0.5) && !(() => {
        let node = el.parentElement;
        while (node) {
          const overflow = getComputedStyle(node).overflowX;
          if (overflow !== "visible") return true;
          node = node.parentElement;
        }
        return false;
      })(),
    });
  }
  return found;
})()`;

const auditResults = [];

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        message.error ? reject(new Error(`${message.error.message} (${message.error.code})`)) : resolve(message.result);
      }
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), reject(new Error(`${method} timed out`))), 15000);
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
    return result.result?.value;
  }

  wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  render(state) {
    return this.evaluate(`window.postMessage(${JSON.stringify(state)}, "*"), true`);
  }

  /** Push a host->webview message, the same shape `window.postMessage` delivers. */
  post(message) {
    return this.evaluate(`window.postMessage(${JSON.stringify(message)}, "*"), true`);
  }

  /**
   * Rows are recreated on every render, so every interaction re-queries them by
   * hash instead of holding a node reference across a `render()`.
   */
  rowRect(index) {
    return this.evaluate(`(() => {
      const row = document.querySelectorAll(".commit")[${index}];
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, height: r.height, left: r.left };
    })()`);
  }

  async clickRow(index, { ctrl = false } = {}) {
    const rect = await this.rowRect(index);
    if (!rect) throw new Error(`row ${index} missing`);
    await this.evaluate(`(() => {
      const row = document.querySelectorAll(".commit")[${index}];
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: ${rect.x}, clientY: ${rect.y}, ctrlKey: ${ctrl} }));
    })()`);
  }

  async contextMenuRow(index) {
    const rect = await this.rowRect(index);
    if (!rect) throw new Error(`row ${index} missing`);
    await this.evaluate(`(() => {
      const row = document.querySelectorAll(".commit")[${index}];
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: ${rect.x}, clientY: ${rect.y} }));
    })()`);
  }

  async hoverRow(index) {
    const rect = await this.rowRect(index);
    if (!rect) throw new Error(`row ${index} missing`);
    await this.evaluate(`(() => {
      const row = document.querySelectorAll(".commit")[${index}];
      row.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, clientX: ${rect.x}, clientY: ${rect.y} }));
    })()`);
  }

  /** Press the grip of `from`, then move onto `to` so the drop marker paints. */
  async dragGrip(from, to) {
    const start = await this.evaluate(`(() => {
      const grip = document.querySelectorAll(".commit")[${from}]?.querySelector(".grip");
      if (!grip) return null;
      const r = grip.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    const target = await this.rowRect(to);
    if (!start || !target) throw new Error("drag endpoints missing");
    const pointer = (type, x, y) => `(() => {
      const el = document.elementFromPoint(${x}, ${y})?.closest(".commit")?.querySelector(".grip") || document.querySelectorAll(".commit")[${from}]?.querySelector(".grip");
      el.dispatchEvent(new PointerEvent("${type}", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: ${x}, clientY: ${y}, buttons: 1 }));
    })()`;
    await this.evaluate(pointer("pointerdown", start.x, start.y));
    await this.evaluate(pointer("pointermove", target.x, target.top + target.height * 0.75));
    await this.evaluate(pointer("pointermove", target.x, target.top + target.height * 0.75));
  }

  async typeSearch(text) {
    await this.evaluate(`(() => {
      const input = document.querySelector(".commit-search");
      input.focus();
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
  }
}

// ---------------------------------------------------------------- chrome

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error("Chrome not found; set CHROME_PATH");
  return found;
}

async function launchChrome(port, profile, url) {
  // The previous instance may still be releasing its profile when the next
  // theme starts; a stale directory is harmless, so failing to delete is not fatal.
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* chrome still exiting */ }
  const child = spawn(findChrome(), [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
    url,
  ], { stdio: "ignore" });
  // `/json/version` is the browser endpoint, which has no `Page` domain. The
  // page target's own socket is the one that can navigate and screenshot.
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return { child, webSocketDebuggerUrl: page.webSocketDebuggerUrl };
    } catch {
      // Chrome has not opened the port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error("Chrome did not expose a page target");
}

// ---------------------------------------------------------------- server

/**
 * Serve the three real assets plus one wrapper document. The wrapper adds the
 * `acquireVsCodeApi` stub before `main.js` runs and deliberately carries no CSP:
 * this is a local render harness, not the webview.
 */
/** The host stub has to be defined before either webview's own script runs. */
const HOST_STUB = `<script>
  window.__hostMessages = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (message) => { window.__hostMessages.push(message); },
    getState: () => window.__savedState,
    setState: (value) => { window.__savedState = value; },
  });
</script>`;

function buildDocument(markup, theme) {
  const variables = Object.entries(theme).map(([k, v]) => `${k}: ${v};`).join("\n");
  if (surface === "compose") {
    // The panel ships its styles and controller inline; the variables have to be
    // declared before them so `var(--vscode-*)` resolves during first paint.
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>:root{${variables}}</style>
<style>${markup.style}</style>${HOST_STUB}</head><body>${markup.body}</body></html>`;
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>:root{${variables}} html,body{height:100%}</style>
<link rel="stylesheet" href="/style.css"></head><body>
${HOST_STUB}
${markup.body}
<script src="/main.js"></script>
</body></html>`;
}

function startServer(html, assets) {
  const server = http.createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
    } else if (assets[request.url]) {
      const [content, type] = assets[request.url];
      response.writeHead(200, { "content-type": `${type}; charset=utf-8` });
      response.end(content);
    } else {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

// ---------------------------------------------------------------- main

async function renderTheme(themeName, chromePort, profile, defaults) {
  const isCompose = surface === "compose";
  const theme = themeVariables(themeName, defaults);
  const markup = isCompose ? readComposeDocument() : { body: readWebviewBody() };
  const missing = unresolvedTokens(theme, isCompose ? markup.style : null);
  if (missing.length) console.warn(`  ! ${themeName}: unresolved ${missing.join(", ")} — those fall back to the CSS defaults`);
  const assets = isCompose ? {} : {
    "/style.css": [fs.readFileSync(path.join(root, "media/style.css")), "text/css"],
    "/main.js": [fs.readFileSync(path.join(root, "media/main.js")), "text/javascript"],
  };
  const { server, port } = await startServer(buildDocument(markup, theme), assets);
  const { child, webSocketDebuggerUrl } = await launchChrome(chromePort, profile, `http://127.0.0.1:${port}/`);

  try {
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => Object.assign(socket, { onopen: resolve, onerror: reject }));
    const cdp = new Cdp(socket);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    // A sidebar-sized viewport at 2x, so text is judged at the size users see.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      // The compose panel opens as an editor and gets the editor's width.
      width: isCompose ? 900 : viewportWidth,
      height: 720,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await cdp.wait(200);

    for (let attempt = 0; attempt < 100; attempt++) {
      const ready = await cdp.evaluate("Array.isArray(window.__hostMessages) && window.__hostMessages.some((m) => m.type === 'ready')").catch(() => false);
      if (ready) break;
      await cdp.wait(50);
    }

    const activeScenarios = isCompose ? composeScenarios : scenarios;
    const names = Object.keys(activeScenarios).filter((name) => !only.length || only.includes(name));
    for (const name of names) {
      // Reload between scenarios: every scenario starts from a clean document,
      // so one scenario's state or open menu cannot leak into the next.
      await cdp.send("Page.reload");
      await cdp.wait(150);
      for (let attempt = 0; attempt < 100; attempt++) {
        const ready = await cdp.evaluate("Array.isArray(window.__hostMessages) && window.__hostMessages.some((m) => m.type === 'ready')").catch(() => false);
        if (ready) break;
        await cdp.wait(50);
      }
      await activeScenarios[name](cdp);
      await cdp.wait(80);
      if (args.includes("--audit")) auditResults.push({ theme: themeName, scenario: name, elements: await cdp.evaluate(AUDIT_PROBE) });
      if (args.includes("--debug-style") && name === "menu") {
        console.log("  menu-fit:", JSON.stringify(await cdp.evaluate(`(() => {
          const menu = document.getElementById("menu");
          const r = menu.getBoundingClientRect();
          return { innerWidth: window.innerWidth, menuWidth: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right), overflows: r.right > window.innerWidth };
        })()`)));
      }
      if (args.includes("--debug-style") && name === "list-idle") {
        // A token that fails to resolve makes its declaration invalid at
        // computed-value time, which looks like "the CSS is missing" rather
        // than "the harness forgot a variable". Print the resolved values.
        const probe = await cdp.evaluate(`(() => {
          const root = getComputedStyle(document.documentElement);
          const dot = document.querySelector(".commit .dot");
          const style = getComputedStyle(dot);
          return {
            chartsBlue: root.getPropertyValue("--vscode-charts-blue").trim(),
            editorBackground: root.getPropertyValue("--vscode-editor-background").trim(),
            dotClass: dot.className,
            dotColor: style.color,
            dotBackground: style.backgroundColor,
            dotWidth: style.width,
            bodyBackground: getComputedStyle(document.body).backgroundColor,
            bodyColor: getComputedStyle(document.body).color,
          };
        })()`);
        console.log("  debug:", JSON.stringify(probe));
      }
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const file = path.join(outDir, isCompose ? `compose-${themeName}` : themeName, `${name}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
      console.log(`  ${path.relative(outDir, file)}`);
    }
    socket.close();
  } finally {
    child.kill();
    server.close();
  }
}

const main = async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const defaults = readColorDefaults();
  for (const [index, themeName] of themes.entries()) {
    console.log(`${themeName}:`);
    await renderTheme(themeName, 9411 + index, path.join(outDir, `.chrome-profile-${themeName}`), defaults);
  }
  if (auditResults.length) {
    fs.writeFileSync(path.join(outDir, "audit.json"), JSON.stringify(auditResults, null, 2));
    const all = auditResults.flatMap((shot) => shot.elements.map((el) => ({ ...el, theme: shot.theme, scenario: shot.scenario })));
    // WCAG AA: 4.5:1 for body text, 3:1 for large text (>=18.66px bold or >=24px).
    const below = all.filter((el) => el.contrast < (el.fontSize >= 24 ? 3 : 4.5));
    const clipped = all.filter((el) => el.clipped);
    const overflowing = all.filter((el) => el.overflowsViewport);
    console.log(`\nAudit: ${all.length} text nodes · ${below.length} below AA · ${clipped.length} clipped · ${overflowing.length} overflowing the panel`);
  }
  console.log(`\nWrote screenshots to ${outDir}`);
};

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
