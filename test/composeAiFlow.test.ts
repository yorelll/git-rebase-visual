/**
 * End-to-end Compose flows for the only two AI entry points that remain:
 *
 *   1. the staged-changes entry creates a commit from the index, and
 *   2. the commit context-menu entry rewrites that commit's message.
 *
 * In both cases 生成 must only put text into the editor; the write happens on
 * 应用 and must use the message the user edited, not the one the model returned.
 * These tests drive the real provider against a real repository, with the LLM
 * endpoint replaced by a one-chunk SSE response.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { abortRebase, executeRebase, resolveBase } from "../src/git/rebaseEngine";
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

function recordFetch(text: string): { calls: string[]; restore(): void } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  (globalThis as any).fetch = async (url: any) => {
    calls.push(String(url));
    return sseResponse(text);
  };
  return { calls, restore: () => { (globalThis as any).fetch = original; } };
}

function configureLlm(): void {
  stub.config["gitRebaseVisual.llm.baseUrl"] = "http://127.0.0.1:9/v1";
  stub.config["gitRebaseVisual.llm.apiKey"] = "test-key";
  stub.config["gitRebaseVisual.llm.model"] = "test-model";
  stub.config["gitRebaseVisual.commitRange"] = "all";
}

function generated(composeMessages: any[]): string | undefined {
  return composeMessages.filter((message) => message?.type === "genResult").pop()?.text;
}

test("the staged entry commits the edited message with a sign-off and only on apply", async (t) => {
  const harness = createHarness(t);
  const { cwd, provider, composeMessages } = harness;
  configureLlm();

  commitFile(cwd, "base.txt", "base\n", "chore: base");
  fs.writeFileSync(path.join(cwd, "feature.txt"), "feature\n", "utf8");
  git(cwd, ["add", "feature.txt"]);
  const before = git(cwd, ["rev-parse", "HEAD"]);

  await (provider as any).refresh();
  // The staged entry's payload, verbatim from media/main.js.
  await (provider as any).onMessage({ type: "openCompose", mode: "staged", ai: true, thenEdit: false });
  const session = (provider as any).compose.activeSession();
  assert.ok(session, "the staged Compose session opened");

  const recorder = recordFetch("feat: generated only");
  t.after(() => recorder.restore());
  composeMessages.length = 0;
  await (provider as any).onMessage({
    type: "generate",
    mode: "staged",
    extra: "",
    sessionId: session.sessionId,
    revision: session.revision,
  });

  assert.equal(recorder.calls.length, 1, "the model ran");
  assert.equal(generated(composeMessages), "feat: generated only", "生成 only puts the model text into the editor");
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), before, "生成 did not create a commit");
  assert.match(git(cwd, ["status", "--porcelain"]), /^A  feature\.txt$/m, "the file is still only staged");

  composeMessages.length = 0;
  const edited = "feat: edited by hand\n\nbody the user kept";
  await (provider as any).onMessage({
    type: "apply",
    mode: "staged",
    message: edited,
    sessionId: session.sessionId,
    revision: session.revision,
  });

  assert.notEqual(git(cwd, ["rev-parse", "HEAD"]), before, "应用 created the commit");
  const message = git(cwd, ["log", "-1", "--pretty=%B"]);
  assert.match(message, /^feat: edited by hand$/m, "the edited subject is what was committed");
  assert.match(message, /^body the user kept$/m, "so is the edited body");
  assert.doesNotMatch(message, /generated only/, "the generated text was not applied over the edit");
  // commitIndex runs `git commit -s`, so the sign-off trailer must be there.
  assert.match(message, /^Signed-off-by: Git Rebase Visual Test <test@example\.com>$/m, "the commit is signed off");
  assert.equal(git(cwd, ["status", "--porcelain"]), "", "the index and working tree are clean");
  assert.ok(composeMessages.some((entry) => entry?.type === "applySucceeded"), "the panel is told the apply succeeded");
});

test("the commit entry rewrites that commit with the edited message, not the generated one", async (t) => {
  const harness = createHarness(t);
  const { cwd, provider, composeMessages } = harness;
  configureLlm();

  commitFile(cwd, "one.txt", "one\n", "chore: base");
  const target = commitFile(cwd, "two.txt", "two\n", "feat: original subject");
  const before = git(cwd, ["rev-parse", "HEAD"]);

  await (provider as any).refresh();
  // The right-click commit entry's payload.
  await (provider as any).onMessage({ type: "openCompose", mode: "commit", hash: target, ai: true, thenEdit: false });
  const session = (provider as any).compose.activeSession();
  assert.ok(session, "the commit Compose session opened");
  assert.equal(session.hash, target, "it targets the clicked commit");

  const recorder = recordFetch("feat: generated only");
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

  assert.equal(recorder.calls.length, 1, "the model ran");
  assert.equal(generated(composeMessages), "feat: generated only", "生成 only produces a draft");
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), before, "生成 did not rewrite the commit");
  const rebaseMerge = path.join(cwd, git(cwd, ["rev-parse", "--git-path", "rebase-merge"]));
  assert.equal(fs.existsSync(rebaseMerge), false, "生成 did not start a rebase");

  composeMessages.length = 0;
  const edited = "feat: edited by hand\n\nrewritten body";
  await (provider as any).onMessage({
    type: "apply",
    mode: "commit",
    hash: target,
    message: edited,
    thenEdit: false,
    sessionId: session.sessionId,
    revision: session.revision,
  });

  assert.notEqual(git(cwd, ["rev-parse", "HEAD"]), before, "应用 rewrote the commit");
  // The rewritten commit is still HEAD and has the edited message.
  const message = git(cwd, ["log", "-1", "--pretty=%B"]);
  assert.match(message, /^feat: edited by hand$/m, "the edited subject replaced the original");
  assert.match(message, /^rewritten body$/m, "the edited body too");
  assert.doesNotMatch(message, /generated only/, "the generated draft was not applied over the edit");
  assert.doesNotMatch(message, /original subject/, "nor the old subject");
  assert.ok(composeMessages.some((entry) => entry?.type === "applySucceeded"), "the panel is told the apply succeeded");
});

/**
 * The only AI route while an edit stop is paused is the ordinary Staged
 * Changes entry: stage the work, generate a message, edit it. Generation is
 * read-only, so it may run; application must stay blocked until the user
 * finishes the rebase. This is the "mid-edit AI path" the UI promises.
 */
