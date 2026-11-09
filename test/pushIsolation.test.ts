/**
 * `rolegit` — the hand-off between the review rounds and the release notes.
 *
 * These tests exist because two consecutive review rounds each fixed a real
 * wording/UX defect and introduced a *new* security defect in the push path:
 *
 *  - round 4 (`code-review-0-8-15.md`) introduced `git log -1 --pretty=%s
 *    <sourceRev>` with a workspace-setting-controlled refspec source, and
 *    `--output=<file>` truncated any writable file;
 *  - the `git push` refspec had the same problem from the start, where
 *    `--receive-pack=<program>` executed a local program.
 *
 * Both must be driven end-to-end through the real provider: the earlier
 * `HEAD~1` mutant survived precisely because only the pure function was tested.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { commitFile, createRepo, git, gitExit, removeRepo } from "./helpers/gitTestRepo";
import { createExtensionContext, installVscodeStub, resetStub, stub, vscodeStub } from "./helpers/vscodeStub";

installVscodeStub();

const { RebaseViewProvider } = require("../src/ui/rebaseViewProvider") as typeof import("../src/ui/rebaseViewProvider");
const { LockStore } = require("../src/lock/lockStore") as typeof import("../src/lock/lockStore");
const { createGitContentRequestStore } = require("../src/ui/gitDiffRequestState") as typeof import("../src/ui/gitDiffRequestState");
const { createGeneratedDiffSnapshotStore } = require("../src/ui/generatedDiffDocument") as typeof import("../src/ui/generatedDiffDocument");
const { getUpstream, pushRefspec, pushRange, resolveRefspec } = require("../src/git/pushGuard") as typeof import("../src/git/pushGuard");
const { getCommits } = require("../src/git/commitLog") as typeof import("../src/git/commitLog");

interface Harness {
  cwd: string;
  provider: InstanceType<typeof RebaseViewProvider>;
  toasts: { level: string; text: string }[];
  titles: string[];
}

function createHarness(t: { after: (fn: () => void) => void }): Harness {
  resetStub();
  const cwd = createRepo();
  stub.workspaceFolders = [{ uri: { fsPath: cwd } }];
  const ctx = createExtensionContext();
  const provider = new RebaseViewProvider(
    ctx as any,
    new LockStore(ctx.globalState as any),
    createGitContentRequestStore(),
    createGeneratedDiffSnapshotStore()
  );
  const toasts: { level: string; text: string }[] = [];
  const titles: string[] = [];
  (provider as any).postInlineToast = (message: string) => toasts.push({ level: "info", text: message });
  const originalProgress = vscodeStub.window.withProgress;
  (vscodeStub.window as any).withProgress = async (opts: any, task: (value: unknown, token: unknown) => Promise<unknown>) => {
    titles.push(String(opts?.title ?? ""));
    return task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  };
  t.after(async () => {
    (vscodeStub.window as any).withProgress = originalProgress;
    await (provider as any).recoveryPass?.catch?.(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      removeRepo(cwd);
    } catch {
      // A leftover temp dir is not a test failure.
    }
  });
  return { cwd, provider, toasts, titles };
}

function remoteFor(cwd: string): string {
  return path.join(cwd, "..", `grv-attack-remote-${path.basename(cwd)}.git`);
}

function setup(cwd: string, remote: string): void {
  git(cwd, ["init", "--bare", "-q", remote]);
  commitFile(cwd, "one.txt", "one\n", "first");
  git(cwd, ["remote", "add", "origin", remote]);
  git(cwd, ["push", "-q", "-u", "origin", "master"]);
}

// ---------------------------------------------------------------------------
// P2: `--output=` through the push subject lookup
// ---------------------------------------------------------------------------

test("a refspec source of --output=<file> cannot write that file", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = remoteFor(cwd);
  t.after(() => removeRepo(remote));
  setup(cwd, remote);
  commitFile(cwd, "two.txt", "two\n", "second");

  // The exact shape B reproduced: the template's source side is an option.
  // Relative on purpose — `pushSource` splits the refspec at its first colon, so
  // an absolute `C:/…` path would be cut at the drive letter. The destination is
  // what the file lands in regardless.
  const target = path.join(cwd, "..", `grv-hijack-${path.basename(cwd)}.txt`);
  t.after(() => { try { fs.rmSync(target, { force: true }); } catch { /* ignore */ } });
  const relative = path.relative(cwd, target).replace(/\\/g, "/");
  stub.config["gitRebaseVisual.push.refspecTemplate"] = `--output=${relative}:refs/heads/pwned`;
  stub.quickPick = { label: "评审推送", kind: "review" };
  stub.choice = "Push";

  await harness.provider.pushBranch();

  assert.equal(fs.existsSync(target), false, "the file the refspec named was not created");
  assert.equal(fs.existsSync(path.join(cwd, "pwned")), false, "no relative path was created either");
  // A source that cannot be resolved is a visible failure, not a silent push
  // with `（无法读取 commit 标题）` in the title.
  const visible = [...harness.toasts.map((e) => e.text), ...stub.messages.map((e) => e.text)];
  assert.ok(
    visible.some((text) => /不是可解析的 commit/.test(text)),
    "the unresolvable source is reported; saw " + JSON.stringify(visible)
  );
  assert.equal(harness.titles.length, 0, "the progress surface never opened");
  assert.notEqual(
    gitExit(cwd, ["--git-dir", remote, "rev-parse", "--verify", "--quiet", "refs/heads/pwned"]),
    0,
    "nothing was pushed"
  );
});

