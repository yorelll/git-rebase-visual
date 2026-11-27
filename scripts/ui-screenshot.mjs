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
 *                                  [--width N] [--height N] [--audit] [--probe]
 *                                  [--debug-style]
 *
 * `--probe` writes `probe.json` from the `window.__probe` object the
 * focus-refresh / kbd-focus-loss / live-mutation / error-keyboard scenarios
 * fill in. Those scenarios assert behaviour (focus survival, reorder count,
 * mutation count, keyboard scrolling), which a PNG cannot show.
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
// Each theme gets its own debug port; the base is randomised per process so two
// renders can run side by side (before/after comparisons, a reviewer's harness).
const portBase = Number(flag("port", String(9000 + Math.floor(Math.random() * 900))));
// VS Code's default sidebar is 300px; 340 leaves room for a wider panel.
const viewportWidth = Number(flag("width", "340"));
// The height matters to the banner bound (`45vh`) and to whether a scrolled
// action stays inside both the banner's scrollport and the window.
const viewportHeight = Number(flag("height", "720"));

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
 * C4: a real Git failure is a multi-sentence diagnostic, not a one-liner. Eight
 * repeated sentences are ~900 UTF-16 characters of CJK, which is what pushed the
 * commit list below the fold before `.banner` grew a height bound.
 */
const LONG_ERROR = Array.from({ length: 8 }, (_, i) =>
  `第${i + 1}段：无法把提交应用到当前分支，因为冲突文件中的冲突标记仍未解决，并且工作区里的另一个文件已被外部进程改写；请逐行检查冲突，保留需要的改动，执行暂存之后重试继续，或者选择中止放弃本次变基并保留现场，确认无误后再继续下一步。`
).join("\n");

/**
 * C4's action-bearing case: the conflict banner renders `conflictFiles` as one
 * joined sentence, so thirty realistically long paths reproduce the same
 * overflow while Continue / Skip / Abort remain part of the banner.
 */
const LONG_CONFLICT_FILES = Array.from({ length: 30 }, (_, i) =>
  `src/modules/generated/section-${i}/internal/rate-conversion-table-${i}.ts`
);

/**
 * C5 state shared by the resting and hovered scenarios. `pendingHashes` marks
 * the commits a paused replay has not applied yet; the list draws the boundary
 * row and the `*（待重放）` meta suffix from it. The stop is parked on a replayed
 * commit so every pending row keeps the plain list background at rest.
 */
const pendingState = {
  ...baseState,
  // The changes section is unrelated to C5 and would push the pending rows
  // below the fold; keep the surface compact so the screenshot shows the
  // normal and pending rows side by side.
  changes: [],
  hasStaged: false,
  hasUnstaged: false,
  stagedCount: 0,
  unstagedCount: 0,
  rebaseInProgress: true,
  conflictCount: 0,
  pausedReason: "edit",
  stoppedAt: commits[2].hash,
  totalSteps: 8,
  completedSteps: 3,
  pendingHashes: [commits[3].hash, commits[4].hash, commits[5].hash],
};

/**
 * Each scenario drives the webview through the same entry points the host uses
 * (`postMessage`) or the same events the user generates, then the caller
 * screenshots whatever is on screen. Nothing here reaches into internal state.
 */
