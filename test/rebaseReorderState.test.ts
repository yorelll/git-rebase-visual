import assert from "node:assert/strict";
import test from "node:test";
import { reorderAround, validateReorderRequest } from "../src/ui/rebaseReorderState";

const a = "a".repeat(40);
const b = "b".repeat(40);
const c = "c".repeat(40);
const d = "d".repeat(40);
const canonical = [a, b, c, d];

test("drag reorder derives a complete canonical order from source anchor placement", () => {
  assert.deepEqual(reorderAround(canonical, d, b, "before"), [a, d, b, c]);
  assert.deepEqual(reorderAround(canonical, a, c, "after"), [b, c, a, d]);
});

test("drag reorder rejects stale session, partial order and locked source", () => {
  const valid = { sourceHash: d, anchorHash: b, placement: "before", revision: 7, order: [a, d, b, c] };
  assert.equal(validateReorderRequest(valid, canonical, 7, new Set()).ok, true);
  assert.equal(validateReorderRequest({ ...valid, revision: 6 }, canonical, 7, new Set()).ok, false);
  assert.equal(validateReorderRequest({ ...valid, order: [a, d, b] }, canonical, 7, new Set()).ok, false);
  assert.equal(validateReorderRequest(valid, canonical, 7, new Set([d])).ok, false);
  assert.equal(validateReorderRequest({ ...valid, order: [a, d, c, b] }, canonical, 7, new Set()).ok, false);
});

test("a locked commit that would be shifted by a reorder is distinguishable from an unchanged prefix", () => {
  const proposed = reorderAround(canonical, d, a, "before");
  assert.deepEqual(proposed, [d, a, b, c]);
  // `b` remains in the payload but moves from index 1 to 2, so a host rewrite
  // guard must inspect canonical positions, not merely reject a locked source.
  assert.notEqual(proposed?.indexOf(b), canonical.indexOf(b));
  assert.equal(canonical.indexOf(a), 0);
});
