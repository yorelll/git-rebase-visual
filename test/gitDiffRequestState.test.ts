import assert from "node:assert/strict";
import test from "node:test";
import {
  commitDiffSpec,
  createGitContentRequestStore,
} from "../src/ui/gitDiffRequestState";

test("opaque Git content requests enforce authority, LRU capacity, expiry, invalidation, and cleanup", () => {
  let now = 100;
  let sequence = 0;
  const store = createGitContentRequestStore({
    now: () => now,
    ttlMs: 10,
    maxEntries: 2,
    token: () => `request-${++sequence}`,
  });
  const first = store.create({ repository: "/repo-a", descriptor: { version: "head", filePath: "one.txt" } });
  const second = store.create({ repository: "/repo-b", descriptor: { version: "index", filePath: "two.txt" } });
  assert.deepEqual(store.resolve(first), { repository: "/repo-a", descriptor: { version: "head", filePath: "one.txt" } });
  const third = store.create({ repository: "/repo-a", descriptor: { version: "empty", filePath: "three.txt" } });
  assert.equal(store.resolve(second), undefined, "least-recently-used request is evicted");
  assert.ok(store.resolve(first));
  assert.ok(store.resolve(third));
  store.invalidateRepository("/repo-a");
  assert.equal(store.resolve(first), undefined);
  assert.equal(store.resolve(third), undefined);

  const expiring = store.create({ repository: "/repo-c", descriptor: { version: "commit", commit: "a".repeat(40), filePath: "four.txt" } });
  now += 10;
  assert.equal(store.resolve(expiring), undefined, "expired URI IDs cannot issue Git reads");
  assert.throws(() => store.create({ repository: "/repo-c", descriptor: { version: "commit", commit: "HEAD", filePath: "x.txt" } }));
  assert.throws(() => store.create({ repository: "/repo-c", descriptor: { version: "head", filePath: "../x.txt" } }));
  const cleanup = store.create({ repository: "/repo-d", descriptor: { version: "head", filePath: "five.txt" } });
  store.clear();
  assert.equal(store.resolve(cleanup), undefined);
});

test("commit parent-to-target resolver handles root/add/delete/rename and binary safely", () => {
  const target = "b".repeat(40);
  const parent = "a".repeat(40);
  assert.deepEqual(commitDiffSpec(undefined, target, { kind: "add", path: "root.txt", binary: false }), {
    left: { version: "empty", filePath: "root.txt" },
    right: { version: "commit", commit: target, filePath: "root.txt" },
    title: "Add (parent ↔ commit): root.txt",
  });
  assert.deepEqual(commitDiffSpec(parent, target, { kind: "delete", path: "gone.txt", binary: false }), {
    left: { version: "commit", commit: parent, filePath: "gone.txt" },
    right: { version: "empty", filePath: "gone.txt" },
    title: "Delete (parent ↔ commit): gone.txt",
  });
  assert.deepEqual(commitDiffSpec(parent, target, { kind: "rename", originalPath: "old.txt", path: "new.txt", binary: false }), {
    left: { version: "commit", commit: parent, filePath: "old.txt" },
    right: { version: "commit", commit: target, filePath: "new.txt" },
    title: "Rename (parent ↔ commit): old.txt → new.txt",
  });
  const binary = commitDiffSpec(parent, target, { kind: "modify", path: "asset.bin", binary: true });
  assert.match(binary.fallbackReason ?? "", /二进制文件/);
});
