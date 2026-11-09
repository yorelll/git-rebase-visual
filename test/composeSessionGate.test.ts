/**
 * `generate` is deliberately outside `requiresCurrentCommitHash`: staged and
 * working generation have no commit at all, so the generic guard cannot apply.
 * That makes the message's `hash` a webview-supplied string that must not reach
 * `git show` unexamined — `--output=<file>` as a hash writes a file (measured,
 * exit 0). Accepting a live Compose session only proves the *panel* is the one
 * this host opened; a page can echo the real `sessionId` and pair it with a
 * different hash, so the authority has to be the session's own hash.
 *
 * This file pins that second gate: a mismatched hash must produce `genError`
 * and must not start an LLM request. The positive control in the same file is
 * what makes the assertion meaningful — without it, "fetch was not called"
 * would also pass if the instrumentation were simply broken.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { commitFile, createRepo, git, removeRepo } from "./helpers/gitTestRepo";
import { createExtensionContext, installVscodeStub, resetStub, stub, vscodeStub } from "./helpers/vscodeStub";

installVscodeStub();

const { RebaseViewProvider } = require("../src/ui/rebaseViewProvider") as typeof import("../src/ui/rebaseViewProvider");
const { LockStore } = require("../src/lock/lockStore") as typeof import("../src/lock/lockStore");
const { createGitContentRequestStore } = require("../src/ui/gitDiffRequestState") as typeof import("../src/ui/gitDiffRequestState");
const { createGeneratedDiffSnapshotStore } = require("../src/ui/generatedDiffDocument") as typeof import("../src/ui/generatedDiffDocument");

interface Harness {
  cwd: string;
  provider: InstanceType<typeof RebaseViewProvider>;
  /** Messages the Compose panel would have shown the user. */
  composeMessages: any[];
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
  // The Compose panel posts through `this.panel.webview.postMessage`, which the
  // stub discards. Capture it at the panel instead of reaching into the provider,
  // so the assertion is on what the user's panel would render.
  const composeMessages: any[] = [];
  const originalCreate = vscodeStub.window.createWebviewPanel;
  (vscodeStub.window as any).createWebviewPanel = (...args: any[]) => {
    const panel = (originalCreate as any)(...args);
    panel.webview.postMessage = async (message: any) => {
      composeMessages.push(message);
      return true;
    };
    return panel;
  };
  t.after(async () => {
    (vscodeStub.window as any).createWebviewPanel = originalCreate;
    await (provider as any).recoveryPass?.catch?.(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      removeRepo(cwd);
    } catch {
      // A leftover temp dir is not a test failure.
    }
  });
  return { cwd, provider, composeMessages };
}

