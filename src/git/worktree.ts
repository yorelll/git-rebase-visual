import { C_LOCALE, git, LITERAL_PATHSPECS, runGit, splitNul, withPositionals } from "./gitRunner";

export interface StashEntry {
  /** Human-readable stash name, e.g. `stash@{2}`. */
  name: string;
  /** Full stash commit sha (stable identity for pop/apply/drop). */
  sha: string;
  subject: string;
}

/**
 * Stashes all changes (including untracked) so a rebase can run on a clean
 * tree. Returns the stash commit sha when something was stashed, or undefined
 * when there was nothing to stash. The sha is a stable identity for the stash
 * that recovery later applies exactly that stash (unaffected by rebase
 * rewriting other commit hashes, and robust if the user creates other stashes).
 */
export async function stashPush(
  cwd: string,
  message: string = "git-rebase-visual auto-stash"
): Promise<string | undefined> {
  return stash(cwd, ["--include-untracked"], message);
}

/** Stashes unstaged changes while leaving the existing index intact. */
export async function stashPushKeepIndex(cwd: string): Promise<string | undefined> {
  return stash(cwd, ["--keep-index", "--include-untracked"], "git-rebase-visual preserve-unstaged");
}

/**
 * Creates one stash entry and returns the commit sha of the entry *this call*
 * created, or undefined when nothing was stashed.
 *
 * ## Why the message is not the evidence
 *
 * The obvious implementation runs `git stash push`, treats "No local changes to
 * save" as "nothing to do", and otherwise reads `stash@{0}`. Both halves of that
 * are wrong under a translated Git, and wrong in the direction that loses data:
 *
 *   - The string is a gettext msgid. With a non-English catalog the regex never
 *     matches, so a push that stashed nothing is treated as a success.
 *   - `stash@{0}` is then *whatever was already on top of the stack* — the
 *     user's own entry. The caller records that sha as "the entry the extension
 *     created", and the recovery path later deletes it once the user's content
 *     happens to satisfy `complete`. A user entry removed by us is precisely
 *     what this module must never do.
 *
 * So "created" is decided by identity, not by prose: the full sha set is read
 * before the push and after it, and the entry is ours only when exactly one sha
 * appeared and it was absent before. `LC_ALL=C` is passed as well, but only so
 * the exit-code-0-with-nothing-stashed case remains recognisable for the log
 * message; the decision below does not depend on it.
 *
 * A push with nothing to stash exits 0 and adds no reflog entry, so the set
 * comparison answers "nothing was created" on its own. A push that fails exits
 * non-zero and also adds nothing, so the two failure shapes need no distinction.
 */
async function stash(
  cwd: string,
  options: string[],
  message: string
): Promise<string | undefined> {
  const before = await stashShasForComparison(cwd);
  const res = await runGit(["stash", "push", ...options, "-m", message], {
    cwd,
    env: C_LOCALE,
  });
  const after = await stashShasForComparison(cwd);
  // The exit code and the stack difference are both consulted by `createdStash`,
  // which is where the decision lives so it can be tested without a locale.
  return createdStash(before, after, res.code, res.stdout + res.stderr);
}

/**
 * Which entry, if any, a single `git stash push` created.
 *
 * Pure, and exported so the decision can be tested directly with the shapes a
 * locale or a race can produce. It deliberately does not take `stash@{0}` as an
 * answer: see the doc on `stash` for why that reads the *user's* entry when the
 * push had nothing to save.
 *
 * `output` is not consulted. It is accepted so callers can pass Git's text
 * without a second call site decision, and documented as unused: the whole point
 * is that the answer must not depend on translated prose.
 */
export function createdStash(
  before: string[] | undefined,
  after: string[] | undefined,
  exitCode: number,
  output?: string
): string | undefined {
  void output;
  if (exitCode !== 0 || !before || !after) {
    return undefined;
  }
  const beforeSet = new Set(before);
  const added = after.filter((entry) => !beforeSet.has(entry));
  // Exactly one new sha is the only shape that names an entry this call created.
  // Zero means nothing was stashed; more than one means a concurrent push raced
  // us, so there is no single entry to claim.
  return added.length === 1 ? added[0] : undefined;
}

/**
 * The three outcomes of reading the stash list.
 *
 * `unreadable` is deliberately separate from `empty`: a corrupted reflog makes
 * `git stash list` print nothing and still exit 0, and reading that as "the
 * stash is gone" discards the only record of uncommitted work.
 */
export type StashListRead =
  | { state: "listed"; shas: string[] }
  | { state: "empty" }
  | { state: "unreadable"; reason: string };

