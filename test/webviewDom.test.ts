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
 * `messageOnly` is the only compose entry that produces a message without
 * writing to Git; every other entry ends in a commit. It must therefore exist
 * wherever the panel offers no other draft route, and may be omitted only where
 * it is genuinely redundant.
 *
 * This matrix is the regression guard for a real defect: the entry was once
 * removed from every non-edit-stop state, which silently deleted both the only
 * `mode: "working"` draft (nothing staged) and the only draft path during a
 * conflict or plain pause. The counts are per region because an edit stop
 * legitimately renders the entry twice — banner and Changes group — and both
 * post the same message.
 */
test("the draft-only entry appears in every state that has no other draft route", () => {
  const view = createHarness();
  try {
    const draftButtons = (region: string): HTMLButtonElement[] =>
      [...view.dom.window.document.querySelectorAll(`${region} button`)]
        .filter((button) => (button.textContent ?? "").includes("仅生成 message")) as HTMLButtonElement[];

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
      expectChanges: number;
      expectBanner: number;
      expectMode?: string;
      extra: Record<string, unknown>;
    }[] = [
      // The one state where the entry duplicated Staged Changes' ✦: idle with
      // everything staged, so nothing is added by a second draft route.
      { name: "idle, all staged", expectChanges: 0, expectBanner: 0, extra: { hasStaged: true, hasUnstaged: false, stagedCount: 1, unstagedCount: 0, changes: files.stagedOnly } },
      // Nothing staged: `mode: "working"` is the only draft onto the worktree.
      { name: "idle, nothing staged", expectChanges: 1, expectBanner: 0, expectMode: "working", extra: { hasStaged: false, hasUnstaged: true, stagedCount: 0, unstagedCount: 1, changes: files.workingOnly } },
      // Mixed idle: still offered, because the worktree has changes of its own
      // and this is the only entry that can draft against the working side.
      { name: "idle, mixed", expectChanges: 1, expectBanner: 0, expectMode: "staged", extra: { hasStaged: true, hasUnstaged: true, stagedCount: 1, unstagedCount: 1, changes: files.both } },
      // A paused rebase offers only Continue/Skip/Abort in the banner, and the
      // host's pause policy rejects every other compose entry.
      { name: "rebase paused", expectChanges: 1, expectBanner: 0, expectMode: "staged", extra: { rebaseInProgress: true, pausedReason: "paused", hasStaged: true, hasUnstaged: false, stagedCount: 1, unstagedCount: 0, changes: files.stagedOnly } },
      { name: "rebase paused, working only", expectChanges: 1, expectBanner: 0, expectMode: "working", extra: { rebaseInProgress: true, pausedReason: "paused", hasStaged: false, hasUnstaged: true, stagedCount: 0, unstagedCount: 1, changes: files.workingOnly } },
      // A conflict is the state where "wait until resolved" would otherwise
      // leave no way to draft at all. The host still refuses AI generation
      // until the conflict is resolved, which is what its own message says.
      { name: "conflict", expectChanges: 1, expectBanner: 0, expectMode: "staged", extra: { rebaseInProgress: true, pausedReason: "conflict", conflictCount: 1, conflictFiles: ["src/a.ts"], hasStaged: true, hasUnstaged: true, stagedCount: 1, unstagedCount: 1, changes: files.both } },
      // An edit stop adds the banner copy on top of the Changes one.
      { name: "edit stop", expectChanges: 1, expectBanner: 1, expectMode: "staged", extra: { rebaseInProgress: true, pausedReason: "edit", stoppedAt: a, hasStaged: true, hasUnstaged: false, stagedCount: 1, unstagedCount: 0, changes: files.stagedOnly } },
    ];

    for (const [index, item] of cases.entries()) {
      const next = state([a], 60 + index);
      Object.assign(next, item.extra);
      view.postState(next);

      const inChanges = draftButtons("#changes");
      const inBanner = draftButtons("#banner");
      assert.equal(inChanges.length, item.expectChanges, `${item.name}: Changes-group count`);
      assert.equal(inBanner.length, item.expectBanner, `${item.name}: banner count`);

      if (!item.expectMode) {
        assert.equal(inChanges.length + inBanner.length, 0, `${item.name}: no draft entry anywhere`);
        continue;
      }
      inChanges[0].click();
      const posted = JSON.parse(JSON.stringify(view.messages.at(-1)));
      assert.equal(posted.type, "openCompose", `${item.name}: opens the compose panel`);
      assert.equal(posted.mode, item.expectMode, `${item.name}: drafts against the right side`);
      assert.equal(posted.messageOnly, true, `${item.name}: never writes to Git`);
      assert.equal(posted.ai, true, `${item.name}: it is the AI draft route`);

      if (item.expectBanner === 1) {
        inBanner[0].click();
        assert.deepEqual(
          JSON.parse(JSON.stringify(view.messages.at(-1))),
          posted,
          `${item.name}: the banner and Changes copies post the same request`
        );
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
