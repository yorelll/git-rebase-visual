import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import { isRebaseInProgress, rebaseStoppedSha } from "../src/git/commitLog";
import { abortRebase, continueRebase, executeRebase, resolveBase } from "../src/git/rebaseEngine";
import { runGit } from "../src/git/gitRunner";
import {
  stashApplyIndexBySha,
  stashPush,
  stashPushKeepIndex,
  stashRestoreForAmend,
} from "../src/git/worktree";
import { cleanupRepo, createRepo, commitFile, git, gitExit } from "./helpers/gitTestRepo";

test("append transaction amends only the original index and restores worktree changes", async (t) => {
  const cwd = createRepo();
  t.after(() => cleanupRepo(cwd));

  const first = commitFile(cwd, "first.txt", "first\n", "first");
  const target = commitFile(cwd, "target.txt", "target\n", "target");
  const tip = commitFile(cwd, "later.txt", "later\n", "later");
  fs.writeFileSync(path.join(cwd, "append.txt"), "append\n", "utf8");
  git(cwd, ["add", "append.txt"]);
  fs.writeFileSync(path.join(cwd, "untracked.txt"), "keep me\n", "utf8");

  const snapshot = await stashPush(cwd);
  assert.ok(snapshot);
  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, first),
    items: [
      { hash: first, action: "pick", subject: "first" },
      { hash: target, action: "edit", subject: "target" },
      { hash: tip, action: "pick", subject: "later" },
    ],
  });
  assert.equal(outcome.stopped, true);
  assert.equal(await isRebaseInProgress(cwd), true);
  assert.equal(await rebaseStoppedSha(cwd), target);

  const applied = await stashApplyIndexBySha(cwd, snapshot);
  assert.equal(applied.ok, true);
  git(cwd, ["commit", "--amend", "--no-edit"]);
  const worktreeStash = await stashPushKeepIndex(cwd);
  assert.ok(worktreeStash);

  const completed = await continueRebase(cwd);
  assert.equal(completed.ok, true);
  assert.equal(await isRebaseInProgress(cwd), false);
  git(cwd, ["stash", "pop"]);
  // The extension's recovery never drops a stash, so clearing the snapshot here
  // is the explicit user action the test is standing in for.
  git(cwd, ["stash", "drop", "stash@{0}"]);

  const targetAfter = git(cwd, ["rev-parse", "HEAD~1"]);
  assert.notEqual(targetAfter, target);
  assert.equal(git(cwd, ["show", `${targetAfter}:append.txt`]), "append");
  assert.equal(git(cwd, ["show", "-s", "--format=%s", "HEAD"]), "later");
  assert.equal(fs.readFileSync(path.join(cwd, "untracked.txt"), "utf8").replace(/\r\n/g, "\n"), "keep me\n");
  assert.equal(git(cwd, ["stash", "list"]), "");
});

/**
 * Regression for the 0.8.1 report: staging ONE file and appending it to the
 * EARLIEST commit failed with `恢复暂存区失败：Index was not unstashed。` and
 * named two files that belong to *later* commits as conflicts.
 *
 * Why no conflict can be legitimate here: each commit adds only its own file,
 * so the target commit's tree has no relation to the other two paths. The
 * append only ever means "put the staged file into this commit". Any path from
 * a later commit reaching the index during the transaction is a bug in how the
 * snapshot is restored, not a real data collision.
 */
