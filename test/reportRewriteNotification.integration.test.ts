import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionContext, installVscodeStub, resetStub, stub } from "./helpers/vscodeStub";
import { commitFile, createRepo, git, removeRepo } from "./helpers/gitTestRepo";

installVscodeStub();

const { RebaseViewProvider } =
  require("../src/ui/rebaseViewProvider") as typeof import("../src/ui/rebaseViewProvider");
const { LockStore } = require("../src/lock/lockStore") as typeof import("../src/lock/lockStore");
const { createGitContentRequestStore } =
  require("../src/ui/gitDiffRequestState") as typeof import("../src/ui/gitDiffRequestState");
const { createGeneratedDiffSnapshotStore } =
  require("../src/ui/generatedDiffDocument") as typeof import("../src/ui/generatedDiffDocument");

interface Harness {
  cwd: string;
  provider: InstanceType<typeof RebaseViewProvider>;
  locks: InstanceType<typeof LockStore>;
}

function createHarness(t: { after: (fn: () => void | Promise<void>) => void }): Harness {
  resetStub();
  const cwd = createRepo();
  stub.workspaceFolders = [{ uri: { fsPath: cwd } }];
  // "all" avoids depending on an upstream; every commit must be in the
  // provider's rendered snapshot so the webview mutation guard accepts it.
  stub.config["gitRebaseVisual.commitRange"] = "all";
  const ctx = createExtensionContext();
  const locks = new LockStore(ctx.globalState as any);
  const provider = new RebaseViewProvider(
    ctx as any,
    locks,
    createGitContentRequestStore(),
    createGeneratedDiffSnapshotStore()
  );
  t.after(async () => {
    // A red test can leave the old awaited notification holding the lock. Free
    // it so the resolved promise and the watchdog timer cannot keep the test
    // process alive after the assertion has already failed.
    (provider as any).disarmWatchdog();
    (provider as any).mutations.forceRelease();
    await (provider as any).recoveryPass?.catch?.(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      removeRepo(cwd);
    } catch {
      // A leftover temp directory is not a test failure.
    }
  });
  return { cwd, provider, locks };
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Resolves to `undefined` when the promise has not settled within `ms`. */
async function settlesWithin<T>(promise: Promise<T>, ms = 60_000): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Collects unhandled rejections for the lifetime of one test. */
function collectUnhandledRejections(t: {
  after: (fn: () => void | Promise<void>) => void;
}): unknown[] {
  const seen: unknown[] = [];
  const handler = (reason: unknown) => {
    seen.push(reason);
  };
  process.on("unhandledRejection", handler);
  t.after(() => {
    process.off("unhandledRejection", handler);
  });
  return seen;
}

/**
 * Builds the same state the second test models: a real completed Undo record
 * whose locked patch is no longer reachable from HEAD, so `reportRewrite` shows
 * the missing-lock warning. The warning is what offers the Undo action.
 */
async function setupMissingLockWarning(harness: Harness): Promise<{
  base: string;
  lost: string;
  undoRecord: any;
}> {
  const { cwd, provider, locks } = harness;
  const base = commitFile(cwd, "f.txt", "line1\nline2\n", "base");
  const lost = commitFile(cwd, "f.txt", "line1\nline2\nlocked\n", "locked");
  await provider.refresh();

  const root = (provider as any).root as string;
  const patchId = await locks.computePatchId(cwd, lost);
  assert.ok(patchId, "the locked commit must have a patch-id");
  await locks.lock(root, lost, patchId);

  const undoRecord = await (provider as any).undo.start(cwd, {
    operation: "删除 commit (drop)",
    beforeTip: lost,
    branch: git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    repository: root,
    affectedHashes: [lost],
    affectedSteps: 1,
  });
  git(cwd, ["reset", "--hard", base]);
  return { base, lost, undoRecord };
}

test("an ignored success notification does not keep the mutation lock", async (t) => {
  const harness = createHarness(t);
  const { cwd, provider } = harness;
  commitFile(cwd, "base.txt", "base\n", "base");
  commitFile(cwd, "one.txt", "one\n", "one");
  const tip = commitFile(cwd, "two.txt", "two\n", "two");
  await provider.refresh();

  const before = git(cwd, ["rev-parse", "HEAD"]);
  // The drop confirmation is modal and resolves; the success notification is
  // non-modal, so the simulated user never dismisses it.
  stub.pendingMessages = true;
  stub.choice = "删除所选 commit";
  const handled = (provider as any).onMessage({
    type: "drop",
    source: "webview:test",
    hash: tip,
  }) as Promise<void>;
  void handled.catch(() => undefined);

  await waitFor(() => git(cwd, ["rev-parse", "HEAD"]) !== before, "the drop rewrite");
  await waitFor(
    () => stub.messages.some((entry) => entry.level === "info" && entry.text.includes("已完成")),
    "the success notification"
  );
  // `onMessage` releases the lock only after `handleMessage` returns, so wait
  // for the whole mutation to settle. With the old awaited notification this
  // never happens because the notification promise is deliberately pending.
  const settled = await settlesWithin(handled.then(() => true));
  assert.equal(
    settled,
    true,
    "an ignored notification must not keep the mutation unsettled (the reported 156 s hang)"
  );
  assert.equal(
    (provider as any).mutations.isBusy(),
    false,
    "an ignored notification must not leave the mutation lock held"
  );
  const success = stub.messages
    .filter((entry) => entry.level === "info" && entry.text.includes("已完成"))
    .at(-1)!;
  assert.match(success.text, /删除 commit \(drop\) 已完成/);
  assert.deepEqual(success.items, [], "success is a notification, not a prompt: no Undo button");
  assert.equal(git(cwd, ["log", "-1", "--format=%s"]), "one");
});

test("an ignored missing-lock warning does not keep the mutation lock", async (t) => {
  const harness = createHarness(t);
  const { cwd, provider, locks } = harness;
  const base = commitFile(cwd, "f.txt", "line1\nline2\n", "base");
  const lost = commitFile(cwd, "f.txt", "line1\nline2\nlocked\n", "locked");
  await provider.refresh();

  const root = (provider as any).root as string;
  const patchId = await locks.computePatchId(cwd, lost);
  assert.ok(patchId, "the locked commit must have a patch-id");
  await locks.lock(root, lost, patchId);

  // Model the post-rewrite state `reportRewrite` audits: the locked commit is
  // no longer reachable from HEAD, so its locked patch-id is missing. The undo
  // record is real, so the warning offers Undo.
  const undoRecord = await (provider as any).undo.start(cwd, {
    operation: "删除 commit (drop)",
    beforeTip: lost,
    branch: git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    repository: root,
    affectedHashes: [lost],
    affectedSteps: 1,
  });
  git(cwd, ["reset", "--hard", base]);

  // Hold the lock exactly as `onMessage` does around a real mutation, then run
  // the post-success audit with the warning notification left pending.
  const acquired = (provider as any).mutations.tryAcquire({
    action: "drop",
    label: "删除 commit",
    source: "webview:test",
  });
  assert.equal(acquired.ok, true);
  stub.pendingMessages = true;
  try {
    const audit = (provider as any).reportRewrite(
      cwd,
      "删除 commit (drop)",
      lost,
      1,
      undoRecord
    ) as Promise<boolean>;
    const settled = await settlesWithin(
      audit.then((warned): { settled: true; warned: boolean } => ({ settled: true, warned }))
    );
    assert.ok(
      settled,
      "the warning must settle even though the user ignores the non-modal notification"
    );
    assert.equal(settled.warned, true, "the missing-lock warning replaces the success notification");
  } finally {
    (provider as any).mutations.release(acquired.owner);
    (provider as any).disarmWatchdog();
  }

  assert.equal(
    (provider as any).mutations.isBusy(),
    false,
    "the caller's finally can release the lock because the audit did not await the warning"
  );
  const warning = stub.messages
    .filter((entry) => entry.level === "warn" && entry.text.includes("改写后未找到"))
    .at(-1)!;
  assert.ok(warning, "the missing-lock warning was shown");
  assert.match(
    warning.text,
    /^删除 commit \(drop\)：改写后未找到/,
    "the warning names which rewrite lost the locked patch"
  );
  assert.deepEqual(warning.items, ["Undo"], "the data-integrity warning keeps its Undo action");
  assert.equal(
    stub.messages.some((entry) => entry.level === "info" && entry.text.includes("已完成")),
    false,
    "the warning already reports the outcome; a second success notification is noise"
  );
});

test("Undo on the missing-lock warning is refused with a user-visible warning while the lock is busy", async (t) => {
  const harness = createHarness(t);
  const { cwd, provider } = harness;
  const { base, lost, undoRecord } = await setupMissingLockWarning(harness);

  // Another mutation owns the lock. Clicking Undo must neither run the work nor
  // steal or release that lock.
  const held = (provider as any).mutations.tryAcquire({
    action: "drop",
    label: "删除 commit",
    source: "webview:test",
  });
  assert.equal(held.ok, true);
  const owner = (held as any).owner;

  let undoRuns = 0;
  (provider as any).undoLatest = async () => {
    undoRuns += 1;
  };
  const unhandled = collectUnhandledRejections(t);
  stub.choice = "Undo";

  const audit = (provider as any).reportRewrite(
    cwd,
    "删除 commit (drop)",
    lost,
    1,
    undoRecord
  ) as Promise<boolean>;
  assert.equal(await audit, true, "the warning replaced the success notification");

  await waitFor(
    () => stub.outputLines.some((line) => line.includes("Undo 未执行")),
    "the busy-lock log line"
  );
  await waitFor(
    () => stub.messages.some((entry) => entry.level === "warn" && entry.text.includes("撤销未执行")),
    "the user-visible busy warning"
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(undoRuns, 0, "the undo must not run while another mutation owns the lock");
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), base, "history must be untouched");
  assert.equal((provider as any).mutations.isBusy(), true, "the busy lock must still be held");
  assert.equal(
    (provider as any).mutations.current(),
    owner,
    "the other mutation's lock must be the one that is still held"
  );
  assert.equal(stub.outputLines.some((line) => line.includes("Undo 失败")), false);
  assert.deepEqual(unhandled, [], "a refused undo must not escape as an unhandled rejection");

  (provider as any).mutations.release(owner);
  (provider as any).disarmWatchdog();
});