test("a refspec source of --output=<file> cannot truncate .git/config", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = remoteFor(cwd);
  t.after(() => removeRepo(remote));
  setup(cwd, remote);
  commitFile(cwd, "two.txt", "two\n", "second");

  const before = fs.readFileSync(path.join(cwd, ".git", "config"), "utf8");
  stub.config["gitRebaseVisual.push.refspecTemplate"] = "HEAD:refs/for/${branch}";
  stub.quickPick = { label: "自定义 refspec…", kind: "custom" };
  // A hand-typed refspec is the second way user data reaches the same place.
  stub.inputBox = "--output=.git/config:refs/heads/pwned";
  stub.choice = "Push";

  await harness.provider.pushBranch();

  const after = fs.readFileSync(path.join(cwd, ".git", "config"), "utf8");
  assert.equal(after, before, ".git/config is byte-identical");
  // Proof the repository still works: the exact failure B saw was
  // `error: key does not contain a section: <subject>`.
  assert.equal(gitExit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]), 0, "the repository still parses");
  assert.match(git(cwd, ["remote"]), /origin/, "the remote is still configured");
});

// ---------------------------------------------------------------------------
// P1: `--receive-pack=` through the push refspec
// ---------------------------------------------------------------------------

test("a refspec of --receive-pack=<program> does not execute it", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = remoteFor(cwd);
  t.after(() => removeRepo(remote));
  setup(cwd, remote);
  commitFile(cwd, "two.txt", "two\n", "second");
  // The fixture already published `master`; a push that never happened leaves
  // it exactly here.
  const remoteTip = git(cwd, ["--git-dir", remote, "rev-parse", "refs/heads/master"]);

  const marker = path.join(cwd, "..", `grv-executed-${path.basename(cwd)}`);
  const program = path.join(cwd, "..", `grv-fakerecv-${path.basename(cwd)}.sh`);
  t.after(() => {
    for (const file of [marker, program]) {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    }
  });
  fs.writeFileSync(program, `#!/bin/sh\ntouch "${marker.replace(/\\/g, "/")}"\nexit 1\n`, "utf8");
  fs.chmodSync(program, 0o755);

  // The execution B reproduced. Normalised to forward slashes so the shell
  // program can run under MSYS Git on Windows.
  stub.config["gitRebaseVisual.push.refspecTemplate"] = "HEAD:refs/for/${branch}";
  stub.quickPick = { label: "自定义 refspec…", kind: "custom" };
  stub.inputBox = `--receive-pack=${program.replace(/\\/g, "/")}`;
  stub.choice = "Push";

  await harness.provider.pushBranch();

  assert.equal(fs.existsSync(marker), false, "the program named by --receive-pack never ran");
  assert.equal(
    git(cwd, ["--git-dir", remote, "rev-parse", "refs/heads/master"]),
    remoteTip,
    "and the remote branch did not move"
  );
  const visible = [...harness.toasts.map((e) => e.text), ...stub.messages.map((e) => e.text)].join("\n");
  // Two refusals are legitimate here and both are visible: the source side is
  // not a commit (this path), or Git rejects the option-shaped refspec at push
  // time (if the source ever resolved). What must never happen is a silent or
  // successful outcome.
  assert.match(
    visible,
    /不是可解析的 commit|推送失败|invalid refspec|does not match any/,
    "the option-shaped refspec is refused on a visible surface"
  );
  assert.doesNotMatch(visible, /已推送/, "and is never reported as pushed");
});

