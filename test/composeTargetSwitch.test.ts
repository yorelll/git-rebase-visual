/**
 * P2-1: a dirty Compose draft on target A can be superseded by the user opening
 * target B from the sidebar. The host used to switch its active session to B
 * while the page-protection kept A on screen, so Cancel/Escape posted A's
 * session and the host's `acceptsActiveSession` guard rejected the close
 * forever. These tests drive the real provider, a single real ComposePanel and
 * the real inline document, and require both halves of the contract:
 *
 *   1. when the page refuses the overwrite, host and page agree on A again, so
 *      Cancel closes and A's draft is recoverable;
 *   2. a stale/retained document still cannot close a newer target.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { commitFile, createRepo, removeRepo } from "./helpers/gitTestRepo";
import { createExtensionContext, installVscodeStub, resetStub, stub, vscodeStub } from "./helpers/vscodeStub";

installVscodeStub();

const { RebaseViewProvider } = require("../src/ui/rebaseViewProvider") as typeof import("../src/ui/rebaseViewProvider");
const { LockStore } = require("../src/lock/lockStore") as typeof import("../src/lock/lockStore");
const { createGitContentRequestStore } = require("../src/ui/gitDiffRequestState") as typeof import("../src/ui/gitDiffRequestState");
const { createGeneratedDiffSnapshotStore } = require("../src/ui/generatedDiffDocument") as typeof import("../src/ui/generatedDiffDocument");

interface FakePanel {
  title: string;
  webview: {
    html: string;
    onDidReceiveMessage(fn: (message: any) => void): { dispose(): void };
    postMessage(message: any): Promise<boolean>;
    asWebviewUri(uri: unknown): unknown;
    cspSource: string;
  };
  onDidDispose(fn: () => void): { dispose(): void };
  reveal(): void;
  dispose(): void;
  disposed: boolean;
  /** Host-to-page messages, captured for draft-restore assertions. */
  received: any[];
  receive(message: any): void;
  window?: any;
}

interface PanelHarness {
  panels: FakePanel[];
  restore(): void;
}

function installPanelHarness(): PanelHarness {
  const panels: FakePanel[] = [];
  const original = vscodeStub.window.createWebviewPanel;
  (vscodeStub.window as any).createWebviewPanel = () => {
    const handlers: ((message: any) => void)[] = [];
    let onDispose: (() => void) | undefined;
    const panel: FakePanel = {
      title: "",
      webview: {
        html: "",
        onDidReceiveMessage(fn) { handlers.push(fn); return { dispose() {} }; },
        async postMessage() { return true; },
        asWebviewUri: (uri) => uri,
        cspSource: "",
      },
      onDidDispose(fn) { onDispose = fn; return { dispose() {} }; },
      reveal() {},
      dispose() { panel.disposed = true; onDispose?.(); },
      disposed: false,
      received: [],
      receive(message) { for (const handler of handlers) handler(message); },
    };
    panels.push(panel);
    return panel as any;
  };
  return { panels, restore: () => { (vscodeStub.window as any).createWebviewPanel = original; } };
}

function loadDocument(panel: FakePanel): any {
  const dom = new JSDOM(panel.webview.html, { runScripts: "outside-only", url: "https://compose.test/" });
  const { window } = dom;
  let state: any;
  Object.defineProperty(window, "acquireVsCodeApi", {
    value: () => ({
      postMessage: (message: any) => { panel.receive(message); return true; },
      getState: () => state,
      setState: (value: any) => { state = value; },
    }),
  });
  panel.webview.postMessage = async (message: any) => {
    panel.received.push(message);
    window.dispatchEvent(new window.MessageEvent("message", { data: message }));
    return true;
  };
  panel.window = window;
  const script = window.document.querySelector("script")?.textContent ?? "";
  assert.ok(script, "the compose document carries its inline script");
  window.eval(script);
  return window;
}

