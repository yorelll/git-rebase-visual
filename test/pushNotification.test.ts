import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { describePush, PUSH_SUBJECT_LIMIT, PUSH_SUBJECT_UNKNOWN, PUSH_TARGET_UNKNOWN, pushDestination, pushKindLabel, pushSource, shortenSubject } from "../src/ui/pushNotification";
import { commitFile, createRepo, git, gitExit, removeRepo } from "./helpers/gitTestRepo";
import { createExtensionContext, installVscodeStub, resetStub, stub, vscodeStub } from "./helpers/vscodeStub";

installVscodeStub();

const { RebaseViewProvider } = require("../src/ui/rebaseViewProvider") as typeof import("../src/ui/rebaseViewProvider");
const { LockStore } = require("../src/lock/lockStore") as typeof import("../src/lock/lockStore");
const { createGitContentRequestStore } = require("../src/ui/gitDiffRequestState") as typeof import("../src/ui/gitDiffRequestState");
const { createGeneratedDiffSnapshotStore } = require("../src/ui/generatedDiffDocument") as typeof import("../src/ui/generatedDiffDocument");

const HASH = /[0-9a-f]{40}/i;

test("a push notification states the kind, the subject and the target branch", () => {
  const text = describePush("normal", "feat(cmos_sensor): add ir ispll", "origin/fpga/rle1283_rts3923");
  assert.equal(text, '普通推送："feat(cmos_sensor): add ir ispll" → origin/fpga/rle1283_rts3923');
  assert.doesNotMatch(text, HASH, "a hash identifies nothing to the user");
  assert.doesNotMatch(text, /HEAD:/, "the refspec stays out of the headline");
});

test("the three push kinds are named as the quick pick names them", () => {
  assert.equal(pushKindLabel("normal"), "普通推送");
  assert.equal(pushKindLabel("review"), "评审推送");
  assert.equal(pushKindLabel("custom"), "自定义推送");
});

/**
 * The destination must be read off the resolved refspec's destination side.
 * The upstream branch (`up.ref`) is the wrong answer for precisely the pushes
 * this project supports: a review refspec creates `refs/for/<branch>` and never
 * touches the upstream branch, and a custom refspec can write anywhere.
 */
test("the destination comes from the refspec, not the upstream branch", () => {
  // Normal: HEAD -> refs/heads/<upstream branch> reads as the familiar remote ref.
  assert.equal(pushDestination("origin", "HEAD:refs/heads/master"), "origin/master");
  assert.equal(pushDestination("origin", "HEAD:refs/heads/fpga/rle1283_rts3923"), "origin/fpga/rle1283_rts3923");
  // Review (Gerrit): the commits land on a review ref, not on origin/master.
  assert.equal(pushDestination("origin", "HEAD:refs/for/master"), "origin:refs/for/master");
  assert.equal(pushDestination("origin", "HEAD:refs/drafts/main"), "origin:refs/drafts/main");
  // Custom, redefining a non-upstream branch.
  assert.equal(pushDestination("origin", "HEAD:refs/heads/hotfix"), "origin/hotfix");
  // Custom, replacing the whole ref.
  assert.equal(pushDestination("origin", "HEAD:refs/tags/v1"), "origin:refs/tags/v1");
  // A forced refspec carries a leading `+`, which is not part of the destination.
  assert.equal(pushDestination("origin", "+HEAD:refs/heads/master"), "origin/master");
  // Surrounding whitespace from a hand-typed refspec is not a branch name.
  assert.equal(pushDestination("origin", "  HEAD:refs/heads/master  "), "origin/master");

  // Admitting uncertainty beats printing a plausible wrong branch.
  assert.equal(pushDestination("origin", ""), PUSH_TARGET_UNKNOWN);
  assert.equal(pushDestination("origin", "HEAD"), PUSH_TARGET_UNKNOWN, "a `:`-less HEAD writes to a remote-decided ref");
  assert.equal(pushDestination("origin", "HEAD:"), PUSH_TARGET_UNKNOWN, "an empty destination deletes the ref");
  assert.equal(pushDestination("origin", "HEAD:refs/"), PUSH_TARGET_UNKNOWN);
  assert.equal(pushDestination("origin", "refs/heads/:refs/heads/x"), "origin/x", "only the destination side is read");
});

