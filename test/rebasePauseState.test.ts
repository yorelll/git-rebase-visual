import assert from "node:assert/strict";
import test from "node:test";
import { rebasePauseState } from "../src/ui/rebaseState";

test("rebasePauseState reports a sorted conflict count and prioritizes conflicts over edit", () => {
  assert.deepEqual(
    rebasePauseState(true, "a".repeat(40), ["z.ts", "a.ts", "z.ts"]),
    {
      conflictFiles: ["a.ts", "z.ts"],
      conflictCount: 2,
      pausedReason: "conflict",
    }
  );
});

test("rebasePauseState distinguishes edit stops and clears stale state", () => {
  assert.deepEqual(rebasePauseState(true, "b".repeat(40), []), {
    conflictFiles: [],
    conflictCount: 0,
    pausedReason: "edit",
  });
  assert.deepEqual(rebasePauseState(false, "b".repeat(40), ["stale.ts"]), {
    conflictFiles: [],
    conflictCount: 0,
    pausedReason: undefined,
  });
});
