import assert from "node:assert/strict";
import test from "node:test";
import { initialSearchCompositionState, matchesCommitSearch, parseCommitSearch, reduceSearchComposition } from "../src/ui/commitSearch";

const commit = {
  hash: "8e1234567890abcdef1234567890abcdef123456",
  shortHash: "8e123456",
  subject: "feat: 支持中文输入",
  author: "王小明",
  authorEmail: "wang@example.com",
  date: "2026-09-12",
};

test("commit search scopes author/msg/hash, normalizes hash 0x, and falls back for unknown prefixes", () => {
  assert.deepEqual(parseCommitSearch("author:王 msg:中文 hash:0x8e12"), [
    { field: "author", value: "王" }, { field: "msg", value: "中文" }, { field: "hash", value: "8e12" },
  ]);
  assert.equal(matchesCommitSearch(commit, "author:王 msg:中文 hash:0x8e12"), true);
  assert.equal(matchesCommitSearch(commit, "hash:0x8e1234"), true);
  assert.equal(matchesCommitSearch(commit, "hash:0x1234"), false);
  assert.equal(matchesCommitSearch(commit, "owner:王"), false);
  assert.equal(matchesCommitSearch({ ...commit, subject: "owner:王 的提交" }, "owner:王"), true);
  assert.equal(matchesCommitSearch(commit, "wang@example.com 支持"), true);
});

test("IME reducer defers input rendering until one final compositionend value", () => {
  const started = reduceSearchComposition(initialSearchCompositionState, "compositionstart", "z");
  const updated = reduceSearchComposition(started, "compositionupdate", "zhong");
  const ignoredInput = reduceSearchComposition(updated, "input", "中");
  assert.equal(ignoredInput.value, "");
  assert.equal(ignoredInput.pendingValue, "中");
  assert.equal(ignoredInput.composing, true);
  const final = reduceSearchComposition(ignoredInput, "compositionend", "中");
  assert.deepEqual(final, { value: "中", composing: false });
  assert.deepEqual(reduceSearchComposition(final, "input", "中文"), { value: "中文", composing: false });
});