test("a review push names the review ref, not the upstream branch", () => {
  const text = describePush("review", "feat(cmos_sensor): add ir ispll", pushDestination("origin", "HEAD:refs/for/master"));
  assert.equal(text, '评审推送："feat(cmos_sensor): add ir ispll" → origin:refs/for/master');
  assert.doesNotMatch(text, /origin\/master/, "the upstream branch was not the destination");
});

test("a long subject is shortened at a stated limit without splitting a character", () => {
  const long = "fix(相机): " + "修复曝光".repeat(30);
  const shortened = shortenSubject(long);
  assert.equal(Array.from(shortened).length, PUSH_SUBJECT_LIMIT + 1, "limit plus the ellipsis");
  assert.ok(shortened.endsWith("…"));
  assert.equal(long.startsWith(shortened.slice(0, -1)), true, "the kept prefix is verbatim");

  const emoji = "✨".repeat(PUSH_SUBJECT_LIMIT + 5);
  assert.equal(Array.from(shortenSubject(emoji)).length, PUSH_SUBJECT_LIMIT + 1, "surrogate pairs are not split");
  assert.equal(shortenSubject("✨".repeat(PUSH_SUBJECT_LIMIT)), "✨".repeat(PUSH_SUBJECT_LIMIT), "exactly at the limit is kept whole");
  assert.equal(shortenSubject("  padded  "), "padded", "the subject is trimmed, not the message");

  // An unreadable subject must say so rather than print empty quotes, which
  // would read as a commit that has no subject at all.
  const unreadable = describePush("normal", "  ", "origin/master");
  assert.equal(unreadable, `普通推送："${PUSH_SUBJECT_UNKNOWN}" → origin/master`);
  assert.doesNotMatch(unreadable, /""/, "empty quotes would read as a subjectless commit");
});

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
  // Both surfaces are captured where the user would see them: the Source
  // Control progress title and the toast/notification body.
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
  return path.join(cwd, "..", `grv-push-remote-${path.basename(cwd)}.git`);
}

test("the progress title and success toast carry kind, subject and branch", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = remoteFor(cwd);
  t.after(() => removeRepo(remote));

  git(cwd, ["init", "--bare", "-q", remote]);
  commitFile(cwd, "one.txt", "one\n", "first");
  git(cwd, ["remote", "add", "origin", remote]);
  git(cwd, ["push", "-q", "-u", "origin", "master"]);

  const subject = "feat(cmos_sensor): add ir ispll";
  commitFile(cwd, "two.txt", "two\n", subject);
  const head = git(cwd, ["rev-parse", "HEAD"]);

  stub.choice = "Push";
  await harness.provider.pushBranch();

  const expected = `普通推送："${subject}" → origin/master`;
  assert.equal(harness.titles.at(-1), `推送中：${expected}`, "the progress title states all three facts");
  assert.equal(harness.toasts.at(-1)?.text, `已推送：${expected}`, "so does the success toast");
  assert.doesNotMatch(harness.titles.at(-1)!, HASH);
  assert.doesNotMatch(harness.toasts.at(-1)!.text, HASH);
  assert.doesNotMatch(harness.toasts.at(-1)!.text, new RegExp(head.slice(0, 7)), "not even the short hash");
  assert.equal(git(cwd, ["rev-parse", "origin/master"]), head, "the push really happened");
});

