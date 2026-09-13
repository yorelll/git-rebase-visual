import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGeneratedDiffSnapshot,
  generatedDiffCommits,
  generatedDiffSelectionIsCurrent,
  generatedDiffRequestIsCurrent,
} from "../src/ui/generatedDiffState";
import { generatedDiffScheme, generatedDiffUriComponents } from "../src/ui/generatedDiffUriState";

const a = { hash: "a".repeat(40), shortHash: "aaaaaaaa" };
const b = { hash: "b".repeat(40), shortHash: "bbbbbbbb" };
const c = { hash: "c".repeat(40), shortHash: "cccccccc" };

test("generated Diff URI is a read-only provider URI rather than an editable untitled document", () => {
  const uri = generatedDiffUriComponents("opaque-snapshot-id");
  assert.equal(uri.scheme, generatedDiffScheme);
  assert.notEqual(uri.scheme, "untitled");
  assert.equal(uri.authority, "snapshot");
  assert.equal(uri.path, "/snapshot.diff");
  assert.equal(uri.query, "opaque-snapshot-id");
});

test("generated Diff accepts only an exact current contiguous selection in oldest-first order", () => {
  // Host commits are newest-first; a/b/c is the canonical oldest-first timeline.
  const commits = generatedDiffCommits([c, b, a], [c.hash, b.hash]);
  assert.deepEqual(commits, [b, c], "unordered payload is normalized to timeline order");
  assert.deepEqual(generatedDiffCommits([c, b, a], [a.hash]), [a], "single selection remains exact");
  assert.equal(generatedDiffCommits([c, b, a], [a.hash, c.hash]), undefined, "gapped 1/3 selection cannot generate a range Diff");
  assert.equal(generatedDiffCommits([c, b, a], [a.hash.slice(0, 8)]), undefined, "short or stale selection cannot generate");
  assert.equal(generatedDiffCommits([c, b, a], [a.hash, "d".repeat(40)]), undefined, "unknown current hash cannot generate");
  assert.equal(generatedDiffCommits([c, b, a], [a.hash, a.hash]), undefined, "duplicate selection cannot generate");
  assert.equal(generatedDiffSelectionIsCurrent(commits!, [c, b, a], [c.hash, b.hash]), true);
  assert.equal(generatedDiffSelectionIsCurrent(commits!, [c, a], [c.hash, b.hash]), false, "removed selection member rejects the stale request");
  assert.equal(generatedDiffRequestIsCurrent(commits!, [c, b, a], [c.hash, b.hash], 7, 7), true);
  assert.equal(generatedDiffRequestIsCurrent(commits!, [c, a, b], [c.hash, b.hash], 7, 8), false, "refresh revision changing while Git is read rejects the stale request");
});

test("generated Diff snapshot freezes a contiguous commit-range content and visibly records binary/truncation behavior", async () => {
  const selected = generatedDiffCommits([c, b, a], [b.hash, a.hash])!;
  const requested: string[] = [];
  const snapshot = await buildGeneratedDiffSnapshot(selected, async (commit) => {
    requested.push(commit.hash);
    return `commit ${commit.shortHash}\nBinary files differ\n`;
  });
  assert.deepEqual(requested, [a.hash, b.hash], "fetches the exact contiguous timeline range oldest-first");
  assert.match(snapshot.content, /连续 commit 区间/);
  assert.match(snapshot.content, /commit aaaaaaaa[\s\S]*commit bbbbbbbb/);
  assert.match(snapshot.content, /binary patch 或摘要/);
  assert.equal(snapshot.truncated, false);

  const truncated = await buildGeneratedDiffSnapshot([a], async () => "0123456789", 5);
  assert.equal(truncated.truncated, true);
  assert.match(truncated.content, /输出已在 5 字符处截断/);
});