test("a refspec of --mirror does not rewrite the remote", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = remoteFor(cwd);
  t.after(() => removeRepo(remote));
  setup(cwd, remote);
  commitFile(cwd, "two.txt", "two\n", "second");
  // A local branch that exists only here: `--mirror` would publish it.
  git(cwd, ["branch", "local-only"]);
  const before = git(cwd, ["--git-dir", remote, "for-each-ref", "--format=%(refname)"]);

  stub.config["gitRebaseVisual.push.refspecTemplate"] = "HEAD:refs/for/${branch}";
  stub.quickPick = { label: "自定义 refspec…", kind: "custom" };
  stub.inputBox = "--mirror";
  stub.choice = "Push";

  await harness.provider.pushBranch();

  const after = git(cwd, ["--git-dir", remote, "for-each-ref", "--format=%(refname)"]);
  assert.equal(after, before, "the remote ref list is unchanged (no refs/remotes/* mirror copies)");
  assert.doesNotMatch(
    [...harness.toasts.map((e) => e.text), ...stub.messages.map((e) => e.text)].join("\n"),
    /已推送/,
    "the push is not reported as successful"
  );
});

// The provider-level cases above are the end-to-end layer, but the subject
// check refuses an option-shaped refspec one step before `pushRefspec` builds
// its argv — so they cannot pin the `git push` command line itself. These two
// call `pushRefspec` directly, which is the only place the marker lives.

test("pushRefspec does not honour --receive-pack as a refspec", async (t) => {
  const cwd = createRepo();
  const remote = remoteFor(cwd);
  t.after(() => {
    removeRepo(remote);
    removeRepo(cwd);
  });
  setup(cwd, remote);
  // Something to push, so Git cannot answer "Everything up-to-date" and skip
  // the receive-pack invocation altogether.
  commitFile(cwd, "two.txt", "two\n", "second");
  const up = await getUpstream(cwd, "master");
  assert.ok(up, "the fixture has an upstream");
  const remoteTip = git(cwd, ["--git-dir", remote, "rev-parse", "refs/heads/master"]);

  const marker = path.join(cwd, "..", `grv-direct-executed-${path.basename(cwd)}`);
  const program = path.join(cwd, "..", `grv-direct-fakerecv-${path.basename(cwd)}.sh`);
  t.after(() => {
    for (const file of [marker, program]) {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    }
  });
  fs.writeFileSync(program, `#!/bin/sh\ntouch "${marker.replace(/\\/g, "/")}"\nexit 1\n`, "utf8");
  fs.chmodSync(program, 0o755);

  await assert.rejects(
    () => pushRefspec(cwd, up!, `--receive-pack=${program.replace(/\\/g, "/")}`),
    /failed/,
    "the option-shaped refspec is rejected"
  );
  assert.equal(fs.existsSync(marker), false, "the program named by --receive-pack never ran");
  assert.equal(
    git(cwd, ["--git-dir", remote, "rev-parse", "refs/heads/master"]),
    remoteTip,
    "and nothing reached the remote"
  );
});