test("appending one staged file to the earliest commit never drags later commits' files into the index", async (t) => {
  const cwd = createRepo();
  t.after(() => cleanupRepo(cwd));

  // `commitFile` writes with `writeFileSync`, which does not create parents;
  // the reporter's paths are nested, so create the directories up front.
  for (const dir of ["irovog0va1", "ov05c10", "ov08x40"]) {
    fs.mkdirSync(path.join(cwd, "omniversion", dir), { recursive: true });
  }

  // Five commits, each owning exactly one file — the reporter's shape.
  commitFile(cwd, "README.md", "base\n", "chore: initial");
  const target = commitFile(
    cwd,
    "omniversion/irovog0va1/irovog0va1.c",
    "v1\n",
    "feat(cmos_sensor): add ir ovog0va1"
  );
  const laterA = commitFile(
    cwd,
    "omniversion/ov05c10/ov05c10.c",
    "v1\n",
    "feat(cmos_sensor): add ov05c10"
  );
  const laterB = commitFile(
    cwd,
    "omniversion/ov05c10/ov05c10_fpga.c",
    "v1\n",
    "feat(cmos_sensor): add ov05c10_fpga"
  );
  const laterC = commitFile(
    cwd,
    "omniversion/ov08x40/ov08x40_fpga.c",
    "v1\n",
    "feat(cmos_sensor): add ov08x40_fpga"
  );
  commitFile(cwd, "omniversion/hm1092.c", "v1\n", "feat(cmos_sensor): add ir hm1092");

  // The property that makes any conflict bogus: no commit touches another's file.
  for (const [hash, own] of [
    [target, "omniversion/irovog0va1/irovog0va1.c"],
    [laterA, "omniversion/ov05c10/ov05c10.c"],
    [laterB, "omniversion/ov05c10/ov05c10_fpga.c"],
    [laterC, "omniversion/ov08x40/ov08x40_fpga.c"],
  ] as const) {
    const touched = git(cwd, ["show", "--name-only", "--format=", hash]).split("\n").filter(Boolean);
    assert.deepEqual(touched, [own], `commit ${hash.slice(0, 7)} must own only ${own}`);
  }

  // Working tree: three modified files; stage exactly one of them.
  const stagedPath = "omniversion/irovog0va1/irovog0va1.c";
  const otherPaths = [
    "omniversion/ov05c10/ov05c10_fpga.c",
    "omniversion/ov08x40/ov08x40_fpga.c",
  ];
  fs.writeFileSync(path.join(cwd, stagedPath), "v1\nSTAGED-APPEND\n", "utf8");
  for (const p of otherPaths) {
    fs.writeFileSync(path.join(cwd, p), "v1\nWORKTREE-ONLY\n", "utf8");
  }
  git(cwd, ["add", stagedPath]);

  const snapshot = await stashPush(cwd);
  assert.ok(snapshot);

  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, target),
    items: [
      { hash: target, action: "edit", subject: "feat(cmos_sensor): add ir ovog0va1" },
      { hash: laterA, action: "pick", subject: "feat(cmos_sensor): add ov05c10" },
      { hash: laterB, action: "pick", subject: "feat(cmos_sensor): add ov05c10_fpga" },
      { hash: laterC, action: "pick", subject: "feat(cmos_sensor): add ov08x40_fpga" },
    ],
  });
  assert.equal(outcome.stopped, true);
  assert.equal(await rebaseStoppedSha(cwd), target);

  // Only the staged delta may reach the index: `stash^1..stash^2` is exactly one
  // path. The failure this test pins is that the restore pulls in `^2..stash`
  // as well, and those paths do not exist at `target`.
  const stagedDelta = git(cwd, ["diff", "--name-only", snapshot + "^1", snapshot + "^2"])
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(stagedDelta, [stagedPath], "the snapshot's index half is exactly the staged file");
  const worktreeOnly = git(cwd, ["diff", "--name-only", snapshot + "^2", snapshot]).split("\n").filter(Boolean);
  assert.deepEqual([...worktreeOnly].sort(), [...otherPaths].sort(), "the worktree-only half is the other two files");

  const applied = await stashApplyIndexBySha(cwd, snapshot);
  assert.equal(
    applied.ok,
    true,
    `restoring the staged snapshot must not conflict: ${applied.message} (index tree ${git(cwd, ["ls-tree", "-r", "--name-only", snapshot + "^2"]).split("\n").join(", ")})`
  );

  // No unmerged paths: the target commit has nothing to conflict with.
  const unmerged = git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  assert.equal(unmerged, "", `no conflicted paths expected, got: ${unmerged}`);

  // The index must contain the staged file and nothing from later commits.
  const indexAfter = git(cwd, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
  assert.deepEqual(indexAfter, [stagedPath], "only the staged file is in the index");

  git(cwd, ["commit", "--amend", "--no-edit"]);
  const amended = git(cwd, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean);
  assert.deepEqual(amended, [stagedPath], "the amended commit gains only the appended file");
  for (const other of otherPaths) {
    assert.notEqual(
      gitExit(cwd, ["cat-file", "-e", `HEAD:${other}`]),
      0,
      `${other} must not be committed by the earliest commit`
    );
  }

  const worktreeStash = await stashPushKeepIndex(cwd);
  assert.ok(worktreeStash);
  const completed = await continueRebase(cwd);
  assert.equal(completed.ok, true, `rebase --continue failed: ${completed.message}`);
  assert.equal(await isRebaseInProgress(cwd), false);

  // No user data lost: both recovery copies are still listed.
  const remaining = git(cwd, ["stash", "list", "--format=%H"]).split("\n").filter(Boolean);
  assert.deepEqual(
    [...remaining].sort(),
    [snapshot, worktreeStash].sort(),
    "both the full snapshot and the keep-index residue survive"
  );
});

