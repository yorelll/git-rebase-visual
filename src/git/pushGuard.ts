import { C_LOCALE, runGit, withPositionals } from "./gitRunner";
import { patchId } from "./commitLog";

export interface UpstreamInfo {
  remote: string;
  branch: string; // remote-side branch name
  ref: string; // e.g. origin/main
}

/**
 * Resolves the upstream remote/branch for the given **short branch name**
 * (`master`, not `refs/heads/master`, and not `HEAD`). Pass an explicit name
 * when HEAD is detached (e.g. mid-rebase), since `HEAD@{upstream}` cannot
 * resolve in a detached state.
 *
 * The pair is asked of Git rather than parsed out of `<remote>/<branch>`: a
 * remote may itself contain a slash (a hand-written `remote.team/origin.url`
 * produces one), so splitting `team/origin/master` at the first `/` yields the
 * remote `team` and the branch `origin/master`. Every caller then acts on that
 * wrong remote — a review push would land on `team` while the notification says
 * `team/origin`, which is the same "the notification lies about the
 * destination" class this module exists to prevent. `upstream:remotename` is
 * Git's own answer and is unambiguous for any remote name.
 *
 * Returns `undefined` — "no usable upstream" — in three cases that all read the
 * same way to the caller:
 *
 *  - the branch is configured with a local tracking upstream
 *    (`branch.<b>.remote = "."`), which has no remote to push to; Git reports
 *    the literal remote name `"."` rather than an empty string for that shape;
 *  - the remote-tracking ref has been pruned (`[gone]` after `git fetch
 *    --prune`). `for-each-ref` still reports the configured upstream, but every
 *    range query against it fails with "unknown revision". A transport push to
 *    a gone branch does succeed, but the lock guard runs *before* the push and
 *    cannot compute its range, so the whole command would fail with an internal
 *    Git error and no user-facing message;
 *  - there is no upstream at all.
 *
 * The caller already renders `undefined` as a visible "未配置 upstream" toast;
 * returning a ref that cannot be resolved instead would silently replace that
 * message with a log line. Pruned and never-configured deliberately share that
 * one message: both leave the user with no pushable upstream and the same next
 * step (re-create or configure one), while separating them would need a third
 * return state threaded through both callers — `docs/improvement/improvement.md`
 * records that trade-off as a P3.
 *
 * Existence is decided by Git's own `%(upstream:track)` (`[gone]`), **one**
 * `for-each-ref` call for everything. The previous revision reconstructed the
 * tracking ref as `refs/remotes/<remote>/<branch>` and probed it with a second
 * `rev-parse --verify` spawn. That reconstruction is wrong for any repo whose
 * `remote.<r>.fetch` maps into another namespace
 * (`+refs/heads/*:refs/remotes/upstream/*`, or a nested
 * `refs/remotes/origin/nested/*`): the upstream is healthy — `git push origin
 * master` works — but the invented path does not exist, so the UI confidently
 * told the user "未配置 upstream". The second spawn also cost ~330 ms per call
 * on a `refresh()` that already takes seconds. `track` is prose, so this child
 * gets `LC_ALL=C` (see the audit table in `gitRunner.ts`).
 */
