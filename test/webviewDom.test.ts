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
    llmConfigured: true,
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
  Object.defineProperty(window, "confirm", { value: () => true });
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

test("actual webview pointer and native drop preserve the original session across a routine same-revision refresh", () => {
  const view = createHarness();
  try {
    view.postState(state([a, b, c], 7));
    const sourceGrip = view.row(c).querySelector(".grip") as HTMLElement;
    const target = view.row(a);
    Object.defineProperty(view.dom.window.document, "elementFromPoint", { configurable: true, value: () => target });
    Object.defineProperty(target, "getBoundingClientRect", { configurable: true, value: () => ({ top: 10, height: 20 }) });

    sourceGrip.dispatchEvent(pointerEvent(view.dom.window, "pointerdown", { pointerId: 4, clientY: 0 }));
    // A routine status refresh now preserves canonical revision. The same drag is
    // valid; external history changes would carry a different revision instead.
    view.postState(state([a, b, c], 7));
    sourceGrip.dispatchEvent(pointerEvent(view.dom.window, "pointerup", { pointerId: 4, clientY: 0 }));

    const pointerPayload = JSON.parse(JSON.stringify(view.messages.filter((message) => message.type === "reorder").map((message) => ({
      sourceHash: message.sourceHash,
      anchorHash: message.anchorHash,
      placement: message.placement,
      revision: message.revision,
      order: message.order,
    }))));
    assert.deepEqual(pointerPayload, [{ sourceHash: c, anchorHash: a, placement: "before", revision: 7, order: [c, a, b] }]);
    assert.equal(view.dom.window.__grvUiTrace().deferredRefresh, false);

    view.messages.length = 0;
    view.postState(state([a, b, c], 11));
    const nativeSourceGrip = view.row(c).querySelector(".grip") as HTMLElement;
    nativeSourceGrip.dispatchEvent(mouseEvent(view.dom.window, "dragstart", { dataTransfer: { effectAllowed: "", setData() {} } }));
    view.postState(state([a, b, c], 11));
    const nativeTarget = view.row(a);
    Object.defineProperty(nativeTarget, "getBoundingClientRect", { configurable: true, value: () => ({ top: 10, height: 20 }) });
    nativeTarget.dispatchEvent(mouseEvent(view.dom.window, "drop", { clientY: 0 }));
    const nativePayload = JSON.parse(JSON.stringify(view.messages.filter((message) => message.type === "reorder").map((message) => ({ revision: message.revision, order: message.order }))));
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

test("legacy webview has no commit hover or context-inspector route", async () => {
  const view = createHarness();
  try {
    view.postState(state([a, b, c], 3));
    view.row(c).dispatchEvent(mouseEvent(view.dom.window, "contextmenu", { clientX: 10, clientY: 10 }));
    view.row(c).dispatchEvent(mouseEvent(view.dom.window, "mouseenter"));
    await new Promise((resolve) => setTimeout(resolve, 420));
    assert.equal(
      view.messages.some((message) => ["openCommitInspector", "openBatchInspector", "requestDetail"].includes(message.type)),
      false,
      "native TreeView owns hover/context UI; the iframe cannot request an inspector"
    );
    assert.equal(view.dom.window.document.getElementById("menu")?.classList.contains("hidden"), true);
  } finally {
    view.close();
  }
});

test("actual webview worktree rows expose paths at rest and route file and section actions", () => {
  const view = createHarness();
  try {
    const next = state([a], 9);
    Object.assign(next, {
      hasStaged: true,
      hasUnstaged: true,
      stagedCount: 1,
      unstagedCount: 2,
      changes: [
        { path: "src/long/path/added.ts", staged: true, unstaged: false, indexKind: "add", conflicted: false },
        { path: "src/long/path/modified.ts", staged: false, unstaged: true, worktreeKind: "modify", conflicted: false },
        { path: "tmp/generated.bin", staged: false, unstaged: true, worktreeKind: "untracked", conflicted: false },
      ],
    });
    view.postState(next);
    const details = view.dom.window.document.querySelector(".changes-more") as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new view.dom.window.Event("toggle"));
    const firstTarget = view.dom.window.document.querySelector(".change-file .file-open") as HTMLButtonElement;
    assert.equal(firstTarget.title, "src/long/path/added.ts", "file hover is the path only");
    const fileActions = [...view.dom.window.document.querySelectorAll(".change-file .file-actions .file-action")];
    assert.equal(fileActions.some((button) => button.getAttribute("aria-label")?.includes("打开")), false, "no redundant open icon; only per-file restore/stage/delete actions remain");
    assert.equal(fileActions.length, 5, "the staged row restores, while each unstaged row has its meaningful action pair");
    assert.ok(view.dom.window.document.querySelector(".file-path")?.textContent?.includes("src/long/path/"));

    firstTarget.click();
    assert.deepEqual(JSON.parse(JSON.stringify(view.messages.at(-1))), { type: "openWorktreeDiff", path: "src/long/path/added.ts", source: "webview:read" });

    const headers = [...view.dom.window.document.querySelectorAll(".file-group-header")];
    const changesHeader = headers.find((header) => header.querySelector(".file-group-label")?.textContent?.startsWith("Changes"))!;
    const stageAll = changesHeader.querySelector("button") as HTMLButtonElement;
    stageAll.click();
    assert.equal(view.messages.at(-1)?.type, "stageAllFiles");

    const stagedHeader = headers.find((header) => header.querySelector(".file-group-label")?.textContent?.startsWith("Staged Changes"))!;
    const unstageAll = stagedHeader.querySelector("button") as HTMLButtonElement;
    unstageAll.click();
    assert.equal(view.messages.at(-1)?.type, "unstageAllFiles");

    const remove = [...view.dom.window.document.querySelectorAll(".file-action")]
      .find((button) => button.getAttribute("aria-label") === "删除未跟踪文件") as HTMLButtonElement;
    remove.click();
    assert.deepEqual(JSON.parse(JSON.stringify(view.messages.at(-1))), { type: "deleteUntrackedFile", path: "tmp/generated.bin", source: "webview:worktree-mutation" });
  } finally {
    view.close();
  }
});

test("locked run summary is compact and removes the expanded long rail", () => {
  const view = createHarness();
  try {
    const next = state([a, b, c], 3);
    const commits = next.commits as Array<Record<string, unknown>>;
    commits.forEach((commit, index) => { commit.locked = true; commit.author = ["lawrence_lv", "sally_peng", "yucheng_xiang"][index]; });
    Object.assign(next, { collapseLockedRuns: true });
    view.postState(next);
    const run = view.dom.window.document.querySelector(".locked-run") as HTMLDetailsElement;
    const summary = run.querySelector("summary")!;
    assert.match(summary.textContent ?? "", /^🔒 : 3 lock · no push · la ×1 · sa ×1 · yu ×1$/);
    assert.doesNotMatch(summary.textContent ?? "", /[a-f0-9]{8}/i);
    assert.match(summary.getAttribute("aria-label") ?? "", /lawrence_lv/);
    run.open = true;
    assert.equal(run.hasAttribute("open"), true, "CSS removes the long rail only while expanded");
  } finally {
    view.close();
  }
});

test("legacy drag guidance replaces the fixed Base marker without adding a direction row", () => {
  const view = createHarness();
  try {
    view.postState(state([a, b, c], 3));
    const base = view.dom.window.document.querySelector(".timeline-end.base") as HTMLElement;
    assert.equal(base.textContent, "↑ Base / 较早");
    const grip = view.row(c).querySelector(".grip") as HTMLElement;
    grip.dispatchEvent(pointerEvent(view.dom.window, "pointerdown", { pointerId: 4, clientY: 0 }));
    assert.match(base.textContent ?? "", /正在移动/);
    assert.equal(view.dom.window.document.getElementById("direction")?.classList.contains("hidden"), true);
  } finally {
    view.close();
  }
});

test("lower worktree details do not add a redundant draft-only action", () => {
  const view = createHarness();
  try {
    const next = state([a], 3);
    Object.assign(next, {
      hasUnstaged: true,
      unstagedCount: 1,
      changes: [{ path: "file.ts", staged: false, unstaged: true, worktreeKind: "modify", conflicted: false }],
    });
    view.postState(next);
    const more = view.dom.window.document.querySelector(".changes-more") as HTMLDetailsElement;
    more.open = true;
    more.dispatchEvent(new view.dom.window.Event("toggle"));
    assert.equal([...more.querySelectorAll("button")].some((button) => button.textContent === "仅生成 message（不提交）"), false);
  } finally {
    view.close();
  }
});
