/**
 * Visual-readability gates that a DOM-behaviour test cannot express.
 *
 * jsdom does not lay out a page or resolve `var(--vscode-*)`, so these tests read
 * the shipped stylesheet through jsdom's CSS parser and resolve the handful of
 * default-theme tokens the declarations name. The token values are pinned copies
 * of the VS Code 1.97.2 defaults (`Dark Modern`, `Light Modern`, plus the colour
 * registry defaults the themes inherit); pinning them makes the gate fail if a
 * declaration starts pointing at a pair that is not designed to be readable,
 * instead of silently reading whatever theme happens to be installed.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

const root = path.resolve(__dirname, "..");
const stylesheet = fs.readFileSync(path.join(root, "media", "style.css"), "utf8");
const cssDom = new JSDOM(`<!doctype html><style>${stylesheet}</style>`);

interface ThemeTokens {
  foreground: string;
  descriptionForeground: string;
  inactiveSelectionBackground: string;
  activeSelectionBackground: string;
  activeSelectionForeground: string;
  secondaryBackground: string;
  secondaryForeground: string;
  focusBorder: string;
  editorInfoForeground: string;
  editorBackground: string;
  errorBackground: string;
  infoBackground: string;
  warningBackground: string;
}

const themes: Record<"dark" | "light", ThemeTokens> = {
  dark: {
    foreground: "#CCCCCC",
    descriptionForeground: "#9D9D9D",
    inactiveSelectionBackground: "#37373D",
    activeSelectionBackground: "#04395E",
    activeSelectionForeground: "#FFFFFF",
    secondaryBackground: "#313131",
    secondaryForeground: "#CCCCCC",
    focusBorder: "#0078D4",
    editorInfoForeground: "#3794FF",
    editorBackground: "#1F1F1F",
    // The colour-registry defaults behind `inputValidation.*Background`; the
    // default themes do not override them.
    errorBackground: "#5A1D1D",
    infoBackground: "#063B49",
    warningBackground: "#352A05",
  },
  light: {
    foreground: "#3B3B3B",
    descriptionForeground: "#3B3B3B",
    // `list.inactiveSelectionBackground` has no Light Modern override; the
    // registry default #E4E6F1 is what the webview receives.
    inactiveSelectionBackground: "#E4E6F1",
    activeSelectionBackground: "#E8E8E8",
    activeSelectionForeground: "#000000",
    secondaryBackground: "#E5E5E5",
    secondaryForeground: "#3B3B3B",
    focusBorder: "#005FB8",
    editorInfoForeground: "#1A85FF",
    editorBackground: "#FFFFFF",
    errorBackground: "#F2DEDE",
    infoBackground: "#D6ECF2",
    warningBackground: "#F6F5D2",
  },
};

const rules = (() => {
  const found: CSSStyleRule[] = [];
  const sheet = cssDom.window.document.styleSheets[0] as CSSStyleSheet;
  for (const rule of [...sheet.cssRules]) {
    if (typeof (rule as CSSStyleRule).selectorText === "string") found.push(rule as CSSStyleRule);
  }
  return found;
})();

/** The last declaration wins, matching the cascade for equally-specific rules. */
function declaration(selector: string, property: string): string | undefined {
  let value: string | undefined;
  for (const rule of rules) {
    const selectors = rule.selectorText.split(",").map((part) => part.trim());
    if (!selectors.includes(selector)) continue;
    const candidate = rule.style.getPropertyValue(property).trim();
    if (candidate) value = candidate;
  }
  return value;
}

function tokenColor(value: string, theme: ThemeTokens): string {
  const match = /^var\((--vscode-[\w-]+)(?:,\s*(.+))?\)$/.exec(value.trim());
  if (!match) return value.trim();
  const token = match[1].replace(/^--vscode-/, "");
  const aliases: Record<string, keyof ThemeTokens> = {
    foreground: "foreground",
    descriptionForeground: "descriptionForeground",
    "list-inactiveSelectionBackground": "inactiveSelectionBackground",
    "list-activeSelectionBackground": "activeSelectionBackground",
    "list-activeSelectionForeground": "activeSelectionForeground",
    "button-secondaryBackground": "secondaryBackground",
    "button-secondaryForeground": "secondaryForeground",
    focusBorder: "focusBorder",
    "editorInfo-foreground": "editorInfoForeground",
    "editor-background": "editorBackground",
    "inputValidation-errorBackground": "errorBackground",
    "inputValidation-infoBackground": "infoBackground",
    "inputValidation-warningBackground": "warningBackground",
  };
  const key = aliases[token];
  if (key) return theme[key];
  return match[2] ? tokenColor(match[2], theme) : value.trim();
}

function rgb(hex: string) {
  const value = hex.replace("#", "");
  const expanded = value.length === 3 ? [...value].map((part) => part + part).join("") : value;
  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16),
  };
}

