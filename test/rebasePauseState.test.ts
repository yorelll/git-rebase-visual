import assert from "node:assert/strict";
import test from "node:test";
import { rebasePauseState } from "../src/ui/rebaseState";

test("rebasePauseState reports a sorted conflict count and prioritizes conflicts over edit", () => {
  assert.deepEqual(
    rebasePauseState(true, true, ["z.ts", "a.ts", "z.ts"]),
    {
      conflictFiles: ["a.ts", "z.ts"],
      conflictCount: 2,
      pausedReason: "conflict",
    }
  );
});

test("rebasePauseState uses explicit edit state and clears stale state", () => {
  assert.deepEqual(rebasePauseState(true, true, []), {
    conflictFiles: [],
    conflictCount: 0,
    pausedReason: "edit",
  });
  assert.deepEqual(rebasePauseState(true, false, []), {
    conflictFiles: [],
    conflictCount: 0,
    pausedReason: "paused",
  });
  assert.deepEqual(rebasePauseState(false, true, ["stale.ts"]), {
    conflictFiles: [],
    conflictCount: 0,
    pausedReason: undefined,
  });
});