/**
 * Reads the stash list and says which of the three shapes it is.
 *
 * This is the single predicate for the question "what is in the stash list".
 * It exists because three copies of it had drifted apart: `worktree`'s
 * before/after comparison and its `stashIndexBySha` treated `git stash list`
 * exiting 0 with empty output as an *empty* stack, while `pendingRecovery`
 * treated the same shape as *unreadable*. All three were reading the same bytes
 * and giving opposite answers, and the only reason it never bit is that the
 * caller happened to gate on the conservative one. A refactor that reordered
 * those gates would have turned the corrupt-reflog case into "the user's work is
 * gone" — the one outcome this module must never produce. One predicate, one
 * answer, and the conservative one: empty output with `refs/stash` still
 * pointing at a commit is `unreadable`, never `empty`.
 *
 * Note that a genuinely empty stack is `empty`, and `refs/stash` not resolving
 * is exactly what makes that determination: the two signals agree.
 */
export async function readStashList(cwd: string): Promise<StashListRead> {
  const list = await runGit(["stash", "list", "--format=%H"], { cwd });
  if (list.code !== 0) {
    return {
      state: "unreadable",
      reason: (list.stderr || list.stdout).trim() || `exit ${list.code}`,
    };
  }
  const shas = list.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (shas.length > 0) {
    return { state: "listed", shas };
  }
  const ref = await runGit(["rev-parse", "--verify", "--quiet", "refs/stash"], { cwd });
  if (ref.code === 0 && ref.stdout.trim()) {
    return {
      state: "unreadable",
      reason: `git stash list 无输出，但 refs/stash 指向 ${ref.stdout.trim().slice(0, 7)}（reflog 可能损坏）`,
    };
  }
  return { state: "empty" };
}

/**
 * The sha list used for the before/after comparison, or `undefined` when it
 * cannot be trusted.
 *
 * Thin wrapper on `readStashList` so both modules answer the corrupt-reflog
 * question identically. A genuinely empty stack is still an empty array — the
 * before/after difference needs that to detect the *first* entry a repo ever
 * gets — while `unreadable` returns `undefined`, which is not "nothing was
 * there" and must never be read as one.
 *
 * Exported because it is this module's answer to the same question
 * `pendingRecovery.stashShas` answers, and the two used to disagree. A test
 * asserts they agree on a corrupted reflog; keeping the comparison reachable is
 * what makes that assertion possible without reaching into a private.
 */
export async function stashShasForComparison(cwd: string): Promise<string[] | undefined> {
  const read = await readStashList(cwd);
  return read.state === "unreadable" ? undefined : read.state === "listed" ? read.shas : [];
}

/** Where a sha sits in the stash list, or why that could not be decided. */
type StashLocation =
  | { state: "at"; index: number }
  | { state: "gone" }
  | { state: "unreadable"; reason: string };

/**
 * The `stash@{n}` index whose commit matches `sha`.
 *
 * This is the third reader of the stash list and it used to have its own copy of
 * the logic, which meant a corrupted reflog produced "the stash is gone" here
 * while `pendingRecovery.stashShas` produced "unreadable" for the same bytes.
 * That mattered more than the naming suggests: every caller turns "gone" into a
 * report that the only copy of the user's work no longer exists. It now goes
 * through the same `readStashList` predicate as the other two.
 */
async function stashIndexBySha(cwd: string, sha: string): Promise<StashLocation> {
  const read = await readStashList(cwd);
  if (read.state === "unreadable") {
    return { state: "unreadable", reason: read.reason };
  }
  const index = read.state === "empty" ? -1 : read.shas.indexOf(sha);
  return index >= 0 ? { state: "at", index } : { state: "gone" };
}

/**
 * The refusal every restore path owes the user when the list cannot be read.
 *
 * "Could not look" is not "not there": reporting `gone` here would tell the
 * caller the stash — and with it the only copy of the content — has disappeared.
 */
function unreadableStash(): StashRestoreResult {
  return {
    ok: false,
    gone: false,
    message: "无法读取 stash 列表，无法确认该条目是否存在；未做任何写入",
  };
}

/**
 * Lists the paths changed between two trees, with renames split into their
 * delete and add halves. `--no-renames` is mandatory: without it `--name-only`
 * collapses a rename to its destination only, so restoring the old path would
 * be skipped and the index would keep a stale entry.
 *
 * `-z` is equally mandatory. With `core.quotePath` at its default (`true`, i.e.
 * unset) a non-ASCII path is printed as a quoted, octal-escaped string that
 * `cat-file`/`rev-parse` cannot resolve, so every such path silently failed both
 * "already present" probes below, was dropped from the restore, and the function
 * still returned `ok: true`. The caller then amended and continued, reporting a
 * successful append of a file that never entered the commit. `-z` emits the raw
 * bytes and NUL-terminates each record, so a leading or trailing space survives
 * as well (trimming would delete it).
 */
async function diffNames(cwd: string, from: string, to: string): Promise<string[]> {
  const res = await runGit(
    withPositionals(["diff", "--name-only", "-z", "--no-renames"], [from, to]),
    { cwd }
  );
  return splitNul(res.stdout);
}

/** True when `rev:path` resolves to a blob in that tree. */
async function pathInTree(cwd: string, rev: string, path: string): Promise<boolean> {
  return (
    await runGit(withPositionals(["cat-file", "-e"], [`${rev}:${path}`]), { cwd })
  ).code === 0;
}