export async function getUpstream(
  cwd: string,
  branch: string
): Promise<UpstreamInfo | undefined> {
  const trimmed = branch.trim().replace(/^refs\/heads\//, "");
  if (!trimmed) {
    return undefined;
  }

  const listed = await runGit(
    withPositionals(
      [
        "for-each-ref",
        "--format=%(upstream:short)%09%(upstream:remotename)%09%(upstream:remoteref)%09%(upstream:track)",
      ],
      [`refs/heads/${trimmed}`]
    ),
    { cwd, env: C_LOCALE }
  );
  if (listed.code !== 0) {
    return undefined;
  }
  const [ref = "", remote = "", remoteRef = "", track = ""] = listed.stdout.trim().split("\t");
  // `"."` is Git's name for a local tracking upstream, not a remote.
  if (!ref || !remote || remote === ".") {
    return undefined;
  }
  // `%(upstream:track)` prints `[gone]` once `git fetch --prune` removed the
  // tracking ref, and empty / `[ahead N]` / `[behind N]` otherwise. Strip the
  // brackets rather than asking for `nobracket`, which needs a newer Git than
  // the 2.31.0 this extension supports.
  if (track.trim().replace(/^\[|\]$/g, "") === "gone") {
    return undefined;
  }
  // The remote-side branch is what `refs/heads/<branch>` names; fall back to the
  // tail of the tracking ref only when Git did not report it.
  const remoteBranch = remoteRef.startsWith("refs/heads/")
    ? remoteRef.slice("refs/heads/".length)
    : ref.slice(remote.length + 1);
  if (!remoteBranch) {
    return undefined;
  }

  return { remote, branch: remoteBranch, ref };
}

/**
 * Returns the commit hashes that would be published by pushing up to `tip`:
 * the range `<upstreamRef>..tip` (full hashes, any order).
 *
 * `upstreamRef` is Git's own `%(upstream:short)`, so the remote half of it can
 * begin with `-`: `git remote add -- -evil <url>` is accepted, `git remote`
 * prints `-evil`, and the upstream then reads `-evil/master`. Without the marker
 * `git rev-list -evil/master..HEAD` is taken as an option bundle and fails with
 * `usage: git rev-list …` (exit 129) — a user who clicked Push got no feedback
 * at all, because the throw only reached the diagnostic log. The marker makes
 * the range a positional, which is also what makes the dash-prefixed shape
 * *work*: measured, `git rev-list --end-of-options '-evil/master..HEAD'` exits 0
 * and lists the unpushed commit.
 */
export async function pushRange(
  cwd: string,
  upstreamRef: string,
  tip: string
): Promise<string[]> {
  const res = await runGit(
    withPositionals(["rev-list"], [`${upstreamRef}..${tip}`]),
    { cwd }
  );
  if (res.code !== 0) {
    // A range that cannot be resolved is not "nothing to push". Returning an
    // empty list would silently let a locked commit through the guard, so this
    // is a hard failure the caller must render.
    throw new Error(
      `git rev-list ${upstreamRef}..${tip} failed (${res.code}): ${res.stderr.trim()}`
    );
  }
  return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * Returns the hashes in the push range that correspond to locked commits,
 * matched by hash OR by patch-id (stable across rebase / cherry-pick). A
 * non-empty result means the push must be rejected.
 */
export async function lockedInPush(
  cwd: string,
  upstreamRef: string,
  tip: string,
  lockedHashes: Set<string>,
  lockedPatchIds: Set<string>
): Promise<string[]> {
  if (lockedHashes.size === 0 && lockedPatchIds.size === 0) {
    return [];
  }
  const range = await pushRange(cwd, upstreamRef, tip);
  const blocked: string[] = [];
  for (const h of range) {
    if (lockedHashes.has(h)) {
      blocked.push(h);
      continue;
    }
    if (lockedPatchIds.size > 0) {
      const pid = await patchId(cwd, h);
      if (pid && lockedPatchIds.has(pid)) {
        blocked.push(h);
      }
    }
  }
  return blocked;
}

/**
 * Resolves a refspec from an optional template. Supported placeholders:
 *   ${tip}    -> the commit being pushed
 *   ${branch} -> the upstream branch name
 * When no template is given, defaults to a normal branch update
 * `<tip>:refs/heads/<branch>`. A template like `${tip}:refs/for/master`
 * targets a Gerrit-style review ref.
 */
export function resolveRefspec(
  up: UpstreamInfo,
  tip: string,
  template?: string
): string {
  if (!template || !template.trim()) {
    return `${tip}:refs/heads/${up.branch}`;
  }
  return template
    .replace(/\$\{tip\}/g, tip)
    .replace(/\$\{branch\}/g, up.branch);
}

/**
 * Pushes the given refspec. Uses --force-with-lease for normal branch updates
 * (so a concurrent remote change aborts instead of clobbering), but NOT for
 * review refs (refs/for/*, refs/drafts/*), where force semantics don't apply.
 *
 * Returns whether the remote actually changed. Git exits 0 for a push that
 * updates nothing — an already-current branch, or `:refs/heads/<missing>` which
 * deletes a ref that was not there — and reports it on **stderr** as
 * "Everything up-to-date" / "deleting a non-existent ref". Reporting that as
 * `已推送` claims a change that did not happen.
 */
export async function pushRefspec(
  cwd: string,
  up: UpstreamInfo,
  refspec: string,
  signal?: AbortSignal
): Promise<{ changed: boolean }> {
  const isReview = /:refs\/(for|drafts)\//.test(refspec);
  const args = ["push"];
  if (!isReview) {
    args.push(`--force-with-lease=${up.branch}`);
  }
  // The refspec is user data (workspace setting `push.refspecTemplate` or the
  // custom-refspec input), and `git push` keeps parsing options after the
  // positional remote. Without the marker, `--receive-pack=<program>` runs that
  // program and `--mirror` rewrites the whole remote — both reachable from a
  // checked-in `.vscode/settings.json`. `--end-of-options` makes Git read every
  // following argument as a positional, so such a refspec is rejected as
  // invalid instead of being honoured.
  //
  // `up.remote` and `up.branch` can begin with `-`, so the marker is not
  // redundant for them — it is what makes them work. Measured on Git
  // 2.53.0.windows.2:
  //
  //   git remote add -- -evil ../remote.git        # accepted; `git remote`
  //                                                #   then prints `-evil`
  //   git push --force-with-lease=master -evil …   # WITHOUT the marker:
  //                                                #   `-evil` is consumed as
  //                                                #   `-e`, the push fails
  //   git push --force-with-lease=master --end-of-options -evil …   # works
  //
  // A branch ref can be dash-prefixed as well: `git push origin
  // HEAD:refs/heads/-foo` succeeds, and `%(upstream:remoteref)` then reports
  // `refs/heads/-foo`. (`git check-ref-format --branch -foo` rejects `-foo`, but
  // that check applies to the *branch shorthand*, not to `refs/heads/-foo`,
  // which `git check-ref-format` accepts.)
  //
  // So both halves of `UpstreamInfo` are dash-capable, and that is fine here:
  // every option — `--force-with-lease`, and the marker itself — is already
  // written before them, so `up.remote` and `refspec` are positional by
  // construction. The marker is what makes the dash-prefixed shapes work rather
  // than something they can defeat.
  args.push(...withPositionals([], [up.remote, refspec]));
  // `LC_ALL=C` because the no-change verdict below is read from English prose
  // ("Everything up-to-date"); another locale would silently flip it to `changed`.
  const res = await runGit(args, { cwd, signal, env: C_LOCALE });
  if (res.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${res.code}): ${res.stderr.trim()}`);
  }
  const output = `${res.stdout}\n${res.stderr}`;
  const noChange = /Everything up-to-date/i.test(output) || /deleting a non-existent ref/i.test(output);
  return { changed: !noChange };
}
