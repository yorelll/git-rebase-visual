/**
 * Cancel/Escape has to close the Compose panel in every state. The previous
 * page guarded a dirty draft with `window.confirm`, which VS Code webviews do
 * not support: once the draft was dirty the guard returned and `closeCompose`
 * was never posted, so only the editor tab's × worked.
 *
 * These tests execute the real panel document produced by `ComposePanel` in
 * JSDOM. `window.confirm` is deliberately defined to return false, modelling
 * the unsupported/declined API: the old guard therefore swallows the close,
 * which is what makes the assertions fail against that version.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { installVscodeStub, resetStub, vscodeStub } from "./helpers/vscodeStub";

installVscodeStub();

const { ComposePanel } = require("../src/ui/composePanel") as typeof import("../src/ui/composePanel");

interface FakePanel {
  title: string;
  posted: any[];
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
  receive(message: any): void;
}

interface PanelHarness {
  panels: FakePanel[];
  restore(): void;
}

/** A panel stub whose `dispose()` really fires `onDidDispose`, like VS Code. */
function installPanelHarness(): PanelHarness {
  const panels: FakePanel[] = [];
  const original = vscodeStub.window.createWebviewPanel;
  (vscodeStub.window as any).createWebviewPanel = () => {
    const messageHandlers: ((message: any) => void)[] = [];
    let disposed: (() => void) | undefined;
    const panel: FakePanel = {
      title: "",
      posted: [],
      webview: {
        html: "",
        onDidReceiveMessage(fn) { messageHandlers.push(fn); return { dispose() {} }; },
        async postMessage(message) { panel.posted.push(message); return true; },
        asWebviewUri: (uri) => uri,
        cspSource: "",
      },
      onDidDispose(fn) { disposed = fn; return { dispose() {} }; },
      reveal() {},
      dispose() { disposed?.(); },
      receive(message) { for (const handler of messageHandlers) handler(message); },
    };
    panels.push(panel);
    return panel as any;
  };
  return { panels, restore: () => { (vscodeStub.window as any).createWebviewPanel = original; } };
}

function payload() {
  return {
    mode: "commit",
    hash: "a".repeat(40),
    thenEdit: false,
    ai: true,
    original: "feat: original\n\nbody",
    trailers: "",
    subject: "feat: original",
    revision: 7,
  };
}

interface Page {
  window: JSDOM["window"];
  messages: any[];
  close(): void;
  dom: JSDOM;
}

function loadPage(html: string): Page {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://compose.test/",
  });
  const { window } = dom;
  const messages: any[] = [];
  Object.defineProperty(window, "acquireVsCodeApi", {
    value: () => ({
      postMessage: (message: any) => { messages.push(message); return true; },
      getState: () => undefined,
      setState: () => undefined,
    }),
  });
  // VS Code webviews do not implement confirm. Returning false is the harshest
  // supported-looking behaviour: the old guard then refuses to close.
  Object.defineProperty(window, "confirm", { value: () => false });
  const script = dom.window.document.querySelector("script")?.textContent ?? "";
  assert.ok(script, "the compose document carries its inline script");
  window.eval(script);
  return { window, messages, dom, close: () => window.close() };
}

function deliver(page: Page, session: { sessionId: string; revision: number }, extra: Record<string, unknown> = {}): void {
  page.window.dispatchEvent(new page.window.MessageEvent("message", {
    data: {
      type: "openCompose",
      ...payload(),
      sessionId: session.sessionId,
      revision: session.revision,
      ...extra,
    },
  }));
}

function input(page: Page, id: "subject" | "body", value: string): void {
  const element = page.window.document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
  element.value = value;
  element.dispatchEvent(new page.window.Event("input", { bubbles: true }));
}

function closeMessages(page: Page): any[] {
  return page.messages.filter((message) => message?.type === "closeCompose");
}