/** Minimal OpenAI-compatible SSE body, so a real generation path can complete. */
function sseResponse(text: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

interface FetchRecorder {
  calls: string[];
  restore(): void;
}

function recordFetch(reply: () => Response): FetchRecorder {
  const original = globalThis.fetch;
  const calls: string[] = [];
  (globalThis as any).fetch = async (url: any) => {
    calls.push(String(url));
    return reply();
  };
  return { calls, restore: () => { (globalThis as any).fetch = original; } };
}

/**
 * Configures the LLM so `generate` gets past `isLlmConfigured()`, and the range
 * so `refresh` has commits to validate against. The default range is
 * `upstream`, and these fixtures deliberately have no remote — with it the list
 * is empty and `openCompose` would reject every hash for the wrong reason.
 */
function configureLlm(): void {
  stub.config["gitRebaseVisual.llm.baseUrl"] = "http://127.0.0.1:9/v1";
  stub.config["gitRebaseVisual.llm.apiKey"] = "test-key";
  stub.config["gitRebaseVisual.llm.model"] = "test-model";
  stub.config["gitRebaseVisual.commitRange"] = "all";
}

test("generate refuses a hash that is not the open Compose session's target", async (t) => {
  const harness = createHarness(t);
  const { cwd, provider, composeMessages } = harness;
  configureLlm();
  const first = commitFile(cwd, "one.txt", "one\n", "first");
  const second = commitFile(cwd, "two.txt", "two\n", "second");
  assert.notEqual(first, second);

  // The provider validates `openCompose`'s hash against the rendered list, so
  // the list has to be real before the session can exist.
  await (provider as any).refresh();
  assert.equal((provider as any).commits.length, 2, "both commits are in the visible list");

  await (provider as any).onMessage({ type: "openCompose", mode: "commit", hash: second, ai: false });
  const session = (provider as any).compose.activeSession();
  assert.ok(session, "the Compose session opened");
  assert.equal(session.hash, second, "the session's target is the hash the host validated");

  const recorder = recordFetch(() => sseResponse("feat: from the model"));
  t.after(() => recorder.restore());
  composeMessages.length = 0;

  // A page that echoes the real session but pairs it with the *other* commit:
  // both hashes are real and both are in the visible list, so nothing but the
  // session-authority check can tell this apart from a legitimate request.
  await (provider as any).onMessage({
    type: "generate",
    mode: "commit",
    hash: first,
    extra: "",
    sessionId: session.sessionId,
    revision: session.revision,
  });

  assert.deepEqual(recorder.calls, [], "no AI request was sent; saw " + JSON.stringify(recorder.calls));
  const error = composeMessages.filter((message) => message?.type === "genError").pop();
  assert.ok(error, "the panel is told; saw " + JSON.stringify(composeMessages.map((message) => message?.type)));
  assert.match(
    String(error.message),
    /生成目标与 Compose 会话不一致/,
    "and the message names the mismatch, not a generic failure; saw " + JSON.stringify(error.message)
  );
  assert.match(String(error.message), /未发送 AI 请求/, "it says no request was made");
});

test("the same message succeeds when the hash matches the session", async (t) => {
  // Positive control: it proves the instrumentation above can see a request.
  // Without it, `deepEqual(calls, [])` would pass even if `fetch` were never
  // reachable from this code path at all.
  const harness = createHarness(t);
  const { cwd, provider, composeMessages } = harness;
  configureLlm();
  commitFile(cwd, "one.txt", "one\n", "first");
  const target = commitFile(cwd, "two.txt", "two\n", "second");

  await (provider as any).refresh();
  await (provider as any).onMessage({ type: "openCompose", mode: "commit", hash: target, ai: false });
  const session = (provider as any).compose.activeSession();
  assert.ok(session);

  const recorder = recordFetch(() => sseResponse("feat: from the model"));
  t.after(() => recorder.restore());
  composeMessages.length = 0;

  await (provider as any).onMessage({
    type: "generate",
    mode: "commit",
    hash: target,
    extra: "",
    sessionId: session.sessionId,
    revision: session.revision,
  });

  assert.equal(recorder.calls.length, 1, "a matching hash really does reach the model; saw " + JSON.stringify(recorder.calls));
  assert.match(recorder.calls[0], /\/chat\/completions$/, "and it is the chat endpoint");
  const result = composeMessages.filter((message) => message?.type === "genResult").pop();
  assert.ok(result, "the generated text reaches the panel; saw " + JSON.stringify(composeMessages.map((message) => message?.type)));
  assert.equal(result.text, "feat: from the model");
});

test("the request that does reach the model names the session's commit, not the message's", async (t) => {
  // 新发现 3's second half: the code sends `targetHash` (read from the session),
  // not `hash` (read from the message). With the two equal that distinction is
  // invisible, so this drives the diff source and asserts the payload contains
  // the session commit's changed file. A future edit that switched back to
  // `hash` would still be caught by the mismatch test above; this one pins that
  // the *content* is the session's commit.
  const harness = createHarness(t);
  const { cwd, provider } = harness;
  configureLlm();
  commitFile(cwd, "one.txt", "one\n", "first");
  const target = commitFile(cwd, "session-target.txt", "target\n", "second");

  await (provider as any).refresh();
  await (provider as any).onMessage({ type: "openCompose", mode: "commit", hash: target, ai: false });
  const session = (provider as any).compose.activeSession();
  assert.ok(session);

  const bodies: string[] = [];
  const original = globalThis.fetch;
  (globalThis as any).fetch = async (_url: any, init: any) => {
    bodies.push(String(init?.body ?? ""));
    return sseResponse("feat: from the model");
  };
  t.after(() => { (globalThis as any).fetch = original; });

  await (provider as any).onMessage({
    type: "generate",
    mode: "commit",
    hash: target,
    extra: "",
    sessionId: session.sessionId,
    revision: session.revision,
  });

  assert.equal(bodies.length, 1, "one request");
  assert.match(bodies[0], /session-target\.txt/, "the diff is the session commit's; saw " + bodies[0].slice(0, 400));
  assert.doesNotMatch(bodies[0], /one\.txt/, "and not the ancestor's file");
});
