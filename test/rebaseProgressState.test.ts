import assert from "node:assert/strict";
import test from "node:test";
import { rebaseProgressState } from "../src/ui/rebaseState";

test("progress distinguishes done executable steps and pending original hashes", () => {
  const state = rebaseProgressState({
    rebaseInProgress: true, atEditStop: true, conflictFiles: [], stoppedHash: "a".repeat(40),
    doneLines: [`pick ${"b".repeat(40)} first`, `edit ${"a".repeat(40)} second`],
    todoLines: [`pick ${"c".repeat(40)} third`, "# comment"],
  });
  assert.equal(state.totalSteps, 3);
  assert.equal(state.completedSteps, 2);
  assert.equal(state.pausedReason, "edit");
  assert.deepEqual(state.pendingHashes, ["c".repeat(40)]);
});

test("external/unknown rebase does not invent progress", () => {
  const state = rebaseProgressState({ rebaseInProgress: true, atEditStop: false, conflictFiles: [] });
  assert.equal(state.totalSteps, undefined);
  assert.equal(state.completedSteps, undefined);
  assert.deepEqual(state.pendingHashes, []);
});