/** True when the path exists in the current index. */
async function pathInIndex(cwd: string, path: string): Promise<boolean> {
  return (
    await runGit(withPositionals(["cat-file", "-e"], [`:${path}`]), { cwd })
  ).code === 0;
}

/** Restores the index half of a snapshot: exactly the staged delta `^1..^2`. */
async function restoreStagedHalf(cwd: string, sha: string): Promise<string | undefined> {
  // A staged deletion is restored by *removing* the path from the index, and if
  // the edited target predates that path it is already absent — in which case
  // `git restore --source=<stash>^2 --staged -- <path>` has no pathspec to
  // resolve and fails with "pathspec did not match any file(s) known to git".
  // That combination is skipped because the desired state (absent from the
  // index) already holds; it is not a workaround for the restore, it is the
  // result of the restore being unnecessary.
  const stagedPaths = await diffNames(cwd, `${sha}^1`, `${sha}^2`);
  const toRestore: string[] = [];
  for (const path of stagedPaths) {
    if ((await pathInTree(cwd, `${sha}^2`, path)) || (await pathInIndex(cwd, path))) {
      toRestore.push(path);
    }
  }
  if (toRestore.length === 0) {
    return undefined;
  }
  const res = await runGit(
    ["restore", `--source=${sha}^2`, "--staged", "--", ...toRestore],
    { cwd, env: LITERAL_PATHSPECS }
  );
  return res.code === 0 ? undefined : `恢复暂存区失败：${(res.stderr || res.stdout).trim()}`;
}

/** Restores the untracked half of a snapshot from the `^3` tree. */
async function restoreUntrackedHalf(cwd: string, sha: string): Promise<string | undefined> {
  // Each file is checked out from `^3` and then unstaged, so it is restored as
  // untracked like it originally was. A path already present and untouched is
  // left alone rather than overwritten.
  if (
    (await runGit(withPositionals(["cat-file", "-e"], [`${sha}^3`]), { cwd })).code !== 0
  ) {
    return undefined;
  }
  // `-z` + NUL-split for the same reason as `diffNames`: an untracked file with
  // a non-ASCII name is otherwise dropped silently while the function still
  // reports success.
  const untrackedPaths = splitNul(
    (
      await runGit(
        withPositionals(["ls-tree", "-r", "-z", "--name-only"], [`${sha}^3`]),
        { cwd }
      )
    ).stdout
  );
  for (const path of untrackedPaths) {
    if ((await pathInIndex(cwd, path)) || (await pathInTree(cwd, "HEAD", path))) {
      // Tracked again (or already staged): not an untracked file any more.
      continue;
    }
    const res = await runGit(
      [...withPositionals(["checkout"], [`${sha}^3`]), "--", path],
      { cwd, env: LITERAL_PATHSPECS }
    );
    if (res.code !== 0) {
      return `恢复未跟踪文件 ${path} 失败：${(res.stderr || res.stdout).trim()}`;
    }
    // `checkout <tree> -- <path>` stages the file; unstage it so it lands as an
    // untracked file again, matching the pre-stash state.
    await runGit(["reset", "-q", "--", path], { cwd, env: LITERAL_PATHSPECS });
  }
  return undefined;
}

/**
 * Restores the worktree half of a snapshot: the full `^1..stash` diff, taken
 * from the snapshot's own tree so no later commit's path can be involved.
 */
async function restoreWorktreeHalf(cwd: string, sha: string): Promise<string | undefined> {
  // The absent-from-both rule: when the path is in neither the snapshot's
  // worktree tree nor the index, `restore --worktree` cannot resolve it and the
  // worktree state already matches the snapshot.
  const worktreePaths = await diffNames(cwd, `${sha}^1`, sha);
  const worktreeToRestore: string[] = [];
  for (const path of worktreePaths) {
    if ((await pathInTree(cwd, sha, path)) || (await pathInIndex(cwd, path))) {
      worktreeToRestore.push(path);
    }
  }
  if (worktreeToRestore.length === 0) {
    return undefined;
  }
  const res = await runGit(
    ["restore", `--source=${sha}`, "--worktree", "--", ...worktreeToRestore],
    { cwd, env: LITERAL_PATHSPECS }
  );
  return res.code === 0 ? undefined : `恢复工作区失败：${(res.stderr || res.stdout).trim()}`;
}

/** What one phase of a snapshot restore touched. */
export interface StashRestoreResult {
  ok: boolean;
  gone: boolean;
  message: string;
}

/**
 * Restores only the index and untracked halves of a snapshot.
 *
 * The append transaction uses this split because of the order its two writes
 * must happen in: the index half has to be in place for `commit --amend` to
 * record it, but the worktree half must NOT be written until that amend
 * succeeds. A worktree-half path that a later commit introduced does not exist
 * in the edited target, so restoring it early leaves it on disk as an untracked
 * file — and `git rebase --abort` then refuses to run at all with
 * "untracked working tree files would be overwritten by reset". A rejected
 * amend (a `pre-commit` hook, say) therefore used to strand the transaction in
 * a state where the very Abort the banner recommended could not succeed.
 */