function edit(window: any, id: "subject" | "body", value: string): void {
  const element = window.document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
  element.value = value;
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface Harness {
  cwd: string;
  provider: InstanceType<typeof RebaseViewProvider>;
  panels: PanelHarness;
}

function createHarness(t: { after: (fn: () => void) => void }): Harness {
  resetStub();
  const cwd = createRepo();
  stub.workspaceFolders = [{ uri: { fsPath: cwd } }];
  // The default range follows `main`, which this fixture does not create.
  stub.config["gitRebaseVisual.commitRange"] = "all";
  const ctx = createExtensionContext();
  const panels = installPanelHarness();
  const provider = new RebaseViewProvider(
    ctx as any,
    new LockStore(ctx.globalState as any),
    createGitContentRequestStore(),
    createGeneratedDiffSnapshotStore()
  );
  t.after(() => {
    (provider as any).compose.dispose();
    panels.restore();
    try {
      removeRepo(cwd);
    } catch {
      // A leftover temp dir is not a test failure.
    }
  });
  return { cwd, provider, panels };
}

async function openCommit(provider: InstanceType<typeof RebaseViewProvider>, hash: string): Promise<any> {
  await (provider as any).onMessage({ type: "openCompose", mode: "commit", hash, ai: false, thenEdit: false });
  return (provider as any).compose.activeSession();
}

test("Cancel closes a dirty panel whose target was superseded, and A's draft is recoverable", async (t) => {
  const harness = createHarness(t);
  const { cwd, provider, panels } = harness;
  const targetA = commitFile(cwd, "a.txt", "a\n", "feat: target A");
  const targetB = commitFile(cwd, "b.txt", "b\n", "feat: target B");
  await (provider as any).refresh();

  const openedA = await openCommit(provider, targetA);
  assert.ok(openedA, "target A opened");
  assert.equal(panels.panels.length, 1, "one panel document exists");
  const panelA = panels.panels[0];
  const page = loadDocument(panelA);
  assert.equal((provider as any).compose.activeSession()?.sessionId, openedA.sessionId, "the page acknowledged A");

  edit(page, "subject", "feat: my unsaved draft");
  edit(page, "body", "body I do not want to lose");
  assert.equal(page.document.body.classList.contains("is-dirty"), true, "the page draft is dirty");

  // The sidebar opens target B. The page refuses to overwrite the dirty draft.
  await openCommit(provider, targetB);
  const offered = panelA.received.filter((message) => message?.type === "openCompose").at(-1);
  assert.equal(offered?.hash, targetB, "the host did offer target B to the page");
  assert.match(
    page.document.getElementById("warning").textContent,
    /目标 commit 已变化/,
    "the page shows the overwrite warning"
  );
  assert.equal(
    (provider as any).compose.activeSession()?.sessionId,
    openedA.sessionId,
    "the host follows the page's refusal instead of staying on B"
  );

  // Cancel must close now.
  page.document.getElementById("close").click();
  await waitFor(() => panelA.disposed);
  assert.equal(panelA.disposed, true, "Cancel disposed the panel even though a newer target had been offered");

  // Reopening A still restores the exact draft.
  await openCommit(provider, targetA);
  const panelA2 = panels.panels.at(-1)!;
  assert.notEqual(panelA2, panelA, "the closed document was replaced");
  loadDocument(panelA2);
  const draft = panelA2.received.filter((message) => message?.type === "openCompose").at(-1)?.draft;
  assert.equal(draft, "feat: my unsaved draft\n\nbody I do not want to lose", "A's draft survived Cancel");
});

test("a stale retained document cannot close the newer Compose target", async (t) => {
  const harness = createHarness(t);
  const { cwd, provider, panels } = harness;
  const targetA = commitFile(cwd, "a.txt", "a\n", "feat: target A");
  const targetB = commitFile(cwd, "b.txt", "b\n", "feat: target B");
  await (provider as any).refresh();

  const openedA = await openCommit(provider, targetA);
  const panel = panels.panels[0];
  // A clean page accepts B, so the host really is on the newer target.
  loadDocument(panel);
  const openedB = await openCommit(provider, targetB);
  assert.equal((provider as any).compose.activeSession()?.sessionId, openedB.sessionId, "B is now active");

  // A retained/older document still believes it is on A.
  await (provider as any).onMessage({
    type: "closeCompose",
    dirty: false,
    sessionId: openedA.sessionId,
    revision: openedA.revision,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(panel.disposed, false, "the stale close must not dispose the panel");
  assert.equal((provider as any).compose.visible(), true, "the newer target stays open");
  assert.equal((provider as any).compose.activeSession()?.sessionId, openedB.sessionId, "and remains active");
});