test("the failure path keeps the same three facts and still reports the Git error", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = remoteFor(cwd);
  t.after(() => removeRepo(remote));

  // The remote is configured but never created, so the push fails for a reason
  // that is stable on every platform, while the upstream ref still resolves.
  git(cwd, ["remote", "add", "origin", remote]);
  commitFile(cwd, "one.txt", "one\n", "first");
  git(cwd, ["config", `branch.master.remote`, "origin"]);
  git(cwd, ["config", `branch.master.merge`, "refs/heads/master"]);
  git(cwd, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
  const subject = "fix: reject an unreadable stash list";
  commitFile(cwd, "two.txt", "two\n", subject);
  assert.notEqual(gitExit(cwd, ["push", "--dry-run", "origin", "master"]), 0, "the missing remote really fails the push");

  stub.choice = "Push";
  // The failure path must still refresh: it used to get that for free from the
  // throw's caller, and the early `return` that replaced the throw skipped it.
  let refreshes = 0;
  const originalRefresh = (harness.provider as any).refresh.bind(harness.provider);
  (harness.provider as any).refresh = async (...args: unknown[]) => {
    refreshes += 1;
    return originalRefresh(...args);
  };
  await harness.provider.pushBranch();
  assert.ok(refreshes >= 1, "a failed push still refreshes the panel");

  const error = stub.messages.filter((entry) => entry.level === "error").at(-1);
  assert.ok(error, "the failure is reported");
  assert.match(error!.text, /推送失败/, "it says the push failed");
  assert.match(error!.text, /普通推送/, "and which kind of push it was");
  assert.match(error!.text, new RegExp(subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the subject is named, not the hash");
  assert.match(error!.text, /origin\/master/, "and the target branch");
  assert.doesNotMatch(error!.text, HASH);

  // A failed push must report exactly one outcome. The failure branch used to
  // `return` out of the progress callback, which fell through to the success
  // toast below it: the user saw 推送失败 and 已推送 for a push that never
  // happened.
  const successToasts = harness.toasts.filter((entry) => entry.text.includes("已推送"));
  assert.deepEqual(successToasts, [], "a failed push never also reports success");
  assert.equal(harness.toasts.filter((entry) => entry.text.includes("推送失败")).length, 0, "failure is not an inline info toast");
  assert.equal(stub.messages.filter((entry) => entry.text.includes("已推送")).length, 0, "and no success notification sneaks through");
});

/**
 * The earlier stub always returned the fallback for every setting, so
 * `push.refspecTemplate` was permanently empty and the quick pick never opened:
 * the review and custom branches were never executed, which is how a review
 * push reporting `origin/master` shipped. These tests register the template and
 * drive the real quick-pick / input-box branches.
 */
test("a review push reports the ref it created, not the upstream branch", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = remoteFor(cwd);
  t.after(() => removeRepo(remote));

  git(cwd, ["init", "--bare", "-q", remote]);
  commitFile(cwd, "one.txt", "one\n", "first");
  git(cwd, ["remote", "add", "origin", remote]);
  git(cwd, ["push", "-q", "-u", "origin", "master"]);
  const subject = "feat(cmos_sensor): add ir ispll";
  commitFile(cwd, "two.txt", "two\n", subject);

  // A configured template is what makes the push kind a real choice.
  stub.config["gitRebaseVisual.push.refspecTemplate"] = "HEAD:refs/for/${branch}";
  stub.quickPick = { label: "评审推送", kind: "review" };
  stub.choice = "Push";
  await harness.provider.pushBranch();

  const expected = `评审推送："${subject}" → origin:refs/for/master`;
  assert.equal(harness.titles.at(-1), `推送中：${expected}`, "the progress title names the review ref");
  assert.equal(harness.toasts.at(-1)?.text, `已推送：${expected}`, "so does the success toast");
  assert.doesNotMatch(harness.toasts.at(-1)!.text, /origin\/master/, "the upstream branch was not touched");
  // The confirmation shown before pushing names the same destination: it used
  // to say `推送到 origin/master？` for a review push.
  const confirm = stub.messages.filter((entry) => entry.level === "warn").at(-1);
  assert.ok(confirm, "the push was confirmed");
  assert.match(confirm!.text, /评审推送到 origin:refs\/for\/master/, "the confirmation names the review ref");
  // The push really happened, and it created the review ref on the remote while
  // leaving the upstream branch where it was.
  const head = git(cwd, ["rev-parse", "HEAD"]);
  assert.equal(git(cwd, ["--git-dir", remote, "rev-parse", "refs/for/master"]), head, "the review ref really moved");
  assert.equal(git(cwd, ["--git-dir", remote, "rev-parse", "refs/heads/master"]), git(cwd, ["rev-parse", "origin/master"]), "the upstream branch did not move");
});

test("a custom refspec reports the branch it actually moved", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = remoteFor(cwd);
  t.after(() => removeRepo(remote));

  git(cwd, ["init", "--bare", "-q", remote]);
  commitFile(cwd, "one.txt", "one\n", "first");
  git(cwd, ["remote", "add", "origin", remote]);
  git(cwd, ["push", "-q", "-u", "origin", "master"]);
  const subject = "fix: keep the abort path read-only";
  commitFile(cwd, "two.txt", "two\n", subject);

  stub.config["gitRebaseVisual.push.refspecTemplate"] = "HEAD:refs/for/${branch}";
  stub.quickPick = { label: "自定义 refspec…", kind: "custom" };
  stub.inputBox = "HEAD:refs/heads/hotfix";
  stub.choice = "Push";
  // The custom branch is only reachable through the quick pick and the input
  // box; count those calls so a stub that skips them cannot pass.
  const asked: string[] = [];
  const originalQuickPick = vscodeStub.window.showQuickPick;
  const originalInputBox = vscodeStub.window.showInputBox;
  (vscodeStub.window as any).showQuickPick = async (...args: any[]) => { asked.push("quickPick"); return (originalQuickPick as any)(...args); };
  (vscodeStub.window as any).showInputBox = async (...args: any[]) => { asked.push("inputBox"); return (originalInputBox as any)(...args); };
  t.after(() => {
    (vscodeStub.window as any).showQuickPick = originalQuickPick;
    (vscodeStub.window as any).showInputBox = originalInputBox;
  });
  await harness.provider.pushBranch();

  assert.deepEqual(asked, ["quickPick", "inputBox"], "the custom branch really ran both prompts");
  // Only `hotfix` moved; reporting origin/master here would be a lie.
  const expected = `自定义推送："${subject}" → origin/hotfix`;
  assert.equal(harness.titles.at(-1), `推送中：${expected}`);
  assert.equal(harness.toasts.at(-1)?.text, `已推送：${expected}`);
  assert.doesNotMatch(harness.toasts.at(-1)!.text, /origin\/master/);
  const confirm = stub.messages.filter((entry) => entry.level === "warn").at(-1);
  assert.ok(confirm, "the push was confirmed");
  assert.match(confirm!.text, /自定义推送到 origin\/hotfix/, "the confirmation names the branch that will move");
  assert.doesNotMatch(confirm!.text, /推送到 origin\/master/, "not the untouched upstream branch");
  assert.equal(git(cwd, ["--git-dir", remote, "rev-parse", "refs/heads/hotfix"]), git(cwd, ["rev-parse", "HEAD"]), "hotfix really moved on the remote");
});