const scenarios = {
  "list-idle": async (page) => {
    await page.render(baseState);
  },

  /**
   * C4: the error path from `renderBanner()` paints `state.error` as one text
   * node. A paused rebase is deliberately not part of this state: the defect is
   * that the plain error banner has no height bound, so the commit list gets
   * whatever vertical space is left.
   */
  "error-long": async (page) => {
    if (LONG_ERROR.length < 850 || LONG_ERROR.length > 950) {
      throw new Error(`error-long fixture drifted: ${LONG_ERROR.length} chars`);
    }
    await page.render({ ...baseState, error: LONG_ERROR });
  },

  /**
   * C5: `pendingHashes` marks the commits a paused replay has not applied yet;
   * the list draws the boundary row and the `*（待重放）` meta suffix from it.
   * The stop is parked on a replayed commit so every pending row keeps the
   * plain list background, which is the surface the opacity is measured on.
   */
  pending: async (page) => {
    await page.render(pendingState);
    await page.wait(150);
  },

  /**
   * C5's adjacent state: the hovered pending row. `.commit:hover` paints
   * `list-hoverBackground`, which is lighter than the resting row; at the
   * resting pending opacity the meta line falls below AA there. A real CDP
   * pointer move is required because a synthetic `mouseenter` does not make
   * `:hover` match.
   */
  "pending-hover": async (page) => {
    await page.render(pendingState);
    const rect = await page.rowRect(4);
    if (!rect) throw new Error("pending row 4 missing");
    await page.mouseMove(rect.x, rect.y);
    await page.wait(150);
  },

  /**
   * K3: a selected row at rest. The selection surface is dimmer than the list,
   * so the meta line was below AA there even though the subject passed.
   */
  selected: async (page) => {
    await page.render(baseState);
    await page.wait(120);
    await page.clickRow(3, { ctrl: true });
    await page.wait(180);
    windowProbe(page, `(() => {
      const row = document.querySelector(".commit.selected");
      return row ? { rowClass: row.className, meta: ${textStyleExpression(".commit.selected .commit-meta")} } : null;
    })()`);
  },

  /**
   * K3: the pending row is also selected. `.commit.pending { opacity: .8 }` is a
   * group opacity, so the raw colour and the effective contrast disagree; the
   * probe records both and the test gate uses the effective one.
   */
  "pending-selected": async (page) => {
    await page.render(pendingState);
    await page.wait(120);
    const rect = await page.rowRect(4);
    if (!rect) throw new Error("pending row 4 missing");
    await page.clickRow(4, { ctrl: true });
    await page.wait(180);
    windowProbe(page, `(() => {
      const row = document.querySelector(".commit.selected");
      return row ? { rowClass: row.className, selected: row.classList.contains("selected"), pending: row.classList.contains("pending"), meta: ${textStyleExpression(".commit.selected .commit-meta")} } : null;
    })()`);
  },

  /**
   * C4's second half: the banner that carries Continue / Skip / Abort can be
   * made just as tall by a long conflict-file list. `.banner` is the same box,
   * so the bound and the internal scroll have to keep those actions reachable,
   * not only keep the list visible.
   */
  "rebase-long": async (page) => {
    await page.render({
      ...baseState,
      rebaseInProgress: true,
      conflictCount: LONG_CONFLICT_FILES.length,
      conflictFiles: LONG_CONFLICT_FILES,
      totalSteps: 8,
      completedSteps: 3,
      pausedReason: "conflict",
      stoppedAt: commits[4].hash,
    });
    await page.wait(150);
  },

  tooltip: async (page) => {
    await page.render(baseState);
    await page.hoverRow(3);
    await page.wait(500);
    await page.post({ type: "detail", hash: commits[3].hash, author: "lawrence", relDate: "4 hours ago", absDate: "today", stat: "3 files changed, 42 insertions(+), 7 deletions(-)", message: subjects[3] + "\n\nExplains why the boundary is where it is, and what happens\nwhen the source rate lands exactly on a tick." });
    await page.wait(200);
  },

  /**
   * K1: the menu is wider than a narrow sidebar. The probe records the geometry
   * (menu versus viewport), the label/shortcut split, and whether the full action
   * survives truncation as an accessible name.
   */
  menu: async (page) => {
    await page.render(baseState);
    await page.contextMenuRow(3);
    await page.wait(200);
    windowProbe(page, `(() => {
      const menu = document.getElementById("menu");
      const rect = menu.getBoundingClientRect();
      return {
        viewport: window.innerWidth,
        menuWidth: Math.round(rect.width),
        menuLeft: Math.round(rect.left),
        menuRight: Math.round(rect.right),
        overflows: rect.right > window.innerWidth + 0.5 || rect.left < -0.5,
        items: [...menu.querySelectorAll("button.item")].map((item) => {
          const label = item.querySelector(".menu-label") || item.children[1];
          const kbd = item.querySelector("kbd");
          const labelStyle = label ? getComputedStyle(label) : null;
          const kbdRect = kbd ? kbd.getBoundingClientRect() : null;
          const itemRect = item.getBoundingClientRect();
          return {
            text: item.textContent.trim(),
            action: item.getAttribute("aria-label"),
            title: item.title,
            label: label ? label.textContent.trim() : null,
            labelTruncated: !!label && label.scrollWidth > label.clientWidth + 1,
            labelEllipsis: labelStyle ? labelStyle.textOverflow : null,
            labelOverflow: labelStyle ? labelStyle.overflow : null,
            kbdRightAligned: !!kbdRect && !!itemRect.width && kbdRect.right >= itemRect.right - 12,
            kbdWidth: kbdRect ? Math.round(kbdRect.width) : null,
          };
        }),
      };
    })()`);
  },

  "menu-batch": async (page) => {
    await page.render(baseState);
    // The real pointer keeps its last position across `Page.reload`, so a
    // scenario that ran earlier can leave it hovering a row and change what
    // this audit sees. Park it on the branch-context strip, which has no hover
    // handler, so the batch menu is always rendered from the same state.
    await page.mouseMove(1, 1);
    await page.clickRow(3, { ctrl: true });
    await page.clickRow(4, { ctrl: true });
    await page.contextMenuRow(4);
    await page.wait(200);
  },

  /**
   * The three scenarios below need the browser's own pointer handling: a
   * synthetic `mouseenter`/`contextmenu` does not make `:hover` or
   * `:focus-visible` match, so they would audit the idle colours and report a
   * passing contrast for a state the user never sees. CDP `Input.*` injects
   * trusted input, exactly like a real pointer.
   */
  "menu-hover": async (page) => {
    await page.render(baseState);
    await page.rightClickRow(3);
    await page.wait(200);
    // The shortcut-bearing item is the one whose `kbd` sits beside a grey icon;
    // it is the row that V1/C1 are about.
    await page.mouseMoveToMenuItem("shortcut");
    await page.wait(120);
  },

  "menu-hover-danger": async (page) => {
    await page.render(baseState);
    await page.rightClickRow(3);
    await page.wait(200);
    await page.mouseMoveToMenuItem("danger");
    await page.wait(120);
  },

  "menu-real": async (page) => {
    await page.render(baseState);
    // A real right click opens the menu and moves focus to its first item.
    // Nothing else is moved: whatever paint is on screen must come from the
    // pointer, not from the programmatic focus.
    await page.rightClickRow(3);
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
    await page.wait(120);
    // K3: the stopped row paints `list-activeSelectionBackground`, where the
    // shared description colour also missed AA.
    windowProbe(page, `(() => {
      const row = document.querySelector(".commit.stopped");
      return row ? { rowClass: row.className, meta: ${textStyleExpression(".commit.stopped .commit-meta")} } : null;
    })()`);
  },

  empty: async (page) => {
    await page.render({ ...baseState, commits: [], canonicalOrder: [], hasStaged: false, hasUnstaged: false, changes: [] });
  },

  filter: async (page) => {
    await page.render(baseState);
    await page.typeSearch("cif");
    await page.wait(150);
    // The page renders its own 清除 button after the input. A real Tab from the
    // focused search box proves it is still in the tab order now that the
    // native `::-webkit-search-cancel-button` is hidden. Shift+Tab returns to
    // the input so the screenshot still shows the typing state; the probe reads
    // the recorded result.
    await page.tabTo(".list-controls .btn");
    await page.evaluate(`document.body.dataset.harnessClearTabbable = "true"`);
    await page.tabTo(".commit-search", { after: "[...document.querySelectorAll('.list-controls .btn')][0]", shift: true });
    // Tabbing into a text field selects its contents; collapse the selection to
    // the end so the screenshot shows the same typing state as the other runs.
    await page.evaluate(`(() => { const input = document.querySelector(".commit-search"); input.setSelectionRange(input.value.length, input.value.length); return true; })()`);
    await page.wait(120);
  },

  /**
   * The change list lives inside a collapsed `<details>`; until it is open the
   * M/A/D/R markers are not rendered at all, so a contrast audit of the change
   * list has to open it the way a pointer click does. The rename row is added
   * here rather than to `baseState` so the other scenarios keep their node set.
   */
  "more-options": async (page) => {
    await page.render({
      ...baseState,
      changes: [
        ...baseState.changes,
        { path: "src/cif/rate-table.ts", indexKind: "rename", worktreeKind: "rename", staged: true, unstaged: false },
      ],
    });
    await page.wait(150);
    const open = await page.evaluate(`(() => {
      const more = document.querySelector("#changes details.changes-more");
      if (!more) return null;
      more.open = true;
      more.dispatchEvent(new Event("toggle"));
      return more.open;
    })()`);
    if (open !== true) throw new Error("changes-more did not open");
    await page.wait(150);
  },

  /**
   * C3: primary and secondary buttons under real keyboard focus. `element.focus()`
   * alone can leave `:focus-visible` false (the browser remembers that the last
   * interaction was a pointer), so the focus is moved with CDP `Tab` presses and
   * the scenario fails if the target never becomes the active element.
   */
  "focus-btn": async (page) => {
    await page.render({
      ...baseState,
      rebaseInProgress: true,
      conflictCount: 0,
      pausedReason: "edit",
      stoppedAt: commits[3].hash,
      totalSteps: 8,
      completedSteps: 3,
    });
    await page.wait(200);
    await page.tabTo(".banner .edit-actions .btn.primary");
    await page.wait(120);
  },

  /**
   * N3: the stopped row owns an `editorInfo` outline for its state. That rule
   * comes after the shared `:focus-visible` one, so the keyboard ring inherited
   * the state colour instead of the focus colour. A real Tab marks it
   * `:focus-visible`; the interaction probe then reads the painted outline.
   */
  "focus-stopped": async (page) => {
    await page.render({
      ...baseState,
      rebaseInProgress: true,
      conflictCount: 0,
      pausedReason: "edit",
      stoppedAt: commits[3].hash,
      totalSteps: 8,
      completedSteps: 3,
    });
    await page.wait(180);
    // The stopped row is not the roving tab stop, so Tab would skip it. A real
    // Tab establishes keyboard modality (making the following programmatic focus
    // match `:focus-visible`), then the row is focused directly.
    await page.pressTab();
    await page.evaluate(`document.querySelector(".commit.stopped").focus(); true`);
    await page.wait(120);
    const focused = await page.evaluate(`document.activeElement?.matches(".commit.stopped:focus-visible") === true`);
    if (!focused) throw new Error("the stopped row never matched :focus-visible");
  },

  /** The secondary control lives in the tooltip, which is the tightest container. */
  "focus-btn-secondary": async (page) => {
    await page.render(baseState);
    await page.hoverRow(3);
    await page.wait(500);
    await page.post({ type: "detail", hash: commits[3].hash, author: "lawrence", relDate: "4 hours ago", absDate: "today", stat: "3 files changed, 42 insertions(+), 7 deletions(-)", message: subjects[3] + "\n\nExplains why the boundary is where it is, and what happens\nwhen the source rate lands exactly on a tick." });
    await page.wait(200);
    // Start one focusable before the tooltip so a single real Tab lands on it.
    await page.tabTo(".tooltip .tip-actions .btn", { after: "[...document.querySelectorAll('.commit')].at(-1)" });
    await page.wait(120);
  },
};

// ------------------------------------------------------- refresh/focus probes

/**
 * The four scenarios below measure what a screenshot cannot: whether a 1.5s
 * refresh keeps keyboard focus, how many reorder messages two Alt+↓ presses
 * produce, how many DOM mutations an identical poll causes, and whether the
 * bounded error banner can be scrolled with the keyboard. `window.__probe` is
 * read into `probe.json` when the harness is run with `--probe`.
 */
