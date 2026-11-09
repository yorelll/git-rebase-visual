import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import { clearPatchIdCache, commitDetail, conflictedFiles, currentBranch, getCommits, isDirty, isRebaseInProgress, patchId, RangeArgv, rebaseAtEditStop, rebaseStoppedSha, rebasingBranch, resolveRange, summarizeNumstat, workingStatus } from "../src/git/commitLog";
import { resolveBase } from "../src/git/rebaseEngine";
import { createRepo, commitFile, git, removeRepo } from "./helpers/gitTestRepo";

test("workingStatus distinguishes staged, unstaged, and untracked changes", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  commitFile(cwd, "one.txt", "one\n", "initial");

  fs.writeFileSync(path.join(cwd, "one.txt"), "staged\n", "utf8");
  git(cwd, ["add", "one.txt"]);
  fs.writeFileSync(path.join(cwd, "two.txt"), "untracked\n", "utf8");
  fs.writeFileSync(path.join(cwd, "three.txt"), "both\n", "utf8");
  git(cwd, ["add", "three.txt"]);
  fs.writeFileSync(path.join(cwd, "three.txt"), "both and worktree\n", "utf8");
  assert.deepEqual(await workingStatus(cwd), {
    hasStaged: true,
    hasUnstaged: true,
    stagedCount: 2,
    unstagedCount: 2,
  });
});

test("background status reads work with an existing optional index lock", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  commitFile(cwd, "one.txt", "one\n", "initial");
  fs.writeFileSync(path.join(cwd, "one.txt"), "changed\n", "utf8");
  const lock = git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index.lock"]);
  fs.writeFileSync(lock, "simulated optional lock\n", "utf8");

  try {
    assert.deepEqual(await workingStatus(cwd), {
      hasStaged: false,
      hasUnstaged: true,
      stagedCount: 0,
      unstagedCount: 1,
    });
    assert.equal(await isDirty(cwd), true);
  } finally {
    fs.rmSync(lock, { force: true });
  }
});

test("workingStatus counts each untracked file and a rename once", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  commitFile(cwd, "before.txt", "before\n", "initial");

  fs.mkdirSync(path.join(cwd, "new-dir"));
  fs.writeFileSync(path.join(cwd, "new-dir", "one.txt"), "one\n", "utf8");
  fs.writeFileSync(path.join(cwd, "new-dir", "two.txt"), "two\n", "utf8");
  git(cwd, ["mv", "before.txt", "after.txt"]);
  assert.deepEqual(await workingStatus(cwd), {
    hasStaged: true,
    hasUnstaged: true,
    stagedCount: 1,
    unstagedCount: 2,
  });
});

test("workingStatus treats a modified submodule as one worktree entry", async (t) => {
  const superRepo = createRepo();
  const subRepo = createRepo();
  t.after(() => {
    removeRepo(superRepo);
    removeRepo(subRepo);
  });
  commitFile(subRepo, "sub.txt", "base\n", "sub base");
  git(superRepo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", subRepo, "nested"]);
  git(superRepo, ["commit", "-qm", "add submodule"]);

  fs.writeFileSync(path.join(superRepo, "nested", "sub.txt"), "modified\n", "utf8");
  assert.deepEqual(await workingStatus(superRepo), {
    hasStaged: false,
    hasUnstaged: true,
    stagedCount: 0,
    unstagedCount: 1,
  });
});

test("commit queries preserve newest-first order and calculate a rebase base", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  const first = commitFile(cwd, "one.txt", "one\n", "first");
  const second = commitFile(cwd, "two.txt", "two\n", "second");

  const commits = await getCommits(cwd, { options: [], positionals: ["HEAD"] });
  assert.deepEqual(commits.map((commit) => commit.hash), [second, first]);
  assert.deepEqual(await resolveBase(cwd, second), { root: false, base: first });
  assert.equal(await currentBranch(cwd), "master");
  assert.deepEqual(await resolveRange(cwd, { kind: "recentN", count: 0 }), {
    revRange: { options: ["-n", "1"], positionals: ["HEAD"] },
    hasBase: false,
  });
});

