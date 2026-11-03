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

/**
 * The 0.8.1 report was that a successful recovery left the plugin's auto-stash
 * listed, so a bare `git stash pop` targeted the plugin's entry instead of the
 * user's own and failed with `could not restore untracked files from stash`.
 *
 * Autostash means stash → rebase → pop, and a pop removes the entry. The fix is
 * to remove our own entry, not to announce it: after a successful recovery
 * `git stash list` must hold exactly what the user had before the plugin acted.
 */
test("a completed auto-stash recovery removes the plugin's own entry", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  commitFile(cwd, "base.txt", "base\n", "base");
  // The auto-stash shape from the report: a worktree edit plus an untracked file.
  fs.writeFileSync(path.join(cwd, "base.txt"), "work\n", "utf8");
  fs.writeFileSync(path.join(cwd, "rtsispd.patch"), "my patch\n", "utf8");
  git(cwd, ["stash", "push", "-u", "-q"]);
  const sha = git(cwd, ["rev-parse", "stash@{0}"]);
  await setPendingStash(harness, sha);
  stub.messages.length = 0;

  await (harness.provider as any).recoverPendingStash(cwd, await recordRoot(cwd));

  const message = stub.messages.at(-1);
  assert.ok(message, "a successful recovery is announced");
  assert.match(message!.text, /已恢复/, "it says the recovery finished");
  assert.match(message!.text, /已删除/, "and that the plugin's temporary entry is gone");
  assert.doesNotMatch(message!.text, /git stash drop/, "there is nothing left for the user to clean up");
  assert.equal(git(cwd, ["stash", "list"]), "", "the plugin's entry is really gone");
  // `core.autocrlf` rewrites the line ending on checkout, so compare the text.
  assert.equal(
    fs.readFileSync(path.join(cwd, "rtsispd.patch"), "utf8").replace(/\r\n/g, "\n"),
    "my patch\n",
    "the untracked file came back"
  );
  assert.equal(await pendingStashOf(harness), undefined, "the record is settled");
});

test("an already-present auto-stash (resolved) also removes the plugin's own entry", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  commitFile(cwd, "base.txt", "base\n", "base");
  const sha = stashWork(cwd);
  // Restore the content by hand, so reconciliation takes the `resolved` branch
  // (no apply needed). This was the fully silent case; it is now also the case
  // that must not strand the entry.
  git(cwd, ["stash", "apply", "-q"]);
  await setPendingStash(harness, sha);
  stub.messages.length = 0;

  await (harness.provider as any).recoverPendingStash(cwd, await recordRoot(cwd));

  assert.equal(git(cwd, ["stash", "list"]), "", "the entry is removed once its content is verified back");
  assert.equal(await pendingStashOf(harness), undefined, "the record is settled");
});

/**
 * Announcing must not turn into a poll-loop notification. The record is cleared
 * by the same pass, so the second pass finds nothing to settle and says nothing.
 */
test("the settled notice is not repeated on every poll", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  commitFile(cwd, "base.txt", "base\n", "base");
  const sha = stashWork(cwd);
  git(cwd, ["stash", "apply", "-q"]);
  await setPendingStash(harness, sha);

  await (harness.provider as any).recoverPendingStash(cwd, await recordRoot(cwd));
  const afterFirst = stub.messages.length;

  // Two more reconciles with the record gone: neither may add a message.
  await (harness.provider as any).recoverPendingStash(cwd, await recordRoot(cwd));
  await (harness.provider as any).recoverPendingStash(cwd, await recordRoot(cwd));
  assert.equal(stub.messages.length, afterFirst, "nothing is repeated once the record is settled");
});

/**
 * The append path shares `applyPendingOutcome`, so it has the same obligation:
 * a settled append must not leave the transaction's change stash behind.
 */
test("a completed append recovery removes its change stash", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  commitFile(cwd, "base.txt", "base\n", "base");
  fs.writeFileSync(path.join(cwd, "base.txt"), "work\n", "utf8");
  git(cwd, ["stash", "push", "-q"]);
  const sha = git(cwd, ["rev-parse", "stash@{0}"]);
  git(cwd, ["stash", "apply", "-q"]);
  const pendingAppend = {
    changeStash: sha,
    targetHash: git(cwd, ["rev-parse", "HEAD"]),
    amended: true,
  };
  const map: Record<string, any> = {};
  map[await recordRoot(cwd)] = pendingAppend;
  await harness.ctx.workspaceState.update(PENDING_APPEND_KEY, map);
  stub.messages.length = 0;

  await (harness.provider as any).restorePendingAppend(cwd, await recordRoot(cwd), true);

  assert.equal(git(cwd, ["stash", "list"]), "", "the transaction's change stash is removed");
});

/**
 * The other half of the same promise. When our own entry cannot be removed —
 * the slot moved out from under the removal, so the helper refuses — the user
 * must be told which entry it is and how to clean it up, and must not be led to
 * believe the user's own stashes are at risk. A settled record also stays
 * settled: the entry is bookkeeping, not the record.
 */