test("pushRefspec does not honour --mirror as a refspec", async (t) => {
  const cwd = createRepo();
  const remote = remoteFor(cwd);
  t.after(() => {
    removeRepo(remote);
    removeRepo(cwd);
  });
  setup(cwd, remote);
  commitFile(cwd, "two.txt", "two\n", "second");
  // A local branch that exists only here: `--mirror` would publish it, and
  // would also copy `refs/remotes/origin/*` into the remote.
  git(cwd, ["branch", "local-only"]);
  const up = await getUpstream(cwd, "master");
  assert.ok(up, "the fixture has an upstream");
  const before = git(cwd, ["--git-dir", remote, "for-each-ref", "--format=%(refname)"]);

  await assert.rejects(
    () => pushRefspec(cwd, up!, "--mirror"),
    /failed/,
    "the option-shaped refspec is rejected"
  );
  const after = git(cwd, ["--git-dir", remote, "for-each-ref", "--format=%(refname)"]);
  assert.equal(after, before, "the remote ref list is unchanged");
  assert.doesNotMatch(after, /local-only/, "the local-only branch was not published");
});

// ---------------------------------------------------------------------------
// 0-8-17 四.1: `recentN` must reach `git log` as an option, not a positional
// ---------------------------------------------------------------------------

test("commitRange=recentN through the real provider returns commits, not an error", async (t) => {
  resetStub();
  const cwd = createRepo();
  const ctx = createExtensionContext();
  const provider = new RebaseViewProvider(
    ctx as any,
    new LockStore(ctx.globalState as any),
    createGitContentRequestStore(),
    createGeneratedDiffSnapshotStore()
  );
  t.after(async () => {
    try { removeRepo(cwd); } catch { /* ignore */ }
  });
  stub.workspaceFolders = [{ uri: { fsPath: cwd } }];
  // More commits than the default limit, so a broken `-n` cannot be masked by
  // "all commits happened to fit".
  for (let i = 1; i <= 25; i += 1) {
    commitFile(cwd, `f${i}.txt`, `${i}\n`, `c${i}`);
  }
  stub.config["gitRebaseVisual.commitRange"] = "recentN";
  stub.config["gitRebaseVisual.recentCount"] = 20;

  const posted: any[] = [];
  (provider as any).view = {
    webview: { postMessage: (msg: any) => posted.push(msg) },
    visible: true,
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
  };

  await provider.refresh();

  const states = posted.filter((m) => m?.type === "state");
  assert.ok(states.length > 0, "the provider posted a state message");
  const last = states[states.length - 1];
  assert.equal(
    last.error,
    undefined,
    "no error is reported; got " + JSON.stringify(last.error)
  );
  assert.equal(
    last.commits.length,
    20,
    "recentN returns exactly recentCount commits; saw " + last.commits.length
  );

  // Every documented range kind still works through the same path.
  for (const [kind, expected] of [["all", 25], ["mainBranch", 25]] as const) {
    posted.length = 0;
    stub.config["gitRebaseVisual.commitRange"] = kind;
    stub.config["gitRebaseVisual.mainBranch"] = "HEAD~1";
    await provider.refresh();
    const s = posted.filter((m) => m?.type === "state").pop();
    assert.equal(s?.error, undefined, `${kind} reports no error`);
    assert.ok(
      kind === "all" ? s.commits.length === 25 : s.commits.length >= 1,
      `${kind} returns commits; saw ${s?.commits?.length}`
    );
  }
});

// This test pins the range *resolution* gate, not the `git log` marker. Proven
// by mutation: removing the `rev-parse --verify` check in `resolveRange` turns
// it red, while removing the `getCommits` marker leaves it green (the range
// never reaches `git log` as an option-shaped positional). The `getCommits`
// marker has its own test below — this one did not cover it, and the old name
// said otherwise.
test("resolveRange rejects a mainBranch whose base is 'HEAD --output=<file>'", async (t) => {
  resetStub();
  const cwd = createRepo();
  const ctx = createExtensionContext();
  const provider = new RebaseViewProvider(
    ctx as any,
    new LockStore(ctx.globalState as any),
    createGitContentRequestStore(),
    createGeneratedDiffSnapshotStore()
  );
  const target = path.join(cwd, "..", `grv-range-hijack-${path.basename(cwd)}.txt`);
  t.after(async () => {
    try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
    try { removeRepo(cwd); } catch { /* ignore */ }
  });
  stub.workspaceFolders = [{ uri: { fsPath: cwd } }];
  commitFile(cwd, "one.txt", "one\n", "first");
  commitFile(cwd, "two.txt", "two\n", "second");
  stub.config["gitRebaseVisual.commitRange"] = "mainBranch";
  // The exact shape that worked before the marker: the base branch carries a
  // second option plus a positional-looking tail.
  stub.config["gitRebaseVisual.mainBranch"] = `HEAD --output=${target.replace(/\\/g, "/")}`;

  const posted: any[] = [];
  (provider as any).view = {
    webview: { postMessage: (msg: any) => posted.push(msg) },
    visible: true,
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
  };

  await provider.refresh();

  assert.equal(fs.existsSync(target), false, "the file named by --output was not created");
  const last = posted.filter((m) => m?.type === "state").pop();
  assert.ok(last, "a state message was posted");
  assert.match(
    String(last.error ?? ""),
    /not found|Base branch/i,
    "the bad base branch is reported; saw " + JSON.stringify(last.error)
  );
});