export async function stashRestoreForAmend(
  cwd: string,
  sha: string
): Promise<StashRestoreResult> {
  const located = await stashIndexBySha(cwd, sha);
  if (located.state === "unreadable") {
    return unreadableStash();
  }
  if (located.state === "gone") {
    return { ok: false, gone: true, message: "stash no longer present" };
  }
  const stagedError = await restoreStagedHalf(cwd, sha);
  if (stagedError) {
    return { ok: false, gone: false, message: stagedError };
  }
  const untrackedError = await restoreUntrackedHalf(cwd, sha);
  if (untrackedError) {
    return { ok: false, gone: false, message: untrackedError };
  }
  return { ok: true, gone: false, message: "" };
}

/**
 * Restores the remaining worktree half of a snapshot, after the amend landed.
 *
 * This is the second phase of `stashRestoreForAmend`. It is a separate call so
 * the append transaction can amend in between, which keeps a failed amend from
 * leaving untracked files behind that block `git rebase --abort`.
 */
export async function stashRestoreWorktreeAfterAmend(
  cwd: string,
  sha: string
): Promise<StashRestoreResult> {
  const located = await stashIndexBySha(cwd, sha);
  if (located.state === "unreadable") {
    return unreadableStash();
  }
  if (located.state === "gone") {
    // The stash is the only copy of the worktree half: without it there is
    // nothing to restore, and reporting success would hide that.
    return { ok: false, gone: true, message: "stash no longer present" };
  }
  const error = await restoreWorktreeHalf(cwd, sha);
  return error
    ? { ok: false, gone: false, message: error }
    : { ok: true, gone: false, message: "" };
}

/**
 * Restores a stash snapshot without dropping it, so the stash remains the
 * recovery copy.
 *
 * A stash commit holds three independent obligations, and each is restored from
 * its own tree. `git stash apply --index` cannot be used here: it merges the
 * worktree half into the current tree, so any path that a *later* commit
 * introduced (and the edited target predates) becomes a bogus
 * `CONFLICT (modify/delete)` and the whole restore aborts with
 * "Index was not unstashed." Restoring each obligation from its own tree only
 * ever touches the snapshot's own paths.
 *
 *   1. worktree half  - full `^1..stash` diff, restored from `stash`
 *   2. index half     - `^1..^2` diff, restored from `stash^2`
 *   3. untracked      - the `^3` tree, unstaged so the files stay untracked
 *
 * Two ordering constraints are load-bearing:
 *   - the worktree half runs BEFORE the index half. Applying a staged deletion
 *     first removes the path from the index, after which `restore --worktree`
 *     cannot resolve it ("pathspec did not match any file(s) known to git").
 *     Each half skips a path that is absent from both, so a path the index half
 *     legitimately removed is not an error.
 *   - `--no-renames` is passed to every `git diff` that enumerates paths (but
 *     not to `git restore`, which has no such option).
 */
export async function stashApplyIndexBySha(
  cwd: string,
  sha: string
): Promise<StashRestoreResult> {
  const located = await stashIndexBySha(cwd, sha);
  if (located.state === "unreadable") {
    return unreadableStash();
  }
  if (located.state === "gone") {
    return { ok: false, gone: true, message: "stash no longer present" };
  }
  const worktreeError = await restoreWorktreeHalf(cwd, sha);
  if (worktreeError) {
    return { ok: false, gone: false, message: worktreeError };
  }
  const stagedError = await restoreStagedHalf(cwd, sha);
  if (stagedError) {
    return { ok: false, gone: false, message: stagedError };
  }
  const untrackedError = await restoreUntrackedHalf(cwd, sha);
  if (untrackedError) {
    return { ok: false, gone: false, message: untrackedError };
  }
  return { ok: true, gone: false, message: "" };
}

/**
 * Returns the current stash list (newest first). Empty when no stashes exist.
 */
export async function stashList(cwd: string): Promise<StashEntry[]> {
  const res = await runGit(
    ["stash", "list", "--format=%gd%x1f%H%x1f%s"],
    { cwd }
  );
  if (res.code !== 0) {
    return [];
  }
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, sha, subject] = line.split("\x1f");
      return { name, sha, subject };
    });
}

