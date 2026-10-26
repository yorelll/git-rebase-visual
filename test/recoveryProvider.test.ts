import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import { createExtensionContext, installVscodeStub, resetStub, stub } from "./helpers/vscodeStub";

installVscodeStub();

const { RebaseViewProvider } = require("../src/ui/rebaseViewProvider") as typeof import("../src/ui/rebaseViewProvider");
const { LockStore } = require("../src/lock/lockStore") as typeof import("../src/lock/lockStore");
const { createGitContentRequestStore } = require("../src/ui/gitDiffRequestState") as typeof import("../src/ui/gitDiffRequestState");
const { createGeneratedDiffSnapshotStore } = require("../src/ui/generatedDiffDocument") as typeof import("../src/ui/generatedDiffDocument");
const { commitFile, createRepo, git, removeRepo } = require("./helpers/gitTestRepo") as typeof import("./helpers/gitTestRepo");
const { reconcilePendingStash, stashPresence } =
  require("../src/git/pendingRecovery") as typeof import("../src/git/pendingRecovery");
const { setGitInvocationObserver } =
  require("../src/git/gitRunner") as typeof import("../src/git/gitRunner");

const PENDING_STASH_KEY = "gitRebaseVisual.pendingStash";
const PENDING_APPEND_KEY = "gitRebaseVisual.pendingAppend";

interface Harness {
  cwd: string;
  ctx: ReturnType<typeof createExtensionContext>;
  provider: InstanceType<typeof RebaseViewProvider>;
  close(): void;
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
  // Info toasts go through the webview sink, which has no view in a unit test.
  // Route them into the same capture the warning/info messages use, so a test
  // can assert on what the user would actually be told.
  (provider as any).postInlineToast = (message: string) => {
    stub.messages.push({ level: "info", text: message, items: [] });
  };
  t.after(async () => {
    // Let any recovery pass finish writing before the temp repo is deleted;
    // Windows refuses to unlink a directory a live Git child still holds.
    await (provider as any).recoveryPass?.catch?.(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      removeRepo(cwd);
    } catch {
      // A leftover temp dir is not a test failure.
    }
  });
  return { cwd, ctx, provider, close: () => undefined };
}

/** The provider keys records by `repoRoot()`, which normalises path casing. */
async function recordRoot(cwd: string): Promise<string> {
  const { repoRoot } = require("../src/git/commitLog") as typeof import("../src/git/commitLog");
  return (await repoRoot(cwd)) ?? cwd;
}

async function setPendingStash(harness: Harness, sha: string): Promise<void> {
  const map: Record<string, string> = {};
  map[await recordRoot(harness.cwd)] = sha;
  await harness.ctx.workspaceState.update(PENDING_STASH_KEY, map);
}

async function pendingStashOf(harness: Harness): Promise<string | undefined> {
  const map = harness.ctx.workspaceState.get<Record<string, string>>(PENDING_STASH_KEY, {});
  return map?.[await recordRoot(harness.cwd)];
}

/** Stashes a worktree edit of `base.txt` and returns the stash sha. */
function stashWork(cwd: string, content = "work\n"): string {
  fs.writeFileSync(path.join(cwd, "base.txt"), content, "utf8");
  git(cwd, ["stash", "push", "-q"]);
  return git(cwd, ["rev-parse", "stash@{0}"]);
}

/**
 * Waits for the off-render-path recovery pass started by `refresh()`. Recovery
 * is deliberately not awaited by the render path, so a test must observe its
 * effect rather than assume it finished in the same tick.
 */
async function settleRecovery(provider: any, check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await provider.recoveryPass?.catch?.(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (check()) return;
    if (Date.now() > deadline) throw new Error("recovery pass did not produce the expected state");
  }
}

