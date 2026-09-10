import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import test from "node:test";
import { abortRebase, continueRebase, executeRebase, resolveBase } from "../src/git/rebaseEngine";
import { clearPatchIdCache, conflictedFiles, isRebaseInProgress, patchId, rebaseAtEditStop, rebaseStoppedSha } from "../src/git/commitLog";
import { LockStore } from "../src/lock/lockStore";
import { createRepo, commitFile, git, removeRepo } from "./helpers/gitTestRepo";

function memoryMemento() {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return values.has(key) ? values.get(key) as T : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      values.set(key, value);
    },
  };
}

function cleanupRebase(cwd: string): void {
  try {
    git(cwd, ["rebase", "--abort"]);
  } catch {
    // The test may have already completed or aborted the rebase.
  }
}

test("a drop plan that conflicts remains paused until Abort, so a caller can retain its lock", async (t) => {
  const cwd = createRepo();
  t.after(() => {
    cleanupRebase(cwd);
    removeRepo(cwd);
  });

  const base = commitFile(cwd, "shared.txt", "base\n", "base");
  const lockedTarget = commitFile(cwd, "shared.txt", "target\n", "locked target");
  const later = commitFile(cwd, "shared.txt", "later\n", "later change");
  const locks = new LockStore(memoryMemento() as any);
  const lockedPatch = await patchId(cwd, lockedTarget);
  await locks.lock(cwd, lockedTarget, lockedPatch);

  // This is the exact extension-level predicate checked before constructing a
  // drop rebase. It must stay true while the rebase is paused or is aborted.
  assert.equal(locks.isLocked(cwd, lockedTarget, lockedPatch), true);
  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, base),
    items: [
      { hash: base, action: "pick", subject: "base" },
      { hash: lockedTarget, action: "drop", subject: "locked target" },
      { hash: later, action: "pick", subject: "later change" },
    ],
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.stopped, true);
  assert.equal(await isRebaseInProgress(cwd), true);
  assert.deepEqual(await conflictedFiles(cwd), ["shared.txt"]);

  // The target's original object is still reachable through the pre-rebase tip
  // while Git is paused. The extension's UI guard blocks this operation before
  // this plan can run; this assertion documents why it must not unlock early.
  assert.equal(git(cwd, ["cat-file", "-e", `${lockedTarget}^{commit}`]), "");
  assert.equal(locks.isLocked(cwd, lockedTarget, lockedPatch), true);
  await abortRebase(cwd);
  assert.equal(await isRebaseInProgress(cwd), false);
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), later);
  assert.equal(locks.isLocked(cwd, lockedTarget, lockedPatch), true);
  clearPatchIdCache();
});

test("a replayed locked patch stays locked by patch-id after an earlier edit", async (t) => {
  const cwd = createRepo();
  t.after(() => {
    cleanupRebase(cwd);
    removeRepo(cwd);
    clearPatchIdCache();
  });

  const base = commitFile(cwd, "base.txt", "base\n", "base");
  const editable = commitFile(cwd, "editable.txt", "before\n", "editable");
  const locked = commitFile(cwd, "locked.txt", "locked\n", "locked");
  const locks = new LockStore(memoryMemento() as any);
  const lockedPatch = await patchId(cwd, locked);
  assert.ok(lockedPatch);
  await locks.lock(cwd, locked, lockedPatch);

  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, base),
    items: [
      { hash: base, action: "pick", subject: "base" },
      { hash: editable, action: "edit", subject: "editable" },
      { hash: locked, action: "pick", subject: "locked" },
    ],
  });
  assert.equal(outcome.stopped, true);
  git(cwd, ["commit", "--amend", "-m", "editable rewritten"]);
  const completed = await continueRebase(cwd);
  assert.equal(completed.ok, true);

  const replayedLocked = git(cwd, ["rev-parse", "HEAD"]);
  assert.notEqual(replayedLocked, locked);
  const replayedPatch = await patchId(cwd, replayedLocked);
  assert.equal(replayedPatch, lockedPatch);
  assert.equal(locks.isLocked(cwd, replayedLocked, replayedPatch), true);
  assert.deepEqual(locks.missingPatchIds(cwd, new Set([replayedPatch!])), []);
});

