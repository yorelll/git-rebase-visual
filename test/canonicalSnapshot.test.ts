import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSnapshotKey, nextCanonicalSnapshotRevision } from "../src/ui/canonicalSnapshot";

const a = "a".repeat(40);
const b = "b".repeat(40);

function input(overrides: Partial<Parameters<typeof canonicalSnapshotKey>[0]> = {}) {
  return {
    repository: "C:/repo",
    branch: "feature/reorder",
    range: "origin/main..HEAD",
    rebaseInProgress: false,
    hashesNewestFirst: [b, a],
    lockedHashes: new Set<string>(),
    ...overrides,
  };
}

test("canonical reorder revision survives routine status refreshes but rejects actionable history changes", () => {
  const initial = nextCanonicalSnapshotRevision({ revision: 0 }, input());
  const statusOnly = nextCanonicalSnapshotRevision(initial, input());
  assert.equal(statusOnly.revision, initial.revision, "status/count/author presentation refresh must not expire a normal drag");

  const reorderedHistory = nextCanonicalSnapshotRevision(statusOnly, input({ hashesNewestFirst: [a, b] }));
  assert.equal(reorderedHistory.revision, initial.revision + 1);
  const lockChanged = nextCanonicalSnapshotRevision(reorderedHistory, input({ lockedHashes: new Set([a]) }));
  assert.equal(lockChanged.revision, reorderedHistory.revision + 1);
  const rangeChanged = nextCanonicalSnapshotRevision(lockChanged, input({ range: "HEAD~20..HEAD" }));
  assert.equal(rangeChanged.revision, lockChanged.revision + 1);
  const rebaseChanged = nextCanonicalSnapshotRevision(rangeChanged, input({ rebaseInProgress: true }));
  assert.equal(rebaseChanged.revision, rangeChanged.revision + 1);
});
