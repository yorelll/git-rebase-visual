import assert from "node:assert/strict";
import test from "node:test";
import { mutationGateDecision } from "../src/ui/mutationGate";

test("provider mutation gate serializes stage and restore writes before paused policy", () => {
  for (const type of ["stageFile", "restoreFile"]) {
    assert.deepEqual(
      mutationGateDecision(type, { busy: false, pausedRebase: true }),
      { kind: "handle", intent: "mutation" },
      `${type} is an explicit edit-stop write`
    );
    assert.deepEqual(
      mutationGateDecision(type, { busy: true, pausedRebase: true }),
      { kind: "busy", intent: "mutation" },
      `${type} is serialized while a prior Git write is active`
    );
  }
});

test("provider mutation gate blocks unsafe paused writes and ignores UI/read traffic", () => {
  assert.deepEqual(
    mutationGateDecision("reorder", { busy: false, pausedRebase: true }),
    { kind: "blockedPaused", intent: "mutation" }
  );
  assert.deepEqual(
    mutationGateDecision("openWorktreeDiff", { busy: true, pausedRebase: true }),
    { kind: "handle", intent: "read" }
  );
  for (const type of ["scroll", "pointermove", "selection", "compositionupdate", "refresh", "toast"]) {
    assert.notEqual(
      mutationGateDecision(type, { busy: false, pausedRebase: true }).kind,
      "blockedPaused",
      `${type} must not create a paused-rebase warning`
    );
  }
});