// `recentN` used to reach `git log` as the single string `-n 20 HEAD`, which
// `getCommits` split and passed as positionals. That put `-n` *after*
// `--end-of-options`, and Git rejected the whole command:
//   fatal: option '-n' must come before non-option arguments
// The commit list went blank for anyone on the documented `recentN` setting
// while the string-shape assertion above stayed green. This test executes the
// resolved range instead of inspecting it.
test("every committed range executes and returns the commits it promises", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  const hashes: string[] = [];
  for (let i = 1; i <= 5; i += 1) {
    hashes.push(commitFile(cwd, `f${i}.txt`, `${i}\n`, `c${i}`));
  }
  // A base *behind* the tip, so `base..HEAD` is the five commits above it.
  git(cwd, ["branch", "base", hashes[0]]);

  /** Resolve and narrow away the `{ error }` arm, which these configs preclude. */
  async function argvFor(cfg: Parameters<typeof resolveRange>[1]) {
    const resolved = await resolveRange(cwd, cfg);
    assert.ok(!("error" in resolved), `range resolves: ${JSON.stringify(resolved)}`);
    return (resolved as { revRange: RangeArgv }).revRange;
  }

  // Execute before inspecting: the regression was invisible to a shape-only
  // assertion, so the execution result is the assertion that must speak first.
  const recentTwo = await argvFor({ kind: "recentN", count: 2 });
  assert.deepEqual(
    (await getCommits(cwd, recentTwo)).map((c) => c.hash),
    [hashes[4], hashes[3]],
    "recentN returns exactly N newest commits"
  );
  assert.deepEqual(recentTwo, { options: ["-n", "2"], positionals: ["HEAD"] });

  // `count` is a settings number; a zero/negative value must clamp to at least 1
  // rather than producing `-n 0` (which means "no limit" to Git).
  const recentClamped = await argvFor({ kind: "recentN", count: 0 });
  assert.deepEqual(recentClamped.options, ["-n", "1"]);
  assert.equal((await getCommits(cwd, recentClamped)).length, 1);

  const all = await argvFor({ kind: "all" });
  assert.deepEqual(all, { options: [], positionals: ["HEAD"] });
  assert.equal((await getCommits(cwd, all)).length, 5);

  // Both base kinds still execute. `upstream` needs a tracking ref.
  git(cwd, ["config", "remote.origin.url", cwd]);
  git(cwd, ["config", `remote.origin.fetch`, "+refs/heads/*:refs/remotes/origin/*"]);
  git(cwd, ["update-ref", "refs/remotes/origin/master", hashes[4]]);
  git(cwd, ["config", "branch.master.remote", "origin"]);
  git(cwd, ["config", "branch.master.merge", "refs/heads/master"]);
  const upstream = await argvFor({ kind: "upstream" });
  assert.deepEqual(upstream, { options: [], positionals: ["HEAD@{upstream}..HEAD"] });
  assert.deepEqual(
    (await getCommits(cwd, upstream)).map((c) => c.hash),
    [],
    "upstream range whose tip is the upstream is empty, and it executes"
  );

  const base = await argvFor({ kind: "mainBranch", mainBranch: "base" });
  assert.deepEqual(base, { options: [], positionals: ["base..HEAD"] });
  assert.equal(
    (await getCommits(cwd, base)).length,
    4,
    "base is the first commit, so the four above it are in range"
  );
});

test("conflictedFiles returns no paths in a clean repository", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  commitFile(cwd, "one.txt", "one\n", "initial");
  assert.deepEqual(await conflictedFiles(cwd), []);
});

test("patchId is stable across a rewritten clone and served by the session cache", async (t) => {
  const cwd = createRepo();
  t.after(() => {
    clearPatchIdCache();
    removeRepo(cwd);
  });
  const base = commitFile(cwd, "base.txt", "base\n", "base");
  const first = commitFile(cwd, "one.txt", "one\n", "first");
  commitFile(cwd, "two.txt", "two\n", "second");

  // Rewrite the same change as a fresh commit object with a different
  // timestamp: `commit-tree` reuses the exact tree (same diff → same
  // patch-id) but always yields a different hash. Unlike `git cherry-pick`,
  // this is deterministic — a cherry-pick that lands in the same second as the
  // original commit can reuse the identical commit object (same hash), which
  // made the old `assert.notEqual` flaky on fast CI runners.
  const parent = git(cwd, ["rev-parse", `${first}^`]);
  const rewritten = git(cwd, [
    "commit-tree",
    `${first}^{tree}`,
    "-p",
    parent,
    "-m",
    "rewritten first",
  ]);
  const pidBefore = await patchId(cwd, first);
  const pidAfter = await patchId(cwd, rewritten);
  assert.notEqual(rewritten, first);
  assert.ok(pidBefore);
  assert.equal(pidAfter, pidBefore);
  // Second lookup is cached — same result.
  assert.equal(await patchId(cwd, first), pidBefore);
});