test("a kept entry is reported by slot and sha, and says the user's stashes are untouched", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  commitFile(cwd, "base.txt", "base\n", "base");
  // A staged change, so the snapshot has an index half of its own.
  fs.writeFileSync(path.join(cwd, "base.txt"), "work\n", "utf8");
  git(cwd, ["add", "base.txt"]);
  git(cwd, ["stash", "push", "-q"]);
  const sha = git(cwd, ["rev-parse", "stash@{0}"]);
  // Put only the *worktree* half back by hand. `contentPresent` then holds but
  // `complete` does not: the index no longer reproduces the staged half, so the
  // entry is still the only record of the staged/unstaged split.
  fs.writeFileSync(path.join(cwd, "base.txt"), "work\n", "utf8");
  await setPendingStash(harness, sha);
  stub.messages.length = 0;

  await (harness.provider as any).recoverPendingStash(cwd, await recordRoot(cwd));

  const message = stub.messages.at(-1);
  assert.ok(message, "the kept entry is reported");
  assert.match(message!.text, /没有删除/, "it says the entry was not removed");
  assert.match(message!.text, /stash@\{0\}/, "and names the slot the user can act on");
  assert.match(message!.text, new RegExp(sha.slice(0, 7)), "and the stable sha");
  assert.match(message!.text, /git stash drop stash@\{0\}/, "with a command that can actually run");
  assert.match(message!.text, /请先核对/, "and asks the user to check before deleting, instead of promising it is free");
  assert.match(message!.text, /你自己压入的 stash 从头到尾没有被改动/, "and no fear about the user's own entries");
  assert.equal(git(cwd, ["rev-parse", "stash@{0}"]), sha, "the entry really is still listed");
  assert.equal(await pendingStashOf(harness), undefined, "the bookkeeping still settles: the content is back");
});

/**
 * The wrong-drop path reports its result as a `kept` removal whose message
 * explains that *another* entry was dropped and has been put back. Announcing
 * that through the ordinary leftover message would name the user's entry and
 * tell them to verify it and delete it — an instruction to delete their own
 * stash, produced by the very code path that exists to stop that happening.
 * The two shapes are therefore reported separately.
 */
test("an undone wrong drop is announced as the user's entry being restored, never as our leftover", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  commitFile(cwd, "base.txt", "base\n", "base");
  const sha = stashWork(cwd);
  git(cwd, ["stash", "apply", "-q"]);
  const committed = git(cwd, ["rev-parse", "HEAD"]);
  await setPendingStash(harness, sha);
  stub.messages.length = 0;

  const undoMessage =
    "stash@{0} 在删除瞬间已变成 1111111（不是本扩展的条目）；已用 git stash store 原样恢复该条目，未丢失任何内容。" +
    "注意：该条目现在位于列表最上方，它的 reflog 说明（git stash list 显示的 %gs）会变成 `git-rebase-visual restored 1111111`";
  (harness.provider as any).announceSettled("autostash", {
    kind: "resolved",
    detail: "内容已在工作区",
    stashRemoved: [
      { status: "kept", kind: "undo-restored", sha: "2".repeat(40), name: undefined, victim: "1".repeat(40), message: undoMessage },
    ],
  });

  const message = stub.messages.at(-1);
  assert.ok(message, "the undo is reported");
  assert.match(message!.text, /删到了别的条目/, "it says what actually went wrong");
  assert.match(message!.text, /已用 git stash store 原样恢复/, "and that the entry is back");
  assert.doesNotMatch(message!.text, /没有删除/, "it is not reported as our own unremoved leftover");
  assert.doesNotMatch(message!.text, /git stash drop/, "and it never offers to drop the restored entry");
  assert.doesNotMatch(message!.text, /请先核对/, "no instruction to check and delete the user's entry");
  assert.equal(committed.length > 0, true);
});

test("a mixed result reports the leftover and the undo without confusing the two", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  commitFile(cwd, "base.txt", "base\n", "base");
  const sha = stashWork(cwd);
  git(cwd, ["stash", "apply", "-q"]);
  await setPendingStash(harness, sha);
  stub.messages.length = 0;

  (harness.provider as any).announceSettled("autostash", {
    kind: "resolved",
    detail: "内容已在工作区",
    stashRemoved: [
      { status: "kept", kind: "leftover", sha: "3".repeat(40), name: "stash@{1}", message: "未能完整确认快照已回到索引与工作区" },
      {
        status: "kept",
        kind: "undo-restored",
        sha: "4".repeat(40),
        name: undefined,
        victim: "5".repeat(40),
        message: "已用 git stash store 原样恢复该条目，未丢失任何内容",
      },
    ],
  });

  const message = stub.messages.at(-1);
  assert.ok(message);
  assert.match(message!.text, /stash@\{1\}/, "the real leftover is named with its slot");
  assert.match(message!.text, /git stash drop stash@\{1\}/, "and offered as a cleanup command");
  assert.match(message!.text, /未能完整确认/, "with its own reason");
});