/**
 * Companion to the report above, for the staged NEW file shape. `stash apply
 * --index` merged the worktree half here too: the later commit's path was
 * modified in the worktree but absent from the edited target, so it came back as
 * the same bogus modify/delete conflict (`A added.txt`, `DU later.txt`).
 */
test("appending a staged new file to an earlier commit never conflicts with a later commit's file", async (t) => {
  const cwd = createRepo();
  t.after(() => cleanupRepo(cwd));

  commitFile(cwd, "README.md", "base\n", "init");
  const target = commitFile(cwd, "first.txt", "first\n", "add first");
  const later = commitFile(cwd, "later.txt", "later\n", "add later");

  // A brand-new staged file, plus a worktree-only edit on the later commit's file.
  const stagedPath = "added.txt";
  const laterPath = "later.txt";
  fs.writeFileSync(path.join(cwd, stagedPath), "brand new\n", "utf8");
  git(cwd, ["add", stagedPath]);
  fs.writeFileSync(path.join(cwd, laterPath), "later\nWORKTREE-ONLY\n", "utf8");

  const snapshot = await stashPush(cwd);
  assert.ok(snapshot);

  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, target),
    items: [
      { hash: target, action: "edit", subject: "add first" },
      { hash: later, action: "pick", subject: "add later" },
    ],
  });
  assert.equal(outcome.stopped, true);
  assert.equal(await rebaseStoppedSha(cwd), target);

  const applied = await stashApplyIndexBySha(cwd, snapshot);
  assert.equal(applied.ok, true, `restoring the snapshot must not conflict: ${applied.message}`);
  assert.equal(git(cwd, ["diff", "--name-only", "--diff-filter=U"]), "", "no conflicted paths");
  assert.deepEqual(
    git(cwd, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean),
    [stagedPath],
    "only the staged new file is in the index"
  );

  git(cwd, ["commit", "--amend", "--no-edit"]);
  // The amended commit owns its own file plus the appended one, and nothing else.
  assert.deepEqual(
    git(cwd, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean).sort(),
    ["added.txt", "first.txt"],
    "the amended commit gains only the new file"
  );
  assert.notEqual(
    gitExit(cwd, ["cat-file", "-e", `HEAD:${laterPath}`]),
    0,
    "the later commit's file must not be pulled into the target commit"
  );
});

/**
 * The cleanest statement of the bug: nothing is untracked and nothing is
 * worktree-only. One file is staged, and it happens to belong to a later commit.
 * `stash apply --index` still failed here with `error: later.txt: does not exist
 * in index`, because the snapshot's worktree half names a path the edited target
 * never had.
 */