/**
 * A remote may contain a slash. `git remote add` refuses the shape, but a
 * hand-written `.git/config` accepts it, and splitting `<remote>/<branch>` at
 * the first slash then yields the remote `team` with branch `origin/master`:
 * a review push lands on `team` while the notification says `team/origin`.
 * `getUpstream` now asks Git (`upstream:remotename`) instead of parsing.
 */
test("a remote name containing a slash is resolved, not split", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = remoteFor(cwd);
  const wrongRemote = path.join(cwd, "..", `grv-push-team-${path.basename(cwd)}.git`);
  t.after(() => { removeRepo(remote); removeRepo(wrongRemote); });

  git(cwd, ["init", "--bare", "-q", remote]);
  git(cwd, ["init", "--bare", "-q", wrongRemote]);
  commitFile(cwd, "one.txt", "one\n", "first");
  // Written through raw config, exactly as the review constructed it.
  git(cwd, ["config", "remote.team/origin.url", remote]);
  git(cwd, ["config", "remote.team/origin.fetch", "+refs/heads/*:refs/remotes/team/origin/*"]);
  git(cwd, ["config", "remote.team.url", wrongRemote]);
  git(cwd, ["config", "remote.team.fetch", "+refs/heads/*:refs/remotes/team/*"]);
  git(cwd, ["config", "branch.master.remote", "team/origin"]);
  git(cwd, ["config", "branch.master.merge", "refs/heads/master"]);
  git(cwd, ["fetch", "-q", "team/origin"]);
  git(cwd, ["push", "-q", "-u", "team/origin", "master"]);
  const subject = "feat: survive a slashed remote";
  commitFile(cwd, "two.txt", "two\n", subject);

  const { getUpstream, resolveRefspec } = require("../src/git/pushGuard") as typeof import("../src/git/pushGuard");
  const up = await getUpstream(cwd, "master");
  assert.ok(up, "the upstream resolves");
  assert.equal(up!.remote, "team/origin", "the remote keeps its full name");
  assert.equal(up!.branch, "master", "and the branch is not the remote's tail");
  assert.equal(resolveRefspec(up!, "HEAD", "HEAD:refs/for/${branch}"), "HEAD:refs/for/master");

  stub.config["gitRebaseVisual.push.refspecTemplate"] = "HEAD:refs/for/${branch}";
  stub.quickPick = { label: "评审推送", kind: "review" };
  stub.choice = "Push";
  await harness.provider.pushBranch();

  const expected = `评审推送："${subject}" → team/origin:refs/for/master`;
  assert.equal(harness.titles.at(-1), `推送中：${expected}`, "the notification names the real remote");
  assert.equal(harness.toasts.at(-1)?.text, `已推送：${expected}`);
  // The review ref landed on `team/origin`, and the decoy `team` remote got nothing.
  const head = git(cwd, ["rev-parse", "HEAD"]);
  assert.equal(git(cwd, ["--git-dir", remote, "rev-parse", "refs/for/master"]), head, "the named remote received the push");
  assert.notEqual(gitExit(cwd, ["--git-dir", wrongRemote, "rev-parse", "--verify", "--quiet", "refs/for/master"]), 0, "the split-at-slash remote received nothing");
});