/** Lets any scheduled recovery pass run to completion (it may start a tick late). */
async function waitForRecoveryIdle(provider: any, quietMs = 500): Promise<void> {
  const deadline = Date.now() + 30_000;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    if (provider.recoveryPass) {
      await provider.recoveryPass.catch?.(() => undefined);
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= quietMs) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("dismissing the recovery banner survives a refresh", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  commitFile(cwd, "base.txt", "base\n", "base");
  // A conflicted apply leaves a record that must stay pending across refreshes.
  const sha = stashWork(cwd);
  await setPendingStash(harness, sha);
  fs.writeFileSync(path.join(cwd, "base.txt"), "conflicting\n", "utf8");

  // Capture what the host pushes to the webview so the banner can be inspected.
  const posted: any[] = [];
  (harness.provider as any).post = (message: any) => posted.push(message);

  // Drive one pass so the banner arms.
  await harness.provider.refresh();
  await settleRecovery(harness.provider, () => !!(harness.provider as any).recoveryNotice);
  assert.ok((harness.provider as any).recoveryNotice, "the pending record arms the banner");

  // The webview dismiss button posts this message; the host must record the
  // dismissal in the warning state, not merely clear the current render.
  // `sourceForAction` in media/main.js classifies `dismissRecoveryNotice` as a
  // plain UI action, so this is the source the real webview posts.
  await (harness.provider as any).onMessage({ type: "dismissRecoveryNotice", source: "webview:ui" });
  assert.equal((harness.provider as any).recoveryNotice, undefined, "dismissing clears the banner");
  assert.equal(
    posted.at(-1)?.recoveryNotice,
    undefined,
    "the webview is told to hide the banner without a full re-render"
  );

  // The next poll reconciles the same still-pending record. Its key is already
  // in `seen`, so rendering from the persisted state keeps the banner hidden.
  await harness.provider.refresh();
  await waitForRecoveryIdle(harness.provider);
  assert.equal((harness.provider as any).recoveryNotice, undefined, "a refresh does not resurrect a dismissed banner");
  assert.ok(
    !posted.some((message) => message.type === "state" && message.recoveryNotice),
    "no rendered state re-arms the banner either"
  );

  const before = await pendingStashOf(harness);
  assert.equal(before, sha, "the record survives while the stash holds the only copy");
  assert.equal((await stashPresence(cwd, sha)).contentPresent, false);
});

test("reset keeps a record whose stash it cannot verify", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  commitFile(cwd, "base.txt", "base\n", "base");
  const sha = stashWork(cwd);
  await setPendingStash(harness, sha);

  // A broken stash reflog makes the content unverifiable. "Could not check" is
  // not "nothing there", so reset must keep both the record and the stash.
  const reflog = path.join(cwd, git(cwd, ["rev-parse", "--git-path", "logs/refs/stash"]));
  fs.writeFileSync(reflog, "garbage line\n", "utf8");

  await harness.provider.resetExtensionState();
  assert.equal(await pendingStashOf(harness), sha, "an unverifiable stash keeps its record");
  const message = stub.messages.at(-1);
  assert.ok(message, "reset reports what it did");
  assert.match(message!.text, /已保留/);
  assert.equal(git(cwd, ["rev-parse", "refs/stash"]), sha, "the stash itself was never dropped");
});

test("reset clears orphaned bookkeeping once the stash is really gone", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  commitFile(cwd, "base.txt", "base\n", "base");
  const sha = stashWork(cwd);
  await setPendingStash(harness, sha);

  git(cwd, ["stash", "drop", "stash@{0}"]);
  await harness.provider.resetExtensionState();
  assert.equal(await pendingStashOf(harness), undefined, "orphaned bookkeeping is cleared");
  // The reconciliation that reset runs first may settle the record itself, in
  // which case reset correctly reports that there was nothing left to clear.
  assert.match(stub.messages.at(-1)!.text, /已重置扩展状态/);
  assert.equal(fs.existsSync(path.join(cwd, "base.txt")), true, "the worktree is untouched");
});

test("forceRelease re-syncs from Git instead of trusting memory", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  commitFile(cwd, "base.txt", "base\n", "base");
  git(cwd, ["checkout", "-q", "-b", "topic"]);
  commitFile(cwd, "b.txt", "b\n", "b");

  const lock = (harness.provider as any).mutations;
  const acquired = lock.tryAcquire({ action: "reorder", label: "变基重排", source: "webview:reorder" });
  assert.equal(acquired.ok, true);
  assert.equal(lock.isBusy(), true);

  await harness.provider.forceReleaseMutationLock();
  assert.equal(lock.isBusy(), false, "the lock is released");
  const message = stub.messages.at(-1);
  assert.ok(message);
  assert.match(message!.text, /当前没有进行中的变基/, "the message reflects real Git state, not memory");
});

test("recovery never overlaps a mutation that owns the lock", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  commitFile(cwd, "base.txt", "base\n", "base");
  const sha = stashWork(cwd);
  await setPendingStash(harness, sha);

  const lock = (harness.provider as any).mutations;
  const acquired = lock.tryAcquire({ action: "reorder", label: "变基重排", source: "webview:reorder" });
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;

  // A poll-triggered pass must skip rather than write the same index.
  await (harness.provider as any).reconcilePendingState(await recordRoot(cwd));
  const presence = await stashPresence(cwd, sha);
  assert.equal(presence.contentPresent, false, "the skipped pass applied nothing");
  assert.equal(git(cwd, ["rev-parse", "refs/stash"]), sha, "and dropped nothing");
  assert.equal(await pendingStashOf(harness), sha, "the record is untouched, so the next tick retries");

  lock.release(acquired.owner);
  await (harness.provider as any).reconcilePendingState(await recordRoot(cwd));
  assert.equal(await pendingStashOf(harness), undefined, "once the lock is free the record settles");
  assert.equal((await reconcilePendingStash(cwd, sha)).kind === "resolved", true);
});

