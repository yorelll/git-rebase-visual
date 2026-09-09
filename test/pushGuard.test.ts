import assert from "node:assert/strict";
import test from "node:test";
import { resolveRefspec } from "../src/git/pushGuard";
import { LockStore } from "../src/lock/lockStore";

const upstream = { remote: "origin", branch: "feature/topic", ref: "origin/feature/topic" };

test("resolveRefspec defaults to an explicit branch ref", () => {
  assert.equal(resolveRefspec(upstream, "HEAD"), "HEAD:refs/heads/feature/topic");
});

test("resolveRefspec substitutes all supported template placeholders", () => {
  assert.equal(
    resolveRefspec(upstream, "abc123", "${tip}:refs/for/${branch}"),
    "abc123:refs/for/feature/topic"
  );
});

test("resolveRefspec treats whitespace-only template as default", () => {
  assert.equal(resolveRefspec(upstream, "HEAD", "  "), "HEAD:refs/heads/feature/topic");
});

test("LockStore lockMany persists a deduplicated atomic selection", async () => {
  const values = new Map<string, unknown>();
  const store = new LockStore({
    get<T>(key: string, fallback?: T) { return (values.get(key) ?? fallback) as T; },
    async update(key: string, value: unknown) { values.set(key, value); },
  } as any);
  await store.lockMany("repo", [
    { hash: "a".repeat(40), patchId: "same" },
    { hash: "b".repeat(40), patchId: "same" },
    { hash: "c".repeat(40), patchId: "other" },
  ]);
  assert.equal(store.lockedHashes("repo").size, 2);
  assert.equal(store.isLocked("repo", "b".repeat(40), "same"), true);
  assert.equal(store.isLocked("repo", "c".repeat(40), "other"), true);
});
