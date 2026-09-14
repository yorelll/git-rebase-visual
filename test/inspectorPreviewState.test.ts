import assert from "node:assert/strict";
import test from "node:test";
import { InspectorPreviewCoordinator } from "../src/ui/inspectorPreviewState";

test("slow hover preview cannot overwrite a later explicit single action inspector", () => {
  const state = new InspectorPreviewCoordinator();
  const preview = state.beginPreview("a".repeat(40))!;
  const action = state.beginAction("single");
  assert.equal(state.canShowAction(action), true);
  assert.equal(state.showPreview(preview), false, "late commitDetail result from hover is discarded");
  assert.equal(state.dismissPreview("a".repeat(40)), undefined, "stale hover leave cannot close action inspector");
  assert.equal(state.canShowAction(action), true);
});

test("queued preview dismissal only closes the preview session that requested it", () => {
  const state = new InspectorPreviewCoordinator();
  const preview = state.beginPreview("a".repeat(40))!;
  assert.equal(state.showPreview(preview), true);
  const dismiss = state.dismissPreview("a".repeat(40));
  assert.equal(dismiss?.shouldClose, true);

  const action = state.beginAction("batch");
  assert.equal(state.canClosePreview(preview), false, "action ownership invalidates queued preview close");
  assert.equal(state.finishPreviewClose(preview), false);
  assert.equal(state.canShowAction(action), true, "batch action remains current");
});

test("hover may replace another hover but never an explicit action until external invalidation", () => {
  const state = new InspectorPreviewCoordinator();
  const first = state.beginPreview("a".repeat(40))!;
  const second = state.beginPreview("b".repeat(40))!;
  assert.equal(state.showPreview(first), false);
  assert.equal(state.showPreview(second), true);

  const action = state.beginAction("single");
  assert.equal(state.beginPreview("c".repeat(40)), undefined);
  state.invalidate();
  const afterExternalClose = state.beginPreview("d".repeat(40));
  assert.ok(afterExternalClose, "external editor close permits the next hover preview");
  assert.equal(state.canShowAction(action), false);
});