/**
 * Removes exactly one stash entry, identified by the sha of the stash commit the
 * extension itself created. Returns a refusal instead of acting when the slot
 * that currently holds that sha cannot be confirmed.
 *
 * ## Why `drop` and not `pop`
 *
 * Autostash semantics are stash → rebase → pop, and `pop` is what removes the
 * entry. `pop` cannot be used here, and this is measured behaviour rather than
 * preference: an auto-stash is created with `--include-untracked`, so it carries
 * a `^3` tree. By the time recovery has written that content back, the untracked
 * file exists on disk, and `git stash pop` then fails with
 * `"… already exists, no checkout"` / `"could not restore untracked files from
 * stash"` **without removing the entry**. Applying first and popping afterwards
 * therefore always fails; popping first and applying afterwards would make every
 * retry of a conflicting recovery re-run a destructive write. So the content is
 * restored (idempotently, retryable) and the entry is removed by `drop` once its
 * content has been *positively verified* to be back. Removal is bookkeeping; the
 * bytes are already in the worktree, index or HEAD.
 *
 * ## Why the occupant check, on both sides of the drop
 *
 * `stash@{n}` is a position, not a name. Resolving the slot by sha and dropping
 * it in a second command races against a concurrent `git stash push`, which
 * shifts every later entry down one slot. A check *before* the drop narrows that
 * window but cannot close it: the push can still land between the check and the
 * drop, and the drop would then remove whatever occupies that slot now — the
 * user's entry.
 *
 * So the entry is also checked *after* the drop. `git stash drop` prints the sha
 * of the entry it removed (`Dropped stash@{0} (<sha>)`); if that sha is not
 * ours, the user's entry was just removed and is put back with `git stash store`
 * — which restores the commit and its reflog entry intact (measured), so the
 * loss is undone rather than merely reported.
 *
 * Both refusals are reported, never retried.
 *
 * ## The test seam
 *
 * The two windows above are sub-millisecond in practice and cannot be hit from a
 * test by pushing a stash and hoping. `hooks` therefore injects a callback into
 * exactly those two instants so the refusal and the restore can be exercised
 * deterministically. It is not a production knob: nothing in the extension passes
 * it, and with no hooks the sequence is precisely the four commands described.
 */
export interface StashRemoveHooks {
  /**
   * Runs after the list lookup and before the occupant read. A test that pushes a
   * stash here makes the occupant of the resolved slot someone else's entry,
   * which is the pre-drop refusal: nothing is dropped at all.
   */
  beforeOccupantCheck?: () => void | Promise<void>;
  /**
   * Runs after the occupant check passes and before `git stash drop`. A test that
   * pushes a stash here makes the drop itself land on the wrong entry, which is
   * the only way to exercise the restore path — the check before the drop has
   * already passed by then.
   */
  betweenCheckAndDrop?: () => void | Promise<void>;
}

/**
 * The result of one removal attempt.
 *
 * `kind` is the machine-readable outcome; `message` is for humans. Callers branch
 * on `kind`, never on the text — see the doc on `StashRemoval.kind` for the
 * mis-announcements that prose matching produced. `ok`/`gone` are retained
 * because every existing caller and test reads them.
 */
export interface StashRemoveResult {
  ok: boolean;
  gone: boolean;
  refused: boolean;
  kind: "removed" | "gone" | "refused" | "undo-restored" | "undo-unknown" | "ambiguous-refusal";
  /** The entry that was dropped and put back (or could not be), for `undo-*`. */
  victim?: string;
  /** True when our own entry was removed but the drop was not cross-checked. */
  uncrosschecked?: boolean;
  message: string;
}

export async function stashRemoveBySha(
  cwd: string,
  sha: string,
  hooks?: StashRemoveHooks
): Promise<StashRemoveResult> {
  // The same predicate every other reader uses. This function used to open with
  // its own `git stash list` and check only `code !== 0`, so a corrupted reflog
  // (empty output, `refs/stash` still alive) fell through to the "not listed"
  // branch below and returned `gone: true` — a recorded removal of an entry that
  // was still in the list. It was unreachable only because `removeOwnStash` gates
  // on `presence.listed !== true` first; reorder that gate and the extension
  // reports deleting its own entry while the entry is still there.
  const read = await readStashList(cwd);
  if (read.state === "unreadable") {
    // "Could not read the list" is not "not present". Reporting `gone` here
    // would let a caller record a removal that never happened.
    return {
      ok: false,
      gone: false,
      refused: true,
      kind: "refused",
      message: `无法读取 stash 列表：${read.reason}`,
    };
  }
  const indices = (read.state === "empty" ? [] : read.shas)
    .map((listed, index) => (listed === sha ? index : -1))
    .filter((index) => index >= 0);
  if (indices.length === 0) {
    // Not listed any more: already popped, applied-and-dropped, or never ours.
    // Either way there is nothing here to remove.
    return { ok: false, gone: true, refused: false, kind: "gone", message: "stash no longer present" };
  }
  if (indices.length > 1) {
    // The same commit sits in more than one reflog slot. That happens when the
    // user runs `git stash store -m … <sha>` on an entry that is still listed: a
    // second slot then names the same commit, and only one of the two is the
    // entry this extension pushed. Dropping either one by slot would be a guess,
    // and half of the possible guesses removes the slot the user created. The
    // content is already verified to be back (this is the only caller), so
    // leaving both costs nothing but a line in the list.
    return {
      ok: false,
      gone: false,
      refused: true,
      kind: "refused",
      message: `${sha.slice(0, 7)} 在 stash 列表中出现了 ${indices.length} 次（${indices
        .map((index) => `stash@{${index}}`)
        .join("、")}），无法确定哪一条才是本扩展创建的；已保留全部条目，未删除任何内容`,
    };
  }
  const idx = indices[0];
  const slot = `stash@{${idx}}`;
  await hooks?.beforeOccupantCheck?.();
  // Re-read the slot at the last possible moment: a `git stash push` between the
  // lookup above and the drop below moves this entry and puts someone else's in
  // its place.
  const occupant = await runGit(
    withPositionals(["rev-parse", "--verify", "--quiet"], [slot]),
    { cwd }
  );
  if (occupant.code !== 0 || occupant.stdout.trim() !== sha) {
    return {
      ok: false,
      gone: false,
      refused: true,
      kind: "refused",
      message: `${slot} no longer holds ${sha.slice(0, 7)}; refusing to remove it`,
    };
  }
  await hooks?.betweenCheckAndDrop?.();
  // Snapshot the list at the last instant before the drop. This is the witness
  // `undoWrongDrop` compares against: a `git stash push` that lands inside the
  // window below has already happened by now, so its entry is part of this
  // snapshot and its removal is visible as a difference.
  const witness = await stashShasForComparison(cwd);
  // `git stash drop` accepts only a stash reference, never a bare sha
  // (`error: '<sha>' is not a stash reference`), so the slot is the only handle.
  // `LC_ALL=C` is pinned because the output is echoed into user-facing messages
  // and (only as a fallback) parsed; the decision itself does not read it.
  const res = await runGit(["stash", "drop", slot], { cwd, env: C_LOCALE });
  if (res.code !== 0) {
    // `stash drop` exited non-zero, so nothing was removed. It is still a refusal
    // rather than a silent failure: the record stays and the caller reports why.
    return {
      ok: false,
      gone: false,
      refused: true,
      kind: "refused",
      message: (res.stderr || res.stdout).trim(),
    };
  }
  // The check above cannot close the race, only narrow it. Verify what was
  // actually dropped and undo a wrong one.
  return undoWrongDrop(cwd, sha, slot, `${res.stdout}\n${res.stderr}`, witness);
}