test("a settled-but-unreleased owner is reaped instead of blocking forever", async (t) => {
  const harness = createHarness(t);
  // A mutation whose `finally` never ran must not wedge the host.
  const lock = (harness.provider as any).mutations;
  const acquired = lock.tryAcquire({ action: "reorder", label: "变基重排", source: "webview:reorder" });
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;
  lock.markSettled(acquired.owner);
  const reaped = lock.reapSettled();
  assert.ok(reaped, "a settled owner is reclaimed");
  assert.equal(lock.isBusy(), false);
});

test("the watchdog warns once for its own stuck owner and ignores foreign cleanup", async (t) => {
  const harness = createHarness(t);
  const provider = harness.provider as any;
  // Shrink the deadline so the test does not wait 90 s; the production value is
  // covered separately by mutationLock's staleAfterMs assertions.
  Object.defineProperty(provider.mutations, "staleAfterMs", { value: 30, configurable: true });
  const acquired = provider.mutations.tryAcquire({
    action: "reorder",
    label: "变基重排",
    source: "webview:reorder",
  });
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;

  provider.armWatchdog(acquired.owner);
  // A late disarm from a superseded owner must not cancel the live watchdog.
  provider.disarmWatchdog({ id: acquired.owner.id + 999 });
  assert.ok(provider.watchdog, "a foreign disarm is ignored while the owner is armed");

  await new Promise((resolve) => setTimeout(resolve, 400));
  const warnings = stub.messages.filter((entry) => entry.items.includes("强制解除并刷新"));
  assert.equal(warnings.length, 1, "the stuck owner produces exactly one actionable warning");
  assert.match(warnings[0].text, /“变基重排”/);
  assert.match(warnings[0].text, /id \d+/);
  assert.equal(provider.watchdog, undefined, "the watchdog clears itself after firing");
  assert.equal(provider.watchdogOwnerId, undefined);

  // Once fired it must not fire again for the same owner on a later tick.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    stub.messages.filter((entry) => entry.items.includes("强制解除并刷新")).length,
    1,
    "a fired watchdog does not repeat"
  );
  // Its own disarm after firing is harmless.
  provider.disarmWatchdog(acquired.owner);
  provider.mutations.release(acquired.owner);
});

test("the explicit Pop command confirms first and never pops without consent", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  commitFile(cwd, "base.txt", "base\n", "base");
  const sha = stashWork(cwd);

  // No answer to the modal: the stash must survive, since `pop` deletes it.
  stub.choice = undefined;
  await harness.provider.popChanges();
  const asked = stub.messages.filter((entry) => entry.items.includes("Pop 并删除该条目"));
  assert.equal(asked.length, 1, "the destructive step is confirmed explicitly");
  assert.match(asked[0].text, /stash@\{0\}/, "the confirmation names the stash it would delete");
  assert.deepEqual(git(cwd, ["stash", "list", "--format=%H"]).split("\n").filter(Boolean), [sha], "declining keeps the stash");

  // Consent: the pop runs and removes the entry, which is now the user's choice.
  stub.choice = "Pop 并删除该条目";
  await harness.provider.popChanges();
  assert.equal(git(cwd, ["stash", "list"]).trim(), "", "consenting pops the newest stash");
  assert.equal(fs.readFileSync(path.join(cwd, "base.txt"), "utf8").replace(/\r\n/g, "\n"), "work\n");
});

test("reset refuses to drop a content-bearing stash and says why", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  commitFile(cwd, "base.txt", "base\n", "base");
  // The stashed edit cannot be re-applied over the conflicting worktree, so the
  // stash stays the only copy of it: reset must not touch it.
  const sha = stashWork(cwd);
  fs.writeFileSync(path.join(cwd, "base.txt"), "conflicting\n", "utf8");
  await setPendingStash(harness, sha);

  const observed: { args: readonly string[] }[] = [];
  setGitInvocationObserver((entry) => observed.push(entry));
  t.after(() => setGitInvocationObserver(undefined));

  await harness.provider.resetExtensionState();

  assert.equal(await pendingStashOf(harness), sha, "a stash that still holds content keeps its record");
  const message = stub.messages.at(-1);
  assert.ok(message);
  assert.match(message!.text, /已保留/, "reset reports the record it kept");
  assert.match(message!.text, /stash 仍保存未恢复的改动/, "and the concrete reason");
  assert.match(message!.text, /git stash apply --index/, "and an actionable next step");
  assert.equal(git(cwd, ["rev-parse", "refs/stash"]), sha, "the recovery copy is untouched");
  assert.equal(
    observed.some((entry) => entry.args[0] === "stash" && ["drop", "pop", "clear"].includes(entry.args[1] ?? "")),
    false,
    "reset never runs a stash-removing command"
  );
});