test("a missing locked patch remains persisted and is detectable after a rewrite", async (t) => {
  const cwd = createRepo();
  t.after(() => {
    cleanupRebase(cwd);
    removeRepo(cwd);
    clearPatchIdCache();
  });

  const base = commitFile(cwd, "base.txt", "base\n", "base");
  const locked = commitFile(cwd, "locked.txt", "locked\n", "locked");
  const locks = new LockStore(memoryMemento() as any);
  const lockedPatch = await patchId(cwd, locked);
  assert.ok(lockedPatch);
  await locks.lock(cwd, locked, lockedPatch);

  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, base),
    items: [
      { hash: base, action: "pick", subject: "base" },
      { hash: locked, action: "drop", subject: "locked" },
    ],
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(
    locks.missingPatchIds(cwd, new Set(), new Set([lockedPatch!])),
    [lockedPatch]
  );
  assert.equal(locks.lockedPatchIds(cwd).has(lockedPatch!), true);
});

test("Continue reports a stopped conflict until it is resolved, then completes", async (t) => {
  const cwd = createRepo();
  t.after(() => {
    cleanupRebase(cwd);
    removeRepo(cwd);
  });

  const base = commitFile(cwd, "shared.txt", "base\n", "base");
  const first = commitFile(cwd, "shared.txt", "first\n", "first");
  const second = commitFile(cwd, "shared.txt", "second\n", "second");

  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, base),
    items: [
      { hash: base, action: "pick", subject: "base" },
      { hash: first, action: "drop", subject: "first" },
      { hash: second, action: "pick", subject: "second" },
    ],
  });
  assert.equal(outcome.stopped, true);
  assert.deepEqual(await conflictedFiles(cwd), ["shared.txt"]);

  const blocked = await continueRebase(cwd);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.stopped, true);
  // Git keeps the stopped SHA while a replay conflict is unresolved. The
  // provider must not turn that stale marker into an edit-stop label after
  // conflict paths have been staged.
  assert.ok(await rebaseStoppedSha(cwd));
  assert.equal(await rebaseAtEditStop(cwd), false);

  // Resolve and stage, but inspect the pause state before Continue. This is
  // the short state-poller window that previously displayed a false edit stop.
  fs.writeFileSync(path.join(cwd, "shared.txt"), "resolved\n", "utf8");
  git(cwd, ["add", "shared.txt"]);
  assert.deepEqual(await conflictedFiles(cwd), []);
  assert.ok(await rebaseStoppedSha(cwd));
  assert.equal(await rebaseAtEditStop(cwd), false);
  const completed = await continueRebase(cwd);
  assert.equal(completed.ok, true);
  assert.equal(completed.stopped, false);
  assert.equal(await isRebaseInProgress(cwd), false);
  assert.equal(git(cwd, ["show", "HEAD:shared.txt"]), "resolved");
});

test("an edit stop can be aborted and restores the original tip", async (t) => {
  const cwd = createRepo();
  t.after(() => {
    cleanupRebase(cwd);
    removeRepo(cwd);
  });

  const base = commitFile(cwd, "base.txt", "base\n", "base");
  const edit = commitFile(cwd, "edit.txt", "edit\n", "edit target");
  const tip = commitFile(cwd, "tip.txt", "tip\n", "tip");

  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, base),
    items: [
      { hash: base, action: "pick", subject: "base" },
      { hash: edit, action: "edit", subject: "edit target" },
      { hash: tip, action: "pick", subject: "tip" },
    ],
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stopped, true);
  assert.equal(await rebaseStoppedSha(cwd), edit);
  assert.deepEqual(await conflictedFiles(cwd), []);

  await abortRebase(cwd);
  assert.equal(await isRebaseInProgress(cwd), false);
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), tip);
});