/**
 * Verifies that `git stash drop` removed the entry this extension meant to
 * remove, and puts the entry back when it did not.
 *
 * ## The message is not the authority
 *
 * Git prints `Dropped stash@{1} (f824287a…)`, but that sentence is a gettext
 * msgid: on a machine whose `LC_ALL` selects another catalog it is translated,
 * the regex misses, and the function used to answer `ok: true, gone: true` —
 * reporting our own entry as removed while the user's entry, which the drop had
 * actually taken, stayed deleted. The whole rollback collapsed into silence, in
 * exactly the situation it exists for.
 *
 * So the decision is made from identity — but "our sha is gone" is *not* the
 * whole answer. A concurrent `git stash drop` by the user of our entry makes our
 * sha vanish too, while our own drop takes someone else's; both vanish inside
 * the same window and `after` ends up missing both. `before` is a list, so a
 * drop removes at most one entry from it: anything *else* that disappeared did
 * so by some other hand, and it is the user's. The witness is therefore checked
 * in **both** directions, and `dropVerdict` below states the four shapes:
 *
 *   - ours absent, nothing foreign vanished → our entry only. Correct.
 *   - ours absent, one foreign sha vanished → a wrong drop *and* a concurrent
 *     drop of ours; restore the foreign entry, same as the ordinary misdrop.
 *   - one foreign sha vanished, ours listed → the ordinary wrong drop; restore.
 *   - more than one foreign sha vanished    → cannot name the victim; refuse.
 *
 * When the witness is unavailable (the pre-drop listing could not be read) but
 * our sha is demonstrably gone, nothing better can be said than `ok/gone`, so
 * that is returned — with a note in the message saying the drop was only
 * verified against our own entry and not cross-checked. Reporting a clean
 * removal whose side effects were never looked at is the failure mode this
 * whole function exists to prevent.
 *
 * `git stash store` restores a dropped entry intact — measured — but it is not
 * invisible: the entry is pushed back on *top of the stack* and its **reflog
 * subject** (`%gs`, what `git stash list` prints) is rewritten to
 * `git-rebase-visual restored <sha7>`. The stash commit's own subject (`%s`,
 * what `git log` shows) is untouched. The returned message says both, because
 * the user will look at `git stash list` next and needs to recognise their entry
 * there, and may then check `git log` and see the original title.
 *
 * @see dropVerdict for the decision itself
 */

/**
 * What a drop did, decided from identity alone.
 *
 * Pure and exported so the four shapes can be driven directly; `undoWrongDrop`
 * is the only production caller and adds the messages. `before` is `undefined`
 * when the pre-drop listing could not be read — that is "no witness", which is
 * not "nothing was there".
 */
