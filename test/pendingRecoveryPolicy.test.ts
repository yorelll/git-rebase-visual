import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_PENDING_WARNINGS,
  RecoveryCoordinator,
  clearPendingWarnings,
  currentBannerText,
  dismissPendingWarning,
  observePendingWarning,
  pendingWarningKey,
  recoveryKey,
  runPendingRecovery,
  shouldStartRecovery,
} from "../src/ui/pendingRecoveryPolicy";

test("pending warnings notify once per (stash sha, reason) across repeated polls", () => {
  // The recovery runs on the 1.5 s poll, so the same finding must not re-toast.
  let state = EMPTY_PENDING_WARNINGS;
  const first = observePendingWarning(state, "abc123", "apply --index 冲突", "text-1");
  assert.equal(first.shouldNotify, true);
  state = first.state;

  for (let poll = 0; poll < 5; poll++) {
    const repeat = observePendingWarning(state, "abc123", "apply --index 冲突", "text-1");
    assert.equal(repeat.shouldNotify, false, `poll ${poll} must stay silent`);
    state = repeat.state;
  }
  assert.equal(state.seen.length, 1);
  assert.equal(state.banner?.key, pendingWarningKey("abc123", "apply --index 冲突"));

  // A different stash, or a different reason, is a genuinely new warning.
  const otherStash = observePendingWarning(state, "def456", "apply --index 冲突", "text-2");
  assert.equal(otherStash.shouldNotify, true);
  const otherReason = observePendingWarning(otherStash.state, "abc123", "pop 冲突", "text-3");
  assert.equal(otherReason.shouldNotify, true);
  assert.equal(otherReason.state.seen.length, 3);
});

test("an armed banner updates its slot text without re-toasting", () => {
  // `stash@{n}` is a position. A concurrent `stash push` moves the user's
  // stash down, so the text captured on first sighting would tell the user to
  // drop an unrelated entry. The key (sha + reason) is stable and still governs
  // notification; only the rendered description is refreshed.
  const key = pendingWarningKey("abc123", "apply --index 冲突");
  const first = observePendingWarning(EMPTY_PENDING_WARNINGS, "abc123", "apply --index 冲突", "保存在 stash@{0}（sha abc123）");
  assert.equal(first.shouldNotify, true);
  assert.equal(first.state.banner?.text, "保存在 stash@{0}（sha abc123）");

  const shifted = observePendingWarning(first.state, "abc123", "apply --index 冲突", "保存在 stash@{1}（sha abc123）");
  assert.equal(shifted.shouldNotify, false, "the same record must not re-toast");
  assert.equal(shifted.key, key);
  assert.deepEqual(shifted.state.seen, [key], "the stable key is recorded once, not once per text");
  assert.equal(shifted.state.banner?.key, key, "the banner stays armed");
  assert.equal(shifted.state.banner?.text, "保存在 stash@{1}（sha abc123）", "text follows the current slot");

  // An unchanged text must not churn state, so a poll with nothing new returns
  // the same instance and the host can skip a re-render.
  const same = observePendingWarning(shifted.state, "abc123", "apply --index 冲突", "保存在 stash@{1}（sha abc123）");
  assert.equal(same.state, shifted.state);
  assert.equal(same.shouldNotify, false);
});

test("a dismissed banner is not re-armed by a shifted slot", () => {
  // The dismissal fix and the refresh fix must not fight: once the user closed
  // the banner, a moved stash slot is still the same problem, not a new one.
  let state = observePendingWarning(EMPTY_PENDING_WARNINGS, "abc123", "conflict", "保存在 stash@{0}").state;
  state = dismissPendingWarning(state);
  const shifted = observePendingWarning(state, "abc123", "conflict", "保存在 stash@{1}");
  assert.equal(shifted.shouldNotify, false);
  assert.equal(shifted.state.banner, undefined, "a dismissed banner stays dismissed");
  assert.equal(currentBannerText(shifted.state), undefined);

  // A genuinely different stash does re-arm and re-notify.
  const other = observePendingWarning(shifted.state, "def456", "conflict", "保存在 stash@{0}（sha def456）");
  assert.equal(other.shouldNotify, true);
  assert.equal(other.state.banner?.text, "保存在 stash@{0}（sha def456）");
});

test("a dismissed banner stays dismissed while the same warning persists", () => {
  let state = observePendingWarning(EMPTY_PENDING_WARNINGS, "abc123", "conflict", "text-a").state;
  state = dismissPendingWarning(state);
  assert.equal(state.banner?.key, undefined);

  // Suppression survives dismissal: no repeated toast for the same problem.
  const repeat = observePendingWarning(state, "abc123", "conflict", "text-a");
  assert.equal(repeat.shouldNotify, false);
  assert.equal(repeat.state.banner?.key, undefined, "dismissal is not undone by polling");
});

test("warnings reset once no pending record remains", () => {
  const state = observePendingWarning(EMPTY_PENDING_WARNINGS, "abc123", "conflict", "text-a").state;
  const cleared = clearPendingWarnings(state);
  assert.deepEqual(cleared.seen, []);
  assert.equal(cleared.banner, undefined);

  // After a clear, the same record may legitimately warn again.
  assert.equal(observePendingWarning(cleared, "abc123", "conflict", "text-a").shouldNotify, true);
  // Clearing an already-clean state returns the same instance.
  assert.equal(clearPendingWarnings(EMPTY_PENDING_WARNINGS), EMPTY_PENDING_WARNINGS);
});