test("a failing Undo from the missing-lock warning is logged without an unhandled rejection", async (t) => {
  const harness = createHarness(t);
  const { cwd, provider } = harness;
  const { base, lost, undoRecord } = await setupMissingLockWarning(harness);

  let undoCalls = 0;
  (provider as any).undoLatest = async () => {
    undoCalls += 1;
    throw new Error("probe-boom");
  };
  const unhandled = collectUnhandledRejections(t);
  stub.choice = "Undo";

  const audit = (provider as any).reportRewrite(
    cwd,
    "删除 commit (drop)",
    lost,
    1,
    undoRecord
  ) as Promise<boolean>;
  assert.equal(await audit, true, "the warning replaced the success notification");

  await waitFor(
    () => stub.outputLines.some((line) => line.includes("Undo 失败：probe-boom")),
    "the failure log line"
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(undoCalls, 1, "the undo work runs once under its own lock");
  assert.equal(
    stub.outputLines.some((line) => line.includes("Undo 未执行")),
    false,
    "a failing undo must not be misreported as a busy lock"
  );
  assert.equal((provider as any).mutations.isBusy(), false, "the fresh lock is released after the failure");
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), base, "the failing undo did not touch history");
  assert.deepEqual(unhandled, [], "a rejected undo must not escape as an unhandled rejection");
});

