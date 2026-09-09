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

test("exec and merge workflow commands count without inventing pending hashes", () => {
  const state = rebaseProgressState({
    rebaseInProgress: true, atEditStop: false, conflictFiles: [],
    doneLines: [`pick ${"a".repeat(40)} first`, "exec npm test", "label start"],
    todoLines: ["break", `merge -C ${"b".repeat(40)} topic`, `fixup ${"c".repeat(40)} follow-up`],
  });
  assert.equal(state.totalSteps, 6);
  assert.equal(state.completedSteps, 3);
  assert.deepEqual(state.pendingHashes, ["c".repeat(40)]);
});

test("unknown todo syntax suppresses progress and active hash", () => {
  const state = rebaseProgressState({
    rebaseInProgress: true, atEditStop: false, conflictFiles: [], stoppedHash: "a".repeat(40),
    doneLines: [`pick ${"b".repeat(40)} first`], todoLines: ["custom-command perhaps-a-hash"],
  });
  assert.equal(state.totalSteps, undefined);
  assert.equal(state.completedSteps, undefined);
  assert.equal(state.activeHash, undefined);
  assert.deepEqual(state.pendingHashes, []);
});