/**
 * If a remote name cannot be trusted, the notification must say so rather than
 * print a plausible wrong branch.
 */
test("a local-tracking upstream is never printed as a remote", () => {
  // `branch.<b>.remote = "."` makes Git report the literal remote name `"."`.
  // `./other` is not a destination a push can reach, so it must not be shown —
  // with or without a remote roster.
  assert.equal(pushDestination(".", "HEAD:refs/heads/other"), PUSH_TARGET_UNKNOWN);
  assert.equal(pushDestination(".", "HEAD:refs/heads/other", ["origin"]), PUSH_TARGET_UNKNOWN);
});

test("an unlisted remote name degrades to the explicit unknown", () => {
  assert.equal(pushDestination("team", "HEAD:refs/for/master", ["team/origin"]), PUSH_TARGET_UNKNOWN, "a split remote is not printed");
  assert.equal(pushDestination("team/origin", "HEAD:refs/for/master", ["team/origin"]), "team/origin:refs/for/master");
  assert.equal(pushDestination("", "HEAD:refs/heads/master", ["origin"]), PUSH_TARGET_UNKNOWN, "no remote means no destination");
  // Without a roster the caller is trusting the name it passed in.
  assert.equal(pushDestination("origin", "HEAD:refs/heads/master"), "origin/master");
});