// ---------------------------------------------------------------------------
// 四.2: the `git log` marker needs its own coverage
// ---------------------------------------------------------------------------

test("getCommits does not let an option-shaped positional write a file", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  commitFile(cwd, "a.txt", "a\n", "first");
  const target = path.join(os.tmpdir(), `grv-getcommits-hijack-${Date.now()}.txt`);
  // `git log` keeps parsing options after a positional, so a base of
  // `--output=<file>..HEAD` used to truncate `<file>..HEAD` — the `.txt` suffix
  // does not make it a non-file. Without the marker this file appears; with it,
  // Git treats the whole thing as a revision that cannot resolve.
  const written = `${target}..HEAD`;
  t.after(() => { try { fs.rmSync(written, { force: true }); } catch {} });
  await getCommits(cwd, { options: [], positionals: [`--output=${target}..HEAD`] }).catch(() => undefined);
  assert.equal(fs.existsSync(written), false, "Git must not have honoured --output=");
});

// ---------------------------------------------------------------------------
// 四.1: a remote name may begin with '-' (measured, not assumed)
// ---------------------------------------------------------------------------

// `git remote add -- -evil <url>` exits 0 and `git remote` then prints
// `-evil`, so `%(upstream:short)` is `-evil/master`. Without the marker both
// range queries below read that as an option bundle and exit 129, which showed
// up as a push that silently did nothing and a sidebar reading "↑0 ↓0".

function setupDashRemote(cwd: string): string {
  const remote = path.join(cwd, "..", `grv-dash-remote-${path.basename(cwd)}.git`);
  git(cwd, ["init", "--bare", "-q", remote]);
  commitFile(cwd, "one.txt", "one\n", "first");
  git(cwd, ["remote", "add", "--", "-evil", remote]);
  // `git push` keeps parsing options after the positional remote, so the test
  // helper needs the same marker the product code uses: without it Git reads
  // `-evil` as `-e` and exits 129 with `unknown switch 'e'`.
  git(cwd, ["push", "-q", "-u", "--end-of-options", "-evil", "master"]);
  return remote;
}

test("pushRange computes the range for a remote named '-evil' instead of throwing", async (t) => {
  const cwd = createRepo();
  const remote = setupDashRemote(cwd);
  t.after(() => { removeRepo(remote); removeRepo(cwd); });

  const up = await getUpstream(cwd, "master");
  assert.ok(up, "the dash-prefixed upstream is found");
  assert.equal(up!.remote, "-evil");
  assert.equal(up!.ref, "-evil/master");

  const tip = commitFile(cwd, "two.txt", "two\n", "second");

  // Before the marker this threw `git rev-list -evil/master..HEAD failed (129)`
  // with `usage: git rev-list …`, so the lock guard aborted the push with no
  // user-visible reason. Measured after: exit 0, listing exactly the unpushed
  // commit.
  const pending = await pushRange(cwd, up!.ref, tip);
  assert.deepEqual(pending, [tip], "the one unpushed commit is in range; saw " + JSON.stringify(pending));
});