test("Undo on the missing-lock warning runs once under a free lock", async (t) => {
  const harness = createHarness(t);
  const { cwd, provider } = harness;
  const { base, lost, undoRecord } = await setupMissingLockWarning(harness);

  let undoCalls = 0;
  (provider as any).undoLatest = async () => {
    undoCalls += 1;
  };
  const unhandled = collectUnhandledRejections(t);
  stub.choice = "Undo";

  const audit = (provider as any).reportRewrite(
    cwd,
    "删除 commit (drop)",
    lost,
    1,
    undoRecord
  ) as Promise<boolean>;
  assert.equal(await audit, true, "the warning replaced the success notification");

  await waitFor(() => undoCalls === 1, "the undo work to run");
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(undoCalls, 1, "the undo work runs exactly once");
  assert.equal(
    stub.outputLines.some((line) => line.includes("Undo 未执行")),
    false,
    "a successful undo must not be reported as a busy lock"
  );
  assert.equal(
    stub.outputLines.some((line) => line.includes("Undo 失败")),
    false,
    "a successful undo must not be reported as a failure"
  );
  assert.equal((provider as any).mutations.isBusy(), false, "the fresh lock is released after the undo");
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), base, "the stubbed undo does not touch history");
  assert.deepEqual(unhandled, []);
});
