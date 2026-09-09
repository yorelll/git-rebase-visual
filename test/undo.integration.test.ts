import assert from "node:assert/strict";
import test from "node:test";
import { runGit } from "../src/git/gitRunner";
import { MAX_UNDO_RECORDS, UndoJournal, undoPreflight } from "../src/git/undo";
import { commitFile, createRepo, git, removeRepo } from "./helpers/gitTestRepo";

function memento() {
  const values = new Map<string, unknown>();
  return { get<T>(key: string, fallback?: T) { return (values.has(key) ? values.get(key) : fallback) as T; }, async update(key: string, value: unknown) { values.set(key, value); } };
}

test("private undo ref restores a completed rewrite with reset --keep", async (t) => {
  const cwd = createRepo(); t.after(() => removeRepo(cwd));
  const before = commitFile(cwd, "a", "one\n", "before");
  const journal = new UndoJournal(memento(), memento());
  const record = await journal.start(cwd, { operation: "reword", beforeTip: before, branch: "master", repository: cwd, affectedHashes: [before], affectedSteps: 1 });
  const after = commitFile(cwd, "b", "two\n", "after");
  await journal.complete(record, after);
  assert.equal((await runGit(["show-ref", "--verify", "--quiet", record.beforeRef], { cwd })).code, 0);
  assert.deepEqual(undoPreflight({ rebaseInProgress: false, currentBranch: "master", expectedBranch: "master", head: after, expectedAfterTip: after, dirty: false, refExists: true }), { ok: true });
  assert.equal((await runGit(["reset", "--keep", record.beforeRef], { cwd })).code, 0);
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), before);
});

test("undo preflight rejects dirty tree, changed HEAD, rebase, branch, and missing ref", () => {
  const base = { rebaseInProgress: false, currentBranch: "main", expectedBranch: "main", head: "after", expectedAfterTip: "after", dirty: false, refExists: true };
  assert.equal(undoPreflight({ ...base, dirty: true }).ok, false);
  assert.equal(undoPreflight({ ...base, head: "other" }).ok, false);
  assert.equal(undoPreflight({ ...base, rebaseInProgress: true }).ok, false);
  assert.equal(undoPreflight({ ...base, currentBranch: "other" }).ok, false);
  assert.equal(undoPreflight({ ...base, refExists: false }).ok, false);
});

test("journal selects completed undo records only from the owning repository", async (t) => {
  const first = createRepo(); const second = createRepo();
  t.after(() => { removeRepo(first); removeRepo(second); });
  const firstTip = commitFile(first, "first", "one\n", "first");
  const secondTip = commitFile(second, "second", "two\n", "second");
  const workspace = memento(); const journal = new UndoJournal(workspace, memento());
  const one = await journal.start(first, { operation: "first", beforeTip: firstTip, branch: "master", repository: first, affectedHashes: [firstTip], affectedSteps: 1 });
  const two = await journal.start(second, { operation: "second", beforeTip: secondTip, branch: "master", repository: second, affectedHashes: [secondTip], affectedSteps: 1 });
  await journal.complete(one, firstTip);
  await journal.complete(two, secondTip);
  assert.equal(journal.latestCompleted(first)?.id, one.id);
  assert.equal(journal.latestCompleted(second)?.id, two.id);
});

test("journal retention removes an evicted private checkpoint ref", async (t) => {
  const cwd = createRepo(); t.after(() => removeRepo(cwd));
  const tip = commitFile(cwd, "tracked", "value\n", "tip");
  const journal = new UndoJournal(memento(), memento());
  let firstRef = "";
  for (let index = 0; index <= MAX_UNDO_RECORDS; index += 1) {
    const record = await journal.start(cwd, {
      operation: `rewrite-${index}`, beforeTip: tip, branch: "master", repository: cwd,
      affectedHashes: [tip], affectedSteps: 1,
    });
    if (index === 0) firstRef = record.beforeRef;
  }
  assert.equal((await runGit(["show-ref", "--verify", "--quiet", firstRef], { cwd })).code, 1);
});