test("during an edit stop the staged AI entry can generate but not apply", async (t) => {
  const harness = createHarness(t);
  const { cwd, provider, composeMessages } = harness;
  configureLlm();

  const base = commitFile(cwd, "base.txt", "base\n", "base");
  const target = commitFile(cwd, "target.txt", "target\n", "feat: target");
  const tip = commitFile(cwd, "tip.txt", "tip\n", "tip");
  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, base),
    items: [
      { hash: base, action: "pick", subject: "base" },
      { hash: target, action: "edit", subject: "feat: target" },
      { hash: tip, action: "pick", subject: "tip" },
    ],
  });
  assert.equal(outcome.stopped, true, "the rebase really stopped at the edit target");
  fs.writeFileSync(path.join(cwd, "mid-edit.txt"), "work in progress\n", "utf8");
  git(cwd, ["add", "mid-edit.txt"]);
  const before = git(cwd, ["rev-parse", "HEAD"]);
  t.after(async () => { await abortRebase(cwd).catch(() => undefined); });

  await (provider as any).refresh();
  await (provider as any).onMessage({ type: "openCompose", mode: "staged", ai: true, thenEdit: false });
  const session = (provider as any).compose.activeSession();
  assert.ok(session, "the staged AI entry opened during the edit stop");

  const recorder = recordFetch("feat: generated mid-edit");
  t.after(() => recorder.restore());
  composeMessages.length = 0;
  await (provider as any).onMessage({
    type: "generate",
    mode: "staged",
    extra: "",
    sessionId: session.sessionId,
    revision: session.revision,
  });
  assert.equal(recorder.calls.length, 1, "generation is allowed because it writes no Git state");
  assert.equal(generated(composeMessages), "feat: generated mid-edit");
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), before, "generation did not commit anything");

  composeMessages.length = 0;
  await (provider as any).onMessage({
    type: "apply",
    mode: "staged",
    message: "feat: should stay blocked",
    sessionId: session.sessionId,
    revision: session.revision,
  });
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), before, "apply stayed blocked during the pause");
  assert.ok(composeMessages.some((entry) => entry?.type === "applyFailed"), "the panel explains that apply did not run");
});
