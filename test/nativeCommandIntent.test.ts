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

test("native batch commands require the passed TreeItem to belong to current multiselection", () => {
  const second = "b".repeat(40);
  const unrelated = {
    ...commit,
    commit: { ...commit.commit, hash: "c".repeat(40), shortHash: "c".repeat(8) },
  };
  const selected = [hash, second];

  assert.deepEqual(nativeCommandIntent("bulkLock", commit, 18, selected), {
    type: "bulkLock", hashes: selected,
  });
  assert.deepEqual(nativeCommandIntent("bulkDrop", commit, 18, selected), {
    type: "bulkDrop", hashes: selected,
  });
  assert.deepEqual(nativeCommandIntent("bulkGenerateDiff", commit, 18, selected), {
    type: "bulkGenerateDiff", hashes: selected, revision: 18,
  });

  for (const type of ["bulkLock", "bulkDrop", "bulkGenerateDiff"]) {
    assert.equal(
      nativeCommandIntent(type, unrelated, 18, selected),
      undefined,
      `A+B selection must reject a command invoked on unrelated C (${type})`
    );
    assert.equal(nativeCommandIntent(type, commit, 18, [hash]), undefined);
  }
});
