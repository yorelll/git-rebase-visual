import assert from "node:assert/strict";
import test from "node:test";
import * as path from "path";
import { clearPatchIdCache, patchId } from "../src/git/commitLog";
import { getUpstream, lockedInPush, pushRefspec, resolveRefspec } from "../src/git/pushGuard";
import { createRepo, commitFile, git, removeRepo } from "./helpers/gitTestRepo";

// Real bare-remote integration for the push guard and pushRefspec. A local
// bare repository stands in for origin, exercising --force-with-lease lockout,
// --force-with-lease rejection after a concurrent remote change, and the
// lockedInPush block list — the same git operations the provider drives.

function remoteFor(cwd: string): string {
  return path.join(cwd, "..", `grv-remote-${path.basename(cwd)}.git`);
}

test("pushRefspec enforces --force-with-lease against a real bare remote", async (t) => {
  const cwd = createRepo();
  const remote = remoteFor(cwd);
  const cloneDir = path.join(cwd, "..", "grv-clone");
  t.after(() => {
    try {
      git(cwd, ["remote", "remove", "origin"]);
    } catch {
      // ignore
    }
    removeRepo(remote);
    removeRepo(cloneDir);
    removeRepo(cwd);
  });

  git(cwd, ["init", "--bare", "-q", remote]);
  commitFile(cwd, "one.txt", "one\n", "first");
  commitFile(cwd, "two.txt", "two\n", "second");
  git(cwd, ["remote", "add", "origin", remote]);
  git(cwd, ["push", "-q", "-u", "origin", "master"]);
  const up = await getUpstream(cwd, "master");
  assert.ok(up);
  assert.equal(up.remote, "origin");
  assert.equal(up.branch, "master");

  // A plain force push with lease succeeds when the local tracking ref still
  // matches what the remote has.
  const pushed = commitFile(cwd, "three.txt", "three\n", "third");
  await pushRefspec(cwd, up, resolveRefspec(up, "HEAD"), new AbortController().signal);
  assert.equal(git(cwd, ["rev-parse", "origin/master"]), pushed);

  // A concurrent remote change (via a second clone) must cause the next
  // --force-with-lease push to be rejected instead of silently overwriting it.
  // Crucially we do NOT fetch: force-with-lease compares against the local
  // `origin/master` tracking ref, which is now stale relative to the remote,
  // so the next force push is rejected.
  git(cwd, ["clone", "-q", remote, cloneDir]);
  git(cloneDir, ["config", "user.email", "clone@example.com"]);
  git(cloneDir, ["config", "user.name", "Clone Bot"]);
  git(cloneDir, ["commit", "--allow-empty", "-qm", "remote-only"]);
  git(cloneDir, ["push", "-q", "origin", "master"]);
  // Local tracking ref is stale now (still points at `pushed`).
  const staleTracking = git(cwd, ["rev-parse", "origin/master"]);
  assert.equal(staleTracking, pushed);

  await assert.rejects(
    () => pushRefspec(cwd, up, resolveRefspec(up, "HEAD"), new AbortController().signal),
    /(stale info|fetch first|rejected|failed|non-fast-forward)/
  );
});

test("lockedInPush blocks locked commits in the push range and allows after unlock", async (t) => {
  const cwd = createRepo();
  const remote = remoteFor(cwd);
  t.after(() => {
    clearPatchIdCache();
    removeRepo(remote);
    removeRepo(cwd);
  });

  git(cwd, ["init", "--bare", "-q", remote]);
  const a = commitFile(cwd, "one.txt", "one\n", "first");
  const b = commitFile(cwd, "two.txt", "two\n", "second");
  git(cwd, ["remote", "add", "origin", remote]);
  // Only `a` is pushed (via a temporary branch so the refspec source is a
  // name, not a raw hash); `b` remains local so it sits in `<upstream>..master`.
  git(cwd, ["branch", "only-base", a]);
  git(cwd, ["push", "-q", "origin", "only-base:master"]);
  git(cwd, ["branch", "-D", "only-base"]);
  // Point `master` at the pushed remote ref so `getUpstream` resolves.
  git(cwd, ["branch", "--set-upstream-to", "origin/master", "master"]);
  const up = await getUpstream(cwd, "master");
  assert.ok(up);

  // Lock `b` by its patch-id (the identity a lock store persists).
  const pid = await patchId(cwd, b);
  assert.ok(pid);
  const blocked = await lockedInPush(
    cwd,
    up.ref,
    "master",
    new Set([a]), // hash lock on an already-pushed older commit — not in range
    new Set([pid!])
  );
  // `a` is outside `<upstream>..HEAD`; only `b` is in the push range and blocked.
  assert.deepEqual(blocked, [b]);

  // After unlocking (no locks), nothing is blocked.
  assert.deepEqual(
    await lockedInPush(cwd, up.ref, "master", new Set(), new Set()),
    []
  );
});