test("recovery single-flight coalesces overlapping refreshes into one restore", async () => {
  const coordinator = new RecoveryCoordinator();
  let restores = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const task = async () => {
    restores += 1;
    await gate;
    return "done";
  };

  const key = recoveryKey("stash", "abc123");
  assert.equal(shouldStartRecovery(new Set(), key), true);
  const first = coordinator.run(key, task);
  const second = coordinator.run(key, task);
  const third = coordinator.run(key, task);
  assert.equal(first, second, "overlapping callers await the same promise");
  assert.equal(second, third);
  assert.equal(coordinator.size, 1, "only one restore is in flight");
  release?.();
  assert.deepEqual(await Promise.all([first, second, third]), ["done", "done", "done"]);
  assert.equal(restores, 1, "the restore ran exactly once");
  assert.equal(coordinator.size, 0);

  // A later refresh starts fresh work instead of reusing a settled promise.
  assert.equal(await coordinator.run(key, async () => "again"), "again");
});

test("overlapping refresh passes perform exactly one restore per pending record", async () => {
  // Mirrors the host: the 1.5 s poll, a workspace event and a read message can
  // all call refresh() while the first recovery is still awaiting Git.
  const coordinator = new RecoveryCoordinator();
  let restores = 0;
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const settled: string[] = [];

  type Outcome = { kind: "restored" | "none" };
  const hooks = {
    pendingStash: () => "abc123" as string | undefined,
    pendingAppend: () => undefined as { changeStash: string } | undefined,
    reconcileStash: async (): Promise<Outcome> => {
      restores += 1;
      await blocked;
      return { kind: "restored" };
    },
    reconcileAppend: async (): Promise<Outcome> => ({ kind: "none" }),
    settleStash: async () => { settled.push("stash"); },
    settleAppend: async () => { settled.push("append"); },
  };

  const first = runPendingRecovery(coordinator, hooks);
  const second = runPendingRecovery(coordinator, hooks);
  const third = runPendingRecovery(coordinator, hooks);
  assert.equal(coordinator.size, 1, "one recovery slot for one record");
  unblock?.();
  await Promise.all([first, second, third]);

  assert.equal(restores, 1, "the restore ran exactly once across three refreshes");
  assert.equal(settled.filter((entry) => entry === "stash").length, 1, "the record settles once");
  assert.equal(coordinator.size, 0);
});

test("a failed recovery releases its slot so the next poll can retry", async () => {
  const coordinator = new RecoveryCoordinator();
  await assert.rejects(
    () => coordinator.run(recoveryKey("append", "abc"), async () => { throw new Error("boom"); }),
    /boom/
  );
  assert.equal(coordinator.size, 0, "a rejected recovery must not wedge the record");
  assert.equal(await coordinator.run(recoveryKey("append", "abc"), async () => "retried"), "retried");
});

test("a recovery pass runs inside the provided lock and skips when it is busy", async () => {
  type Outcome = { kind: "restored" | "none" };
  const coordinator = new RecoveryCoordinator();
  const order: string[] = [];
  let locked = true;
  const hooks = {
    pendingStash: () => "abc123" as string | undefined,
    pendingAppend: () => undefined as { changeStash: string } | undefined,
    reconcileStash: async (): Promise<Outcome> => {
      order.push("reconcile");
      return { kind: "restored" };
    },
    reconcileAppend: async (): Promise<Outcome> => ({ kind: "none" }),
    settleStash: async () => { order.push("settle"); },
    settleAppend: async () => { order.push("settle-append"); },
    locked: async <T>(work: () => Promise<T>): Promise<T | undefined> => {
      if (locked) {
        order.push("skipped");
        return undefined;
      }
      order.push("lock");
      try {
        return await work();
      } finally {
        order.push("unlock");
      }
    },
  };

  // A mutation owns the lock: the pass must not run any Git work at all.
  assert.deepEqual(await runPendingRecovery(coordinator, hooks), {});
  assert.deepEqual(order, ["skipped"]);
  assert.equal(coordinator.size, 0, "a skipped pass must not leave a slot behind");

  // The next tick succeeds and everything runs inside the lock.
  locked = false;
  order.length = 0;
  const result = await runPendingRecovery(coordinator, hooks);
  assert.deepEqual(order, ["lock", "reconcile", "settle", "unlock"]);
  assert.equal(result.stash?.kind, "restored");
});

test("a task that throws synchronously does not poison its single-flight key", async () => {
  const coordinator = new RecoveryCoordinator();
  const key = recoveryKey("append", "abc");
  await assert.rejects(
    () =>
      coordinator.run(key, (() => {
        throw new Error("sync boom");
      }) as () => Promise<unknown>),
    /sync boom/
  );
  assert.equal(coordinator.size, 0, "the slot is released even when the throw is synchronous");
  assert.equal(await coordinator.run(key, async () => "recovered"), "recovered");
});