test("Cancel and Escape close the Compose panel while idle, dirty, generating, generated and edited", () => {
  resetStub();
  const harness = installPanelHarness();
  const panel = new ComposePanel(vscodeStub.Uri.file("/tmp/grv-ext") as any, () => undefined);
  try {
    panel.open(payload());
    const session = (panel as any).activeSession();
    assert.ok(session, "the host session opened");
    const page = loadPage(harness.panels[0].webview.html);
    try {
      deliver(page, session);

      const clickClose = (label: string) => {
        page.messages.length = 0;
        (page.window.document.getElementById("close") as HTMLButtonElement).click();
        const sent = closeMessages(page);
        assert.equal(sent.length, 1, `${label}: Cancel posts exactly one closeCompose`);
        assert.equal(sent[0].sessionId, session.sessionId, `${label}: it targets the open session`);
        assert.equal(sent[0].revision, session.revision, `${label}: and its revision`);
        return sent[0];
      };

      // Idle: no draft at all.
      assert.equal(clickClose("idle").dirty, false, "idle close reports no draft");

      // Edited directly.
      input(page, "subject", "feat: edited by hand");
      assert.equal(clickClose("edited").dirty, true, "an edited draft is reported as dirty");

      // Generated by the model.
      page.messages.length = 0;
      page.window.dispatchEvent(new page.window.MessageEvent("message", { data: { type: "genResult", text: "feat: generated\n\nbody" } }));
      assert.equal(clickClose("generated").dirty, true, "a generated draft is reported as dirty");

      // Generating: the user may cancel while the request is still in flight.
      (page.window.document.getElementById("generate") as HTMLButtonElement).click();
      assert.equal(clickClose("generating").dirty, true, "closing while generating is allowed");

      // Escape goes through the same path.
      page.messages.length = 0;
      page.window.document.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      const escaped = closeMessages(page);
      assert.equal(escaped.length, 1, "Escape always posts closeCompose, even with a dirty draft");
      assert.equal(escaped[0].dirty, true, "and reports that the draft must be retained");
    } finally {
      page.close();
    }
  } finally {
    panel.dispose();
    harness.restore();
  }
});

test("clicking 应用 posts the edited subject and body, not the generated draft", () => {
  resetStub();
  const harness = installPanelHarness();
  const panel = new ComposePanel(vscodeStub.Uri.file("/tmp/grv-ext") as any, () => undefined);
  try {
    panel.open(payload());
    const session = (panel as any).activeSession();
    assert.ok(session, "the host session opened");
    const page = loadPage(harness.panels[0].webview.html);
    try {
      deliver(page, session);
      // The model fills both fields first; the user then edits them by hand.
      page.window.dispatchEvent(new page.window.MessageEvent("message", {
        data: { type: "genResult", text: "feat: generated subject\n\ngenerated body" },
      }));
      input(page, "subject", "feat: edited subject");
      input(page, "body", "edited body");

      page.messages.length = 0;
      (page.window.document.getElementById("apply") as HTMLButtonElement).click();
      const applied = page.messages.filter((message) => message?.type === "apply");
      assert.equal(applied.length, 1, "应用 posts exactly one apply message");
      assert.equal(
        applied[0].message,
        "feat: edited subject\n\nedited body",
        "the message is the text currently in the edited fields"
      );
      assert.equal(applied[0].sessionId, session.sessionId, "and it carries the open session");
      assert.equal(applied[0].revision, session.revision, "and its revision");
      assert.doesNotMatch(applied[0].message, /generated/, "the generated draft is not what gets applied");
    } finally {
      page.close();
    }
  } finally {
    panel.dispose();
    harness.restore();
  }
});

test("a draft sent before Cancel is still delivered when the same target is reopened", () => {
  resetStub();
  const harness = installPanelHarness();
  const panel = new ComposePanel(vscodeStub.Uri.file("/tmp/grv-ext") as any, () => undefined);
  try {
    panel.open(payload());
    const session = (panel as any).activeSession();
    assert.ok(session);
    harness.panels[0].receive({ type: "composeDraft", draft: "feat: long message", sessionId: session.sessionId, revision: session.revision });
    panel.close();

    panel.open(payload());
    assert.equal(harness.panels.length, 2, "closing disposes the old document; reopening creates a new one");
    harness.panels[1].receive({ type: "composeReady", sessionId: session.sessionId, revision: session.revision });
    const reopened = harness.panels[1].posted.filter((message) => message?.type === "openCompose").at(-1);
    assert.ok(reopened, "the reopened panel receives its session");
    assert.equal(reopened.draft, "feat: long message", "the draft survived Cancel and is restored on reopen");
  } finally {
    panel.dispose();
    harness.restore();
  }
});