test("appending a staged file to an earlier commit works with no untracked or worktree residue", async (t) => {
  const cwd = createRepo();
  t.after(() => cleanupRepo(cwd));

  commitFile(cwd, "README.md", "base\n", "init");
  const target = commitFile(cwd, "first.txt", "first\n", "add first");
  const later = commitFile(cwd, "later.txt", "later\n", "add later");

  // Stage a modification of the later commit's own file; the worktree is clean
  // apart from that staged change.
  fs.writeFileSync(path.join(cwd, "later.txt"), "later\nSTAGED\n", "utf8");
  git(cwd, ["add", "later.txt"]);
  assert.equal(git(cwd, ["ls-files", "--others", "--exclude-standard"]), "", "no untracked files");
  assert.equal(git(cwd, ["diff", "--name-only"]), "", "no unstaged changes");

  const snapshot = await stashPush(cwd);
  assert.ok(snapshot);

  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, target),
    items: [
      { hash: target, action: "edit", subject: "add first" },
      { hash: later, action: "pick", subject: "add later" },
    ],
  });
  assert.equal(outcome.stopped, true);
  assert.equal(await rebaseStoppedSha(cwd), target);

  const applied = await stashApplyIndexBySha(cwd, snapshot);
  assert.equal(applied.ok, true, `a clean staged-only snapshot must restore: ${applied.message}`);
  assert.deepEqual(
    git(cwd, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean),
    ["later.txt"],
    "the staged file is restored to the index"
  );

  git(cwd, ["commit", "--amend", "--no-edit"]);
  assert.equal(
    git(cwd, ["show", `${"HEAD"}:later.txt`]),
    "later\nSTAGED",
    "the amended target commit carries the appended content"
  );
});

/**
 * Pins the shape that already worked, because a naive fix regresses it: a staged
 * DELETION. The path must end up absent from the index while the amended commit
 * records the removal, and the deleted file must not reappear in the worktree.
 */
test("appending a staged deletion to an earlier commit removes the path from that commit", async (t) => {
  const cwd = createRepo();
  t.after(() => cleanupRepo(cwd));

  commitFile(cwd, "README.md", "base\n", "init");
  const target = commitFile(cwd, "first.txt", "first\n", "add first");
  const later = commitFile(cwd, "later.txt", "later\n", "add later");

  git(cwd, ["rm", "-q", "later.txt"]);
  const snapshot = await stashPush(cwd);
  assert.ok(snapshot);

  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, target),
    items: [
      { hash: target, action: "edit", subject: "add first" },
      { hash: later, action: "pick", subject: "add later" },
    ],
  });
  assert.equal(outcome.stopped, true);
  assert.equal(await rebaseStoppedSha(cwd), target);

  const applied = await stashApplyIndexBySha(cwd, snapshot);
  assert.equal(applied.ok, true, `a staged deletion must restore: ${applied.message}`);

  // The target predates later.txt, so the removal is already in effect. The
  // restore must not resurrect the path in the index or the worktree.
  assert.notEqual(gitExit(cwd, ["cat-file", "-e", ":later.txt"]), 0, "path absent from the index");
  assert.equal(fs.existsSync(path.join(cwd, "later.txt")), false, "path absent from the worktree");

  git(cwd, ["commit", "--amend", "--no-edit"]);
  assert.notEqual(
    gitExit(cwd, ["cat-file", "-e", "HEAD:later.txt"]),
    0,
    "the amended commit still does not contain the later commit's file"
  );
  assert.equal(
    git(cwd, ["show", "--name-only", "--format=", "HEAD"]).trim(),
    "first.txt",
    "the amended commit still contains only its own file"
  );
});

