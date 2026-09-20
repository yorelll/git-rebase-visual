import assert from "node:assert/strict";
import test from "node:test";
import { CommitDetailCache } from "../src/ui/commitDetailCache";

test("commit detail cache coalesces a selected-row read and avoids repeated poll reads", async () => {
  const cache = new CommitDetailCache<string>(2);
  let calls = 0;
  const load = async () => {
    calls += 1;
    return "rich immutable commit tooltip";
  };
  const [first, concurrent] = await Promise.all([
    cache.getOrLoad("/repo:commit", load),
    cache.getOrLoad("/repo:commit", load),
  ]);
  assert.equal(first, "rich immutable commit tooltip");
  assert.equal(concurrent, "rich immutable commit tooltip");
  assert.equal(calls, 1, "a duplicate refresh/selection joins the first Git request");
  assert.equal(await cache.getOrLoad("/repo:commit", load), "rich immutable commit tooltip");
  assert.equal(calls, 1, "subsequent 1.5-second status polls reuse immutable metadata");
});

test("commit detail cache remains bounded LRU and does not cache failures", async () => {
  const cache = new CommitDetailCache<string>(2);
  await cache.getOrLoad("a", async () => "a");
  await cache.getOrLoad("b", async () => "b");
  assert.equal(cache.get("a"), "a"); // a becomes newest; b is eviction candidate
  await cache.getOrLoad("c", async () => "c");
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.size, 2);
  let failures = 0;
  await assert.rejects(cache.getOrLoad("bad", async () => { failures += 1; throw new Error("no detail"); }));
  await assert.rejects(cache.getOrLoad("bad", async () => { failures += 1; throw new Error("no detail"); }));
  assert.equal(failures, 2, "failed metadata is retriable rather than becoming a permanent empty tooltip");
});
