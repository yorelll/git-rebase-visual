import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

const root = path.resolve(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "media", "main.js"), "utf8");
const hash = (letter: string) => letter.repeat(40);
const a = hash("a");
const b = hash("b");
const c = hash("c");

interface Harness {
  dom: JSDOM;
  messages: any[];
  postState(state: Record<string, unknown>): void;
  row(id: string): HTMLElement;
  close(): void;
}

function state(commits: string[], revision: number): Record<string, unknown> {
  return {
    type: "state",
    canonicalRevision: revision,
    canonicalOrder: commits,
    commits: commits.map((commit, index) => ({
      hash: commit,
      shortHash: commit.slice(0, 8),
      subject: `commit-${index + 1}`,
      author: `Author ${index + 1}`,
      authorEmail: `author-${index + 1}@example.test`,
      authorInitial: "A",
      authorColorKey: String(index),
      date: "today",
      locked: false,
    })),
    rebaseInProgress: false,
    llmConfigured: false,
    hasStaged: false,
    hasUnstaged: false,
    changes: [],
  };
}

function createHarness(): Harness {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="list"></div><div id="banner"></div><div id="context"></div>
    <span id="context-text"></span><div id="inline-toast"></div><div id="changes"></div>
    <div id="menu" class="hidden"></div><div id="tooltip" class="hidden"></div>
    <div id="direction" class="hidden"></div><div id="live"></div>
  </body>`, { runScripts: "outside-only", url: "https://webview.test/" });
  const messages: any[] = [];
  const { window } = dom;
  Object.defineProperty(window, "acquireVsCodeApi", {
    value: () => ({
      postMessage: (message: unknown) => { messages.push(message); return true; },
      getState: () => undefined,
      setState: () => undefined,
    }),
  });
  Object.defineProperty(window.document, "elementFromPoint", {
    configurable: true,
    value: () => null,
  });
  window.eval(mainSource);
  messages.length = 0; // Ignore ready.
  return {
    dom,
    messages,
    postState(next) {
      window.dispatchEvent(new window.MessageEvent("message", { data: next }));
    },
    row(id) {
      const row = window.document.querySelector(`.commit[data-hash="${id}"]`);
      assert.ok(row, `commit row ${id} exists`);
      return row as HTMLElement;
    },
    close() { window.close(); },
  };
}

function mouseEvent(window: Window, type: string, init: Record<string, unknown> = {}): MouseEvent {
  const { dataTransfer, ...mouseInit } = init;
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, ...mouseInit });
  if (dataTransfer) Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return event;
}

function pointerEvent(window: Window, type: string, init: Record<string, unknown> = {}): Event {
  const event = new window.Event(type, { bubbles: true, cancelable: true }) as Event & Record<string, unknown>;
  Object.assign(event, { pointerId: 1, clientX: 5, clientY: 5, ...init });
  return event;
}

test("actual webview pointer and native drop preserve their original drag session before deferred state applies", () => {
  const view = createHarness();
  try {
    view.postState(state([a, b, c], 7));
    const sourceGrip = view.row(c).querySelector(".grip") as HTMLElement;
    const target = view.row(a);
    Object.defineProperty(view.dom.window.document, "elementFromPoint", { configurable: true, value: () => target });
    Object.defineProperty(target, "getBoundingClientRect", { configurable: true, value: () => ({ top: 10, height: 20 }) });

    sourceGrip.dispatchEvent(pointerEvent(view.dom.window, "pointerdown", { pointerId: 4, clientY: 0 }));
    view.postState(state([b, a, c], 8));
    sourceGrip.dispatchEvent(pointerEvent(view.dom.window, "pointerup", { pointerId: 4, clientY: 0 }));

    const pointerPayload = JSON.parse(JSON.stringify(view.messages.filter((message) => message.type === "reorder").map((message) => ({
      sourceHash: message.sourceHash,
      anchorHash: message.anchorHash,
      placement: message.placement,
      revision: message.revision,
      order: message.order,
    }))));
    assert.deepEqual(pointerPayload, [{
      sourceHash: c,
      anchorHash: a,
      placement: "before",
      revision: 7,
      order: [c, a, b],
    }]);
    assert.equal(view.dom.window.__grvUiTrace().deferredRefresh, false);
    assert.equal(view.row(b).classList.contains("commit"), true, "deferred state rendered only after the old-session intent posted");

    view.messages.length = 0;
    view.postState(state([a, b, c], 11));
    const nativeSourceGrip = view.row(c).querySelector(".grip") as HTMLElement;
    nativeSourceGrip.dispatchEvent(mouseEvent(view.dom.window, "dragstart", {
      dataTransfer: { effectAllowed: "", setData() {} },
    }));
    view.postState(state([b, a, c], 12));
    const nativeTarget = view.row(a);
    Object.defineProperty(nativeTarget, "getBoundingClientRect", { configurable: true, value: () => ({ top: 10, height: 20 }) });
    nativeTarget.dispatchEvent(mouseEvent(view.dom.window, "drop", { clientY: 0 }));
    const nativePayload = JSON.parse(JSON.stringify(view.messages.filter((message) => message.type === "reorder").map((message) => ({
      revision: message.revision, order: message.order,
    }))));
    assert.deepEqual(nativePayload, [{ revision: 11, order: [c, a, b] }]);
  } finally {
    view.close();
  }
});

test("actual webview author dots show a two-character label for same-initial authors", () => {
  const view = createHarness();
  try {
    const initial = state([a, b], 3);
    const commits = initial.commits as Array<Record<string, unknown>>;
    commits[0].author = "Alice";
    commits[0].authorInitial = "A";
    commits[0].authorColorKey = "0";
    commits[1].author = "Andrew";
    commits[1].authorInitial = "A";
    commits[1].authorColorKey = "1";
    view.postState(initial);

    const dots = [...view.dom.window.document.querySelectorAll(".commit .dot")];
    assert.deepEqual(dots.map((dot) => dot.textContent), ["Al", "An"]);
    assert.equal(dots.every((dot) => dot.classList.contains("author-label-two")), true);

    commits[1].author = "Alicia";
    view.postState(initial);
    assert.deepEqual(
      [...view.dom.window.document.querySelectorAll(".commit .dot")].map((dot) => dot.textContent),
      ["Alice", "Alici"],
      "same two-character prefix expands to distinct textual author labels"
    );
  } finally {
    view.close();
  }
});

test("actual webview context menus reconcile selection with their pointer target and retain selected batches", () => {
  const view = createHarness();
  try {
    view.postState(state([a, b, c], 3));
    const click = (id: string, extra: Record<string, unknown> = {}) =>
      view.row(id).dispatchEvent(mouseEvent(view.dom.window, "click", extra));
    click(a, { ctrlKey: true });
    click(b, { ctrlKey: true });
    assert.deepEqual(JSON.parse(JSON.stringify(view.dom.window.__grvUiTrace().selectedHashes)).sort(), [a, b]);

    view.row(c).dispatchEvent(mouseEvent(view.dom.window, "contextmenu", { clientX: 10, clientY: 10 }));
    assert.deepEqual(JSON.parse(JSON.stringify(view.dom.window.__grvUiTrace().selectedHashes)), []);
    assert.match(view.dom.window.document.getElementById("menu")?.textContent ?? "", new RegExp(c.slice(0, 8)));
    assert.doesNotMatch(view.dom.window.document.getElementById("menu")?.textContent ?? "", /批量删除/);
    const singleGeneratedDiff = [...view.dom.window.document.querySelectorAll("#menu button")]
      .find((button) => button.textContent?.includes("生成 Diff"));
    assert.ok(singleGeneratedDiff, "single menu exposes generated Diff");
    singleGeneratedDiff.click();
    assert.deepEqual(
      JSON.parse(JSON.stringify(view.messages.at(-1))),
      { type: "generateDiff", hash: c, revision: 3, source: "webview:read" },
      "single menu payload uses the pointer target"
    );

    click(a, { ctrlKey: true });
    click(b, { ctrlKey: true });
    view.row(a).dispatchEvent(mouseEvent(view.dom.window, "contextmenu", { clientX: 10, clientY: 10 }));
    assert.deepEqual(JSON.parse(JSON.stringify(view.dom.window.__grvUiTrace().selectedHashes)).sort(), [a, b]);
    const menuText = view.dom.window.document.getElementById("menu")?.textContent ?? "";
    assert.match(menuText, /已选择 2 个 commit/);
    assert.match(menuText, /批量删除 commit/);
    assert.match(menuText, /编辑 message/);
    const edit = [...view.dom.window.document.querySelectorAll("#menu button")].find((button) => button.textContent?.includes("编辑 message"));
    assert.ok(edit?.classList.contains("disabled"), "single-commit action is disabled for a retained batch");
    const bulkGeneratedDiff = [...view.dom.window.document.querySelectorAll("#menu button")]
      .find((button) => button.textContent?.includes("生成 Diff"));
    assert.ok(bulkGeneratedDiff, "batch menu exposes generated Diff");
    bulkGeneratedDiff.click();
    assert.deepEqual(
      JSON.parse(JSON.stringify(view.messages.at(-1))),
      { type: "bulkGenerateDiff", hashes: [a, b], revision: 3, source: "webview:read" },
      "contiguous batch payload retains exactly the selected rows"
    );

    view.dom.window.document.getElementById("list")?.dispatchEvent(mouseEvent(view.dom.window, "contextmenu"));
    assert.deepEqual(
      JSON.parse(JSON.stringify(view.dom.window.__grvUiTrace().selectedHashes)),
      [],
      "blank list context menu clears multi-selection"
    );
  } finally {
    view.close();
  }
});

test("actual webview disables generated Diff for a non-contiguous batch", () => {
  const view = createHarness();
  try {
    view.postState(state([a, b, c], 3));
    view.row(a).dispatchEvent(mouseEvent(view.dom.window, "click", { ctrlKey: true }));
    view.row(c).dispatchEvent(mouseEvent(view.dom.window, "click", { ctrlKey: true }));
    view.row(a).dispatchEvent(mouseEvent(view.dom.window, "contextmenu", { clientX: 10, clientY: 10 }));

    const generatedDiff = [...view.dom.window.document.querySelectorAll("#menu button")]
      .find((button) => button.textContent?.includes("生成 Diff"));
    assert.ok(generatedDiff, "batch menu exposes the generated Diff action");
    assert.equal(generatedDiff.classList.contains("disabled"), true);
    assert.match(generatedDiff.getAttribute("aria-description") ?? "", /仅支持连续 commit/);
    generatedDiff.click();
    assert.equal(view.messages.some((message) => message.type === "bulkGenerateDiff"), false);
  } finally {
    view.close();
  }
});