/**
 * P1-1: a path Git has to quote must still be restored.
 *
 * With `core.quotePath` at its default (`true`, i.e. unset) `git diff
 * --name-only` prints a non-ASCII path as an escaped string
 * (`"\346\226\260..."`). That string is not a path: `cat-file -e HEAD:<it>`
 * fails, so both "already present" checks said "absent", the path was dropped
 * from the restore without an error, and `stashApplyIndexBySha` still returned
 * `ok: true`. The append then committed and continued, reporting success for a
 * file that never entered the commit.
 *
 * The same shape covers the other two silent drops: a path with a leading space
 * (which `trim()` deletes) and a path with pathspec glob characters (which
 * `git restore` reads as a pattern unless `GIT_LITERAL_PATHSPECS=1` is set). The
 * decoy `br1.txt` is what a glob interpretation of `br[1].txt` would hit.
 *
 * This machine has `core.quotePath=false`, which is exactly why the defect was
 * invisible locally, so the test sets it explicitly.
 */
test("a quoted non-ASCII path, a leading space and a glob name are all appended for real", async (t) => {
  const cwd = createRepo();
  t.after(() => cleanupRepo(cwd));
  git(cwd, ["config", "core.autocrlf", "false"]);
  git(cwd, ["config", "core.quotePath", "true"]);

  commitFile(cwd, "README.md", "base\n", "init");
  // A decoy the glob form of `br[1].txt` would match (`br1.txt`). Its content
  // must *differ* between the append target and the snapshot's index tree, or a
  // stray glob write would reproduce the bytes the target already has and be
  // invisible — which is exactly how the earlier version of this test failed to
  // pin `GIT_LITERAL_PATHSPECS`. So the decoy is committed before the target
  // with one value and changed again *after* the target: a glob match then
  // stages the newer blob onto a tree holding the older one, and the amended
  // commit's `br1.txt` visibly changes.
  commitFile(cwd, "br1.txt", "DECOY-OLD\n", "add decoy");
  const target = commitFile(cwd, "first.txt", "first\n", "add first");
  const later = commitFile(cwd, "later.txt", "later\n", "add later");
  commitFile(cwd, "br1.txt", "DECOY-NEW\n", "update decoy after the target");

  const hostile = ["新增说明.txt", " lead.txt", "br[1].txt"];
  for (const name of hostile) {
    fs.writeFileSync(path.join(cwd, name), `APPENDED:${name}\n`, "utf8");
    git(cwd, ["add", "--", name]);
  }
  // The invariant is about the *target's* content: the amend rewrites the target
  // commit, so its `br1.txt` must still be `DECOY-OLD`. Comparing against the
  // pre-amend tip would be vacuous, because that tip already carries `DECOY-NEW`.
  const targetDecoyBlob = git(cwd, ["rev-parse", `${target}:br1.txt`]);
  assert.equal(git(cwd, ["show", `${target}:br1.txt`]), "DECOY-OLD", "the target starts with the old decoy");
  // The premise that makes a stray glob write visible: the snapshot's index
  // tree and the append target disagree about this path's content.
  assert.notEqual(
    git(cwd, ["rev-parse", `${target}:br1.txt`]),
    git(cwd, ["rev-parse", `HEAD:br1.txt`]),
    "the decoy's blob differs between the append target and the snapshot's index tree"
  );

  const snapshot = await stashPush(cwd);
  assert.ok(snapshot);

  // The premise of the regression: without `-z` Git really does quote the path,
  // and the quoted form does not resolve. If either stops holding, this test is
  // no longer exercising the bug.
  // (`git()` trims the output, which is exactly the `trim()` this regression is
  // about; the quoting assertion deliberately targets the remaining lines.)
  const quoted = git(cwd, ["diff", "--name-only", snapshot + "^1", snapshot]);
  const quotedLine = quoted
    .split("\n")
    .find((line) => line.startsWith('"') && line.endsWith('"'));
  assert.ok(quotedLine, `Git must quote the non-ASCII path without -z, got: ${JSON.stringify(quoted)}`);
  assert.notEqual(
    gitExit(cwd, ["cat-file", "-e", `HEAD:${quotedLine}`]),
    0,
    "the quoted literal is not a resolvable path"
  );

  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, target),
    items: [
      { hash: target, action: "edit", subject: "add first" },
      { hash: later, action: "pick", subject: "add later" },
    ],
  });
  assert.equal(outcome.stopped, true);
  assert.equal(await rebaseStoppedSha(cwd), target);

  const applied = await stashRestoreForAmend(cwd, snapshot);
  assert.equal(applied.ok, true, `restoring a quoted snapshot must not silently drop paths: ${applied.message}`);

  // Every hostile path must be in the index before the amend, with its content.
  for (const name of hostile) {
    assert.equal(
      gitExit(cwd, ["cat-file", "-e", `:${name}`]),
      0,
      `${JSON.stringify(name)} must be staged for the amend`
    );
  }
  git(cwd, ["commit", "--amend", "--no-edit"]);

  // ...and every one must actually be in the amended commit. Checking `ok` from
  // the restore is not enough: the bug returned `ok: true` with nothing staged.
  for (const name of hostile) {
    assert.equal(
      git(cwd, ["show", `HEAD:${name}`]),
      `APPENDED:${name}`,
      `${JSON.stringify(name)} must be in the amended commit with its content`
    );
  }
  // The amended target must still carry the decoy content it started with. A
  // glob-matched `restore --staged` stages the snapshot's newer `br1.txt` here,
  // so this is the assertion `GIT_LITERAL_PATHSPECS` actually controls.
  assert.equal(
    git(cwd, ["rev-parse", "HEAD:br1.txt"]),
    targetDecoyBlob,
    "the decoy must be untouched: the glob name is matched literally"
  );
  assert.equal(git(cwd, ["show", "HEAD:br1.txt"]), "DECOY-OLD", "the decoy did not pick up the newer bytes");
});

