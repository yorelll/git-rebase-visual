import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_STALE_AFTER_MS,
  MutationLock,
  busyRejectionMessage,
  mutationActionLabel,
  shortSource,
  staleLockDiagnostic,
  staleLockMessage,
} from "../src/ui/mutationLock";

function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

test("a free lock acquires with a stable owner identity", () => {
  const lock = new MutationLock();
  assert.equal(lock.isBusy(), false);
  assert.equal(lock.current(), undefined);
  const result = lock.tryAcquire({ action: "reorder", label: "变基重排", source: "webview:reorder" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(lock.isBusy(), true);
  assert.equal(lock.current()?.id, result.owner.id);
  assert.deepEqual(lock.current(), {
    id: result.owner.id,
    action: "reorder",
    label: "变基重排",
    source: "webview:reorder",
    startedAt: result.owner.startedAt,
  });
});

test("a second mutation is rejected and the rejection names the current owner", () => {
  const time = clock();
  const lock = new MutationLock({ now: time.now });
  const first = lock.tryAcquire({ action: "reorder", label: "变基重排", source: "webview:read" });
  assert.equal(first.ok, true);
  time.advance(12_000);
  const second = lock.tryAcquire({ action: "drop", label: "删除 commit", source: "webview:read" });
  assert.equal(second.ok, false);
  if (second.ok || !second.owner) return;
  assert.equal(second.owner.action, "reorder");
  const rejection = lock.rejection(second.owner);
  assert.ok(rejection);
  assert.equal(rejection.description, "“变基重排” (reorder, webview, 12s)");
  const message = busyRejectionMessage(rejection);
  assert.match(message, /正在执行/);
  assert.match(message, /变基重排/);
  assert.match(message, /reorder/);
  assert.match(message, /12s/);
  assert.match(message, /强制解除/);
});

test("release is owner-checked so a late finally cannot clear a newer owner", () => {
  const lock = new MutationLock();
  const first = lock.tryAcquire({ action: "reorder", label: "变基重排", source: "webview:read" });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(lock.release(first.owner), true);
  const second = lock.tryAcquire({ action: "drop", label: "删除 commit", source: "webview:read" });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  // A stale owner completing later must not free the new owner's lock.
  assert.equal(lock.release(first.owner), false);
  assert.equal(lock.current()?.id, second.owner.id);
  assert.equal(lock.release(second.owner), true);
  assert.equal(lock.isBusy(), false);
});

test("force release returns the owner it cleared and is safe when idle", () => {
  const lock = new MutationLock();
  assert.equal(lock.forceRelease(), undefined);
  const acquired = lock.tryAcquire({ action: "push", label: "推送", source: "command" });
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;
  const released = lock.forceRelease();
  assert.equal(released?.id, acquired.owner.id);
  assert.equal(lock.isBusy(), false);
});

test("reapSettled releases a lost release only after the owner promise settled", () => {
  const lock = new MutationLock();
  const acquired = lock.tryAcquire({ action: "reorder", label: "变基重排", source: "webview:read" });
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;
  assert.equal(lock.reapSettled(), undefined, "a running owner is never reaped");
  lock.markSettled(acquired.owner);
  const reaped = lock.reapSettled();
  assert.equal(reaped?.id, acquired.owner.id);
  assert.equal(lock.isBusy(), false, "the next message self-heals the lost release");
});

test("markSettled ignores an undefined owner and keeps an older owner untouched", () => {
  const lock = new MutationLock();
  lock.markSettled(undefined);
  const first = lock.tryAcquire({ action: "reorder", label: "变基重排", source: "webview:read" });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  lock.release(first.owner);
  const second = lock.tryAcquire({ action: "drop", label: "删除 commit", source: "webview:read" });
  assert.equal(second.ok, true);
  lock.markSettled(first.owner);
  assert.equal(lock.reapSettled(), undefined, "a superseded owner must not free the new lock");
  assert.equal(lock.isBusy(), true);
});

test("staleness is measured against the watchdog deadline", () => {
  const time = clock();
  const lock = new MutationLock({ now: time.now });
  const acquired = lock.tryAcquire({ action: "reorder", label: "变基重排", source: "webview:read" });
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;
  time.advance(DEFAULT_STALE_AFTER_MS - 1);
  assert.equal(lock.isStale(), false);
  assert.equal(lock.rejection(acquired.owner)?.stale, false);
  time.advance(1);
  assert.equal(lock.isStale(), true);
  const rejection = lock.rejection(acquired.owner);
  assert.ok(rejection);
  assert.equal(rejection.stale, true);
  const message = staleLockMessage(rejection, lock.elapsedMs());
  assert.match(message, /90s/);
  assert.match(message, /id 1/);
  assert.match(message, /强制解除/);
});

test("stale diagnostics carry the owner and elapsed time on one line", () => {
  const time = clock();
  const lock = new MutationLock({ now: time.now });
  const acquired = lock.tryAcquire({ action: "reorder", label: "变基重排", source: "webview:worktree" });
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;
  time.advance(95_000);
  const rejection = lock.rejection(acquired.owner);
  assert.ok(rejection);
  const line = staleLockDiagnostic(rejection, lock.elapsedMs());
  assert.match(line, /^mutation-stuck /);
  assert.match(line, /id=1/);
  assert.match(line, /action=reorder/);
  assert.match(line, /label=变基重排/);
  assert.match(line, /source=webview:worktree/);
  assert.match(line, /elapsedMs=95000/);
  assert.match(line, /startedAt=\d{4}-\d{2}-\d{2}T/);
});

test("shortSource keeps the origin but drops the action suffix", () => {
  assert.equal(shortSource("webview:reorder"), "webview");
  assert.equal(shortSource("command"), "command");
  assert.equal(shortSource(":weird"), ":weird");
});

test("every mutation action has a human label, with a machine-name fallback", () => {
  assert.equal(mutationActionLabel("reorder"), "变基重排");
  assert.equal(mutationActionLabel("bulkDrop"), "批量删除");
  assert.equal(mutationActionLabel("push"), "推送");
  assert.equal(mutationActionLabel("futureAction"), "futureAction");
});