test("a locked commit is still blocked when the remote is named '-evil'", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = setupDashRemote(cwd);
  t.after(() => removeRepo(remote));

  const tip = commitFile(cwd, "two.txt", "two\n", "second");
  const before = stub.messages.length;

  // A guard that cannot compute its range must not read as "nothing blocked":
  // that would publish the locked commit. Drive the real push path so the
  // behaviour, not just the helper, is pinned.
  await (harness.provider as any).refresh();
  const commits = (harness.provider as any).commits ?? [];
  const target = commits.find((commit: any) => commit.hash === tip);
  assert.ok(target, "the unpushed commit is in the visible list");
  await (harness.provider as any).lockCommits(cwd, [target.hash]);
  await (harness.provider as any).pushBranch();

  const reported = stub.messages.slice(before).map((message) => message.text).join("\n");
  assert.equal(
    /usage: git rev-list|failed \(129\)/.test(reported),
    false,
    "the push does not fail with an internal Git usage error; saw " + JSON.stringify(reported)
  );
  assert.match(reported, /推送被拒绝|无法计算推送范围/, "the guard reports a reason; saw " + JSON.stringify(reported));
});

test("refresh reports ahead/behind for a remote named '-evil' instead of 0/0", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = setupDashRemote(cwd);
  t.after(() => removeRepo(remote));

  commitFile(cwd, "two.txt", "two\n", "second");

  const posted: any[] = [];
  (harness.provider as any).view = {
    webview: { postMessage: (msg: any) => posted.push(msg) },
    visible: true,
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
  };
  await (harness.provider as any).refresh();

  const last = posted.filter((m) => m?.type === "state").pop();
  assert.ok(last, "a state message was posted");
  // Measured truth in this repo: `git rev-list --left-right --count
  // -evil/master...HEAD` is `0\t1` (behind 0, ahead 1). Without the marker the
  // query exited 129 and the sidebar rendered "↑0 ↓0", which is exactly the
  // healthy shape — the defect this pins.
  assert.equal(last.aheadCount, 1, "ahead is the one unpushed commit; saw " + JSON.stringify(last.aheadCount));
  assert.equal(last.behindCount, 0, "behind is 0; saw " + JSON.stringify(last.behindCount));
  assert.equal(last.upstreamNote, undefined, "the counts are real, so no 'cannot compute' note; saw " + JSON.stringify(last.upstreamNote));
});

// ---------------------------------------------------------------------------
// 四.3 / 四.4: existence is Git's own answer, and costs one spawn
// ---------------------------------------------------------------------------

test("a healthy upstream in a renamed fetch namespace resolves instead of 'not configured'", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = remoteFor(cwd);
  t.after(() => removeRepo(remote));
  setup(cwd, remote);

  // Both shapes are healthy — `git push origin master` works in them — but the
  // tracking ref does not live at `refs/remotes/origin/master`. The previous
  // revision reconstructed that path and told the user "未配置 upstream".
  for (const namespace of ["refs/remotes/upstream/*", "refs/remotes/origin/nested/*"]) {
    git(cwd, ["config", "remote.origin.fetch", `+refs/heads/*:${namespace}`]);
    git(cwd, ["fetch", "-q", "origin"]);
    const expected = namespace.replace("refs/remotes/", "").replace("/*", "/master");
    const up = await getUpstream(cwd, "master");
    assert.ok(up, `the upstream resolves in ${namespace}`);
    assert.equal(up!.ref, expected, "the upstream ref is the one Git reported");
    assert.equal(up!.remote, "origin");
    assert.equal(up!.branch, "master");
  }
});

test("a pruned upstream in any namespace is still rejected", async (t) => {
  const cwd = createRepo();
  const remote = remoteFor(cwd);
  t.after(() => removeRepo(remote));
  t.after(() => removeRepo(cwd));
  setup(cwd, remote);

  for (const namespace of ["refs/remotes/origin/*", "refs/mirror/*"]) {
    git(cwd, ["config", "remote.origin.fetch", `+refs/heads/*:${namespace}`]);
    git(cwd, ["fetch", "-q", "origin"]);
    assert.ok(await getUpstream(cwd, "master"), `${namespace} resolves while healthy`);
    git(cwd, ["--git-dir", remote, "update-ref", "-d", "refs/heads/master"]);
    git(cwd, ["fetch", "-q", "--prune", "origin"]);
    assert.equal(
      await getUpstream(cwd, "master"),
      undefined,
      `${namespace} is rejected once pruned`
    );
    // Restore the remote branch for the next namespace.
    git(cwd, ["push", "-q", "origin", "master"]);
    git(cwd, ["fetch", "-q", "origin"]);
  }
});