/**
 * The three refusals that are NOT "our leftover was kept" and NOT "a victim was
 * restored". The announcer used to tell them apart by searching `message` for
 * `"git stash store"`, which classified both of the following wrongly: the
 * `ambiguous-refusal` text contains that phrase (inside a "you can run this
 * manually" hint), so a refusal that restored nothing was announced as a
 * successful restore; and an unreadable post-drop listing contains no such
 * phrase, so it fell into the leftover branch and printed a `git stash drop
 * <slot>` command for a slot whose occupant was unknown.
 */
test("an ambiguous refusal is not announced as a restore", async (t) => {
  const harness = createHarness(t);
  commitFile(harness.cwd, "base.txt", "base\n", "base");
  stub.messages.length = 0;

  // The exact wording the ambiguous branch produces, phrase included.
  const ambiguous =
    "删除 stash@{0} 时列表中有 2 个其他条目同时消失（1111111、2222222），无法确定删除的是哪一条；" +
    "未尝试恢复，可用 git stash store <sha> 逐个恢复";
  (harness.provider as any).announceSettled("autostash", {
    kind: "resolved",
    detail: "内容已在工作区",
    stashRemoved: [
      { status: "kept", kind: "ambiguous-refusal", sha: "9".repeat(40), name: undefined, message: ambiguous },
    ],
  });

  const message = stub.messages.at(-1);
  assert.ok(message, "the refusal is reported");
  assert.doesNotMatch(message!.text, /已用 git stash store 原样恢复/, "nothing was restored");
  assert.doesNotMatch(message!.text, /删到了别的条目/, "and no victim is claimed");
  assert.doesNotMatch(message!.text, /git stash drop/, "no slot is offered for dropping either");
  assert.match(message!.text, /未尝试恢复/, "the user is told what did not happen");
  assert.match(message!.text, /git stash list/, "and how to check by hand");
});

test("an unreadable post-drop listing never offers a drop command", async (t) => {
  const harness = createHarness(t);
  commitFile(harness.cwd, "base.txt", "base\n", "base");
  stub.messages.length = 0;

  (harness.provider as any).announceSettled("autostash", {
    kind: "resolved",
    detail: "内容已在工作区",
    stashRemoved: [
      {
        status: "kept",
        kind: "undo-unknown",
        sha: "9".repeat(40),
        name: "stash@{0}",
        message: "删除瞬间 stash@{0} 已是 7777777，已尝试恢复但失败：boom",
      },
    ],
  });

  const message = stub.messages.at(-1);
  assert.ok(message);
  assert.doesNotMatch(message!.text, /git stash drop/, "a slot whose occupant is unknown must not be offered");
  assert.match(message!.text, /没有恢复任何条目/, "the announcement says nothing was restored");
  assert.match(message!.text, /已尝试恢复但失败/, "and carries the failure reason");
});

test("a genuine leftover still offers the drop command", async (t) => {
  const harness = createHarness(t);
  commitFile(harness.cwd, "base.txt", "base\n", "base");
  stub.messages.length = 0;

  (harness.provider as any).announceSettled("autostash", {
    kind: "resolved",
    detail: "内容已在工作区",
    stashRemoved: [
      { status: "kept", kind: "leftover", sha: "3".repeat(40), name: "stash@{0}", message: "未能完整确认快照已回到索引与工作区" },
    ],
  });

  const message = stub.messages.at(-1);
  assert.ok(message);
  assert.match(message!.text, /git stash drop stash@\{0\}/, "the cleanup command is offered for a known leftover");
  assert.match(message!.text, /没有删除/, "and it is named as ours, not as a victim");
});

test("the no-witness caveat reaches the log and the user, not just the Git module", async (t) => {
  const harness = createHarness(t);
  commitFile(harness.cwd, "base.txt", "base\n", "base");
  stub.messages.length = 0;

  // The entry was removed, but the pre-drop listing could not be read, so a
  // second loss cannot be ruled out. That caveat used to be built inside
  // `res.message` and dropped by `removeOwnStash` before anyone saw it.
  (harness.provider as any).announceSettled("autostash", {
    kind: "resolved",
    detail: "内容已在工作区",
    stashRemoved: [
      {
        status: "removed",
        kind: "removed",
        sha: "6".repeat(40),
        name: "stash@{0}",
        uncrosschecked: true,
        message: "该条目已确认从 stash 列表消失，但删除前的列表未能读取，无法交叉核对是否有其他条目一起消失",
      },
    ],
  });

  const message = stub.messages.at(-1);
  assert.ok(message, "the user is told");
  assert.match(message!.text, /无法交叉核对/, "the caveat reaches the user-facing toast");
  assert.match(message!.text, /git stash list/, "with the command to check");
  const line = stub.outputLines.find((text) => text.includes("uncrosschecked="));
  assert.ok(line, "and it is written to the log with the sha");
  assert.match(line!, /6666666/, "naming the entry it applies to");
});
