import assert from "node:assert/strict";
import test from "node:test";
import { createGeneratedDiffSnapshotStore } from "../src/ui/generatedDiffDocument";

test("generated Diff snapshots are opaque, frozen, repository-scoped, TTL/LRU bounded, and cleanable", () => {
  let now = 100;
  let sequence = 0;
  const store = createGeneratedDiffSnapshotStore({
    now: () => now,
    ttlMs: 10,
    maxEntries: 2,
    token: () => `snapshot-${++sequence}`,
  });

  let source = "oldest selected commit only\n";
  const first = store.create({ repository: "/repo-a", content: source, language: "diff" });
  source = "mutated after generation";
  assert.deepEqual(store.resolve(first), {
    repository: "/repo-a",
    content: "oldest selected commit only\n",
    language: "diff",
  });

  const second = store.create({ repository: "/repo-b", content: "second", language: "diff" });
  // Resolve first after both exist, then capacity eviction removes second.
  assert.equal(store.resolve(first)?.content, "oldest selected commit only\n");
  const third = store.create({ repository: "/repo-a", content: "third", language: "diff" });
  assert.equal(store.resolve(second), undefined);
  assert.equal(store.resolve(first)?.content, "oldest selected commit only\n");
  assert.equal(store.resolve(third)?.content, "third");

  store.invalidateRepository("/repo-a");
  assert.equal(store.resolve(first), undefined);
  assert.equal(store.resolve(third), undefined);
  assert.throws(() => store.create({ repository: "", content: "x", language: "diff" }));

  const expiring = store.create({ repository: "/repo-c", content: "snapshot", language: "diff" });
  now += 10;
  assert.equal(store.resolve(expiring), undefined);
  const cleanup = store.create({ repository: "/repo-d", content: "snapshot", language: "diff" });
  store.clear();
  assert.equal(store.resolve(cleanup), undefined);
});