function luminance(hex: string): number {
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
  };
  const colour = rgb(hex);
  return 0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b);
}

function ratio(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** A group opacity composites the text over the surface behind the row. */
function effective(foreground: string, background: string, opacity: number): string {
  const fg = rgb(foreground);
  const bg = rgb(background);
  const blend = (a: number, b: number) => Math.round(a * opacity + b * (1 - opacity));
  return `#${[blend(fg.r, bg.r), blend(fg.g, bg.g), blend(fg.b, bg.b)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;
}

// ---------------------------------------------------------------- K3: meta
test("selected, stopped and pending-selected meta all reach AA", () => {
  const selected = declaration(".commit.selected .commit-meta", "color");
  const stopped = declaration(".commit.stopped .commit-meta", "color");
  assert.ok(selected, "a selected row overrides the shared meta colour");
  assert.ok(stopped, "a stopped row overrides the shared meta colour");

  for (const [name, theme] of Object.entries(themes)) {
    const selectedForeground = tokenColor(selected, theme);
    const stoppedForeground = tokenColor(stopped, theme);
    const selectedBackground = theme.inactiveSelectionBackground;
    const stoppedBackground = theme.activeSelectionBackground;

    const selectedRaw = ratio(selectedForeground, selectedBackground);
    assert.ok(selectedRaw >= 4.5, `${name}: selected meta raw ${selectedRaw.toFixed(2)} >= 4.5`);

    // `.commit.pending { opacity: .8 }` dims the whole row; the user sees the
    // composited colour, so this is the value that has to pass.
    const pendingEffective = ratio(
      effective(selectedForeground, selectedBackground, 0.8),
      selectedBackground
    );
    assert.ok(pendingEffective >= 4.5, `${name}: pending-selected meta effective ${pendingEffective.toFixed(2)} >= 4.5`);

    const stoppedRaw = ratio(stoppedForeground, stoppedBackground);
    assert.ok(stoppedRaw >= 4.5, `${name}: stopped meta raw ${stoppedRaw.toFixed(2)} >= 4.5`);

    // The group opacity is also the always-visible pending cue. The fix must not
    // make pending rows indistinguishable from ordinary selected rows.
    assert.ok(
      selectedRaw - pendingEffective >= 1,
      `${name}: pending stays visibly dimmer (${selectedRaw.toFixed(2)} vs ${pendingEffective.toFixed(2)})`
    );
  }
});

// ---------------------------------------------------------------- N3: rings
test("secondary and stopped focus rings reach 3:1 against their fills", () => {
  const secondary = declaration(".btn:not(.primary):focus-visible", "outline-color");
  const stopped = declaration(".commit.stopped:focus-visible", "outline-color");
  assert.ok(secondary, "secondary buttons override the shared focus ring colour");
  assert.ok(stopped, "a focused stopped row overrides its state outline colour");

  for (const [name, theme] of Object.entries(themes)) {
    const secondaryRing = tokenColor(secondary, theme);
    const secondaryFill = theme.secondaryBackground;
    const secondaryRatio = ratio(secondaryRing, secondaryFill);
    assert.ok(secondaryRatio >= 3, `${name}: secondary focus ring ${secondaryRatio.toFixed(2)} >= 3`);

    const stoppedRing = tokenColor(stopped, theme);
    const stoppedFill = theme.activeSelectionBackground;
    const stoppedRatio = ratio(stoppedRing, stoppedFill);
    assert.ok(stoppedRatio >= 3, `${name}: stopped focus ring ${stoppedRatio.toFixed(2)} >= 3`);
  }
});

// ------------------------------------------------------- batch D: banner ring
/**
 * The painted ring colour. jsdom keeps `outline` as a shorthand, so a colour
 * that still lives on the grouped `outline: 1px solid …` rule has to be read
 * from the shorthand itself; otherwise the gate would only notice a colour that
 * was moved into a longhand and miss the regression it exists to catch.
 */
function outlineColor(selector: string, theme: ThemeTokens): string | undefined {
  const explicit = declaration(selector, "outline-color");
  if (explicit) return tokenColor(explicit, theme);
  const shorthand = declaration(selector, "outline");
  const colour = shorthand && /(?:^|\s)(var\([^)]*\)|#[0-9a-fA-F]{3,8})\s*$/.exec(shorthand);
  return colour ? tokenColor(colour[1], theme) : undefined;
}

test("the banner focus ring reaches 3:1 on every validation fill", () => {
  // The colour override must not carry the ring's geometry with it: the shared
  // rule is still the only place that sets the inset 1px outline.
  assert.equal(declaration(".banner:focus-visible", "outline-offset"), "-1px", "the ring keeps its inset offset");

  const surfaces: Record<string, string> = {
    error: ".banner.error",
    conflict: ".banner.rebase.conflict",
    info: ".banner.rebase",
    recovery: ".banner.recovery",
  };
  for (const [name, theme] of Object.entries(themes)) {
    const ring = outlineColor(".banner:focus-visible", theme);
    assert.ok(ring, `${name}: the banner has a painted ring colour`);
    for (const [variant, selector] of Object.entries(surfaces)) {
      const background = declaration(selector, "background");
      assert.ok(background, `${variant} banner declares its validation fill`);
      const contrast = ratio(ring, tokenColor(background, theme));
      assert.ok(contrast >= 3, `${name}: ${variant} banner focus ring ${contrast.toFixed(2)} >= 3`);
    }
  }
});

// ---------------------------------------------------------------- K1: menu
test("the context menu is capped to the viewport and labels truncate honestly", () => {
  const maxWidth = declaration(".menu", "max-width");
  const minWidth = declaration(".menu", "min-width");
  assert.equal(maxWidth, "calc(100vw - 8px)", "the menu never grows wider than the webview");
  // A fixed 200px minimum would win over the cap below a 208px viewport.
  assert.equal(minWidth, "min(200px, calc(100vw - 8px))", "the minimum also respects a very narrow viewport");

  const labelMinWidth = declaration(".menu .item .menu-label", "min-width");
  const labelOverflow = declaration(".menu .item .menu-label", "overflow");
  const labelEllipsis = declaration(".menu .item .menu-label", "text-overflow");
  assert.equal(labelMinWidth, "0", "the label is allowed to shrink");
  assert.equal(labelOverflow, "hidden", "the label clips instead of pushing the menu wider");
  assert.equal(labelEllipsis, "ellipsis", "truncation is visible");
});

// ---------------------------------------------------------------- N4: labels
/**
 * The compose panel is one template literal inside `ComposePanel`. Evaluating
 * that template is exactly what the extension does; the nonce and CSP source are
 * the only substitutions, so the shipped markup is what these tests inspect.
 */
function composeDocument(): string {
  const source = fs.readFileSync(path.join(root, "src/ui/composePanel.ts"), "utf8");
  const start = source.indexOf("<!doctype html>");
  const end = source.indexOf("</html>", start);
  assert.ok(start >= 0 && end > start, "compose template is present");
  const raw = source.slice(start, end + "</html>".length);
  return new Function("nonce", "webview", `return \`${raw}\`;`)("test-nonce", { cspSource: "test-csp" });
}