/**
 * P2-2: a rejected amend must leave a tree that `git rebase --abort` can undo.
 *
 * The append used to write the snapshot's worktree half before `commit --amend`.
 * A worktree-half path owned by a later commit does not exist in the edited
 * target, so it landed on disk as an *untracked* file. When the amend then failed
 * (a `pre-commit` hook is the realistic case) `git rebase --abort` refused with
 * "untracked working tree files would be overwritten by reset" (exit 128) —
 * retryable forever, so the Abort the user was told to choose could never
 * succeed. The transaction now restores the index half only, amends, and writes
 * the worktree half afterwards.
 */
test("a rejecting pre-commit hook leaves the paused rebase abortable", async (t) => {
  const cwd = createRepo();
  t.after(() => cleanupRepo(cwd));
  git(cwd, ["config", "core.autocrlf", "false"]);
  commitFile(cwd, "README.md", "base\n", "init");
  const target = commitFile(cwd, "first.txt", "first\n", "add first");
  const later = commitFile(cwd, "later.txt", "later\n", "add later");

  fs.writeFileSync(path.join(cwd, "append.txt"), "append\n", "utf8");
  git(cwd, ["add", "append.txt"]);
  // A worktree-only edit on the later commit's file: this is the path that would
  // be restored as untracked and block the abort.
  fs.writeFileSync(path.join(cwd, "later.txt"), "later\nWT-EDIT\n", "utf8");
  const snapshot = await stashPush(cwd);
  assert.ok(snapshot);

  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, target),
    items: [
      { hash: target, action: "edit", subject: "add first" },
      { hash: later, action: "pick", subject: "add later" },
    ],
  });
  assert.equal(outcome.stopped, true);
  assert.equal(await rebaseStoppedSha(cwd), target);

  // The transaction's first phase, then a hook that rejects the amend.
  const restored = await stashRestoreForAmend(cwd, snapshot);
  assert.equal(restored.ok, true, restored.message);
  // The ordering contract: the worktree half must NOT be on disk yet. Writing it
  // here is what used to leave `later.txt` as an untracked file and make the
  // abort impossible, so this assertion is the one that pins the order.
  assert.equal(
    fs.existsSync(path.join(cwd, "later.txt")),
    false,
    "the snapshot's worktree half must not be written before the amend lands"
  );
  const hook = path.join(cwd, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\necho 'rejected by test hook' >&2\nexit 1\n", "utf8");
  fs.chmodSync(hook, 0o755);
  assert.notEqual(gitExit(cwd, ["commit", "--amend", "--no-edit"]), 0, "the hook rejects the amend");

  // The advertised escape hatch must work, not dead-end.
  await abortRebase(cwd);
  assert.equal(await isRebaseInProgress(cwd), false, "the rebase is gone");
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), later, "history is back to the pre-rebase tip");
  assert.equal(
    fs.existsSync(path.join(cwd, "later.txt")) &&
      fs.readFileSync(path.join(cwd, "later.txt"), "utf8").replace(/\r\n/g, "\n"),
    "later\n",
    "the later commit's file is back at its committed content"
  );
  assert.equal((await runGit(["stash", "list", "--format=%H"], { cwd })).stdout.includes(snapshot), true, "the recovery copy survives");

  // And the original worktree edit is still recoverable from the stash.
  const recovered = await stashApplyIndexBySha(cwd, snapshot);
  assert.equal(recovered.ok, true, recovered.message);
  assert.equal(
    fs.readFileSync(path.join(cwd, "later.txt"), "utf8").replace(/\r\n/g, "\n"),
    "later\nWT-EDIT\n",
    "the user's original worktree edit is not lost"
  );
});

