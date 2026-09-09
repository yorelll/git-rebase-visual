import assert from "node:assert/strict";
import test from "node:test";
import { commitFile, createRepo, git, removeRepo } from "./helpers/gitTestRepo";
import { runGit } from "../src/git/gitRunner";

test("git rev-list left-right count reports upstream ahead and behind", async () => {
  const remote = createRepo();
  const local = createRepo();
  const peer = createRepo();
  try {
    commitFile(remote, "base", "base", "base");
    git(remote, ["config", "receive.denyCurrentBranch", "ignore"]);
    const remotePath = remote.replace(/\\/g, "/");
    git(local, ["remote", "add", "origin", remotePath]);
    git(local, ["fetch", "origin"]);
    git(local, ["checkout", "-qb", "main", "origin/master"]);
    git(local, ["branch", "--set-upstream-to", "origin/master", "main"]);
    commitFile(local, "ahead", "ahead", "ahead");

    git(peer, ["remote", "add", "origin", remotePath]);
    git(peer, ["fetch", "origin"]);
    git(peer, ["checkout", "-qb", "main", "origin/master"]);
    commitFile(peer, "behind", "behind", "behind");
    git(peer, ["push", "origin", "HEAD:master"]);
    git(local, ["fetch", "origin"]);

    const result = await runGit(["rev-list", "--left-right", "--count", "origin/master...HEAD"], { cwd: local });
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout.trim().split(/\s+/).map(Number), [1, 1]);
  } finally {
    removeRepo(remote);
    removeRepo(local);
    removeRepo(peer);
  }
});