test("the subject comes from the refspec source, not always HEAD", () => {
  assert.equal(pushSource("HEAD:refs/heads/master"), "HEAD");
  assert.equal(pushSource("+HEAD~1:refs/heads/master"), "HEAD~1");
  assert.equal(pushSource("abc1234:refs/for/main"), "abc1234");
  assert.equal(pushSource("refs/heads/topic"), "refs/heads/topic", "a `:`-less refspec sources from itself");
  assert.equal(pushSource(":refs/heads/gone"), undefined, "a deletion publishes no commit");
  assert.equal(pushSource(""), undefined);
});

test("a push that changes nothing is not reported as pushed", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = remoteFor(cwd);
  t.after(() => removeRepo(remote));

  git(cwd, ["init", "--bare", "-q", remote]);
  commitFile(cwd, "one.txt", "one\n", "first");
  git(cwd, ["remote", "add", "origin", remote]);
  git(cwd, ["push", "-q", "-u", "origin", "master"]);

  // Deleting a ref that never existed: Git exits 0 but nothing changes.
  stub.config["gitRebaseVisual.push.refspecTemplate"] = "HEAD:refs/for/${branch}";
  stub.quickPick = { label: "自定义 refspec…", kind: "custom" };
  stub.inputBox = ":refs/heads/never-existed";
  stub.choice = "Push";
  await harness.provider.pushBranch();

  const toast = harness.toasts.at(-1)?.text ?? "";
  assert.match(toast, /无需推送/, "the no-op is named as one");
  assert.doesNotMatch(toast, /已推送/, "and is not called a successful push");
  assert.doesNotMatch(toast, /推送失败/, "nor a failure");
});

test("dismissing the push kind choice aborts without pushing or reporting", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = remoteFor(cwd);
  t.after(() => removeRepo(remote));

  git(cwd, ["init", "--bare", "-q", remote]);
  commitFile(cwd, "one.txt", "one\n", "first");
  git(cwd, ["remote", "add", "origin", remote]);
  git(cwd, ["push", "-q", "-u", "origin", "master"]);
  commitFile(cwd, "two.txt", "two\n", "second");

  stub.config["gitRebaseVisual.push.refspecTemplate"] = "HEAD:refs/for/${branch}";
  stub.quickPick = undefined; // The user pressed Escape.
  await harness.provider.pushBranch();

  assert.deepEqual(harness.toasts, [], "no outcome is reported");
  assert.equal(git(cwd, ["rev-parse", "origin/master"]), git(cwd, ["rev-parse", "origin/master"]), "nothing moved");
  assert.equal(harness.titles.length, 0, "the progress surface never opened");
});

test("success reports only success, never a failure", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = remoteFor(cwd);
  t.after(() => removeRepo(remote));

  git(cwd, ["init", "--bare", "-q", remote]);
  commitFile(cwd, "one.txt", "one\n", "first");
  git(cwd, ["remote", "add", "origin", remote]);
  git(cwd, ["push", "-q", "-u", "origin", "master"]);
  commitFile(cwd, "two.txt", "two\n", "second");

  stub.choice = "Push";
  await harness.provider.pushBranch();

  assert.equal(harness.toasts.filter((entry) => entry.text.includes("已推送")).length, 1, "exactly one success report");
  assert.equal(stub.messages.filter((entry) => entry.text.includes("推送失败")).length, 0, "no failure notification");
  assert.equal(harness.toasts.filter((entry) => entry.text.includes("推送失败")).length, 0);
});

/**
 * Regression from the N-1 fix: `getUpstream` asks `for-each-ref` for the
 * configured upstream, which still reports `origin/master` after that remote
 * branch has been pruned. Every range query against it then fails with
 * `unknown revision`, and the command wrapper only writes a diagnostic — so the
 * user, who has just clicked Push in the confirmation dialog, saw nothing at
 * all. The old `rev-parse @{upstream}` returned undefined here and the caller's
 * existing "未配置 upstream" toast fired.
 *
 * The lock is required to reach the range query: with no locks `lockedInPush`
 * returns before it lists anything, and the push simply recreates the branch.
 */