/**
 * P3: pins the worktree-before-index ordering inside `stashApplyIndexBySha`.
 *
 * A staged deletion removes the path from the index. If the index half ran first,
 * `restore --worktree` would then be unable to resolve that path and fail with
 * "pathspec ... did not match any file(s) known to git". The target here *has*
 * the path (so the deletion is a real change, not the absent-from-both skip),
 * which is what makes the ordering observable: flip the two halves and this test
 * goes red.
 */
test("the full restore applies the worktree half before the index half", async (t) => {
  const cwd = createRepo();
  t.after(() => cleanupRepo(cwd));
  git(cwd, ["config", "core.autocrlf", "false"]);
  const base = commitFile(cwd, "base.txt", "base\n", "base");
  // The target commit owns `keep.txt`; the staged deletion below must remove it
  // from the replayed target, so the path exists in the index when the restore
  // starts.
  const target = commitFile(cwd, "keep.txt", "keep\n", "add keep");
  const later = commitFile(cwd, "later.txt", "later\n", "add later");

  git(cwd, ["rm", "-q", "keep.txt"]);
  const snapshot = await stashPush(cwd);
  assert.ok(snapshot);

  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, base),
    items: [
      { hash: target, action: "edit", subject: "add keep" },
      { hash: later, action: "pick", subject: "add later" },
    ],
  });
  assert.equal(outcome.stopped, true);
  assert.equal(await rebaseStoppedSha(cwd), target);
  assert.equal(gitExit(cwd, ["cat-file", "-e", ":keep.txt"]), 0, "the path is in the index before the restore");

  const applied = await stashApplyIndexBySha(cwd, snapshot);
  assert.equal(applied.ok, true, `a staged deletion of a path the target owns must restore: ${applied.message}`);
  assert.notEqual(gitExit(cwd, ["cat-file", "-e", ":keep.txt"]), 0, "the path is gone from the index");
  // ...and from the worktree. This is the assertion the order actually controls:
  // run the index half first and the worktree half's absent-from-both guard skips
  // the path, leaving the deleted file behind as an untracked file — which then
  // blocks `rebase --continue` with "untracked working tree files would be
  // overwritten by merge".
  assert.equal(fs.existsSync(path.join(cwd, "keep.txt")), false, "the deleted path is gone from the worktree too");
});
