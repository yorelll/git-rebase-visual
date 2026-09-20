import assert from "node:assert/strict";
import test from "node:test";
import { beginPointerDrag, canStartReorder, nativeTreeDropAtEndIntent, nativeTreeDropIntent, oneStepReorderIntent, pointerDropIntent } from "../src/ui/rebasePointerDragState";
import { validateReorderRequest } from "../src/ui/rebaseReorderState";

const a = "a".repeat(40);
const b = "b".repeat(40);
const c = "c".repeat(40);
const locked = "d".repeat(40);
const canonical = [a, b, c, locked];

test("pointer drag produces the same complete canonical intent as native drag", () => {
  assert.equal(canStartReorder({ rebaseInProgress: false, filterActive: false, locked: false }), true);
  assert.equal(canStartReorder({ rebaseInProgress: true, filterActive: false, locked: false }), false);
  assert.equal(canStartReorder({ rebaseInProgress: false, filterActive: true, locked: false }), false);
  assert.equal(canStartReorder({ rebaseInProgress: false, filterActive: false, locked: true }), false);
  const session = beginPointerDrag(c, 9, 42);
  assert.deepEqual(pointerDropIntent(session, { anchorHash: a, placement: "before" }, canonical), {
    sourceHash: c, pointerId: 42, revision: 9, anchorHash: a, placement: "before", order: [c, a, b, locked],
  });
  assert.equal(pointerDropIntent(session, { anchorHash: c, placement: "after" }, canonical), undefined);
});

test("native TreeView drop produces a no-layout-shift canonical intent", () => {
  assert.deepEqual(nativeTreeDropIntent(c, a, canonical, 12), {
    sourceHash: c, anchorHash: a, placement: "before", revision: 12, order: [c, a, b, locked],
  });
  assert.equal(nativeTreeDropIntent(c, c, canonical, 12), undefined);
  assert.equal(nativeTreeDropIntent("missing", a, canonical, 12), undefined);
});

test("native TreeView end boundary moves a commit to newest and remains host-validated", () => {
  const intent = nativeTreeDropAtEndIntent(b, canonical, 12);
  assert.deepEqual(intent, {
    sourceHash: b, anchorHash: locked, placement: "after", revision: 12, order: [a, c, locked, b],
  });
  assert.equal(validateReorderRequest(intent!, canonical, 12, new Set()).ok, true);
  assert.equal(validateReorderRequest(intent!, canonical, 13, new Set()).ok, false, "stale revision is rejected");
  assert.equal(validateReorderRequest(intent!, canonical, 12, new Set([locked])).ok, false, "locked end anchor is rejected");
  assert.equal(nativeTreeDropAtEndIntent(b, canonical, 12, new Set([locked])), undefined, "native end target rejects a locked newest commit");
  assert.equal(nativeTreeDropAtEndIntent(locked, canonical, 12), undefined, "already-newest source cannot be dropped after itself");
});

test("Alt arrows derive one-step canonical intents with boundaries and revision", () => {
  assert.deepEqual(oneStepReorderIntent(canonical, b, "up", 11), {
    sourceHash: b, anchorHash: a, placement: "before", revision: 11, order: [b, a, c, locked],
  });
  assert.deepEqual(oneStepReorderIntent(canonical, b, "down", 11), {
    sourceHash: b, anchorHash: c, placement: "after", revision: 11, order: [a, c, b, locked],
  });
  assert.equal(oneStepReorderIntent(canonical, a, "up", 11), undefined);
  assert.equal(oneStepReorderIntent(canonical, locked, "down", 11), undefined);
});