test("the banner re-describes a stash whose slot moved, and stays dismissed after a dismissal", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  commitFile(cwd, "base.txt", "base\n", "base");
  const sha = stashWork(cwd);
  await setPendingStash(harness, sha);
  // A conflicting worktree keeps the record pending, so the banner is armed.
  fs.writeFileSync(path.join(cwd, "base.txt"), "conflicting\n", "utf8");

  await harness.provider.refresh();
  await settleRecovery(harness.provider, () => !!(harness.provider as any).recoveryNotice);
  const first = (harness.provider as any).recoveryNotice as string;
  assert.match(first, /stash@\{0\}/, "the armed banner names the current slot");
  assert.match(first, new RegExp(sha.slice(0, 7)), "and always the stable sha");
  const firstToasts = stub.messages.length;

  // A concurrent `stash push` of an unrelated path moves the record's stash to
  // `stash@{1}`. The stale `stash@{0}` in the banner would now name a different
  // stash, which is the bug: following it drops an unrelated entry.
  fs.writeFileSync(path.join(cwd, "other.txt"), "unrelated\n", "utf8");
  git(cwd, ["add", "other.txt"]);
  git(cwd, ["stash", "push", "-q", "-m", "unrelated", "--", "other.txt"]);
  assert.equal(git(cwd, ["rev-parse", "stash@{1}"]), sha, "the record's stash moved down one slot");

  // Allow the backoff window the provider keeps after a still-pending pass.
  (harness.provider as any).recoveryNotBefore = 0;
  await harness.provider.refresh();
  await settleRecovery(
    harness.provider,
    () => /stash@\{1\}/.test((harness.provider as any).recoveryNotice ?? ""),
    30_000
  );
  const refreshed = (harness.provider as any).recoveryNotice as string;
  assert.match(refreshed, /stash@\{1\}/, "the banner follows the current slot");
  assert.match(refreshed, new RegExp(sha.slice(0, 7)), "the stable sha identifies the stash");
  assert.equal(
    stub.messages.slice(firstToasts).filter((entry) => /未完成的/.test(entry.text)).length,
    0,
    "re-describing the same record does not toast again"
  );

  // Dismissal still wins: the same record stays hidden even though its text
  // changed, otherwise the fix for the stale name would regress the dismissal.
  await (harness.provider as any).onMessage({ type: "dismissRecoveryNotice", source: "webview:ui" });
  assert.equal((harness.provider as any).recoveryNotice, undefined);
  (harness.provider as any).recoveryNotBefore = 0;
  await harness.provider.refresh();
  await waitForRecoveryIdle(harness.provider);
  assert.equal((harness.provider as any).recoveryNotice, undefined, "a moved slot does not resurrect a dismissed banner");
  assert.equal(await pendingStashOf(harness), sha, "the record survives the whole sequence");
  assert.equal(git(cwd, ["rev-parse", "stash@{1}"]), sha, "and so does the stash, untouched");
});

/**
 * `restoreAppendSnapshot` reports the recovery copy in a conflict, and its
 * message interpolates both the slot name and the sha. A refactor once left a
 * literal `（sha sha）` there. Nothing executed that string, so no test noticed;
 * this pins the user-visible text for the resolvable-slot branch. The
 * unresolvable-slot wording is covered by the banner tests, not here.
 */
test("a conflicted restore names the recovery stash by slot and by sha", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  commitFile(cwd, "base.txt", "base\n", "base");
  const sha = stashWork(cwd);
  // A conflicting worktree makes the apply fail, so the pending branch that
  // owns this message runs instead of silently restoring.
  fs.writeFileSync(path.join(cwd, "base.txt"), "conflicting\n", "utf8");

  await (harness.provider as any).restoreAppendSnapshot(cwd, sha);

  const message = stub.messages.at(-1);
  assert.ok(message, "the conflict is reported");
  assert.doesNotMatch(message!.text, /sha sha/, "no unfilled placeholder reaches the user");
  assert.match(message!.text, new RegExp(sha.slice(0, 7)), "the stable sha identifies the copy");
  assert.match(message!.text, /stash@\{0\}/, "and the resolved slot is named as a hint");
  assert.match(message!.text, /git stash apply/, "with an actionable command");
  assert.equal(git(cwd, ["rev-parse", "refs/stash"]), sha, "the copy is never removed");
});