export type DropVerdict =
  /** The post-drop listing could not be read; identity cannot be established. */
  | { kind: "unreadable" }
  /** Our sha is gone and nothing else vanished: the drop did exactly what it should. */
  | { kind: "ours-only" }
  /** Exactly one entry that is not ours vanished: it has to go back. */
  | { kind: "wrong"; dropped: string }
  /** Several entries that are not ours vanished: the victim cannot be named. */
  | { kind: "ambiguous"; foreign: string[] }
  /** Our sha is still listed and nothing else vanished: the drop did nothing. */
  | { kind: "ours-still-listed" }
  /** No pre-drop listing, so the drop was only verified against our own entry. */
  | { kind: "no-witness"; oursListed: boolean };

export function dropVerdict(
  before: string[] | undefined,
  after: string[] | undefined,
  sha: string
): DropVerdict {
  if (!after) {
    return { kind: "unreadable" };
  }
  const oursListed = after.includes(sha);
  if (!before) {
    return { kind: "no-witness", oursListed };
  }
  const afterSet = new Set(after);
  const vanished = before.filter((entry) => !afterSet.has(entry));
  // Only a sha that is not ours can be a wrong drop. A `before` that lists our
  // sha twice (a duplicate the caller now refuses) yields nothing here.
  const foreign = vanished.filter((entry) => entry !== sha);
  if (foreign.length > 1) {
    return { kind: "ambiguous", foreign };
  }
  if (foreign.length === 1) {
    return { kind: "wrong", dropped: foreign[0] };
  }
  return oursListed ? { kind: "ours-still-listed" } : { kind: "ours-only" };
}

/** Git's `Dropped stash@{n} (<sha>)`, the only prose that ever names the victim. */
function reportedDrop(dropOutput: string): string | undefined {
  return /Dropped\s+(?:refs\/)?stash@\{\d+\}\s+\(([0-9a-f]{40,64})\)/i.exec(dropOutput)?.[1];
}