// ---------------------------------------------------------------------------
// 新发现 1 / 新发现 2 / 新发现 4: the one shape where the count really fails
// ---------------------------------------------------------------------------

/**
 * A repository whose upstream still resolves but whose history cannot be
 * walked. Measured: `git for-each-ref … %(upstream:track)` exits **0** with an
 * empty track field (i.e. "healthy") so `getUpstream` returns a ref, while
 * `git rev-list --left-right --count <ref>...HEAD` exits **128**.
 *
 * The recipe that works is *identical tips plus a corrupt object behind them*:
 * with `HEAD == origin/master` the ref listing can answer without parsing the
 * history, but the three-dot range query still has to walk the shared commits to
 * find the merge base and hits the corrupt one. `rev-parse --abbrev-ref
 * --symbolic-full-name HEAD@{upstream}` also still exits 0, which is exactly how
 * `refresh` gets past `resolveRange` and into the count.
 *
 * This is the only reachable shape for the `upstreamNote` branch — the other
 * unhealthy-upstream shapes (pruned, never fetched, dangling, symref-broken,
 * non-commit) all report `[gone]` and are absorbed earlier. The corrupt object
 * also fails `getCommits`, which is why `refresh` must spread `...presentation`
 * in that catch for the note to reach the webview at all.
 */
function corruptAncestorOfIdenticalTips(cwd: string): string {
  const hashes = git(cwd, ["rev-list", "HEAD"]).split("\n");
  const victim = hashes[1];
  assert.ok(victim, "the fixture has a commit behind HEAD to corrupt");
  const objectPath = path.join(cwd, ".git", "objects", victim.slice(0, 2), victim.slice(2));
  // Loose objects are written read-only on Unix; the mode has to change first
  // or the write fails with EACCES and the test silently measures a healthy repo.
  fs.chmodSync(objectPath, 0o644);
  fs.writeFileSync(objectPath, "garbage-garbage-garbage-garbage\n", "utf8");
  return victim;
}

function setupCorruptHistory(cwd: string): string {
  const remote = path.join(cwd, "..", `grv-corrupt-remote-${path.basename(cwd)}.git`);
  git(cwd, ["init", "--bare", "-q", remote]);
  commitFile(cwd, "one.txt", "one\n", "first");
  commitFile(cwd, "two.txt", "two\n", "second");
  git(cwd, ["remote", "add", "origin", remote]);
  git(cwd, ["push", "-q", "-u", "origin", "master"]);
  // The tips must be identical: that is what lets `for-each-ref` answer without
  // reading the corrupt history.
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), git(cwd, ["rev-parse", "origin/master"]), "the tips are identical");
  corruptAncestorOfIdenticalTips(cwd);
  assert.notEqual(gitExit(cwd, ["rev-list", "--left-right", "--count", "origin/master...HEAD"]), 0, "the count really fails");
  return remote;
}

test("refresh shows the 'cannot compute' note instead of 0/0 when the count fails", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = setupCorruptHistory(cwd);
  t.after(() => removeRepo(remote));

  // The shape is only interesting because `getUpstream` still answers, so pin
  // that first: if it ever starts returning undefined, this test would otherwise
  // pass through the unrelated "未配置 upstream" path and pin nothing.
  const up = await getUpstream(cwd, "master");
  assert.ok(up, "the upstream still resolves, so the count is attempted at all");
  assert.equal(up!.ref, "origin/master");

  const posted: any[] = [];
  (harness.provider as any).view = {
    webview: { postMessage: (msg: any) => posted.push(msg) },
    visible: true,
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
  };
  await (harness.provider as any).refresh();

  const state = posted.filter((m) => m?.type === "state").pop();
  assert.ok(state, "a state message was posted; saw " + JSON.stringify(posted.map((m) => m?.type)));
  // Before 新发现 1 this assertion had no provider-level coverage at all: only
  // synthetic `upstreamNote` values were fed to the presentation layer, so
  // deleting the assignment left the whole suite green.
  assert.match(
    String(state.upstreamNote),
    /^无法计算与 origin\/master 的领先\/落后（/,
    "the note names the upstream it could not measure; saw " + JSON.stringify(state.upstreamNote)
  );
  assert.doesNotMatch(String(state.upstreamNote), /\n/, "the note is one line, not Git's whole stderr");
  assert.match(String(state.upstreamNote), /fatal: .* is corrupt/, "and it keeps the line that names the reason");
  assert.equal(state.aheadCount, 0);
  assert.equal(state.behindCount, 0);

  // 新发现 4: this shape also fails `getCommits`, so the note only reaches the
  // webview because that catch spreads `...presentation`. Asserting both fields
  // together is what pins the spread: without it the state is `{type, error,
  // rebaseInProgress}` and the note computed above is discarded.
  assert.match(String(state.error), /corrupt/, "the failure is reported too; saw " + JSON.stringify(state.error));
});

