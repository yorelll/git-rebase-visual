import assert from "node:assert/strict";
import test from "node:test";
import { nativeCommandIntent } from "../src/ui/nativeCommandIntent";

const hash = "a".repeat(40);
const commit = {
  kind: "commit" as const,
  commit: { hash, shortHash: hash.slice(0, 8), subject: "one", author: "Author", authorEmail: "author@example.test", date: "today" },
  locked: false,
  stopped: false,
  pending: false,
};

test("native one-commit Generate Diff carries the canonical revision", () => {
  assert.deepEqual(nativeCommandIntent("generateDiff", commit, 17), {
    type: "generateDiff", hash, revision: 17,
  });
});

test("native multiple Generate Diff carries selected hashes and canonical revision", () => {
  const second = "b".repeat(40);
  assert.deepEqual(nativeCommandIntent("bulkGenerateDiff", commit, 18, [hash, second]), {
    type: "bulkGenerateDiff", hashes: [hash, second], revision: 18,
  });
  assert.equal(nativeCommandIntent("bulkGenerateDiff", commit, 18, [hash]), undefined);
});