test("a pruned upstream reports a visible error instead of failing silently", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = remoteFor(cwd);
  t.after(() => removeRepo(remote));

  git(cwd, ["init", "--bare", "-q", remote]);
  commitFile(cwd, "one.txt", "one\n", "first");
  git(cwd, ["remote", "add", "origin", remote]);
  git(cwd, ["push", "-q", "-u", "origin", "master"]);
  const pushed = git(cwd, ["rev-parse", "HEAD"]);

  // Delete the remote branch without touching the local tracking ref, then
  // prune it away — the shape `git fetch --prune` leaves behind.
  git(cwd, ["--git-dir", remote, "update-ref", "-d", "refs/heads/master"]);
  git(cwd, ["fetch", "-q", "--prune", "origin"]);
  commitFile(cwd, "two.txt", "two\n", "second");
  assert.equal(
    gitExit(cwd, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/master"]),
    1,
    "the tracking ref really is gone"
  );
  assert.match(git(cwd, ["status", "-sb"]), /\[gone\]/, "the fixture really reproduced a pruned upstream");

  // One real lock is what makes the lock guard enumerate the range. `refresh`
  // is what records the repo root the guard reads locks for, so it runs first
  // exactly as it does before a user can click Push.
  await harness.provider.refresh();
  const ctx = (harness.provider as any).ctx;
  // The guard reads locks for the provider's normalized repo root, which is not
  // byte-identical to the fixture path on Windows (C:/... vs the 8.3 short form).
  const root = (harness.provider as any).root as string;
  assert.ok(root, "the provider recorded a repo root");
  const store = new LockStore(ctx.globalState);
  await store.lock(root, pushed);
  assert.equal(store.lockedHashes(root).size, 1, "the lock is really stored");

  stub.choice = "Push";
  await harness.provider.pushBranch();

  // Visible to the user: a message on a VS Code surface, not a log line.
  const visible = [
    ...harness.toasts.map((entry) => entry.text),
    ...stub.messages.map((entry) => entry.text),
  ];
  assert.ok(
    visible.some((text) => /upstream/i.test(text)),
    "the user is told the upstream is unusable; saw " + JSON.stringify(visible)
  );
  assert.doesNotMatch(visible.join("\n"), /unknown revision/, "no raw Git range error reaches the user");
  assert.doesNotMatch(visible.join("\n"), /已推送/, "and nothing claims the push happened");
  assert.equal(harness.titles.length, 0, "the progress surface never opened for an unusable upstream");
});

/**
 * `branch.<b>.remote = "."` is a local tracking upstream, not a remote. Git
 * reports the literal `"."`, so a check for an empty `remotename` lets it
 * through, and the dialog said `推送到 ./other？` while the notification said
 * `（无法确定目标分支）` for the same push — they disagreed because only the
 * notification received the configured remote names.
 */
test("a local tracking upstream is not treated as a remote, and no dialog contradicts a notification", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  commitFile(cwd, "one.txt", "one\n", "first");
  commitFile(cwd, "two.txt", "two\n", "two");
  git(cwd, ["branch", "other"]);
  git(cwd, ["branch", "--set-upstream-to=other", "master"]);

  const guard = require("../src/git/pushGuard") as typeof import("../src/git/pushGuard");
  assert.equal(await guard.getUpstream(cwd, "master"), undefined, "a local upstream has no remote to push to");

  stub.choice = "Push";
  await harness.provider.pushBranch();

  const visible = [
    ...harness.toasts.map((entry) => entry.text),
    ...stub.messages.map((entry) => entry.text),
  ];
  assert.ok(
    visible.some((text) => /upstream/i.test(text)),
    "the user is told there is no pushable upstream; saw " + JSON.stringify(visible)
  );
  const dialogs = stub.messages.filter((entry) => entry.level === "warn").map((entry) => entry.text);
  assert.deepEqual(dialogs, [], "no confirmation is shown for a push that cannot work");
  assert.doesNotMatch(visible.join("\n"), /\.\/other/, "the local upstream ref is never printed as a remote");
});