test("compose fields have programmatic labels and their labels focus them", () => {
  const dom = new JSDOM(composeDocument(), { runScripts: "outside-only", url: "https://compose.test/" });
  try {
    const doc = dom.window.document;
    for (const id of ["subject", "body", "extra"]) {
      const control = doc.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
      assert.ok(control, `#${id} exists`);
      const label = doc.querySelector(`label[for="${id}"]`);
      assert.ok(label, `#${id} has a label bound with for=`);
      assert.match(label.textContent ?? "", /\S/, `#${id}'s label text is readable`);
      assert.equal(control.labels?.length, 1, `#${id} is associated with exactly one label`);
      // jsdom does not implement label activation (a real click forwards focus to
      // the labelled control); `label.control` is the DOM's own association and
      // the harness probe covers the actual click-to-focus behaviour.
      assert.equal((label as HTMLLabelElement).control, control, `#${id}'s label points at its control`);
    }
  } finally {
    dom.window.close();
  }
});

// ---------------------------------------------------------------- N7: error
test("compose error copy meets AA while red stays on the border", () => {
  const document = new JSDOM(composeDocument(), { runScripts: "outside-only", url: "https://compose.test/" });
  try {
    const style = /<style>([\s\S]*?)<\/style>/.exec(composeDocument())![1];
    const panel = new JSDOM(`<!doctype html><style>${style}</style>`);
    const sheet = panel.window.document.styleSheets[0] as CSSStyleSheet;
    const rule = [...sheet.cssRules].find(
      (candidate) => (candidate as CSSStyleRule).selectorText === ".error"
    ) as CSSStyleRule | undefined;
    assert.ok(rule, "the compose error style exists");

    const colour = rule.style.getPropertyValue("color").trim();
    assert.doesNotMatch(colour, /--vscode-errorForeground\)/, "error body text does not use the UI red");
    const border = rule.style.getPropertyValue("border-left-color").trim();
    assert.match(border, /--vscode-(inputValidation-errorBorder|errorForeground)/, "the red is kept on the border");

    for (const [name, theme] of Object.entries(themes)) {
      const foreground = tokenColor(colour, theme);
      const background = theme.editorBackground;
      const contrast = ratio(foreground, background);
      assert.ok(contrast >= 4.5, `${name}: compose error copy ${contrast.toFixed(2)} >= 4.5`);
    }
  } finally {
    document.window.close();
  }
});
