import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createExtensionContext, installVscodeStub, resetStub, stub } from "./helpers/vscodeStub";

installVscodeStub();

const { RebaseViewProvider } = require("../src/ui/rebaseViewProvider") as typeof import("../src/ui/rebaseViewProvider");
const { LockStore } = require("../src/lock/lockStore") as typeof import("../src/lock/lockStore");
const { createGitContentRequestStore } = require("../src/ui/gitDiffRequestState") as typeof import("../src/ui/gitDiffRequestState");
const { createGeneratedDiffSnapshotStore } = require("../src/ui/generatedDiffDocument") as typeof import("../src/ui/generatedDiffDocument");
const { commitFile, createRepo, git, removeRepo } = require("./helpers/gitTestRepo") as typeof import("./helpers/gitTestRepo");
const { getWorktreeChanges } = require("../src/git/worktreeChanges") as typeof import("../src/git/worktreeChanges");

const root = path.resolve(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "media", "main.js"), "utf8");

/**
 * The restore actions used to post the panel's group key (`unstaged`) while the
 * host accepted only `working`/`staged`. The webview DOM test pins the message
 * shape; this test drives that same message into the real host handler, which is
 * where 缺少要恢复的文件状态 was reported. A shape that only satisfies the
 * assertion above would fail here.
 */
interface Harness {
  cwd: string;
  provider: InstanceType<typeof RebaseViewProvider>;
  webview(): { dom: JSDOM; messages: any[]; postState(state: Record<string, unknown>): void };
}

function createHarness(t: { after: (fn: () => void) => void }): Harness {
  resetStub();
  const cwd = createRepo();
  stub.workspaceFolders = [{ uri: { fsPath: cwd } }];
  const ctx = createExtensionContext();
  const provider = new RebaseViewProvider(
    ctx as any,
    new LockStore(ctx.globalState as any),
    createGitContentRequestStore(),
    createGeneratedDiffSnapshotStore()
  );
  const toasts: string[] = [];
  (provider as any).postInlineToast = (message: string) => toasts.push(message);
  // `toast` is module-level and resolves its sink from the active provider, so
  // the harness must record through the same capture for assertions.
  (stub as any).__toasts = toasts;
  t.after(async () => {
    await (provider as any).recoveryPass?.catch?.(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      removeRepo(cwd);
    } catch {
      // A leftover temp dir is not a test failure.
    }
  });

  return {
    cwd,
    provider,
    webview() {
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
      Object.defineProperty(window.document, "elementFromPoint", { configurable: true, value: () => null });
      window.eval(mainSource);
      messages.length = 0;
      return {
        dom,
        messages,
        postState(next: Record<string, unknown>) {
          window.dispatchEvent(new window.MessageEvent("message", { data: next }));
        },
      };
    },
  };
}

function changeRow(view: ReturnType<Harness["webview"]>, filePath: string): HTMLElement {
  const row = [...view.dom.window.document.querySelectorAll(".change-file")]
    .find((candidate) => candidate.querySelector(".file-open")?.getAttribute("title") === filePath);
  assert.ok(row, `row for ${filePath} exists`);
  return row as HTMLElement;
}

function action(view: ReturnType<Harness["webview"]>, filePath: string, label: string): HTMLButtonElement {
  const found = [...changeRow(view, filePath).querySelectorAll(".file-action")]
    .find((candidate) => candidate.getAttribute("aria-label") === label);
  assert.ok(found, `${label} exists on ${filePath}`);
  return found as HTMLButtonElement;
}

function state(changes: unknown[]): Record<string, unknown> {
  return {
    type: "state",
    canonicalRevision: 1,
    canonicalOrder: ["a".repeat(40)],
    commits: [],
    rebaseInProgress: false,
    llmConfigured: true,
    hasStaged: true,
    hasUnstaged: true,
    stagedCount: 1,
    unstagedCount: 2,
    // The panel renders these rows and posts their actions. The host answers
    // from Git, but the message must be the webview's own.
    changes: (changes as any[]).map((change) => ({
      path: change.path,
      staged: change.staged,
      unstaged: change.unstaged,
      indexKind: change.indexKind,
      worktreeKind: change.worktreeKind,
      conflicted: change.conflicted,
    })),
  };
}

test("the host accepts each restore action the webview posts", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  // Both files are committed first, then each side gets its own change: the
  // staging below must not be swept into a later commit.
  commitFile(cwd, "staged.ts", "base\n", "add staged");
  commitFile(cwd, "modified.ts", "base\n", "add modified");
  fs.writeFileSync(path.join(cwd, "staged.ts"), "changed\n", "utf8");
  git(cwd, ["add", "staged.ts"]);
  // One working-side tracked edit and one untracked file, mirroring the report.
  fs.writeFileSync(path.join(cwd, "modified.ts"), "edited\n", "utf8");
  fs.writeFileSync(path.join(cwd, "untracked.bin"), "untracked\n", "utf8");

  const changes = await getWorktreeChanges(cwd);
  assert.deepEqual(
    changes.map((change) => [change.path, change.staged, change.unstaged, change.worktreeKind]).sort(),
    [
      ["modified.ts", false, true, "modify"],
      ["staged.ts", true, false, undefined],
      ["untracked.bin", false, true, "untracked"],
    ],
    "fixture covers the staged, working and untracked sides the three actions target"
  );

  const view = harness.webview();
  view.postState(state(changes as unknown[]));
  const details = view.dom.window.document.querySelector(".changes-more") as HTMLDetailsElement;
  details.open = true;

  // ⌫ on the untracked file. The report: this raised 缺少要恢复的文件状态 and
  // deleted nothing.
  stub.choice = "删除文件";
  action(view, "untracked.bin", "删除未跟踪文件").click();
  const remove = view.messages.at(-1);
  assert.equal(remove.type, "restoreFile");
  assert.equal(remove.side, "working", "the webview speaks the host's vocabulary");
  await (harness.provider as any).handleMessage(remove);
  assert.equal(fs.existsSync(path.join(cwd, "untracked.bin")), false, "the host deleted the file instead of rejecting the side");
  assert.match((stub as any).__toasts.at(-1) ?? "", /已删除未跟踪文件/, "and reported a real deletion");

  // ↶ in Changes: the working-tree half is restored.
  stub.choice = "确认恢复";
  action(view, "modified.ts", "恢复此文件的工作区改动").click();
  const restore = view.messages.at(-1);
  assert.equal(restore.side, "working");
  await (harness.provider as any).handleMessage(restore);
  assert.equal(fs.readFileSync(path.join(cwd, "modified.ts"), "utf8").replace(/\r\n/g, "\n"), "base\n", "the working edit was discarded");

  // ↶ in Staged Changes: the index half is restored, content untouched.
  action(view, "staged.ts", "撤销此文件的暂存").click();
  const unstage = view.messages.at(-1);
  assert.equal(unstage.side, "staged");
  await (harness.provider as any).handleMessage(unstage);
  const after = (await getWorktreeChanges(cwd)).find((change) => change.path === "staged.ts");
  assert.ok(after, "staged.ts is still a change");
  assert.equal(after!.staged, false, "the index half is gone");
  assert.equal(after!.unstaged, true, "the content stayed in the working tree");
  assert.equal(fs.readFileSync(path.join(cwd, "staged.ts"), "utf8").replace(/\r\n/g, "\n"), "changed\n");

  view.dom.window.close();
});