test("a push whose range cannot be computed reports that, and never reports success", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = setupCorruptHistory(cwd);
  t.after(() => removeRepo(remote));

  // `lockedInPush` returns before it queries the range when there is no lock, so
  // without one this test would exercise the "nothing locked" fast path instead.
  await (harness.provider as any).refresh();
  const root = (harness.provider as any).root as string;
  assert.ok(root, "the provider recorded a repo root before the failing refresh");
  const ctx = (harness.provider as any).ctx;
  const store = new LockStore(ctx.globalState);
  await store.lock(root, "a".repeat(40));
  assert.equal(store.lockedHashes(root).size, 1, "the lock is really stored");

  const before = stub.messages.length;
  stub.choice = "Push";
  await harness.provider.pushBranch();

  const visible = [
    ...harness.toasts.map((entry) => entry.text),
    ...stub.messages.slice(before).map((entry) => entry.text),
  ].join("\n");
  // B proved the catch renders; what was missing is an assertion on its *text*.
  // The old assertion in the `-evil` test was `/推送被拒绝|无法计算推送范围/`,
  // whose first alternative always matches, so it constrained nothing.
  assert.match(visible, /无法计算推送范围（origin\/master\.\.HEAD）：/, "the reason is named; saw " + JSON.stringify(visible));
  assert.match(visible, /git rev-list origin\/master\.\.HEAD failed \(128\)/, "and it carries Git's own failure");
  assert.match(visible, /未执行推送/, "and says no push happened");
  assert.doesNotMatch(visible, /已推送/, "a push that never ran is not reported as pushed");
  assert.doesNotMatch(visible, /推送被拒绝/, "nothing was rejected for a lock — the range itself failed");
  assert.equal(harness.titles.length, 0, "the progress surface never opened");
});

test("getUpstream spawns one Git process, not two", async () => {
  const cwd = createRepo();
  const remote = remoteFor(cwd);
  const { setGitInvocationObserver } = require("../src/git/gitRunner") as typeof import("../src/git/gitRunner");
  try {
    setup(cwd, remote);
    const seen: string[] = [];
    setGitInvocationObserver((entry) => seen.push(entry.args.join(" ")));
    try {
      await getUpstream(cwd, "master");
    } finally {
      setGitInvocationObserver(undefined);
    }
    assert.equal(seen.length, 1, "one for-each-ref call answers everything; saw " + JSON.stringify(seen));
    assert.match(seen[0], /^for-each-ref /, "and it is the listing, not a probe");
    // The ref pattern matters as much as the spawn count. Measured on this
    // machine (spawn-dominated, so the deltas are conservative):
    //   refs    scoped to refs/heads/master   unscoped (all refs)
    //   2       637 ms                        614 ms
    //   2 000   602 ms                        761 ms
    //   20 000  633 ms                        2049 ms
    // Dropping the pattern would keep the one-spawn assertion green while making
    // every `refresh()` pay a listing that scales with total ref count.
    assert.match(
      seen[0],
      /refs\/heads\/master\s*$/,
      "and it is scoped to the one branch, not the whole ref database; saw " + seen[0]
    );
  } finally {
    removeRepo(remote);
    removeRepo(cwd);
  }
});