test("clearPatchIdCache forces a fresh patch-id computation", async (t) => {
  const cwd = createRepo();
  t.after(() => {
    clearPatchIdCache();
    removeRepo(cwd);
  });
  const hash = commitFile(cwd, "one.txt", "one\n", "first");
  const pid = await patchId(cwd, hash);
  assert.ok(pid);
  clearPatchIdCache();
  assert.equal(await patchId(cwd, hash), pid);
});

test("commitDetail reports a structured numstat summary", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  const hash = commitFile(cwd, "one.txt", "one\n", "initial");
  fs.writeFileSync(path.join(cwd, "one.txt"), "one\nmore\n", "utf8");
  fs.writeFileSync(path.join(cwd, "two.txt"), "two\n", "utf8");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-qm", "adds"]);
  const detail = await commitDetail(cwd, git(cwd, ["rev-parse", "HEAD"]));
  assert.match(detail.stat, /2 files changed/);
  assert.match(detail.stat, /2 insertions\(\+\)/);
  assert.doesNotMatch(detail.stat, /deletion/); // zero-contribution counts are omitted
  void hash;
});

test("summarizeNumstat formats structured stat lines deterministically", () => {
  // Binary lines (`-` in a column) count as a changed file without +/- counts;
  // header/blank/subject lines are skipped as non-data rows.
  assert.equal(
    summarizeNumstat(["3\t1\tfile.txt", "1\t-\tbin.dat", "commit 0123456789abcdef0123456789abcdef01234567"]),
    "2 files changed, 3 insertions(+), 1 deletion(-)"
  );
  assert.equal(summarizeNumstat(["1\t2\ta.ts", "2\t0\tb.ts"]), "2 files changed, 3 insertions(+), 2 deletions(-)");
  assert.equal(summarizeNumstat(["1\t2\ta.ts", "0\t1\tb.ts"]), "2 files changed, 1 insertion(+), 3 deletions(-)");
  assert.equal(summarizeNumstat(["cfa7ed6357450347aa5de5da3ae1eb6de589b5eb"]), "");
  assert.equal(summarizeNumstat([]), "");
});

test("rebase state helpers find an edit stop via absolute Git paths", async (t) => {
  const cwd = createRepo();
  t.after(() => {
    try {
      git(cwd, ["rebase", "--abort"]);
    } catch {
      // No rebase may remain after a failed setup.
    }
    removeRepo(cwd);
  });
  commitFile(cwd, "one.txt", "one\n", "first");
  const second = commitFile(cwd, "two.txt", "two\n", "second");
  const editor = path.join(cwd, "editor.js");
  fs.writeFileSync(
    editor,
    "const fs=require('fs'); const file=process.argv[2]; fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^pick /m, 'edit '));\n",
    "utf8"
  );
  const env = { ...process.env, GIT_SEQUENCE_EDITOR: `\"${process.execPath}\" \"${editor}\"`, GIT_EDITOR: "true" };
  const { execFileSync } = await import("child_process");
  execFileSync("git", ["rebase", "-i", "HEAD~1"], { cwd, env, stdio: "pipe" });

  assert.equal(await isRebaseInProgress(cwd), true);
  assert.equal(await rebaseStoppedSha(cwd), second);
  assert.equal(await rebaseAtEditStop(cwd), true);
  assert.equal(await rebasingBranch(cwd), "master");
});

test("rebase state helpers resolve the original branch for an apply-backend conflict", async (t) => {
  const cwd = createRepo();
  t.after(() => {
    try {
      git(cwd, ["rebase", "--abort"]);
    } catch {
      // No rebase may remain after a failed setup.
    }
    removeRepo(cwd);
  });

  commitFile(cwd, "shared.txt", "base\n", "base");
  git(cwd, ["checkout", "-qb", "topic"]);
  commitFile(cwd, "shared.txt", "topic\n", "topic change");
  git(cwd, ["checkout", "-q", "master"]);
  commitFile(cwd, "shared.txt", "master\n", "master change");
  git(cwd, ["checkout", "-q", "topic"]);

  const { execFileSync } = await import("child_process");
  assert.throws(
    () => execFileSync("git", ["rebase", "--apply", "master"], { cwd, stdio: "pipe" })
  );

  assert.equal(await isRebaseInProgress(cwd), true);
  assert.deepEqual(await conflictedFiles(cwd), ["shared.txt"]);
  assert.equal(await rebasingBranch(cwd), "topic");
  assert.equal(await rebaseStoppedSha(cwd), undefined);
});