/**
 * B mutated `pushSource(refspec) ?? "HEAD"` to `"HEAD"` and every test still
 * passed: N-2 was wired up but unpinned. This drives the real provider and
 * asserts the *other* commit's subject appears, so the mutant dies.
 */
test("a custom refspec publishing HEAD~1 names that commit, not HEAD", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = remoteFor(cwd);
  t.after(() => removeRepo(remote));

  git(cwd, ["init", "--bare", "-q", remote]);
  const older = "fix: keep the abort path read-only";
  commitFile(cwd, "one.txt", "one\n", "first");
  commitFile(cwd, "two.txt", "two\n", older);
  const olderSha = git(cwd, ["rev-parse", "HEAD"]);
  git(cwd, ["remote", "add", "origin", remote]);
  git(cwd, ["push", "-q", "-u", "origin", "master"]);
  const headSubject = "feat: something HEAD says";
  commitFile(cwd, "three.txt", "three\n", headSubject);

  stub.config["gitRebaseVisual.push.refspecTemplate"] = "HEAD:refs/heads/older";
  stub.quickPick = { label: "自定义 refspec…", kind: "custom" };
  stub.inputBox = "HEAD~1:refs/heads/older";
  stub.choice = "Push";
  await harness.provider.pushBranch();

  const expected = '自定义推送："' + older + '" → origin/older';
  assert.equal(harness.titles.at(-1), "推送中：" + expected, "the title names the commit the refspec publishes");
  assert.equal(harness.toasts.at(-1)?.text, "已推送：" + expected);
  assert.doesNotMatch(harness.toasts.at(-1)!.text, new RegExp(headSubject), "not HEAD's subject");
  assert.equal(git(cwd, ["--git-dir", remote, "rev-parse", "refs/heads/older"]), olderSha, "and that commit really landed");
});

/**
 * A deletion refspec publishes nothing. Falling back to HEAD's subject claimed
 * a commit the push never sent; the wording has to say it deleted a ref.
 */
test("a deletion refspec does not claim a commit it never published", async (t) => {
  const harness = createHarness(t);
  const cwd = harness.cwd;
  const remote = remoteFor(cwd);
  t.after(() => removeRepo(remote));

  git(cwd, ["init", "--bare", "-q", remote]);
  commitFile(cwd, "one.txt", "one\n", "first");
  git(cwd, ["remote", "add", "origin", remote]);
  git(cwd, ["push", "-q", "-u", "origin", "master"]);
  git(cwd, ["push", "-q", "origin", "master:refs/heads/obsolete"]);
  const headSubject = "fix: a subject this deletion must not quote";
  commitFile(cwd, "two.txt", "two\n", headSubject);

  stub.config["gitRebaseVisual.push.refspecTemplate"] = "HEAD:refs/for/${branch}";
  stub.quickPick = { label: "自定义 refspec…", kind: "custom" };
  stub.inputBox = ":refs/heads/obsolete";
  stub.choice = "Push";
  await harness.provider.pushBranch();

  const expected = "自定义推送：删除远端 ref → origin/obsolete";
  assert.equal(harness.titles.at(-1), "推送中：" + expected, "the title says a ref is deleted");
  assert.equal(harness.toasts.at(-1)?.text, "已推送：" + expected);
  assert.doesNotMatch(harness.toasts.at(-1)!.text, new RegExp(headSubject), "HEAD's subject is not claimed");
  assert.doesNotMatch(harness.toasts.at(-1)!.text, /""/, "no empty quotes either");
  assert.notEqual(
    gitExit(cwd, ["--git-dir", remote, "rev-parse", "--verify", "--quiet", "refs/heads/obsolete"]),
    0,
    "the ref really went away"
  );
});