export async function undoWrongDrop(
  cwd: string,
  sha: string,
  slot: string,
  dropOutput: string,
  before?: string[]
): Promise<StashRemoveResult> {
  const after = await stashShasForComparison(cwd);
  const verdict = dropVerdict(before, after, sha);
  let dropped: string | undefined;
  /** Set when our entry was removed but the drop could not be cross-checked. */
  let uncrosschecked = false;

  switch (verdict.kind) {
    case "ours-only":
      return { ok: true, gone: true, refused: false, kind: "removed", message: "" };
    case "wrong":
      dropped = verdict.dropped;
      break;
    case "ambiguous":
      // No entry is restored here, and no victim can be named. `kind` says that
      // explicitly so no announcement can turn this into "已原样恢复".
      return {
        ok: false,
        gone: false,
        refused: true,
        kind: "ambiguous-refusal",
        message: `删除 ${slot} 时列表中有 ${verdict.foreign.length} 个其他条目同时消失（${verdict.foreign
          .map((entry) => entry.slice(0, 7))
          .join("、")}），无法确定删除的是哪一条；未尝试恢复，可用 git stash store <sha> 逐个恢复`,
      };
    case "ours-still-listed": {
      // Our entry is still listed and nothing else is demonstrably missing: the
      // drop did not do what it was asked. Git's own text is the only remaining
      // hint; it is consulted, never trusted.
      const reported = reportedDrop(dropOutput);
      if (!reported) {
        return {
          ok: false,
          gone: false,
          refused: true,
          kind: "refused",
          message: `已执行 git stash drop ${slot}，但 ${sha.slice(0, 7)} 仍在 stash 列表中，无法确认删除了哪一条；未删除任何其他内容`,
        };
      }
      if (reported === sha) {
        // The message names our sha while the listing still contains it: a
        // concurrent `git stash store` of the same commit put it back. Nothing
        // was lost, and the entry is listed, so the honest answer is "still
        // there".
        return {
          ok: false,
          gone: false,
          refused: true,
          kind: "refused",
          message: `${sha.slice(0, 7)} 被删除后又被重新加入列表（例如并发的 git stash store），条目仍在，未丢失内容`,
        };
      }
      dropped = reported;
      break;
    }
    case "no-witness": {
      if (!verdict.oursListed) {
        // Our entry is gone, but `before` was unreadable, so a *second* entry
        // may have gone with it and nothing here can see that. Git's message is
        // the only remaining lead: if it names a different sha, that entry was
        // dropped and has to go back.
        const reported = reportedDrop(dropOutput);
        if (!reported || reported === sha) {
          return {
            ok: true,
            gone: true,
            refused: false,
            kind: "removed",
            // Kept on the result, not only in this sentence: the caller fills its
            // own message from the structured fields, so a caveat that lives only
            // in `message` would be discarded before the user ever sees it.
            uncrosschecked: true,
            message:
              `${sha.slice(0, 7)} 已从 stash 列表消失，但删除前的列表未能读取，` +
              `无法交叉核对是否有其他条目在同一次删除中一起消失；` +
              `该条目本身已确认不在列表中，如需核对可执行 git stash list`,
          };
        }
        dropped = reported;
        uncrosschecked = true;
        break;
      }
      const reported = reportedDrop(dropOutput);
      if (!reported) {
        return {
          ok: false,
          gone: false,
          refused: true,
          kind: "refused",
          message: `已执行 git stash drop ${slot}，但 ${sha.slice(0, 7)} 仍在 stash 列表中，无法确认删除了哪一条；未删除任何其他内容`,
        };
      }
      if (reported === sha) {
        return {
          ok: false,
          gone: false,
          refused: true,
          kind: "refused",
          message: `${sha.slice(0, 7)} 被删除后又被重新加入列表（例如并发的 git stash store），条目仍在，未丢失内容`,
        };
      }
      dropped = reported;
      uncrosschecked = true;
      break;
    }
    case "unreadable": {
      // The listing itself failed, so identity cannot be established. Fall back
      // to the message, and if that is unparseable too, refuse rather than claim
      // a clean removal: "cannot verify" is never "correct".
      const reported = reportedDrop(dropOutput);
      if (!reported) {
        return {
          ok: false,
          gone: false,
          refused: true,
          kind: "refused",
          message: `已执行 git stash drop ${slot}，但无法重新读取 stash 列表，无法确认删除的是 ${sha.slice(0, 7)}；未删除任何其他内容`,
        };
      }
      if (reported === sha) {
        return { ok: true, gone: true, refused: false, kind: "removed", message: "" };
      }
      dropped = reported;
      uncrosschecked = true;
      break;
    }
  }

  // Deliberately NO `--end-of-options` here: unlike every other command in this
  // file, `git stash store` implements its own argument parsing and rejects the
  // marker outright (`"git stash store" requires one <commit> argument`, exit 1,
  // measured on 2.53.0.windows.2). The marker cannot be added "for consistency"
  // — it breaks the undo restore. What protects this call instead is `dropped`:
  // a full 40-hex sha parsed out of `git stash list --format=%H`, never a ref
  // name and never user text.
  const restored = await runGit(
    ["stash", "store", "-m", `git-rebase-visual restored ${dropped.slice(0, 7)}`, dropped],
    { cwd }
  );
  // `stash store` is not invisible, and "说明文字" was not precise enough to act
  // on: it rewrites the *reflog* subject (`%gs`, the line `git stash list`
  // prints) and leaves the stash commit's own subject (`%s`, the title `git log`
  // shows) alone. A user who checks with `git log` sees their original message
  // and might conclude the store created something new; one who checks
  // `git stash list` sees the replacement subject and might conclude the entry
  // was lost. Naming both is the only way the message is true for either reader.
  const placement =
    `注意：该条目现在位于列表最上方，` +
    `它的 reflog 说明（git stash list 显示的 %gs）会变成 \`git-rebase-visual restored ${dropped.slice(0, 7)}\`，` +
    `而该 stash commit 的标题（%s，git log 里看到的那一行）保持不变；` +
    `内容与原来完全相同（commit ${dropped.slice(0, 7)}）`;
  const caveat = uncrosschecked
    ? "（删除前的列表未能读取，本次仅按 Git 的输出确认了被删除的条目，未做前后交叉核对）"
    : "";
  return {
    ok: false,
    gone: false,
    refused: true,
    kind: restored.code === 0 ? "undo-restored" : "undo-unknown",
    victim: dropped,
    uncrosschecked,
    message:
      restored.code === 0
        ? `${slot} 在删除瞬间已变成 ${dropped.slice(0, 7)}（不是本扩展的条目）；已用 git stash store 原样恢复该条目，未丢失任何内容。${placement}${caveat}`
        : `删除瞬间 ${slot} 已是 ${dropped.slice(0, 7)}，已尝试恢复但失败：${(restored.stderr || restored.stdout).trim()}；该 commit ${dropped} 仍可通过 git stash store 恢复`,
  };
}

/**
 * Pops the most recent stash (stash@{0}). Reports empty when none exist.
 *
 * Reachable solely from the explicit "Pop Stash" command the user invokes. No
 * automatic path may call it: a `pop` both writes and deletes, so a conflict
 * consumes the entry it failed to apply. Recovery removes the extension's *own*
 * entries through `stashRemoveBySha`, after verifying their content is back.
 */
export async function stashPopManual(
  cwd: string
): Promise<{ ok: boolean; empty: boolean; message: string }> {
  const list = await runGit(["stash", "list"], { cwd });
  if (!list.stdout.trim()) {
    return { ok: false, empty: true, message: "" };
  }
  const res = await runGit(["stash", "pop"], { cwd });
  return { ok: res.code === 0, empty: false, message: (res.stderr || res.stdout).trim() };
}

/**
 * Creates a commit from the current index with the given message. Uses -s so a
 * Signed-off-by trailer is added (matching a normal `git commit -s`); the
 * repo's commit-msg hook still appends Change-Id as usual.
 */
export async function commitIndex(cwd: string, message: string): Promise<void> {
  await git(["commit", "-s", "-m", message], { cwd });
}

/** Stages all changes then commits with the given message (signed off). */
export async function commitAll(cwd: string, message: string): Promise<void> {
  await git(["add", "-A"], { cwd });
  await git(["commit", "-s", "-m", message], { cwd });
}
