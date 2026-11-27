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
  // Keep the fixture's element order identical to the real template
  // (src/ui/rebaseViewProvider.ts): #changes → #direction → #list. An older
  // fixture put #list first, so it could not catch a regression that moved
  // #direction below or inside the list — the very shift this row exists to
  // prevent.
  const dom = new JSDOM(`<!doctype html><body>
    <div id="banner"></div><div id="context"></div>
    <span id="context-text"></span><div id="inline-toast"></div>
    <div id="changes"></div><div id="direction" class="hidden"></div><div id="list"></div>
    <div id="menu" class="hidden"></div><div id="tooltip" class="hidden"></div><div id="live"></div>
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

function mouseEvent(window: Window & typeof globalThis, type: string, init: Record<string, unknown> = {}): MouseEvent {
  const { dataTransfer, ...mouseInit } = init;
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, ...mouseInit });
  if (dataTransfer) Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return event;
}

function pointerEvent(window: Window & typeof globalThis, type: string, init: Record<string, unknown> = {}): Event {
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

/**
 * `#direction` sits between #changes and #list and stays in the document flow.
 * The old implementation hid the row at idle and un-hid it on the first
 * pointerdown, which pushed the whole commit list down ~24px exactly when the
 * drag began — moving the row under the cursor and changing what
 * elementFromPoint resolved to. The row must be resident from ready onward, and
 * only its text may change between idle, dragging, and idle again.
 *
 * The fixture deliberately gives the row class="hidden", which is stricter than
 * the real template: src/ui/rebaseViewProvider.ts renders #direction without
 * `hidden`. Keeping the stricter initial state forces this test to prove which
 * code makes the row visible rather than passing on the template's own markup;
 * it is not evidence that the real first frame hides the row.
 */
test("actual webview keeps the direction row resident across the drag lifecycle", () => {
  const view = createHarness();
  try {
    const doc = view.dom.window.document;
    const direction = doc.getElementById("direction")!;
    const list = doc.getElementById("list")!;
    // Document order is load-bearing: a regression that moved #direction below
    // (or inside) #list would reintroduce a shift at drag start while every
    // behavioural assertion below still passed.
    assert.equal(direction.nextElementSibling, list, "#direction is the immediate previous sibling of #list");
    assert.equal(direction.classList.contains("hidden"), false, "the row is visible after ready");
    // At ready no state has arrived yet. The bootstrap default is commits: [],
    // which must not be mistaken for a genuinely empty timeline: show a neutral
    // one-line loading copy, never "", which would collapse the row's height and
    // move the list again when the first state lands.
    const beforeState = direction.textContent ?? "";
    assert.match(beforeState, /正在加载 commit/, "startup copy says loading, not 'no commits'");
    assert.equal(beforeState.length > 0, true, "the loading copy is not empty, so the row height stays constant");
    assert.equal(direction.getAttribute("aria-live"), "off", "the idle discovery copy is silent");

    view.postState(state([a, b, c], 7));
    assert.match(direction.textContent ?? "", /Alt\+↑↓/, "the first state switches from loading to the static drag hint");
    assert.doesNotMatch(direction.textContent ?? "", /正在加载 commit/, "the loading copy is gone once state arrived");
    assert.equal(direction.getAttribute("aria-live"), "off", "the static hint stays out of the live region");

    const sourceGrip = view.row(c).querySelector(".grip") as HTMLElement;
    const target = view.row(a);
    Object.defineProperty(doc, "elementFromPoint", { configurable: true, value: () => target });
    Object.defineProperty(target, "getBoundingClientRect", { configurable: true, value: () => ({ top: 10, height: 20 }) });

    sourceGrip.dispatchEvent(pointerEvent(view.dom.window, "pointerdown", { pointerId: 4, clientY: 0 }));
    assert.equal(direction.classList.contains("hidden"), false, "pointerdown never toggles the row's visibility");
    assert.match(direction.textContent ?? "", /正在移动/, "pointerdown swaps in the live grab hint");
    assert.doesNotMatch(direction.textContent ?? "", /Alt\+↑↓/, "the static hint is replaced while dragging");
    assert.equal(direction.getAttribute("aria-live"), "polite", "drag changes must still be announced");

    sourceGrip.dispatchEvent(pointerEvent(view.dom.window, "pointermove", { pointerId: 4, clientY: 0 }));
    assert.equal(direction.classList.contains("hidden"), false, "pointermove keeps the row resident");
    assert.match(direction.textContent ?? "", /移动到/, "pointermove shows the live insertion target");
    assert.equal(direction.getAttribute("aria-live"), "polite", "the insertion target is announced while dragging");

    // Back to no hit target so pointerup takes the endDrag path rather than
    // posting a reorder; the visible regression is the hint, not the payload.
    Object.defineProperty(doc, "elementFromPoint", { configurable: true, value: () => null });
    sourceGrip.dispatchEvent(pointerEvent(view.dom.window, "pointerup", { pointerId: 4, clientY: 0 }));
    assert.equal(direction.classList.contains("hidden"), false, "drag end keeps the row resident instead of re-hiding it");
    assert.match(direction.textContent ?? "", /Alt\+↑↓/, "drag end restores the static hint");
    assert.equal(direction.getAttribute("aria-live"), "off", "returning to idle silences the row; #live owns the completion announcement");
  } finally {
    view.close();
  }
});

test("the direction row states why reordering is unavailable instead of promising it", () => {
  const view = createHarness();
  try {
    const doc = view.dom.window.document;
    const direction = () => doc.getElementById("direction")!;

    view.postState(state([], 1));
    assert.match(direction().textContent ?? "", /没有可重排的 commit/, "an empty timeline has nothing to drag");

    view.postState(state([a, b, c], 2));
    assert.match(direction().textContent ?? "", /拖动 ⋮⋮ 重排/, "a draggable timeline gets the actionable hint");

    // applySearch() only calls renderList(), not render(). The hint must still
    // refresh, so renderDirection() has to hang off the list render.
    const search = view.row(a).closest("#list")!.querySelector(".commit-search") as HTMLInputElement;
    search.value = "no-such-commit";
    search.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
    assert.match(direction().textContent ?? "", /过滤中无法重排/, "an active filter stops claiming drag is available");
    assert.equal(direction().getAttribute("aria-live"), "off", "the unavailable copy is not a live announcement");

    const clear = [...doc.querySelectorAll<HTMLButtonElement>("#list button")].find((b) => b.textContent === "清除");
    assert.ok(clear, "the filter renders a clear button");
    clear!.click();
    assert.match(direction().textContent ?? "", /拖动 ⋮⋮ 重排/, "clearing the filter restores the actionable hint");

    // A rebase only arrives through render(), never through the filter path.
    view.postState({ ...state([a, b, c], 3), rebaseInProgress: true });
    assert.match(direction().textContent ?? "", /变基进行中 · 重排已禁用/, "a running rebase disables reordering");
    assert.equal(direction().getAttribute("aria-live"), "off", "the disabled copy is not a live announcement");
  } finally {
    view.close();
  }
});

test("an empty timeline never points at the filter controls it does not render", () => {
  const view = createHarness();
  try {
    const doc = view.dom.window.document;
    const direction = () => doc.getElementById("direction")!;
    view.postState(state([a, b, c], 1));
    const search = doc.querySelector("#list .commit-search") as HTMLInputElement;
    search.value = "persisted-filter";
    search.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
    assert.match(direction().textContent ?? "", /过滤中无法重排/, "an active filter is reported while its controls exist");

    // The filter lives in the webview's saved UI state, so a refresh can return
    // an empty commit list while it is still active. renderList() returns before
    // building the search input or its clear button; the copy must not send the
    // user to a control that is not on screen.
    view.postState(state([], 2));
    assert.match(direction().textContent ?? "", /没有可重排的 commit/, "an empty timeline wins over the stale filter copy");
    assert.doesNotMatch(direction().textContent ?? "", /清空搜索后可用/, "the copy does not point at a missing clear button");
    assert.equal(doc.querySelector("#list .commit-search"), null, "the empty list really renders no search input");
    assert.equal([...doc.querySelectorAll("#list button")].some((b) => b.textContent === "清除"), false, "and no clear button");
  } finally {
    view.close();
  }
});

test("pointercancel and native dragstart/dragend close the drag session and its live hint", () => {
  const view = createHarness();
  try {
    const doc = view.dom.window.document;
    const direction = doc.getElementById("direction")!;
    const reorders = () => view.messages.filter((message) => message.type === "reorder");
    view.postState(state([a, b, c], 4));
    const grip = () => view.row(c).querySelector(".grip") as HTMLElement;

    // A cancelled pointer abandons the drag: nothing is posted and the row goes
    // back to its silent idle copy.
    grip().dispatchEvent(pointerEvent(view.dom.window, "pointerdown", { pointerId: 9, clientY: 0 }));
    assert.equal(view.dom.window.__grvUiTrace().dragging, true, "pointerdown starts a drag session");
    assert.equal(direction.getAttribute("aria-live"), "polite", "the drag session is announced");
    grip().dispatchEvent(pointerEvent(view.dom.window, "pointercancel", { pointerId: 9, clientY: 0 }));
    assert.equal(view.dom.window.__grvUiTrace().dragging, false, "pointercancel ends the session");
    assert.match(direction.textContent ?? "", /Alt\+↑↓/, "pointercancel restores the idle copy");
    assert.equal(direction.getAttribute("aria-live"), "off", "pointercancel silences the row again");
    assert.deepEqual(reorders(), [], "pointercancel posts no reorder");

    // Native HTML5 drag: dragstart opens the session and the live hint; dragend
    // closes it even when no drop ever happened.
    const dataTransfer = { effectAllowed: "", setData() {} };
    grip().dispatchEvent(mouseEvent(view.dom.window, "dragstart", { dataTransfer }));
    assert.equal(view.dom.window.__grvUiTrace().dragging, true, "native dragstart starts a drag session");
    assert.match(direction.textContent ?? "", /正在移动/, "native dragstart shows the live grab hint");
    assert.equal(direction.getAttribute("aria-live"), "polite", "the native drag session is announced");
    grip().dispatchEvent(mouseEvent(view.dom.window, "dragend", { dataTransfer }));
    assert.equal(view.dom.window.__grvUiTrace().dragging, false, "native dragend ends the session");
    assert.match(direction.textContent ?? "", /Alt\+↑↓/, "native dragend restores the idle copy");
    assert.equal(direction.getAttribute("aria-live"), "off", "native dragend silences the row again");
    assert.deepEqual(reorders(), [], "an abandoned native drag posts no reorder");
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
    const menu = view.dom.window.document.getElementById("menu");
    assert.equal(menu?.classList.contains("hidden"), false, "the sidebar's own menu opens in place");
    assert.match(menu?.textContent ?? "", new RegExp(c.slice(0, 8)));
    assert.doesNotMatch(menu?.textContent ?? "", /批量删除/);
    const singleGeneratedDiff = [...view.dom.window.document.querySelectorAll<HTMLButtonElement>("#menu button")]
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
    // AI exists in exactly two executable places; the batch menu has no entry
    // at all, not even a disabled placeholder.
    assert.doesNotMatch(menuText, /AI 生成 message/, "the batch menu has no AI entry");
    const edit = [...view.dom.window.document.querySelectorAll<HTMLButtonElement>("#menu button")].find((button) => button.textContent?.includes("编辑 message"));
    assert.ok(edit?.classList.contains("disabled"), "single-commit action is disabled for a retained batch");
    const bulkGeneratedDiff = [...view.dom.window.document.querySelectorAll<HTMLButtonElement>("#menu button")]
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

test("actual webview hover requests and renders detail in the sidebar tooltip", async () => {
  const view = createHarness();
  try {
    view.postState(state([a, b, c], 3));
    view.messages.length = 0;
    view.row(c).dispatchEvent(mouseEvent(view.dom.window, "mouseenter"));
    await new Promise((resolve) => setTimeout(resolve, 420));
    assert.deepEqual(
      JSON.parse(JSON.stringify(view.messages.filter((message) => message.type === "requestDetail").at(-1))),
      { type: "requestDetail", hash: c, source: "webview:read" },
      "hover asks the host for commit detail after the 400ms delay"
    );
    assert.equal(
      view.messages.some((message) => message.type === "openCommitInspector"),
      false,
      "no editor-area panel is opened"
    );

    view.postState({
      type: "detail",
      hash: c,
      author: "Carol",
      relDate: "1 hour ago",
      absDate: "today",
      stat: "2 files changed, 3 insertions(+), 1 deletion(-)",
      message: "subject-c\n\nbody",
    });
    const tooltip = view.dom.window.document.getElementById("tooltip");
    assert.equal(tooltip?.classList.contains("hidden"), false, "detail renders in the sidebar tooltip");
    assert.match(tooltip?.textContent ?? "", /subject-c/);
    assert.match(tooltip?.textContent ?? "", /Carol/);
    assert.match(tooltip?.textContent ?? "", /2 files · \+3 −1/);

    view.postState({
      type: "detail",
      hash: a,
      author: "Alice",
      relDate: "1 hour ago",
      absDate: "today",
      stat: "1 file changed",
      message: "stale",
    });
    assert.doesNotMatch(tooltip?.textContent ?? "", /stale/, "a late detail for another row is ignored");

    view.row(c).dispatchEvent(mouseEvent(view.dom.window, "mouseleave"));
    await new Promise((resolve) => setTimeout(resolve, 240));
    assert.equal(tooltip?.classList.contains("hidden"), true, "leaving the row hides the tooltip");
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
    assert.deepEqual(JSON.parse(JSON.stringify(view.messages.at(-1))), { type: "restoreFile", path: "tmp/generated.bin", side: "working", deleteUntracked: true, source: "webview:worktree-mutation" });
  } finally {
    view.close();
  }
});

/**
 * The user asked for AI-generated commit messages in exactly two places:
 *
 *   1. a commit's context menu — `AI 生成 message…`; and
 *   2. the Staged Changes group — `✦ AI 生成 message 并提交暂存区`, next to
 *      unstage.
 *
 * The old draft-only entry (`AI 仅生成 message（不提交）`) is gone from both the
 * edit-stop banner and 更多提交选项. This matrix keeps the per-state coverage the
 * old draft-entry test provided (idle with all/none/mixed staged, paused,
 * conflict, edit stop) but now asserts the absence of that entry and the exact
 * payloads of the two allowed ones. It is deliberately per region: a paused edit
 * stop must not grow a banner AI action while the normal Staged Changes entry
 * stays available.
 */
test("only the two allowed AI compose entries exist in every UI state", () => {
  const view = createHarness();
  try {
    // Icon buttons (`✦`, `↶`) carry their meaning in `aria-label`, not
    // textContent, so search both. Do not search `title`: ordinary buttons use
    // it for tooltip prose (the edit-stop 新建 commit tooltip mentions AI)
    // without being an AI entry.
    const buttonLabel = (button: HTMLButtonElement): string =>
      [button.textContent ?? "", button.getAttribute("aria-label") ?? ""].join(" ");
    const textButtons = (region: string, predicate: (text: string) => boolean): HTMLButtonElement[] =>
      [...view.dom.window.document.querySelectorAll(`${region} button`)]
        .filter((button) => predicate(buttonLabel(button as HTMLButtonElement))) as HTMLButtonElement[];
    const draftButtons = (region: string) => textButtons(region, (text) => text.includes("仅生成 message"));
    const aiButtons = (region: string) => textButtons(region, (text) => text.includes("AI"));

    const files = {
      both: [
        { path: "src/a.ts", staged: true, unstaged: false, indexKind: "add", conflicted: false },
        { path: "src/b.ts", staged: false, unstaged: true, worktreeKind: "modify", conflicted: false },
      ],
      stagedOnly: [{ path: "src/a.ts", staged: true, unstaged: false, indexKind: "add", conflicted: false }],
      workingOnly: [{ path: "src/b.ts", staged: false, unstaged: true, worktreeKind: "modify", conflicted: false }],
    };

    const cases: {
      name: string;
      expectStagedEntry: number;
      extra: Record<string, unknown>;
    }[] = [
      { name: "idle, all staged", expectStagedEntry: 1, extra: { hasStaged: true, hasUnstaged: false, stagedCount: 1, unstagedCount: 0, changes: files.stagedOnly } },
      { name: "idle, nothing staged", expectStagedEntry: 0, extra: { hasStaged: false, hasUnstaged: true, stagedCount: 0, unstagedCount: 1, changes: files.workingOnly } },
      { name: "idle, mixed", expectStagedEntry: 1, extra: { hasStaged: true, hasUnstaged: true, stagedCount: 1, unstagedCount: 1, changes: files.both } },
      { name: "rebase paused", expectStagedEntry: 1, extra: { rebaseInProgress: true, pausedReason: "paused", hasStaged: true, hasUnstaged: false, stagedCount: 1, unstagedCount: 0, changes: files.stagedOnly } },
      { name: "rebase paused, working only", expectStagedEntry: 0, extra: { rebaseInProgress: true, pausedReason: "paused", hasStaged: false, hasUnstaged: true, stagedCount: 0, unstagedCount: 1, changes: files.workingOnly } },
      { name: "conflict", expectStagedEntry: 1, extra: { rebaseInProgress: true, pausedReason: "conflict", conflictCount: 1, conflictFiles: ["src/a.ts"], hasStaged: true, hasUnstaged: true, stagedCount: 1, unstagedCount: 1, changes: files.both } },
      { name: "edit stop", expectStagedEntry: 1, extra: { rebaseInProgress: true, pausedReason: "edit", stoppedAt: a, hasStaged: true, hasUnstaged: false, stagedCount: 1, unstagedCount: 0, changes: files.stagedOnly } },
    ];

    for (const [index, item] of cases.entries()) {
      const next = state([a], 60 + index);
      Object.assign(next, item.extra);
      view.postState(next);

      // The draft-only entry is gone everywhere, including 更多提交选项 and the
      // edit-stop banner.
      assert.deepEqual(draftButtons("#changes"), [], `${item.name}: no draft-only entry in Changes/更多提交选项`);
      assert.deepEqual(draftButtons("#banner"), [], `${item.name}: no draft-only entry in the banner`);
      assert.deepEqual(aiButtons("#banner"), [], `${item.name}: no AI action in the banner, even at an edit stop`);

      const stagedEntries = aiButtons("#changes");
      assert.equal(stagedEntries.length, item.expectStagedEntry, `${item.name}: Staged Changes AI entry count`);
      if (item.expectStagedEntry) {
        assert.match(stagedEntries[0].getAttribute("aria-label") ?? "", /AI 生成 message 并提交暂存区/, `${item.name}: the staged entry keeps its label`);
        const header = stagedEntries[0].closest(".file-group-header") as HTMLElement;
        const headerButtons = [...header.querySelectorAll("button")];
        assert.equal(headerButtons.indexOf(stagedEntries[0]), 1, `${item.name}: the AI entry sits next to restore/unstage`);
        assert.equal(headerButtons[0].getAttribute("aria-label"), "撤销全部暂存", `${item.name}: its neighbour is still unstage`);
        stagedEntries[0].click();
        const posted = JSON.parse(JSON.stringify(view.messages.at(-1)));
        assert.equal(posted.type, "openCompose", `${item.name}: the staged entry opens Compose`);
        assert.equal(posted.mode, "staged", `${item.name}: it composes from the index`);
        assert.equal(posted.ai, true, `${item.name}: it is the AI entry`);
        assert.equal(posted.thenEdit, false, `${item.name}: it applies a commit, not an edit stop`);
        assert.equal("messageOnly" in posted, false, `${item.name}: the removed draft-only mode is not sent`);
      }

      // The other allowed entry is the commit context menu: executable outside
      // a pause, disabled with an explanation once a rebase is in progress.
      view.row(a).dispatchEvent(mouseEvent(view.dom.window, "contextmenu", { clientX: 10, clientY: 10 }));
      assert.deepEqual(draftButtons("#menu"), [], `${item.name}: no draft-only entry in the context menu`);
      const menuAi = textButtons("#menu", (text) => text.includes("AI 生成 message…"));
      assert.equal(menuAi.length, 1, `${item.name}: the single-commit menu has the one AI entry`);
      if (item.extra.rebaseInProgress) {
        assert.ok(menuAi[0].classList.contains("disabled"), `${item.name}: the AI entry is disabled during a paused rebase`);
        assert.equal(
          menuAi[0].title,
          "变基进行中；如需 AI message，请先暂存改动并使用暂存区的 ✦",
          `${item.name}: and points at the staged route`
        );
        view.messages.length = 0;
        menuAi[0].click();
        assert.deepEqual(view.messages, [], `${item.name}: a disabled AI entry posts nothing`);
      } else {
        assert.equal(menuAi[0].classList.contains("disabled"), false, `${item.name}: the AI entry stays enabled normally`);
        menuAi[0].click();
        const fromMenu = JSON.parse(JSON.stringify(view.messages.at(-1)));
        assert.equal(fromMenu.type, "openCompose", `${item.name}: the menu opens Compose`);
        assert.equal(fromMenu.mode, "commit", `${item.name}: it composes for the commit`);
        assert.equal(fromMenu.hash, a, `${item.name}: it targets the right-clicked commit`);
        assert.equal(fromMenu.ai, true, `${item.name}: it is the AI entry`);
        assert.equal(fromMenu.thenEdit, false, `${item.name}: it rewrites the message`);
        assert.equal("messageOnly" in fromMenu, false, `${item.name}: the removed draft-only mode is not sent`);
      }
    }
  } finally {
    view.close();
  }
});

/**
 * The panel's group key is `staged`/`unstaged`; the host's restore vocabulary
 * is `staged`/`working` (`restoreWorktreeChange`). Posting the group key through
 * unchanged made every Changes-side restore fail host validation with
 * 缺少要恢复的文件状态, which is what clicking the untracked file's ⌫ reported.
 * These three actions are the whole surface that reaches `restoreFile`.
 */
test("every restore action posts the host's side vocabulary", () => {
  const view = createHarness();
  try {
    const next = state([a], 5);
    Object.assign(next, {
      hasStaged: true,
      hasUnstaged: true,
      stagedCount: 1,
      unstagedCount: 2,
      changes: [
        { path: "src/staged.ts", staged: true, unstaged: false, indexKind: "add", conflicted: false },
        { path: "src/modified.ts", staged: false, unstaged: true, worktreeKind: "modify", conflicted: false },
        { path: "tmp/untracked.bin", staged: false, unstaged: true, worktreeKind: "untracked", conflicted: false },
      ],
    });
    view.postState(next);
    const details = view.dom.window.document.querySelector(".changes-more") as HTMLDetailsElement;
    details.open = true;

    const actionFor = (path: string, label: string): HTMLButtonElement => {
      const row = [...view.dom.window.document.querySelectorAll(".change-file")]
        .find((candidate) => candidate.querySelector(".file-open")?.getAttribute("title") === path);
      assert.ok(row, `row for ${path} exists`);
      const action = [...row.querySelectorAll(".file-action")]
        .find((candidate) => candidate.getAttribute("aria-label") === label);
      assert.ok(action, `${label} exists on ${path}`);
      return action as HTMLButtonElement;
    };

    // ↶ in Changes: restore the working-tree half.
    actionFor("src/modified.ts", "恢复此文件的工作区改动").click();
    assert.deepEqual(JSON.parse(JSON.stringify(view.messages.at(-1))), {
      type: "restoreFile", path: "src/modified.ts", side: "working", deleteUntracked: false, source: "webview:worktree-mutation",
    });

    // ⌫ on an untracked file: the delete is the working-side restore plus the flag.
    actionFor("tmp/untracked.bin", "删除未跟踪文件").click();
    assert.deepEqual(JSON.parse(JSON.stringify(view.messages.at(-1))), {
      type: "restoreFile", path: "tmp/untracked.bin", side: "working", deleteUntracked: true, source: "webview:worktree-mutation",
    });

    // ↶ in Staged Changes: unstage, which is the one side that stays `staged`.
    actionFor("src/staged.ts", "撤销此文件的暂存").click();
    assert.deepEqual(JSON.parse(JSON.stringify(view.messages.at(-1))), {
      type: "restoreFile", path: "src/staged.ts", side: "staged", deleteUntracked: false, source: "webview:worktree-mutation",
    });
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

test("a locked run holding a not-yet-replayed commit says so after the author list", () => {
  const view = createHarness();
  try {
    const next = state([a, b, c], 5);
    const commits = next.commits as Array<Record<string, unknown>>;
    commits.forEach((commit, index) => { commit.locked = true; commit.author = ["lawrence_lv", "sally_peng", "yucheng_xiang"][index]; });
    // `b` is pending: Git has not replayed it yet, so the run must not look stable.
    Object.assign(next, { collapseLockedRuns: true, pendingHashes: [b] });
    view.postState(next);
    const summary = (view.dom.window.document.querySelector(".locked-run summary"))!;
    assert.match(
      summary.textContent ?? "",
      /^🔒 : 3 lock · no push · la ×1 · sa ×1 · yu ×1 · replay$/,
      "the replay suffix follows the authors, separated by the same dot"
    );
    // The accessible name must carry the same fact; the row labels already say
    // 待重放, so the run summary dropping it silently was a real gap.
    const aria = summary.getAttribute("aria-label") ?? "";
    assert.match(aria, /尚未重放/, "the accessible name says the run is not fully replayed");
    assert.match(aria, /不会(被)?推送/, "and keeps the existing 'will not be pushed' fact");
  } finally {
    view.close();
  }
});

test("actual webview shows a dismissible recovery banner without hiding the commit list", () => {
  const view = createHarness();
  try {
    const pending = state([a, b, c], 4);
    Object.assign(pending, { recoveryNotice: "追加事务未完成，原始改动仍保存在 stash@{0}（stash: abc1234）。" });
    view.postState(pending);

    const banner = view.dom.window.document.getElementById("banner")!;
    assert.equal(banner.classList.contains("hidden"), false);
    assert.equal(banner.classList.contains("recovery"), true);
    assert.match(banner.textContent ?? "", /待恢复的改动/);
    assert.match(banner.textContent ?? "", /stash@\{0\}/);
    assert.equal(view.dom.window.document.querySelectorAll(".commit").length, 3, "stale bookkeeping never hides history");

    const buttons = [...banner.querySelectorAll("button")];
    buttons.find((button) => button.textContent === "打开日志")!.click();
    buttons.find((button) => button.textContent === "关闭提示")!.click();
    assert.deepEqual(
      view.messages.slice(-2).map((message) => message.type),
      ["openLogs", "dismissRecoveryNotice"]
    );

    const dismissed = { ...state([a, b, c], 5), recoveryNotice: undefined };
    view.postState(dismissed);
    assert.equal(view.dom.window.document.getElementById("banner")!.classList.contains("hidden"), true);
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

    const generatedDiff = [...view.dom.window.document.querySelectorAll<HTMLButtonElement>("#menu button")]
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

test("a state without a commit list renders the banner and the reason instead of throwing", () => {
  // Four provider sites post `{type:"state", error}` with no `commits` at all:
  // no workspace folder, not a git repository, a failed `resolveRange`, and a
  // failed `getCommits` (the last one now also carries `...presentation`). The
  // render order is banner → context → changes → list, so the user already sees
  // the error and the upstream note when the list previously threw
  // `Cannot read properties of undefined (reading 'map')` — a half-rendered
  // screen plus a console error.
  const view = createHarness();
  try {
    const errors: unknown[] = [];
    view.dom.window.addEventListener("error", (event) => errors.push((event as ErrorEvent).error ?? "error"));

    view.postState({
      type: "state",
      error: "git rev-list origin/master...HEAD failed (128): fatal: ... is corrupt",
      rebaseInProgress: false,
      branchName: "master",
      upstreamRef: "origin/master",
      aheadCount: 0,
      behindCount: 0,
      upstreamNote: "无法计算与 origin/master 的领先/落后（fatal: ... is corrupt）",
      rangeLabel: "范围：upstream..HEAD",
    });

    const banner = view.dom.window.document.getElementById("banner")!;
    assert.match(banner.textContent ?? "", /git rev-list origin\/master\.\.\.HEAD failed/, "the reason is on screen");
    const context = view.dom.window.document.getElementById("context-text")!;
    assert.match(context.textContent ?? "", /↑\? ↓\?/, "the context bar rendered too");
    // The whole point: rendering completed rather than aborting in `renderList`.
    const list = view.dom.window.document.getElementById("list")!;
    assert.equal(list.querySelector(".empty")?.textContent, "没有可显示的 commit。", "the list renders its empty state, not a throw");
    assert.deepEqual(errors, [], "no uncaught error escaped render()");

    // The `rebaseInProgress` variant is strictly worse and must be covered too:
    // `renderBanner` reads `state.commits` to find the stopped commit, and it is
    // the first thing render() does — so the throw happens before the error text
    // is painted, leaving an empty banner. `resolveRange` / `getCommits` post
    // exactly this shape while a rebase is paused.
    view.postState({
      type: "state",
      error: "git rev-list origin/master...HEAD failed (128): fatal: ... is corrupt",
      rebaseInProgress: true,
      branchName: "master",
      upstreamRef: "origin/master",
      aheadCount: 0,
      behindCount: 0,
      upstreamNote: "无法计算与 origin/master 的领先/落后（fatal: ... is corrupt）",
      rangeLabel: "范围：upstream..HEAD",
    });
    // During a paused rebase the banner is the rebase banner, which does not
    // carry `error` (pre-existing precedence, unchanged here). The failure is
    // still visible through the context note, and the point of this half is that
    // neither the banner nor the list throws before painting.
    assert.match(banner.textContent ?? "", /变基进行中/, "the rebase banner painted");
    assert.match(context.textContent ?? "", /↑\? ↓\?/, "the note still reaches the context bar");
    assert.equal(list.querySelector(".empty")?.textContent, "没有可显示的 commit。", "and still renders a list");
    assert.deepEqual(errors, [], "no uncaught error escaped either render()");
  } finally {
    view.close();
  }
});

test("actual webview replaces the ahead/behind arrows with the reason when the range cannot be computed", () => {
  const view = createHarness();
  try {
    // `upstreamNote` and the real counts are mutually exclusive by construction.
    // Rendering "↑0 ↓0" next to "cannot compute the range" is the defect: 0/0
    // is indistinguishable from "in sync", so the note would lose.
    view.postState({ ...state([a, b, c], 2), branchName: "master", upstreamRef: "-evil/master", aheadCount: 0, behindCount: 0, rangeLabel: "范围：upstream..HEAD" });
    const text = () => view.dom.window.document.getElementById("context-text")!.textContent ?? "";
    assert.match(text(), /↑0 ↓0/, "the healthy shape still shows the real counts");

    view.postState({
      ...state([a, b, c], 3),
      branchName: "master",
      upstreamRef: "-evil/master",
      aheadCount: 0,
      behindCount: 0,
      upstreamNote: "无法计算与 -evil/master 的领先/落后（usage: git rev-list …）",
      rangeLabel: "范围：upstream..HEAD",
    });
    const shown = text();
    assert.equal(/↑0 ↓0/.test(shown), false, "the misleading zeroes are gone; saw " + shown);
    assert.match(shown, /↑\? ↓\?/, "the counts are marked unknown; saw " + shown);
    assert.match(shown, /无法计算与 -evil\/master 的领先\/落后/, "the reason is visible; saw " + shown);
  } finally {
    view.close();
  }
});

test("the menu grows from the pointer but skips the animation when opened from the keyboard", () => {
  const pointerView = createHarness();
  try {
    pointerView.postState(state([a, b, c], 3));
    const menu = pointerView.dom.window.document.getElementById("menu")!;
    pointerView.row(b).dispatchEvent(mouseEvent(pointerView.dom.window, "contextmenu", { clientX: 100, clientY: 200 }));
    assert.equal(menu.classList.contains("hidden"), false, "a pointer right-click opens the menu");
    // `openMenu` writes the clamped offset of the trigger point inside the menu;
    // jsdom reports zero-size boxes, so the value is "0px 0px" here, but the
    // shape and the property are what the CSS `transform-origin` consumes.
    assert.match(menu.style.getPropertyValue("--grv-origin"), /^\d+px \d+px$/, "the pop-in origin is set from the click point");
    assert.notEqual(menu.dataset.instant, "true", "a pointer menu keeps its entrance animation");
  } finally {
    pointerView.close();
  }

  const keyboardView = createHarness();
  try {
    keyboardView.postState(state([a, b, c], 3));
    const menu = keyboardView.dom.window.document.getElementById("menu")!;
    keyboardView.row(c).dispatchEvent(new keyboardView.dom.window.KeyboardEvent("keydown", {
      key: "ContextMenu",
      bubbles: true,
      cancelable: true,
    }));
    assert.equal(menu.classList.contains("hidden"), false, "the ContextMenu key opens the menu");
    assert.equal(menu.dataset.instant, "true", "a keyboard menu suppresses the entrance animation");
  } finally {
    keyboardView.close();
  }
});

test("a second tooltip request within the grace window skips the 400ms anti-misfire delay", async () => {
  const view = createHarness();
  try {
    view.postState(state([a, b, c], 3));
    view.messages.length = 0;
    view.row(c).dispatchEvent(mouseEvent(view.dom.window, "mouseenter"));
    await new Promise((resolve) => setTimeout(resolve, 420));
    assert.deepEqual(
      view.messages.filter((message) => message.type === "requestDetail").map((message) => message.hash),
      [c],
      "the first hover still waits the full 400ms"
    );

    // Leaving hides the tooltip after its own 200ms grace and arms the window.
    view.row(c).dispatchEvent(mouseEvent(view.dom.window, "mouseleave"));
    await new Promise((resolve) => setTimeout(resolve, 240));
    view.messages.length = 0;

    view.row(b).dispatchEvent(mouseEvent(view.dom.window, "mouseenter"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      view.messages.filter((message) => message.type === "requestDetail").map((message) => message.hash),
      [b],
      "the next hover requests detail immediately instead of paying 400ms again"
    );
  } finally {
    view.close();
  }
});

test("the tooltip pops in from the row-facing edge and flips its origin when placed above", () => {
  const view = createHarness();
  try {
    view.postState(state([a, b, c], 3));
    view.messages.length = 0;
    view.row(c).dispatchEvent(mouseEvent(view.dom.window, "mouseenter"));
    const detail = {
      type: "detail",
      hash: c,
      author: "Carol",
      relDate: "1 hour ago",
      absDate: "today",
      stat: "1 file changed",
      message: "subject-c",
    };
    view.postState(detail);
    const tooltip = view.dom.window.document.getElementById("tooltip")!;
    assert.equal(tooltip.classList.contains("hidden"), false, "the detail renders");
    assert.equal(tooltip.style.getPropertyValue("--grv-origin"), "left top", "below the row, it grows from its top edge");

    // jsdom always reports offsetHeight 0, so the real fit check cannot flip.
    // Shrinking the viewport below `topPos + th` makes the flip branch observable
    // without depending on layout that this environment does not implement.
    Object.defineProperty(view.dom.window, "innerHeight", { configurable: true, value: 1 });
    view.postState(detail);
    assert.equal(tooltip.style.getPropertyValue("--grv-origin"), "left bottom", "flipped above the row, it grows from its bottom edge");
  } finally {
    view.close();
  }
});