/** Assign an expression's value to `window.__probe` so `--probe` records it. */
function windowProbe(page, expression) {
  return page.evaluate(`window.__probe = ${expression}; true`);
}

/**
 * The text-node metric the audit reports, as an expression that can be embedded
 * in a larger probe object. It returns both the raw contrast and the effective
 * contrast after every ancestor `opacity`, because a pending row is dimmed by a
 * group opacity and only the effective value is what the user sees.
 */
function textStyleExpression(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
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
    const background = (node) => {
      for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
        const bg = parse(getComputedStyle(current).backgroundColor);
        if (bg && bg.a > 0) return bg;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const opacity = (node) => {
      let alpha = 1;
      for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
        const value = parseFloat(getComputedStyle(current).opacity);
        if (!Number.isNaN(value)) alpha *= value;
      }
      return alpha;
    };
    const fg = parse(getComputedStyle(el).color);
    const bg = background(el);
    const groupOpacity = opacity(el);
    return {
      text: el.textContent.trim().slice(0, 48),
      color: getComputedStyle(el).color,
      background: "rgb(" + Math.round(bg.r) + ", " + Math.round(bg.g) + ", " + Math.round(bg.b) + ")",
      opacity: Number(groupOpacity.toFixed(3)),
      contrast: Number(ratio(blend(fg, bg), bg).toFixed(2)),
      effectiveContrast: Number(ratio(blend({ ...fg, a: fg.a * groupOpacity }, bg), bg).toFixed(2)),
    };
  })()`;
}

async function pressKey(page, key, code, vk, modifiers = 0) {
  // Enter needs its text payload for Chromium to run a focused button's
  // default activation; arrows and PageDown are fine without one.
  const text = key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {};
  const event = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, ...text };
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...event });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
}

const ACTIVE_SNAPSHOT = `(() => {
  const a = document.activeElement;
  // data-path/data-group live on the .change-file ancestor, not on the focused
  // button; read the row so a change-action snapshot reports its real scope.
  const changeRow = a && a.closest ? a.closest(".change-file") : null;
  const lockedRun = a && a.closest ? a.closest("details.locked-run") : null;
  return {
    tag: a ? a.tagName : null,
    id: a ? a.id : null,
    cls: a ? (a.className || "").toString().trim().replace(/\\s+/g, ".") : null,
    hash: a && a.dataset ? (a.dataset.hash || null) : null,
    path: changeRow ? (changeRow.dataset.path || null) : null,
    group: changeRow ? (changeRow.dataset.group || null) : null,
    action: a && a.dataset ? (a.dataset.action || null) : null,
    lockedRun: lockedRun ? (lockedRun.dataset.lockedRun || null) : null,
    isBody: a === document.body,
    hasFocus: document.hasFocus(),
  };
})()`;

const installRecord = (page) => page.evaluate(`window.__probe = { steps: [] };
  window.__probeRecord = (label) => window.__probe.steps.push({ label, ...${ACTIVE_SNAPSHOT} });
  true`);

scenarios["focus-refresh"] = async (page) => {
  const state = { ...baseState };
  await page.render(state);
  await page.wait(150);
  await installRecord(page);
  // Focus a non-first row directly. With the roving tabindex there is only one
  // commit tab stop, so a Tab from an arbitrary row leaves the list (the
  // `tab-order` probe covers that path); what this scenario measures is the
  // identity restoration across a rebuild, which must work for any row.
  await page.evaluate(`document.querySelectorAll(".commit")[5].focus(); window.__probeRecord("commitRowFocused"); true`);
  // The exact defect: an identical state used to rebuild #list and drop focus.
  await page.render(state);
  await page.wait(120);
  await page.evaluate(`window.__probeRecord("afterStateRefresh"); true`);
  // A genuine list change rebuilds the rows; focus must be re-found by hash.
  const changed = { ...state, commits: state.commits.map((commit, index) => index === 0 ? { ...commit, subject: commit.subject + " (updated)" } : commit) };
  await page.render(changed);
  await page.wait(120);
  await page.evaluate(`window.__probeRecord("afterChangedStateRefresh"); true`);

  // The search box keeps its own selection restore.
  await page.evaluate(`document.querySelector(".commit-search").focus(); window.__probeRecord("searchFocused"); true`);
  await page.render(changed);
  await page.wait(120);
  await page.evaluate(`window.__probeRecord("afterSameStateSearchRefresh"); true`);

  // A change row and its open-diff button: identity is path + group.
  await page.evaluate(`(() => { const more = document.querySelector("#changes details.changes-more"); if (more) { more.open = true; more.dispatchEvent(new Event("toggle")); } return true; })()`);
  await page.wait(100);
  await page.evaluate(`document.querySelector(".file-open").focus(); window.__probeRecord("fileOpenFocused"); true`);
  await page.render({ ...changed, stagedCount: (changed.stagedCount || 0) + 1 });
  await page.wait(120);
  await page.evaluate(`window.__probeRecord("afterChangedStateFileOpenRefresh"); true`);

  // A banner action survives a real banner-content change (progress advances).
  const editState = { ...state, rebaseInProgress: true, conflictCount: 0, pausedReason: "edit", stoppedAt: commits[3].hash, totalSteps: 8, completedSteps: 3 };
  await page.render(editState);
  await page.wait(150);
  await page.evaluate(`(() => { const b = [...document.querySelectorAll("#banner .btn")].find((el) => el.textContent.trim() === "Continue"); b.focus(); window.__probeRecord("bannerButtonFocused"); return true; })()`);
  await page.render(editState);
  await page.wait(120);
  await page.evaluate(`window.__probeRecord("afterSameStateBannerRefresh"); true`);
  await page.render({ ...editState, completedSteps: 4 });
  await page.wait(120);
  await page.evaluate(`window.__probeRecord("afterChangedStateBannerRefresh"); true`);
};

scenarios["kbd-focus-loss"] = async (page) => {
  await page.render(baseState);
  await page.wait(150);
  await page.evaluate(`window.__probe = { steps: [] };
    window.__probeSnapshot = (label) => {
      window.__probe.steps.push({ label, ...${ACTIVE_SNAPSHOT} });
      window.__probe.reorders = window.__hostMessages.filter((message) => message.type === "reorder")
        .map((message) => ({ sourceHash: message.sourceHash, anchorHash: message.anchorHash, placement: message.placement }));
    };
    document.querySelectorAll(".commit")[4].focus();
    true`);
  await page.evaluate(`window.__probeSnapshot("before"); true`);
  await pressKey(page, "ArrowDown", "ArrowDown", 40, 1);
  await page.wait(200);
  await page.evaluate(`window.__probeSnapshot("afterAltDown1"); true`);
  // On the old webview the first renderList() dropped focus to <body>, so this
  // second key press never reached a row and produced no second reorder.
  await pressKey(page, "ArrowDown", "ArrowDown", 40, 1);
  await page.wait(200);
  await page.evaluate(`window.__probeSnapshot("afterAltDown2"); true`);
  // Ctrl+Space multi-select also rerenders the list, and used to drop focus.
  await page.evaluate(`document.querySelectorAll(".commit")[3].focus(); true`);
  await pressKey(page, " ", "Space", 32, 2);
  await page.wait(200);
  await page.evaluate(`window.__probeSnapshot("afterCtrlSpace"); true`);
};

scenarios["live-mutation"] = async (page) => {
  const state = { ...baseState, rebaseInProgress: true, conflictCount: 0, pausedReason: "edit", stoppedAt: commits[3].hash, totalSteps: 8, completedSteps: 3 };
  await page.render(state);
  await page.wait(150);
  await page.evaluate(`window.__probe = {};
    window.__probeObserve = () => {
      window.__mutations = { banner: 0, list: 0, direction: 0, context: 0, changes: 0 };
      const observe = (id, key) => {
        const el = document.getElementById(id);
        if (!el) return;
        new MutationObserver((records) => { window.__mutations[key] += records.length; }).observe(el, { childList: true, subtree: true, characterData: true });
      };
      observe("banner", "banner"); observe("list", "list"); observe("direction", "direction"); observe("context-text", "context"); observe("changes", "changes");
    };
    window.__probeObserve();
    window.__probeTexts = {
      banner: document.getElementById("banner").textContent,
      list: document.getElementById("list").textContent,
      direction: document.getElementById("direction").textContent,
    };
    true`);
  await page.render(state);
  await page.wait(250);
  await page.evaluate(`window.__probe.sameState = {
    mutations: window.__mutations,
    textsUnchanged: {
      banner: document.getElementById("banner").textContent === window.__probeTexts.banner,
      list: document.getElementById("list").textContent === window.__probeTexts.list,
      direction: document.getElementById("direction").textContent === window.__probeTexts.direction,
    },
    bannerLive: document.getElementById("banner").getAttribute("aria-live"),
    bannerRole: document.getElementById("banner").getAttribute("role"),
  }; true`);
  // An equivalent state differs only in a field the panel does not paint. It
  // must not churn the regions either.
  await page.evaluate(`window.__probeObserve(); true`);
  await page.render({ ...state, undoAvailable: !state.undoAvailable });
  await page.wait(250);
  await page.evaluate(`window.__probe.equivalentState = {
    mutations: window.__mutations,
    textsUnchanged: {
      banner: document.getElementById("banner").textContent === window.__probeTexts.banner,
      list: document.getElementById("list").textContent === window.__probeTexts.list,
      direction: document.getElementById("direction").textContent === window.__probeTexts.direction,
    },
  }; true`);
};

scenarios["error-keyboard"] = async (page) => {
  await page.render({ ...baseState, error: LONG_ERROR });
  await page.wait(250);
  await page.evaluate(`window.__probe = {};
    window.__probeBanner = () => {
      const banner = document.getElementById("banner");
      const style = getComputedStyle(banner);
      return {
        tabIndex: banner.tabIndex,
        hasTabIndexAttribute: banner.hasAttribute("tabindex"),
        scrollHeight: banner.scrollHeight,
        clientHeight: banner.clientHeight,
        scrollTop: banner.scrollTop,
        maxHeight: style.maxHeight,
        overflowY: style.overflowY,
        focusVisible: banner.matches(":focus-visible"),
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineColor: style.outlineColor,
        active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
        documentScrollTop: document.scrollingElement.scrollTop,
      };
    };
    window.__probe.long = window.__probeBanner();
    true`);
  await page.evaluate(`document.getElementById("banner").focus(); true`);
  await page.wait(80);
  await page.evaluate(`window.__probe.long.afterFocus = window.__probeBanner(); true`);
  await pressKey(page, "PageDown", "PageDown", 34);
  await page.wait(250);
  await page.evaluate(`window.__probe.long.afterPageDown = window.__probeBanner(); true`);
  // A short error fits: the banner must not become a tab stop.
  await page.render({ ...baseState, error: "fatal: a short failure" });
  await page.wait(200);
  await page.evaluate(`window.__probe.short = window.__probeBanner(); true`);
};

/** A collapsed run of the three locked commits at the top of `baseState`. */
scenarios["locked-run-focus"] = async (page) => {
  const collapsed = { ...baseState, collapseLockedRuns: true };
  await page.render(collapsed);
  await page.wait(150);
  await installRecord(page);
  await page.evaluate(`(() => { const summary = document.querySelector("details.locked-run > summary"); if (!summary) return false; summary.focus(); window.__probe.lockedRun = summary.closest("details").dataset.lockedRun; return true; })()`);
  await page.evaluate(`window.__probeRecord("lockedRunSummaryFocused"); true`);
  // Appending a commit rebuilds #list (and therefore the <details>/<summary>)
  // without changing the locked run's own hash list.
  const extra = { ...baseState.commits[7], hash: "9".repeat(40), shortHash: "9".repeat(8), subject: "chore: force a list rebuild" };
  await page.render({ ...collapsed, commits: [...collapsed.commits, extra], canonicalOrder: [...collapsed.canonicalOrder, extra.hash] });
  await page.wait(150);
  await page.evaluate(`window.__probeRecord("afterListRebuild"); true`);
  await page.evaluate(`window.__probe.summaryStillExists = !!document.querySelector("details.locked-run > summary"); true`);
};

/** A focused locked run disappears while an unrelated run survives. */
scenarios["locked-run-missing"] = async (page) => {
  const twoRuns = {
    ...baseState,
    collapseLockedRuns: true,
    // Two runs (indices 0-2 and 4-6) separated by one unlocked commit.
    commits: baseState.commits.map((commit, index) => ({ ...commit, locked: [0, 1, 2, 4, 5, 6].includes(index) })),
  };
  await page.render(twoRuns);
  await page.wait(150);
  await installRecord(page);
  await page.evaluate(`(() => { const summaries = document.querySelectorAll("details.locked-run > summary"); if (summaries.length < 2) return false; summaries[1].focus(); return true; })()`);
  await page.evaluate(`window.__probeRecord("secondRunFocused"); true`);
  const oneRun = { ...twoRuns, commits: twoRuns.commits.map((commit, index) => ({ ...commit, locked: index < 3 })) };
  await page.render(oneRun);
  await page.wait(150);
  await page.evaluate(`window.__probeRecord("afterRunRemoved"); true`);
  await page.evaluate(`window.__probe.remainingRuns = document.querySelectorAll("details.locked-run").length; true`);
};

/** Continue becomes disabled when the paused rebase gains conflicts. */
scenarios["disabled-action-focus"] = async (page) => {
  const editState = { ...baseState, rebaseInProgress: true, conflictCount: 0, pausedReason: "edit", stoppedAt: commits[3].hash, totalSteps: 8, completedSteps: 3 };
  await page.render(editState);
  await page.wait(150);
  await installRecord(page);
  await page.evaluate(`(() => { const b = [...document.querySelectorAll("#banner .btn")].find((el) => el.textContent.trim() === "Continue"); b.focus(); return true; })()`);
  await page.evaluate(`window.__probeRecord("continueFocused"); true`);
  // The same action now exists but is disabled; focus must not silently fall
  // to <body>. A sibling banner action is the same-region fallback.
  await page.render({ ...editState, conflictCount: 2, conflictFiles: ["src/cif/rate.ts", "src/sensor/table.ts"], pausedReason: "conflict" });
  await page.wait(150);
  await page.evaluate(`window.__probe.continueDisabled = (() => { const b = [...document.querySelectorAll("#banner .btn")].find((el) => el.textContent.trim() === "Continue"); return !!b && b.disabled; })(); true`);
  await page.evaluate(`window.__probeRecord("afterContinueDisabled"); true`);
};

// ------------------------------------------------------- semantics probes

/**
 * Chrome's accessibility tree for one element and its direct children. The DOM
 * probes above can read attributes, but they cannot prove what a screen reader
 * is actually handed: `role="listbox"` on a node whose children are a search
 * box and two labels looks correct in `getAttribute` and wrong here.
 */
async function axSnapshot(page, selector) {
  await page.send("DOM.enable");
  await page.send("Accessibility.enable");
  const { root } = await page.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) return { found: false, selector };
  const { node } = await page.send("DOM.describeNode", { nodeId });
  const { nodes } = await page.send("Accessibility.getFullAXTree");
  const target = nodes.find((candidate) => candidate.backendDOMNodeId === node.backendNodeId);
  if (!target) return { found: false, selector };
  const summarize = (axNode) => ({
    role: axNode.role?.value ?? null,
    name: axNode.name?.value ?? null,
    description: axNode.description?.value ?? null,
    ignored: !!axNode.ignored,
    properties: Object.fromEntries((axNode.properties || [])
      .filter((property) => ["multiselectable", "selected", "focusable", "disabled", "expanded"].includes(property.name))
      .map((property) => [property.name, property.value?.value])),
  });
  const children = nodes.filter((candidate) => candidate.parentId === target.nodeId && !candidate.ignored);
  return {
    found: true,
    selector,
    node: summarize(target),
    childRoles: children.map((child) => child.role?.value ?? null),
    children: children.slice(0, 14).map(summarize),
    optionCount: nodes.filter((candidate) => candidate.role?.value === "option" && !candidate.ignored).length,
    groupNodes: nodes.filter((candidate) => candidate.role?.value === "group" && !candidate.ignored).map(summarize).slice(0, 6),
  };
}

/**
 * N2(b): what Tab actually visits, in order, from the top of the document. The
 * change list is opened first so the N6 dead stops are part of the count.
 */
scenarios["tab-order"] = async (page) => {
  await page.render(baseState);
  await page.wait(150);
  await page.evaluate(`(() => {
    const more = document.querySelector("#changes details.changes-more");
    if (more) { more.open = true; more.dispatchEvent(new Event("toggle")); }
    return true;
  })()`);
  await page.wait(120);
  const snapshot = `(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return { body: true };
    const changeRow = a.closest ? a.closest(".change-file") : null;
    return {
      tag: a.tagName,
      id: a.id || null,
      cls: (a.className || "").toString().trim().replace(/\\s+/g, "."),
      role: a.getAttribute("role") || null,
      name: (a.getAttribute("aria-label") || a.title || a.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80),
      tabIndex: a.tabIndex,
      commitHash: a.dataset ? (a.dataset.hash || null) : null,
      changeRow: changeRow ? (changeRow.dataset.path || null) : null,
      fileAction: a.dataset ? (a.dataset.action || null) : null,
    };
  })()`;
  const stops = [];
  for (let i = 0; i < 120; i++) {
    await page.pressTab();
    await page.wait(10);
    const info = await page.evaluate(snapshot);
    if (info.body) break;
    // A full cycle returns to the first stop; do not count it twice.
    if (stops.length && JSON.stringify(info) === JSON.stringify(stops[0])) break;
    stops.push(info);
  }
  const fileActions = await page.evaluate(`(() => {
    const open = document.querySelector("#changes .change-file .file-open");
    if (!open) return null;
    open.focus();
    const actions = open.closest(".change-file").querySelector(".file-actions");
    if (!actions) return null;
    const style = getComputedStyle(actions);
    return {
      activeIsOpen: document.activeElement === open,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      buttonCount: actions.querySelectorAll("button").length,
    };
  })()`);
  await page.evaluate(`window.__probe = ${JSON.stringify({
    stopCount: stops.length,
    stops,
    commitStops: stops.filter((stop) => stop.commitHash).length,
    changeRowStops: stops.filter((stop) => stop.changeRow && !stop.fileAction).length,
    fileControlStops: stops.filter((stop) => stop.changeRow && stop.fileAction).length,
    fileActions,
  })}; true`);
};

/**
 * N2(a)(c)(d)(e): listbox role, direct-child roles, roving tabindex
 * distribution, the announced reachable count and the locked-run group name.
 */
scenarios.ax = async (page) => {
  // collapseLockedRuns folds the first three locked commits into one group.
  await page.render({ ...baseState, collapseLockedRuns: true });
  await page.wait(150);
  await page.evaluate(`window.__probe = (() => {
    const list = document.getElementById("list");
    const box = list.querySelector('[role="listbox"]') || list;
    const describe = (el) => el.tagName + ((el.className || "").toString().trim() ? "." + (el.className || "").toString().trim().replace(/\\s+/g, ".") : "");
    const run = document.querySelector("details.locked-run");
    return {
      listRole: list.getAttribute("role"),
      listChildren: [...list.children].map(describe),
      listboxRole: box.getAttribute("role"),
      listboxTag: box === list ? "list" : "inner",
      multiselectable: box.getAttribute("aria-multiselectable"),
      label: box.getAttribute("aria-label"),
      directChildRoles: [...box.children].map((child) => child.getAttribute("role") || child.tagName),
      commitTabIndex: [...document.querySelectorAll(".commit")].map((row) => ({ hash: row.dataset.hash, tabIndex: row.tabIndex, inRun: !!row.closest("details.locked-run") })),
      zeroTabStopCount: [...document.querySelectorAll(".commit")].filter((row) => row.tabIndex === 0).length,
      optionNames: [...document.querySelectorAll(".commit")]
        .filter((row) => { const lockedRun = row.closest("details.locked-run"); return !lockedRun || lockedRun.open; })
        .map((row) => ({ name: row.getAttribute("aria-label"), posinset: row.getAttribute("aria-posinset"), setsize: row.getAttribute("aria-setsize") })),
      lockedRun: run ? { role: run.getAttribute("role"), ariaLabel: run.getAttribute("aria-label"), open: run.open } : null,
    };
  })(); true`);
  await page.evaluate(`window.__probe.ax = ${JSON.stringify(await axSnapshot(page, '[role="listbox"]'))}; true`);
  // N5: an icon-only tooltip button must expose its action, not the glyph, as
  // the accessible name. Open the tooltip on a visible option and read its AX.
  const tipHash = await page.evaluate(`(() => {
    const row = [...document.querySelectorAll(".commit")].find((candidate) => !candidate.closest("details.locked-run"));
    if (!row) return null;
    row.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    return row.dataset.hash;
  })()`);
  if (tipHash) {
    await page.post({ type: "detail", hash: tipHash, author: "lawrence", relDate: "1 hour ago", absDate: "today", stat: "1 file changed", message: "subject" });
    await page.wait(100);
    await page.evaluate(`window.__probe.tooltipAx = ${JSON.stringify(await axSnapshot(page, "#tooltip .tip-actions"))}; true`);
  }

  // B2-1 / B2-2 / B2-4: the option name is what a screen reader reads, so its
  // "第 X 项，共 N 项" must follow the reachable set in filtered and pending
  // states too. A no-match listbox must not expose its `.empty` text as a
  // StaticText child, and filtering must not stop a locked run collapsing.
  await page.evaluate(`window.__optionNames = () => [...document.querySelectorAll(".commit")]
    .filter((row) => { const run = row.closest("details.locked-run"); return !run || run.open; })
    .map((row) => ({ name: row.getAttribute("aria-label"), posinset: row.getAttribute("aria-posinset"), setsize: row.getAttribute("aria-setsize") })); true`);
  await page.render(baseState);
  await page.wait(120);
  await page.typeSearch("cif");
  await page.wait(150);
  await page.evaluate(`window.__probe.filtered = {
    names: window.__optionNames(),
    label: document.querySelector('[role="listbox"]').getAttribute("aria-label"),
  }; true`);
  // Clear the persisted filter before measuring the pending state, otherwise
  // this probe would silently measure a filtered list again.
  await page.typeSearch("");
  await page.wait(150);
  await page.render(pendingState);
  await page.wait(120);
  await page.evaluate(`window.__probe.pending = {
    names: window.__optionNames(),
    label: document.querySelector('[role="listbox"]').getAttribute("aria-label"),
  }; true`);
  await page.typeSearch("");
  await page.wait(150);
  // Locked at 0 / 2 / 4, separated by unlocked commits: no run initially, and
  // the default roving row is the first locked commit.
  const lockSubjects = { 0: "lock-a", 2: "lock-b", 4: "lock-c" };
  const lockCommits = baseState.commits.map((commit, index) => lockSubjects[index]
    ? { ...commit, locked: true, subject: lockSubjects[index] }
    : { ...commit, locked: false });
  await page.render({ ...baseState, collapseLockedRuns: true, commits: lockCommits });
  await page.wait(120);
  await page.evaluate(`window.__probe.lockRun = { before: document.querySelectorAll("details.locked-run").length }; true`);
  // Filter edits are local renders on the same state object. The bug's first
  // filtered render promoted its fallback roving row into state.activeHash, so
  // the second keystroke protected that row and dropped the fold.
  await page.typeSearch("lock");
  await page.wait(150);
  await page.evaluate(`window.__probe.lockRun.afterFirstFilter = document.querySelectorAll("details.locked-run").length; true`);
  await page.typeSearch("lock ");
  await page.wait(150);
  await page.evaluate(`window.__probe.lockRun.afterSecondFilter = document.querySelectorAll("details.locked-run").length;
    window.__probe.lockRun.names = window.__optionNames();
    window.__probe.lockRun.label = document.querySelector('[role="listbox"]').getAttribute("aria-label");
    window.__probe.lockRun.activeHash = window.__grvUiTrace().activeHash || null; true`);
  await page.typeSearch("zzzz");
  await page.wait(150);
  const noMatchAx = await axSnapshot(page, '[role="listbox"]');
  await page.evaluate(`window.__probe.noMatch = {
    emptyAriaHidden: document.querySelector('[role="listbox"] .empty')?.getAttribute("aria-hidden") ?? null,
    label: document.querySelector('[role="listbox"]').getAttribute("aria-label"),
    ax: ${JSON.stringify(noMatchAx)},
  }; true`);
};

/**
 * N2(a): do ↑/↓/Home/End move the active row, does focus follow, and does the
 * selection stay untouched? Ctrl+Space first establishes a real selection.
 */
scenarios["kbd-list"] = async (page) => {
  await page.render(baseState);
  await page.wait(150);
  await page.evaluate(`window.__probe = { steps: [] };
    window.__kbdSnap = (label) => {
      const a = document.activeElement;
      const trace = window.__grvUiTrace();
      window.__probe.steps.push({
        label,
        activeHash: a && a.dataset ? (a.dataset.hash || null) : null,
        zeroTabStops: [...document.querySelectorAll(".commit")].filter((row) => row.tabIndex === 0).map((row) => row.dataset.hash),
        traceActive: trace.activeHash || null,
        selected: trace.selectedHashes,
      });
    };
    const row = [...document.querySelectorAll(".commit")].find((candidate) => candidate.tabIndex === 0);
    row.focus();
    window.__kbdSnap("start");
    true`);
  await pressKey(page, " ", "Space", 32, 2);
  await page.wait(150);
  await page.evaluate(`window.__kbdSnap("afterCtrlSpace"); true`);
  const keys = [["ArrowDown", "ArrowDown", 40], ["ArrowDown", "ArrowDown", 40], ["ArrowUp", "ArrowUp", 38], ["End", "End", 35], ["Home", "Home", 36]];
  for (let index = 0; index < keys.length; index++) {
    await pressKey(page, ...keys[index]);
    await page.wait(120);
    await page.evaluate(`window.__kbdSnap(${JSON.stringify(`${keys[index][0]}#${index + 1}`)}); true`);
  }
};

/**
 * N9: disabled items must be reach stops, must not run their action on Enter,
 * and their reason must reach both the live region and the AX description.
 */
scenarios["menu-keyboard"] = async (page) => {
  await page.render({ ...baseState, llmConfigured: false, hasStaged: false, hasUnstaged: false, stagedCount: 0, unstagedCount: 0, changes: [] });
  await page.wait(150);
  await page.contextMenuRow(3);
  await page.wait(150);
  await page.evaluate(`window.__probe = {
    items: [...document.querySelectorAll("#menu button.item")].map((el) => ({
      label: el.textContent.trim(),
      ariaDisabled: el.getAttribute("aria-disabled"),
      nativeDisabled: el.disabled,
      tabIndex: el.tabIndex,
      title: el.title,
      description: el.getAttribute("aria-description"),
    })),
    cycle: [],
  }; true`);
  for (let i = 0; i < 14; i++) {
    await page.evaluate(`(() => {
      const a = document.activeElement;
      window.__probe.cycle.push(a && a.textContent ? a.textContent.trim() : null);
      a?.dispatchEvent?.(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      return true;
    })()`);
  }
  const focused = await page.evaluate(`(() => {
    const ai = [...document.querySelectorAll("#menu button.item")].find((el) => el.textContent.includes("AI 生成 message"));
    if (!ai) return false;
    ai.focus();
    window.__probe.aiFocused = document.activeElement === ai;
    window.__probe.beforeMessages = window.__hostMessages.length;
    return true;
  })()`);
  if (!focused) throw new Error("the menu has no AI item to focus");
  await pressKey(page, "Enter", "Enter", 13);
  await page.wait(150);
  await page.evaluate(`window.__probe.activated = {
    focusedLabel: document.activeElement && document.activeElement.textContent ? document.activeElement.textContent.trim() : null,
    live: document.getElementById("live").textContent,
    newMessages: window.__hostMessages.slice(window.__probe.beforeMessages).map((message) => message.type),
    menuOpen: !document.getElementById("menu").classList.contains("hidden"),
  }; true`);
  await page.evaluate(`window.__probe.ax = ${JSON.stringify(await axSnapshot(page, "#menu"))}; true`);

  // B2-3: the batch menu's first entries are disabled single-commit actions.
  // Opening it must still land focus on the first actionable item, while the
  // arrow cycle keeps the disabled ones reachable.
  await pressKey(page, "Escape", "Escape", 27);
  await page.wait(120);
  await page.clickRow(3, { ctrl: true });
  await page.clickRow(4, { ctrl: true });
  await page.contextMenuRow(4);
  await page.wait(150);
  await page.evaluate(`window.__probe.batchInitialFocus = (() => {
    const items = [...document.querySelectorAll("#menu button.item")];
    const active = document.activeElement;
    return {
      label: active && active.textContent ? active.textContent.trim() : null,
      ariaDisabled: active ? active.getAttribute("aria-disabled") : null,
      tabIndex: active ? active.tabIndex : null,
      firstItemDisabled: items[0] ? items[0].getAttribute("aria-disabled") : null,
      activeIndex: items.indexOf(active),
    };
  })(); true`);
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
    windowProbe(page, `(() => {
      const error = document.getElementById("error");
      return { text: error.textContent.trim(), style: ${textStyleExpression("#error")} };
    })()`);
  },

  /**
   * N4: the three fields need a programmatic name, and clicking a visible label
   * must move focus to its control. `input.labels` is the DOM's own association;
   * the AX tree is what a screen reader actually receives.
   */
  "compose-probe": async (page) => {
    // The AI section (and its 补充信息 field) is hidden unless the target is an
    // AI compose, so measure all three fields in the AI variant.
    await page.post({ ...composeTarget, ai: true, model: "fast" });
    await page.wait(150);
    windowProbe(page, `(() => {
      const fields = ["subject", "body", "extra"].map((id) => {
        const el = document.getElementById(id);
        return {
          id,
          tag: el.tagName,
          labels: [...(el.labels || [])].map((label) => label.textContent.trim()),
          ariaLabel: el.getAttribute("aria-label"),
          htmlFor: [...(el.labels || [])].map((label) => label.htmlFor),
        };
      });
      const labelClicks = [...document.querySelectorAll("main label")].map((label) => {
        const control = label.htmlFor ? document.getElementById(label.htmlFor) : label.querySelector("input, textarea, select");
        control?.blur();
        label.click();
        return {
          text: label.textContent.trim(),
          htmlFor: label.htmlFor,
          target: control ? (control.id || control.tagName) : null,
          focused: !!control && document.activeElement === control,
        };
      });
      return { fields, labelClicks };
    })()`);
    const ax = {};
    for (const id of ["subject", "body", "extra"]) {
      const snapshot = await axSnapshot(page, `#${id}`);
      ax[id] = snapshot.found ? { role: snapshot.node.role, name: snapshot.node.name } : null;
    }
    await page.evaluate(`window.__probe.ax = ${JSON.stringify(ax)}; true`);
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
  // Group opacity is applied after the subtree is painted, so a text node inside
  // an element with opacity 0.62 is composited at 62% over the surface behind
  // the group. The plain contrast field multiplies only the colour's own alpha
  // and therefore over-reports such text; effectiveContrast folds in every
  // ancestor opacity on the way up to the background.
  const cumulativeOpacity = (el) => {
    let alpha = 1;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const opacity = parseFloat(getComputedStyle(node).opacity);
      if (!Number.isNaN(opacity)) alpha *= opacity;
    }
    return alpha;
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
    const opacity = cumulativeOpacity(el);
    const effectiveFg = blend({ ...fg, a: fg.a * opacity }, bg);
    // A scroll container is asked to clip by the stylesheet; only unrequested
    // overflow is a layout defect, matching the ellipsis exemption below. This
    // deliberately covers every scroll container, including the pre-existing
    // tip-msg box (max-height 26vh; overflow-y:auto), not only the banner that
    // C4 bounded; both are purposeful overflow rather than a clipped label.
    const scrolls = ["auto", "scroll"].includes(style.overflowY) || ["auto", "scroll"].includes(style.overflowX);
    found.push({
      label: label(el),
      text: own.slice(0, 40),
      fontSize: parseFloat(style.fontSize),
      color: style.color,
      background: "rgb(" + Math.round(bg.r) + ", " + Math.round(bg.g) + ", " + Math.round(bg.b) + ")",
      contrast: Number(ratio(blend(fg, bg), bg).toFixed(2)),
      // Foreground alpha after every ancestor opacity; 1 means no opacity group
      // sits between this text node and the surface it is painted on.
      effectiveOpacity: Number(opacity.toFixed(3)),
      effectiveContrast: Number(ratio(effectiveFg, bg).toFixed(2)),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      // The icon box is sized by the stylesheet and the glyph is sized by the
      // font, so "does it fit" is scrollWidth vs clientWidth, not rect.width.
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      // Ellipsised text is a deliberate truncation, not a layout defect; only
      // report clipping where the stylesheet did not ask for it.
      clipped: !scrolls && style.textOverflow !== "ellipsis" && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1),
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

/**
 * State probe for the pointer scenarios. The audit says what colour a text node
 * ended up with; this says *why* — which menu item the browser considers
 * hovered, whether the programmatic focus is painting a keyboard focus ring,
 * and whether any row was selected as a side effect of opening the menu.
 */
const INTERACTION_PROBE = `(() => {
  const describe = (el) => {
    if (!el) return null;
    const cls = (el.className || "").toString().split(/\\s+/).filter(Boolean).slice(0, 2).join(".");
    return el.id ? "#" + el.id : el.tagName.toLowerCase() + (cls ? "." + cls : "");
  };
  const active = document.activeElement;
  const items = [...document.querySelectorAll("#menu .item")].map((el) => {
    const style = getComputedStyle(el);
    return {
      text: el.textContent.trim().slice(0, 24),
      hovered: el.matches(":hover"),
      focusVisible: el.matches(":focus-visible"),
      painted: style.backgroundColor !== "rgba(0, 0, 0, 0)",
      color: style.color,
      backgroundColor: style.backgroundColor,
    };
  });
  const rows = [...document.querySelectorAll(".commit")];
  const menuEl = document.getElementById("menu");
  const menuRect = menuEl && !menuEl.classList.contains("hidden") ? menuEl.getBoundingClientRect() : null;
  // The audit above measures text contrast; a focus ring is not a text node, so
  // the focus scenarios need the outline geometry and both of its backgrounds:
  // the button it surrounds (C3's "same colour as the fill") and the surface it
  // is painted onto (what the keyboard user actually sees).
  const parse = (value) => {
    const m = value.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const channel = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const background = (el) => {
    const layers = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (!bg || bg.a === 0) continue;
      if (bg.a >= 1) {
        let base = bg;
        for (let i = layers.length - 1; i >= 0; i--) {
          const top = layers[i];
          base = { r: top.r * top.a + base.r * (1 - top.a), g: top.g * top.a + base.g * (1 - top.a), b: top.b * top.a + base.b * (1 - top.a), a: 1 };
        }
        return base;
      }
      layers.push(bg);
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const rgb = (c) => "rgb(" + Math.round(c.r) + ", " + Math.round(c.g) + ", " + Math.round(c.b) + ")";
  const activeOutline = (() => {
    if (!active || active === document.body) return null;
    const style = getComputedStyle(active);
    const rect = active.getBoundingClientRect();
    const width = parseFloat(style.outlineWidth) || 0;
    const offset = parseFloat(style.outlineOffset) || 0;
    const box = { left: rect.left - offset - width, top: rect.top - offset - width, right: rect.right + offset + width, bottom: rect.bottom + offset + width };
    const clippedBy = [];
    for (let node = active.parentElement; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      const b = node.getBoundingClientRect();
      if (box.left < b.left - 0.5 || box.right > b.right + 0.5 || box.top < b.top - 0.5 || box.bottom > b.bottom + 0.5) clippedBy.push(describe(node));
    }
    const color = parse(style.outlineColor);
    const inside = background(active);
    const outside = background(active.parentElement);
    return {
      selector: describe(active),
      className: (active.className || "").toString(),
      focusVisible: active.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: width,
      outlineOffset: offset,
      outlineColor: style.outlineColor,
      background: style.backgroundColor,
      insideBackground: rgb(inside),
      outsideBackground: rgb(outside),
      contrastInside: color ? Number(ratio(color, inside).toFixed(2)) : null,
      contrastOutside: color ? Number(ratio(color, outside).toFixed(2)) : null,
      box: { left: Math.round(box.left), top: Math.round(box.top), right: Math.round(box.right), bottom: Math.round(box.bottom) },
      clippedBy,
    };
  })();
  const search = document.querySelector(".commit-search");
  // Chromium answers getComputedStyle(input, "::-webkit-search-cancel-button")
  // with the UA defaults no matter what the author sheet says, so a computed
  // style cannot prove the native affordance is hidden. Read the author rules
  // instead and check that their selector (pseudo-element stripped) matches.
  const cancelRules = [];
  if (search) {
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = [...sheet.cssRules]; } catch { continue; }
      for (const rule of rules) {
        if (!rule.selectorText || !rule.selectorText.includes("::-webkit-search-cancel-button")) continue;
        const bases = rule.selectorText.split(",").map((part) => part.replace(/::[\\w-]+/g, "").trim()).filter(Boolean);
        let matches = false;
        try { matches = bases.some((base) => search.matches(base)); } catch { /* :host() etc. */ }
        if (matches) cancelRules.push({ selector: rule.selectorText, display: rule.style.display, appearance: rule.style.webkitAppearance || rule.style.appearance });
      }
    }
  }
  const searchRect = search ? search.getBoundingClientRect() : null;
  const clear = document.querySelector(".list-controls .btn");
  return {
    searchBox: search ? {
      type: search.type,
      rect: searchRect && { left: Math.round(searchRect.left), top: Math.round(searchRect.top), width: Math.round(searchRect.width), height: Math.round(searchRect.height) },
      cancelRules,
      clearTabbable: document.body.dataset.harnessClearTabbable === "true",
      clearButton: clear ? { text: clear.textContent.trim(), tabIndex: clear.tabIndex, disabled: clear.disabled, focusVisible: clear.matches(":focus-visible") } : null,
    } : null,
    activeOutline,
    activeElement: describe(active),
    activeFocusVisible: !!active && active.matches(":focus-visible"),
    selectionForegroundToken: getComputedStyle(document.documentElement).getPropertyValue("--vscode-menu-selectionForeground").trim(),
    menuOpen: !!menuRect,
    menuRect: menuRect && { left: Math.round(menuRect.left), width: Math.round(menuRect.width), right: Math.round(menuRect.right) },
    menuItems: items,
    highlightedMenuItems: items.filter((item) => item.hovered || item.focusVisible || item.painted).map((item) => item.text),
    selectedRows: rows.filter((row) => row.classList.contains("selected")).length,
  };
})()`;

/**
 * Geometry probe for the fault-tolerance scenarios. C4 is a question about the
 * viewport, not about colour: how tall the banner gets, where the list starts,
 * and whether the banner's actions can still be brought on screen. The banner
 * is scrolled to both ends during the probe and restored, so the screenshot
 * still shows the top of a long error.
 */
const LAYOUT_PROBE = `(() => {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const banner = document.getElementById("banner");
  const list = document.getElementById("list");
  const visible = banner && !banner.classList.contains("hidden");
  const actions = visible ? [...banner.querySelectorAll(".banner-actions .btn, .edit-actions .btn")] : [];
  const contains = (outer, box) => !!box && box.top >= outer.top - 0.5 && box.bottom <= outer.bottom + 0.5 && box.left >= outer.left - 0.5 && box.right <= outer.right + 0.5;
  const actionState = () => {
    const bannerBox = banner.getBoundingClientRect();
    const style = getComputedStyle(banner);
    // The scrollport is the padding box, so trim the border before intersecting.
    const scrollport = {
      top: bannerBox.top + (parseFloat(style.borderTopWidth) || 0),
      bottom: bannerBox.bottom - (parseFloat(style.borderBottomWidth) || 0),
      left: bannerBox.left + (parseFloat(style.borderLeftWidth) || 0),
      right: bannerBox.right - (parseFloat(style.borderRightWidth) || 0),
    };
    const viewportBox = { top: 0, bottom: viewport.height, left: 0, right: viewport.width };
    return actions.map((button) => {
      const box = rect(button);
      const inScrollport = contains(scrollport, box);
      const inWindow = contains(viewportBox, box);
      return {
        text: button.textContent.trim(),
        rect: box,
        // A button is reachable only when it is fully inside BOTH the banner's
        // scrollport and the window; testing the window alone hid the 7px that
        // the scroll container had clipped at 340x300.
        inScrollport,
        inWindow,
        inViewport: inScrollport && inWindow,
      };
    });
  };
  let atTop = null, atBottom = null;
  if (visible) {
    banner.scrollTop = 0;
    atTop = actionState();
    banner.scrollTop = banner.scrollHeight;
    atBottom = actionState();
    banner.scrollTop = 0;
  }
  return {
    viewport,
    banner: visible ? {
      rect: rect(banner),
      scrollHeight: banner.scrollHeight,
      clientHeight: banner.clientHeight,
      scrollTopMax: banner.scrollHeight - banner.clientHeight,
      maxHeight: getComputedStyle(banner).maxHeight,
      overflowY: getComputedStyle(banner).overflowY,
      // The list must keep a usable slice of the viewport even with a long error.
      listTop: list ? rect(list).top : null,
      listVisibleHeight: list ? Math.max(0, Math.min(rect(list).bottom, viewport.height) - Math.max(rect(list).top, 0)) : null,
    } : null,
    actionsAtTop: atTop,
    actionsAtBottom: atBottom,
    documentHeight: document.documentElement.scrollHeight,
  };
})()`;

const auditResults = [];
const probeResults = [];

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

  /**
   * One real Tab key press. `Input.dispatchKeyEvent` is trusted input, so the
   * browser runs its default focus traversal and marks the newly focused
   * element as keyboard-focused (`:focus-visible`). A synthetic `keydown` or a
   * programmatic `focus()` does not necessarily do either.
   */
  async pressTab({ shift = false } = {}) {
    const key = { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: shift ? 8 : 0 };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  }

  /**
   * Press Tab until `selector` is the active element. `after` is an optional JS
   * expression yielding an element to focus first, which turns a long DOM walk
   * into one key press; the Tab itself still has to be the event that moves
   * focus, so the target really matches `:focus-visible`.
   */
  async tabTo(selector, { after = null, max = 160, shift = false } = {}) {
    if (after) {
      const found = await this.evaluate(`(() => { const el = (${after}); if (!el) return false; el.focus(); return true; })()`);
      if (!found) throw new Error(`focus start ${after} missing`);
    }
    for (let i = 0; i < max; i++) {
      await this.pressTab({ shift });
      if (await this.evaluate(`document.activeElement?.matches(${JSON.stringify(selector)}) === true`)) {
        await this.evaluate(`(() => { const el = document.activeElement; el.scrollIntoView({ block: "nearest" }); return true; })()`);
        return;
      }
    }
    throw new Error(`Tab never reached ${selector} within ${max} presses`);
  }

  /**
   * Move the hardware pointer. `mouseMoved` is what makes `:hover` match;
   * dispatching a synthetic `mouseenter` from the page does not, because the
   * cascade only consults the browser's internal hover chain.
   */
  mouseMove(x, y) {
    return this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  }

  /** A full press/release pair with a real button, so the browser derives `click` and `contextmenu`. */
  async mouseClick(x, y, { button = "left", clickCount = 1 } = {}) {
    const buttons = button === "right" ? 2 : 1;
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount });
  }

  async rightClickRow(index) {
    const rect = await this.rowRect(index);
    if (!rect) throw new Error(`row ${index} missing`);
    await this.mouseClick(rect.x, rect.y, { button: "right" });
  }

  /**
   * Aim at a menu item after the menu is on screen. `kind` is "shortcut" for
   * the only item that carries a `kbd`, or "danger" for the destructive item.
   */
  async mouseMoveToMenuItem(kind) {
    const rect = await this.evaluate(`(() => {
      const items = [...document.querySelectorAll("#menu .item")];
      const item = ${kind === "danger"
        ? `items.find((el) => el.classList.contains("danger"))`
        : `items.find((el) => el.querySelector("kbd"))`};
      if (!item) return null;
      const r = item.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: item.textContent.trim() };
    })()`);
    if (!rect) throw new Error(`no menu item matching ${kind}`);
    await this.mouseMove(rect.x, rect.y);
    return rect;
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
      height: isCompose ? 720 : viewportHeight,
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
      // Entrance animations must be finished before anything is measured. The
      // banner fades in over 150ms; sampling mid-fade folds a transient opacity
      // into effectiveContrast and reports a colour the user never sees.
      await cdp.evaluate(`Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))).then(() => true)`).catch(() => {});
      if (args.includes("--audit")) auditResults.push({ theme: themeName, scenario: name, elements: await cdp.evaluate(AUDIT_PROBE), interaction: await cdp.evaluate(INTERACTION_PROBE), layout: await cdp.evaluate(LAYOUT_PROBE) });
      if (args.includes("--probe")) {
        const probe = await cdp.evaluate("window.__probe ?? null").catch(() => null);
        if (probe) {
          probeResults.push({ theme: themeName, scenario: name, probe });
          console.log(`  probe ${name}: ${JSON.stringify(probe)}`);
        }
      }
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
    // A fixed base port collides when two renders run at once (before/after
    // comparison, or a reviewer's harness next to ours); pick a per-process base.
    await renderTheme(themeName, portBase + index, path.join(outDir, `.chrome-profile-${themeName}`), defaults);
  }
  if (probeResults.length) {
    fs.writeFileSync(path.join(outDir, "probe.json"), JSON.stringify(probeResults, null, 2));
  }
  if (auditResults.length) {
    fs.writeFileSync(path.join(outDir, "audit.json"), JSON.stringify(auditResults, null, 2));
    const all = auditResults.flatMap((shot) => shot.elements.map((el) => ({ ...el, theme: shot.theme, scenario: shot.scenario })));
    // WCAG AA: 4.5:1 for body text, 3:1 for large text (>=18.66px bold or >=24px).
    const threshold = (el) => el.fontSize >= 24 ? 3 : 4.5;
    const below = all.filter((el) => el.contrast < threshold(el));
    // Text inside an opacity group is only as readable as its effective
    // contrast. Report that separately: the raw field above ignores ancestor
    // opacity, so an opacity regression can hide in a stable raw count.
    const effectiveBelow = all.filter((el) => el.effectiveContrast < threshold(el));
    const clipped = all.filter((el) => el.clipped);
    const overflowing = all.filter((el) => el.overflowsViewport);
    console.log(`\nAudit: ${all.length} text nodes · ${below.length} below AA raw · ${effectiveBelow.length} below AA effective (ancestor opacity) · ${clipped.length} clipped · ${overflowing.length} overflowing the panel`);
    console.log("Contrast verdicts must read effectiveContrast: contrast ignores ancestor opacity (C5).");
  }
  console.log(`\nWrote screenshots to ${outDir}`);
};

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
