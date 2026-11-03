import * as fs from "fs";
import * as pathModule from "path";
import { LITERAL_PATHSPECS, runGit, splitNul } from "./gitRunner";
import { isRebaseInProgress } from "./commitLog";
import { readStashList, stashRemoveBySha, type StashRemoveResult } from "./worktree";

/**
 * # The guarantee
 *
 * **This module removes only stash entries the extension itself created, and
 * only after their content is provably back. It never touches an entry it did
 * not create.**
 *
 * The rule has two halves and they answer different questions.
 *
 * *Restoring* the content is apply-only (`git stash apply`, never `git stash
 * pop`). `pop` both writes and deletes, so a conflicting pop consumes the copy
 * it failed to apply. Every restore step is retryable and idempotent because of
 * this.
 *
 * *Removing* the extension's own entry is a separate, later step, and it is
 * bookkeeping rather than recovery: once the content is positively confirmed in
 * the worktree, index or `HEAD`, the entry is a duplicate and leaving it behind
 * is a defect. It strands the user — a bare `git stash pop` hits our `-u` entry
 * first and fails with "could not restore untracked files from stash", so their
 * own stash becomes hard to pop. Autostash means stash → rebase → pop; a pop
 * removes the entry. Removing it is what `pop` would have done.
 *
 * The removal is gated three times over. `stashRemoveBySha` re-resolves the slot
 * from the sha immediately before acting and refuses if the slot no longer holds
 * that exact sha (a concurrent `git stash push` must never make this remove the
 * user's entry); it only ever runs on an outcome whose presence probes all
 * succeeded positively; and a non-zero exit keeps everything and reports. A
 * record may be cleared only after its content has been *positively confirmed*
 * present, so a failed probe leaves the record, the banner and the stash intact.
 *
 * A user's own stash can never reach the removal path: only shas this extension
 * generated and persisted — `pendingStash` and the append record's
 * `changeStash`/`unstagedStash` — are ever passed to it.
 *
 * Deleting a stash that holds unverified content is a user action;
 * `recoveryCommands` gives the exact command for each step so the banner can
 * offer it verbatim.
 */

/**
 * A persisted append transaction. It is bookkeeping only: the stash commits are
 * the authority on whether user content still exists.
 */
export interface PendingAppendRecord {
  /** Full pre-append snapshot, including the original index and worktree. */
  changeStash: string;
  /** Recovery copy for worktree-only changes left after the amend. */
  unstagedStash?: string;
  /** Original target SHA; distinguishes an external abort from a completed replay. */
  targetHash?: string;
  /**
   * True only after the staged snapshot has been committed into the edited
   * target. Old persisted records default to false, the conservative choice.
   */
  amended?: boolean;
}

/**
 * Whether one part of a stash snapshot is visible in the repository again.
 * `unknown` is a first-class value: a probe that failed must never be read as
 * evidence that content is back, because "absent evidence" is exactly what
 * would authorise clearing the persisted record.
 */
export type PresencePart = "present" | "missing" | "unknown";

export interface StashPresence {
  /**
   * Still reachable through `git stash list`. Undefined when the list itself
   * failed: a broken stash reflog must not be mistaken for "stash is gone".
   */
  listed: boolean | undefined;
  /** The staged snapshot is reproduced by the current index. */
  index: PresencePart;
  /**
   * How many paths the snapshot's staged half (`^1..^2`) contains. Needed in
   * addition to `index` because `index: "present"` is also reported for a
   * snapshot that simply has *no* staged half (zero paths): there,
   * `git stash apply --index` has nothing to merge and succeeds normally. Only
   * a *non-empty* staged half that is already in the index makes `--index` fail
   * with "already exists in index".
   */
  indexPaths: number;
  /** The worktree snapshot is reproduced by the current worktree. */
  worktree: PresencePart;
  /**
   * The worktree-*only* part of the snapshot (`stash^2..stash`) is reproduced by
   * the current worktree. Probed separately from `worktree` because an append
   * commits the staged half: afterwards the combined worktree probe can fail
   * merely because a later commit rewrote the staged path, while this part is
   * what still has to be restored.
   */
  unstaged: PresencePart;
  /** Untracked files from `stash^3` are back on disk with identical content. */
  untracked: PresencePart;
  /**
   * All changed content is visible in the worktree and every probe succeeded.
   * The index may still differ (a plain `git stash apply`), so re-applying would
   * conflict: treat it as restored and skip the apply. This is the signal for
   * "no re-apply is needed", never for authorising a removal — the index half
   * is not covered by it, so an entry whose staged split is not reproduced would
   * still be the only record of that split.
   */
  contentPresent: boolean;
  /** Every part, including index placement, was positively verified. */
  complete: boolean;
  /** Human-readable probe failure, surfaced in the warning when there is one. */
  probeError?: string;
}

/**
 * What happened when a settled recovery tried to remove the extension's own
 * stash entry.
 *
 * Present on `resolved`/`restored` only. `kept` means the entry is still listed
 * and the user has to be told why; it never means content was lost — a removal
 * only ever runs after the content was positively confirmed back.
 */
export interface StashRemoval {
  /** `removed`: the extension's entry is gone. `kept`: it is still listed. */
  status: "removed" | "kept";
  /**
   * What shape the attempt took. This exists because the announcer used to
   * decide by searching the user-facing `message` for `"git stash store"`, which
   * is prose matching one layer above the rules this module enforces — and it
   * mis-classified both ways: the `ambiguous` refusal ends with the words
   * `可用 git stash store <sha> 逐个恢复` (so a refusal that restored *nothing*
   * was announced as "已原样恢复"), while an unreadable post-drop list contains
   * no such substring (so it fell into the leftover branch and offered
   * `git stash drop stash@{0}`, naming a slot whose occupant was unknown).
   *
   * A machine-readable field cannot be got wrong by rewording a message, and it
   * is what the announcement branches on.
   *
   *   - `removed`         — ours is gone. The expected, silent shape.
   *   - `leftover`        — ours is still listed; it is the one to clean up.
   *   - `undo-restored`   — another entry was dropped and has been put back.
   *   - `undo-unknown`    — another entry was dropped and could not be put back;
   *                         `victim`/`message` say which and why.
   *   - `ambiguous-refusal` — several entries vanished / the sha is duplicated;
   *                         nothing was restored and no victim can be named.
   */
  kind: "removed" | "leftover" | "undo-restored" | "undo-unknown" | "ambiguous-refusal";
  /** Sha of the entry this removal was about. */
  sha: string;
  /**
   * Human slot name, resolved *before* the attempt. After a successful removal
   * every later slot has shifted, so this is the only moment the name is
   * meaningful; keeping it lets the message name the entry that was removed
   * without re-resolving a slot that now belongs to someone else.
   */
  name?: string;
  /** The entry that was dropped and restored (or could not be), if any. */
  victim?: string;
  /**
   * True when the entry is confirmed removed but the drop could not be
   * cross-checked against a pre-drop listing. Set on `status: "removed"`
   * results; it is the caveat that used to exist only inside the Git module's
   * message string and was dropped before the user could see it.
   */
  uncrosschecked?: boolean;
  /** Why it is still listed, or what the undo could not finish. */
  message?: string;
}

/**
 * The invariant this module guarantees: **no outcome removes an entry this
 * extension did not create.**
 *
 * `resolved` and `restored` mean "the record may be cleared because its content
 * was positively confirmed present in the worktree, index or HEAD". On the way
 * out, the extension's own entries are removed and each result reported in
 * `stashRemoved`; a `kept` removal leaves that entry, is reported to the user,
 * and is never retried destructively. An entry belonging to the user is never
 * passed to the removal path at all.
 *
 * `stashRemoved` is a list because one append transaction can own two entries
 * (`changeStash` and `unstagedStash`) and both have to be accounted for — a
 * single slot would let one removal silently stand in for the other.
 */
export type PendingReconcile =
  | { kind: "none" }
  /** The record is moot or its content is already back; clear it silently. */
  | { kind: "resolved"; detail: string; stashRemoved?: StashRemoval[] }
  /** This pass restored the content; clear the record and report success. */
  | { kind: "restored"; detail: string; stashRemoved?: StashRemoval[] }
  /** Content is still only in a stash, or could not be verified; keep and warn. */
  | {
      kind: "pending";
      reason: string;
      stashSha: string;
      detail: string;
      /**
       * The probe the decision was based on. It lets the banner build commands
       * that can actually run against the state the user is looking at, instead
       * of a fixed list whose first entry may be guaranteed to fail.
       */
      presence?: StashPresence;
    };

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Every stash sha currently listed, newest first, or undefined when the listing
 * cannot be trusted. The distinction matters: a corrupted `refs/stash` reflog
 * makes `git stash list` print nothing, and treating that as "the stash is gone"
 * silently discards the only record of uncommitted work.
 *
 * The decision lives in `worktree.readStashList` and is shared with that
 * module's before/after comparison, which had drifted to the opposite answer for
 * the corrupt shape. A genuinely empty stack still returns `[]` here: callers
 * need to tell "no stashes at all" from "could not read".
 */
export async function stashShas(cwd: string): Promise<string[] | undefined> {
  const read = await readStashList(cwd);
  return read.state === "unreadable" ? undefined : read.state === "listed" ? read.shas : [];
}

/**
 * Current `stash@{n}` name for a stash sha, or undefined when it is gone — and
 * also undefined when the sha is *ambiguous*.
 *
 * `git stash store -m … <sha>` on an entry that is still listed creates a second
 * slot naming the same commit. Taking the first match then returns a slot number
 * that may belong to the user's copy rather than to the entry the extension
 * pushed, and everything downstream is slot-addressed. The callers already treat
 * `undefined` as "the slot cannot be resolved": the banner's apply steps fall
 * back to the bare sha, which Git accepts and no concurrent push can invalidate,
 * and the `git stash drop` step is withheld because Git has no sha-addressed
 * drop. That is exactly the right answer for an ambiguous entry, so it is
 * returned instead of a guess.
 */
export async function stashNameForSha(cwd: string, sha: string): Promise<string | undefined> {
  const list = await runGit(["stash", "list", "--format=%gd%x1f%H"], { cwd });
  if (list.code !== 0) {
    return undefined;
  }
  const matches = list.stdout
    .split("\n")
    .map((line) => line.split("\x1f"))
    .filter(([, hash]) => hash?.trim() === sha);
  if (matches.length !== 1) {
    return undefined;
  }
  return matches[0][0]?.trim() || undefined;
}

interface PathsProbe {
  paths: string[];
  ok: boolean;
  error?: string;
}

/**
 * Paths changed between two revisions, NUL-split so spaces survive.
 *
 * `--no-renames` is mandatory and `worktree.ts`'s `diffNames` sets it for the
 * same reason: with rename detection on, `--name-only` reports a rename as its
 * *destination only*, so a snapshot that staged `a.txt → b.txt` lists one path
 * instead of two. Every probe built on this list then asks about `b.txt` alone
 * and never about the deletion of `a.txt`, which is half the staged change. A
 * user who restored only the destination produced `index: "present"`,
 * `complete: true`, and the entry was deleted while the staged deletion had not
 * returned to the index — a false positive on the one signal that authorises
 * removal. `stagedSnapshotInHead` had the same blind spot and reported
 * `committed: true` for a HEAD that still had `a.txt`.
 *
 * `-z` is mandatory for the same reason as in `worktree.ts`: without it a
 * non-ASCII path arrives quoted and octal-escaped, and matches nothing.
 */
async function changedPaths(cwd: string, from: string, to: string): Promise<PathsProbe> {
  const res = await runGit(["diff", "--name-only", "-z", "--no-renames", from, to], { cwd });
  if (res.code !== 0) {
    return { paths: [], ok: false, error: nonEmpty(res.stderr) ?? `git diff exit ${res.code}` };
  }
  // No `trim()`: a path may legally begin or end with a space (` lead.txt`), and
  // trimming it produced a path that matches nothing — the restore then skipped
  // the file while every probe still reported success.
  return { paths: splitNul(res.stdout), ok: true };
}

type UntrackedProbe =
  | { kind: "absent" }
  | { kind: "entries"; blobs: Map<string, string> }
  | { kind: "error"; detail: string };

/**
 * Number of parents of a stash commit. A plain stash has two (`^1` worktree
 * base, `^2` index); `git stash push -u` adds `^3` for untracked files. The
 * parent count is read from the commit object itself, so it stays correct even
 * when the `^3` tree has been deleted (the commit still lists three parents).
 */
async function parentCount(cwd: string, sha: string): Promise<number | undefined> {
  const res = await runGit(["rev-list", "--parents", "-n", "1", sha], { cwd });
  if (res.code !== 0) {
    return undefined;
  }
  const fields = res.stdout.trim().split(/\s+/).filter(Boolean);
  return fields.length === 0 ? undefined : fields.length - 1;
}

/**
 * Untracked-file snapshot (`stash^3`). Only a stash with three parents has one,
 * so `absent` means "there is nothing to verify" and is safe. A stash that
 * *does* have a third parent but whose tree cannot be read was corrupted:
 * reporting "nothing to verify" there would authorise dropping the only copy,
 * so that is a probe error.
 */
async function treeBlobs(cwd: string, sha: string): Promise<UntrackedProbe> {
  const parents = await parentCount(cwd, sha);
  if (parents === undefined) {
    return { kind: "error", detail: `无法读取 stash ${sha.slice(0, 7)} 的 commit 对象` };
  }
  if (parents < 3) {
    return { kind: "absent" };
  }
  const res = await runGit(["ls-tree", "-r", "-z", `${sha}^3`], { cwd });
  if (res.code !== 0) {
    return {
      kind: "error",
      detail: `stash ${sha.slice(0, 7)} 的未跟踪快照（stash^3）无法读取：${nonEmpty(res.stderr) ?? `exit ${res.code}`}`,
    };
  }
  const blobs = new Map<string, string>();
  for (const entry of res.stdout.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    // `ls-tree` prints `<mode> SP <type> SP <object>`: the object id is the
    // *third* field. Reading the second stores the literal string "blob" as the
    // id, so every untracked comparison fails and files that are present on disk
    // are reported `missing`.
    const [, , blob] = entry.slice(0, tab).split(" ");
    blobs.set(entry.slice(tab + 1), blob);
  }
  return { kind: "entries", blobs };
}

/** Hashes a worktree path exactly as Git would store it. */
async function worktreeBlob(cwd: string, filePath: string): Promise<string | undefined> {
  const res = await runGit(["hash-object", `--path=${filePath}`, "--", filePath], {
    cwd,
    env: LITERAL_PATHSPECS,
  });
  return res.code === 0 ? nonEmpty(res.stdout) : undefined;
}

/** Blob id at `path` inside `rev`, or undefined when the path is not there. */
async function revBlob(cwd: string, rev: string, filePath: string): Promise<string | undefined> {
  const res = await runGit(["rev-parse", "--verify", "--quiet", `${rev}:${filePath}`], { cwd });
  return res.code === 0 ? nonEmpty(res.stdout) : undefined;
}

/** Result of putting back the parts of a snapshot a commit cannot contain. */
interface ResidualRestore {
  ok: boolean;
  /** Paths this call actually wrote back. */
  restored: string[];
  /** Paths holding newer content; the record must be kept for these. */
  conflicts: string[];
  error?: string;
}

/** Whether a worktree path exists as a regular file. */
function worktreePathExists(cwd: string, filePath: string): boolean {
  try {
    return fs.existsSync(pathModule.join(cwd, filePath));
  } catch {
    return true;
  }
}

/**
 * Puts back the parts of a snapshot that an amended commit cannot contain:
 * untracked files (`stash^3`) and worktree-only tracked edits (`stash^2..stash`).
 *
 * Only paths that provably hold the snapshot's content, or that are absent, are
 * written. A path holding anything else is reported as a conflict instead, so
 * newer user work is never overwritten — the caller keeps the record and warns.
 * The comparison is against the snapshot itself, not against `HEAD`: once the
 * user has committed newer content the worktree equals `HEAD` again, so a
 * HEAD-relative check would call the path clean and overwrite it.
 */
async function restoreResidualSnapshot(cwd: string, sha: string): Promise<ResidualRestore> {
  const restored: string[] = [];
  const conflicts: string[] = [];

  const untracked = await treeBlobs(cwd, sha);
  if (untracked.kind === "error") {
    return { ok: false, restored, conflicts, error: untracked.detail };
  }
  const untrackedPaths: string[] = [];
  if (untracked.kind === "entries") {
    for (const [filePath, blob] of untracked.blobs) {
      const current = await worktreeBlob(cwd, filePath);
      if (current === blob) {
        continue;
      }
      if (worktreePathExists(cwd, filePath)) {
        // Something else now occupies the path; do not overwrite it.
        conflicts.push(filePath);
        continue;
      }
      untrackedPaths.push(filePath);
    }
  }

  const unstaged = await changedPaths(cwd, `${sha}^2`, sha);
  if (!unstaged.ok) {
    return { ok: false, restored, conflicts, error: unstaged.error };
  }
  const unstagedPaths: string[] = [];
  for (const filePath of unstaged.paths) {
    const exists = worktreePathExists(cwd, filePath);
    const snapshotBlob = await revBlob(cwd, sha, filePath);
    const current = exists ? await worktreeBlob(cwd, filePath) : undefined;
    if (exists === (snapshotBlob !== undefined) && current === snapshotBlob) {
      continue;
    }
    // A keep-index stash is pushed *after* `commit --amend`, so `stash^2` is the
    // exact tree that amend committed. `rebase --continue` then leaves every
    // path that commit owns at precisely that content, so a worktree blob equal
    // to `stash^2:path` means the path holds the transaction's own committed
    // bytes rather than something the user typed since: putting the snapshot's
    // worktree version back is exactly what the user needs.
    //
    // This is byte equality with the committed tree, not proof that nobody ever
    // wrote to the path. The 0.8.0 advice (`git stash apply --index <name>`)
    // could itself leave the worktree holding those same bytes, so a user who
    // followed it and then came back here may have the snapshot reinstated over
    // identical content. That is recoverable and never destructive: the bytes
    // being overwritten are the ones the amended commit still holds, so
    // `git checkout <amended> -- <path>` restores them.
    //
    // Before this, such a path fell through to the "carries newer edits" branch
    // and was reported as a conflict. The user was then told to run
    // `git stash apply --index`, which re-runs this comparison and produces the
    // same false conflict — a loop with no exit. The check is on Git state (not
    // the persisted `amended` flag) and only ever writes when the current blob
    // is the transaction's own committed blob, so newer user content — anything
    // that differs from `stash^2` — is still refused below.
    //
    // A snapshot *deletion* is deliberately excluded: restoring it would remove
    // a file as a side effect, which stays a conflict.
    if (snapshotBlob !== undefined && exists && current !== undefined) {
      const committedBlob = await revBlob(cwd, `${sha}^2`, filePath);
      if (committedBlob !== undefined && current === committedBlob) {
        unstagedPaths.push(filePath);
        continue;
      }
    }
    // "Untouched" must be measured against the snapshot, never against HEAD:
    // once the user commits newer content, worktree == HEAD again and a
    // HEAD-relative check calls the path clean, overwrites that newer committed
    // content with the stale snapshot, and drops the recovery copy. The snapshot
    // blob itself is the only write baseline — anything else at the path is a
    // conflict. (Two safe cases returned above: worktree == snapshot blob, and
    // worktree == `stash^2` with the snapshot having content; so a path is only
    // written below when it is absent and the snapshot has content.)
    if (!snapshotBlob || exists) {
      // Either the snapshot itself deleted the path (restoring would delete a
      // file as a side effect) or the path carries newer edits.
      conflicts.push(filePath);
      continue;
    }
    unstagedPaths.push(filePath);
  }

  if (conflicts.length > 0) {
    return { ok: false, restored, conflicts };
  }
  if (untrackedPaths.length > 0) {
    const res = await runGit(
      ["restore", `--source=${sha}^3`, "--worktree", "--", ...untrackedPaths],
      { cwd, env: LITERAL_PATHSPECS }
    );
    if (res.code !== 0) {
      return {
        ok: false,
        restored,
        conflicts,
        error: nonEmpty(res.stderr) ?? `git restore exit ${res.code}`,
      };
    }
    restored.push(...untrackedPaths);
  }
  if (unstagedPaths.length > 0) {
    const res = await runGit(
      ["restore", `--source=${sha}`, "--worktree", "--", ...unstagedPaths],
      { cwd, env: LITERAL_PATHSPECS }
    );
    if (res.code !== 0) {
      return {
        ok: false,
        restored,
        conflicts,
        error: nonEmpty(res.stderr) ?? `git restore exit ${res.code}`,
      };
    }
    restored.push(...unstagedPaths);
  }
  return { ok: true, restored, conflicts };
}

/**
 * Whether the parts of a snapshot that live only in the worktree are back.
 *
 * Audit note for the `worktree=missing unstaged=missing` shape seen in 0.8.0
 * logs: that signal is real, not a probe artefact. It was measured with real
 * Git — after `rebase --continue` the worktree no longer holds the snapshot's
 * unstaged bytes, so the probe reports `missing` and
 * `reconcilePendingAppend` restores through `restoreResidualSnapshot` before
 * reporting `restored`.
 *
 * Note what this probe does *not* tell you: it reports `missing` whether or not
 * the replayed commit owns the path, so it cannot be read as "the commit does
 * not have this content". What keeps that shape safe is the `stash^2`
 * committed-blob guard in `restoreResidualSnapshot`, not this comparison.
 * A later commit that rewrites the path instead conflicts during the rebase or
 * during the re-apply that follows it, so reconciliation is never reached for
 * that shape. No shape was found in which this signal alone yields a false
 * `pending` or a false `resolved`; the probes below only ever promote a part on
 * a successful positive comparison.
 */
function residualPresent(presence: StashPresence): boolean {
  return presence.untracked === "present" && presence.unstaged === "present";
}

/**
 * Compares a stash snapshot with the live index/worktree. This is the only
 * evidence used to decide that content is already restored: `stash apply` does
 * not drop the stash, so "still listed" never means "not restored".
 *
 * Every part starts as `unknown` and only a successful, positive probe may
 * promote it to `present` or `missing`. A probe failure leaves `unknown`, which
 * makes `complete` false and therefore keeps the persisted record.
 */
export async function stashPresence(cwd: string, sha: string): Promise<StashPresence> {
  const shas = await stashShas(cwd);
  const listed = shas === undefined ? undefined : shas.includes(sha);
  const parts = {
    index: "unknown" as PresencePart,
    worktree: "unknown" as PresencePart,
    unstaged: "unknown" as PresencePart,
    untracked: "unknown" as PresencePart,
  };
  let probeError: string | undefined;

  const staged = await changedPaths(cwd, `${sha}^1`, `${sha}^2`);
  const indexPaths = staged.ok ? staged.paths.length : 0;
  if (!staged.ok) {
    probeError = `无法读取暂存快照的变更路径：${staged.error}`;
  } else if (staged.paths.length === 0) {
    parts.index = "present";
  } else {
    const diff = await runGit(
      ["diff", "--cached", "--quiet", `${sha}^2`, "--", ...staged.paths],
      { cwd, env: LITERAL_PATHSPECS }
    );
    if (diff.code === 0) parts.index = "present";
    else if (diff.code === 1) parts.index = "missing";
    else {
      probeError = `索引比对失败：${nonEmpty(diff.stderr) ?? `exit ${diff.code}`}`;
    }
  }

  const worktreeChanges = await changedPaths(cwd, `${sha}^1`, sha);
  if (!worktreeChanges.ok) {
    probeError = `无法读取工作区快照的变更路径：${worktreeChanges.error}`;
  } else if (worktreeChanges.paths.length === 0) {
    // The snapshot's worktree tree equals its base. Any `^2..stash` difference
    // is then the *reversal* of a staged change (index has content the worktree
    // does not), not user work that still needs restoring: restoring the
    // `stash` side would write the base content that is already there. Probing
    // `^2..stash` here would report `missing` for a staged-then-deleted path and
    // drive the residual restore into a conflict it can never resolve.
    parts.worktree = "present";
    parts.unstaged = "present";
  } else {
    const diff = await runGit(
      ["diff", "--quiet", sha, "--", ...worktreeChanges.paths],
      { cwd, env: LITERAL_PATHSPECS }
    );
    if (diff.code === 0) parts.worktree = "present";
    else if (diff.code === 1) parts.worktree = "missing";
    else {
      probeError = `工作区比对失败：${nonEmpty(diff.stderr) ?? `exit ${diff.code}`}`;
    }

    // The worktree-*only* contribution is `stash^2..stash`: what was changed but
    // never staged. It is only meaningful once the combined probe above is
    // non-empty, so it is probed here rather than independently.
    const unstagedChanges = await changedPaths(cwd, `${sha}^2`, sha);
    if (!unstagedChanges.ok) {
      probeError = `无法读取未暂存快照的变更路径：${unstagedChanges.error}`;
    } else if (unstagedChanges.paths.length === 0) {
      parts.unstaged = "present";
    } else {
      const unstagedDiff = await runGit(
        ["diff", "--quiet", sha, "--", ...unstagedChanges.paths],
        { cwd, env: LITERAL_PATHSPECS }
      );
      if (unstagedDiff.code === 0) parts.unstaged = "present";
      else if (unstagedDiff.code === 1) parts.unstaged = "missing";
      else {
        probeError = `未暂存内容比对失败：${nonEmpty(unstagedDiff.stderr) ?? `exit ${unstagedDiff.code}`}`;
      }
    }
  }

  const untracked = await treeBlobs(cwd, sha);
  if (untracked.kind === "error") {
    probeError = untracked.detail;
  } else if (untracked.kind === "absent" || untracked.blobs.size === 0) {
    parts.untracked = "present";
  } else {
    let allPresent = true;
    for (const [filePath, blob] of untracked.blobs) {
      const current = await worktreeBlob(cwd, filePath);
      if (current !== blob) {
        allPresent = false;
        break;
      }
    }
    // A missing file hashes differently, so a mismatch is real evidence of
    // absence; only a successful hash comparison can produce `present`.
    parts.untracked = allPresent ? "present" : "missing";
  }

  return {
    listed,
    ...parts,
    indexPaths,
    // `contentPresent` means "no re-apply is needed": the changed worktree
    // content and the untracked files are visible on disk. The append path adds
    // the worktree-only half explicitly through `residualPresent`, because there
    // that half can be the only uncaptured content.
    contentPresent: parts.worktree === "present" && parts.untracked === "present",
    // Every part this notion of "complete" covers must be positively verified;
    // one unverified part keeps the record. `unstaged` is redundant
    // when it is probed (its paths already appear in the `worktree` probe) and
    // is `present` by construction when it is not, so it is not listed here.
    complete:
      listed === true &&
      parts.index === "present" &&
      parts.worktree === "present" &&
      parts.untracked === "present",
    probeError,
  };
}

/**
 * Removes an entry the extension created, once `presence.complete` confirms that
 * every part of what it holds is reproduced outside it.
 *
 * `complete` is deliberately the only gate, and it is the strictest shape
 * `stashPresence` produces: listed, the staged half reproduced by the index, the
 * worktree half by the worktree, the untracked half by files on disk, each one by
 * a successful *positive* probe (a failed probe never promotes a part, so it can
 * never reach here). A weaker signal — `contentPresent`, which drops the index
 * requirement — is not enough: the worktree can reproduce the snapshot while the
 * index no longer reproduces its staged half, and the entry is then the only
 * record of the staged/unstaged split. No bytes would be lost, but the user's
 * intent would be, so the entry stays and the user is told once how to drop it.
 *
 * `presence.listed !== true` means there is nothing to remove: the entry is
 * already gone (the user popped or dropped it) or the listing failed, and this
 * function must not claim a removal it did not perform.
 *
 * A refusal or non-zero exit from `stashRemoveBySha` is reported, never retried:
 * retrying a destructive step on a state that just refused it is how a "keep
 * everything" path turns into a "delete the wrong thing" path.
 */
async function removeOwnStash(
  cwd: string,
  sha: string,
  presence: StashPresence
): Promise<StashRemoval[]> {
  if (presence.listed !== true) {
    return [];
  }
  const name = await stashNameForSha(cwd, sha);
  if (!presence.complete) {
    return [
      {
        status: "kept",
        kind: "leftover",
        sha,
        name,
        message: `未能完整确认快照已回到索引与工作区（${presenceDetail(presence)}），保留条目`,
      },
    ];
  }
  const res = await stashRemoveBySha(cwd, sha);
  if (res.ok || res.gone) {
    // `gone` covers the entry disappearing between the probe and the removal
    // (the user dropped it in that window). Nothing of ours is listed, which is
    // exactly the state this function exists to produce.
    //
    // `uncrosschecked` is carried through rather than dropped. The removal is
    // real — the entry is demonstrably gone — but the verifier could not read the
    // pre-drop list, so it could not rule out a second entry having gone with it.
    // That caveat used to be built inside `res.message` and then discarded here,
    // so the user was told a clean removal happened and nothing else.
    //
    // The clean shape omits both fields instead of setting them to `undefined`:
    // this object is compared with `deepEqual` by callers, and an own property
    // holding `undefined` still counts as a difference.
    const removal: StashRemoval = { status: "removed", kind: "removed", sha, name };
    if (res.uncrosschecked) {
      removal.uncrosschecked = true;
      removal.message =
        "该条目已确认从 stash 列表消失，但删除前的列表未能读取，无法交叉核对是否有其他条目一起消失";
    }
    return [removal];
  }
  // A refusal is not one shape. `undo-restored` / `undo-unknown` mean another
  // entry was dropped — possibly the user's — and must be announced as that, not
  // as "our leftover was kept". `ambiguous-refusal` means nothing was restored
  // and no victim can be named. This is a declared field rather than a substring of
  // `res.message`, which is what mis-classified the `ambiguous` refusal as a
  // successful restore and sent the unreadable case down the leftover branch,
  // where it offered a `git stash drop` for a slot whose occupant was unknown.
  const kind: StashRemoval["kind"] =
    res.kind === "undo-restored" || res.kind === "undo-unknown" || res.kind === "ambiguous-refusal"
      ? res.kind
      : "leftover";
  // Same rule as the clean removal above: omit absent fields rather than
  // writing `undefined`, so callers can compare with `deepEqual`.
  const kept: StashRemoval = { status: "kept", kind, sha, name };
  if (res.victim !== undefined) kept.victim = res.victim;
  if (res.message !== undefined) kept.message = res.message;
  return [kept];
}

/**
 * Concatenates the removals of the entries one append transaction owns, so both
 * are reported. An entry that reported nothing contributes nothing: `[]` means
 * "there was no such entry to remove", never "removal succeeded".
 */
function mergeRemovals(
  first: StashRemoval[],
  second: StashRemoval[] | undefined
): StashRemoval[] | undefined {
  const all = [...first, ...(second ?? [])];
  return all.length > 0 ? all : undefined;
}

/** A tree entry as Git records it: mode, type and object id. */
interface TreeEntry {
  mode: string;
  type: string;
  object: string;
}

/**
 * One `rev:path` tree entry, `undefined` when the path is absent from `rev`, or
 * `"error"` when the lookup itself failed. Absence and "could not read" are
 * deliberately distinct: only a successful read may count as evidence.
 */
async function treeEntry(
  cwd: string,
  rev: string,
  filePath: string
): Promise<TreeEntry | undefined | "error"> {
  const res = await runGit(["ls-tree", "-z", rev, "--", filePath], { cwd, env: LITERAL_PATHSPECS });
  if (res.code !== 0) {
    return "error";
  }
  for (const record of res.stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    if (record.slice(tab + 1) !== filePath) continue;
    const [mode, type, object] = record.slice(0, tab).split(" ");
    if (!mode || !type || !object) return "error";
    return { mode, type, object };
  }
  return undefined;
}

/**
 * Whether every path the snapshot staged is present in `rev` with byte-identical
 * content *and the same mode*.
 *
 * This is the whole "did the append land" test, and it is deliberately the
 * strict one. The earlier implementation inferred landing from history
 * (`git rev-list --objects --not <since>`, then a `git log --raw` scan, then
 * blob-id equality) and each variant was wrong in some shape:
 *
 * - Blob identity excludes the file mode, so a `chmod +x` snapshot whose `+x`
 *   never landed compared equal, and the record was judged resolved even though
 *   the change was absent.
 * - A revert-shaped amend reproduces its parent's tree exactly for that path, so
 *   `git log --raw` emits no entry at all; the history scan saw nothing and only
 *   the final-blob fallback kept the test green. One later same-file edit
 *   defeated both predicates at once.
 * - `--not <since>` prunes any blob already reachable at the baseline even when
 *   a commit in range writes it again (mode-only changes, reverts).
 *
 * Comparing the actual tree entries has none of those blind spots: mode and
 * object id are exactly what the amend committed. It is also strictly positive
 * — a path that does not match is reported unconfirmed, never "fine" — which is
 * safe precisely because a non-match only *keeps* the record. Nothing is
 * deleted on the strength of this answer.
 *
 * The cost is that a landed append whose file was *later* edited again by the
 * same rebase stays pending. That is the intended trade (see `recoveryCommands`):
 * the banner is actionable, the content is still in the stash, and nothing is
 * lost by asking the user to confirm.
 */
export async function stagedSnapshotInHead(
  cwd: string,
  sha: string,
  rev = "HEAD"
): Promise<{ committed: boolean; detail: string }> {
  const staged = await changedPaths(cwd, `${sha}^1`, `${sha}^2`);
  if (!staged.ok) {
    return { committed: false, detail: `无法读取快照路径：${staged.error}` };
  }
  const paths = staged.paths;
  if (paths.length === 0) {
    // An empty snapshot has nothing to prove; an empty diff cannot be missing.
    return { committed: true, detail: "快照没有变更路径" };
  }

  const differing: string[] = [];
  const unreadable: string[] = [];
  for (const filePath of paths) {
    const want = await treeEntry(cwd, `${sha}^2`, filePath);
    const have = await treeEntry(cwd, rev, filePath);
    if (want === "error" || have === "error") {
      unreadable.push(filePath);
      continue;
    }
    if (!want && !have) {
      // The snapshot staged a deletion and `rev` does not have the path either.
      continue;
    }
    if (!want || !have || want.mode !== have.mode || want.object !== have.object) {
      differing.push(filePath);
    }
  }

  if (differing.length > 0 || unreadable.length > 0) {
    const parts = [
      differing.length
        ? `${rev} 中 ${differing.slice(0, 3).join(", ")}${differing.length > 3 ? " 等" : ""} 的内容或权限与快照不一致`
        : "",
      unreadable.length
        ? `无法读取 ${unreadable.slice(0, 3).join(", ")}${unreadable.length > 3 ? " 等" : ""} 的树对象`
        : "",
    ].filter(Boolean);
    return { committed: false, detail: parts.join("；") };
  }
  return { committed: true, detail: `${paths.length} 个路径的内容与权限已与 ${rev} 完全一致` };
}

/**
 * Applies a stash's original index without removing it, then verifies content.
 *
 * Both signals are required. The presence probe answers "is every blob present",
 * which is a *content* question; it cannot see a merge the apply could not write
 * into the index. `git stash apply --index` exits non-zero with
 * "COULD NOT WRITE INDEX ... needs merge" in exactly that case while the content
 * probe still reports complete (the worktree holds both sides), so trusting
 * presence alone would clear the record and leave the index mid-conflict with no
 * banner left to explain it. The exit code is the only evidence the index is
 * actually coherent, so a non-zero exit keeps the record pending.
 */
async function applyIndex(
  cwd: string,
  sha: string
): Promise<{ ok: boolean; message: string; presence: StashPresence }> {
  const res = await runGit(["stash", "apply", "--index", sha], { cwd });
  const presence = await stashPresence(cwd, sha);
  return {
    ok: res.code === 0 && presence.complete,
    message: (res.stderr || res.stdout).trim(),
    presence,
  };
}

function presenceDetail(presence: StashPresence): string {
  return [
    `listed=${presence.listed === undefined ? "unknown" : presence.listed}`,
    `index=${presence.index}`,
    `worktree=${presence.worktree}`,
    `unstaged=${presence.unstaged}`,
    `untracked=${presence.untracked}`,
    presence.probeError ? `probe=${presence.probeError}` : "",
  ].filter(Boolean).join(" ");
}

/**
 * Reconciles one auto-stash record against Git state. Apply-only semantics:
 * `stash apply` keeps the recovery copy until its content is verified, so a
 * failed or partial apply can never destroy the only copy of user work.
 */
export async function reconcilePendingStash(
  cwd: string,
  sha: string
): Promise<PendingReconcile> {
  const presence = await stashPresence(cwd, sha);
  const detail = presenceDetail(presence);

  if (presence.listed === undefined) {
    // The listing failed. This says nothing about the stash, so the record must
    // survive and the user must be told why it could not be checked.
    return {
      kind: "pending",
      reason: `无法读取 stash 列表，暂时无法判断恢复状态：${presence.probeError ?? "git stash list 失败"}`,
      stashSha: sha,
      detail,
      presence,
    };
  }
  if (!presence.listed) {
    // Nothing is restorable any more: the user popped, applied or dropped it.
    return presence.contentPresent
      ? { kind: "resolved", detail: `stash 已不在列表中，且内容已在工作区（${detail}）` }
      : { kind: "resolved", detail: `stash 已不在列表中，无可恢复内容（${detail}）` };
  }
  if (presence.probeError) {
    return {
      kind: "pending",
      reason: `无法确认 stash 内容是否已恢复：${presence.probeError}`,
      stashSha: sha,
      detail,
      presence,
    };
  }
  if (presence.contentPresent) {
    // `stash apply` never removes the recovery copy, so re-applying an
    // already-present snapshot would only duplicate or conflict. The content is
    // verified on disk, so the copy is a duplicate: remove our own entry here
    // rather than leaving it in front of the user's stashes.
    return {
      kind: "resolved",
      detail: `内容已在工作区，跳过重复 apply（${detail}）`,
      stashRemoved: await removeOwnStash(cwd, sha, presence),
    };
  }

  const applied = await applyIndex(cwd, sha);
  if (!applied.ok) {
    return {
      kind: "pending",
      reason: `apply --index 未能在工作区复现完整内容：${applied.message || "未知原因"}`,
      stashSha: sha,
      detail: `${detail} after=${presenceDetail(applied.presence)}`,
      presence: applied.presence,
    };
  }
  return {
    kind: "restored",
    detail: `已恢复 autostash 内容（${presenceDetail(applied.presence)}）`,
    stashRemoved: await removeOwnStash(cwd, sha, applied.presence),
  };
}

/**
 * Reconciles one append transaction. The stored `targetHash` decides whether the
 * amend ever landed: while it is still an ancestor of HEAD the staged snapshot
 * belongs back in the index. In that `pending` case the transaction's own
 * entries are left alone — the banner is describing a live transaction, and
 * removing its only record while telling the user it is unfinished would be the
 * exact opposite of helpful.
 */
export async function reconcilePendingAppend(
  cwd: string,
  record: PendingAppendRecord
): Promise<PendingReconcile> {
  const targetStillAncestor = record.targetHash
    ? (await runGit(["merge-base", "--is-ancestor", record.targetHash, "HEAD"], { cwd })).code === 0
    : false;
  const change = await stashPresence(cwd, record.changeStash);
  const detail = `change:${presenceDetail(change)}`;

  if (change.listed === undefined) {
    return {
      kind: "pending",
      reason: `无法读取 stash 列表，暂时无法判断追加快照状态：${change.probeError ?? "git stash list 失败"}`,
      stashSha: record.changeStash,
      detail,
      presence: change,
    };
  }
  if (change.probeError) {
    return {
      kind: "pending",
      reason: `无法确认追加快照是否已恢复：${change.probeError}`,
      stashSha: record.changeStash,
      detail,
      presence: change,
    };
  }

  if (!change.listed) {
    // The stash is gone: no part of it can be restored any more, even if a part
    // is missing from the worktree. Keeping the record would only warn forever.
    return { kind: "resolved", detail: `追加快照 stash 已不存在（${detail}）` };
  }

  // A snapshot has two independent obligations:
  //   1. the staged half (`sha^1..sha^2`), which the append was meant to commit;
  //   2. the residual half (worktree-only edits `sha^2..sha` and untracked
  //      files `sha^3`), which was never supposed to be committed and must be
  //      put back in the worktree.
  // Resolving requires *both*. Checking only `index === "present"` would clear
  // the record while untracked or unstaged content still existed solely in the
  // stash — the only copy.
  let detailForOutcome = detail;
  let stagedCommitted = false;

  if (change.index !== "present") {
    if (targetStillAncestor) {
      // The rebase was aborted or never reached the amend: restore the original
      // index. `apply --index` keeps the stash, so a conflict cannot lose it.
      const applied = await applyIndex(cwd, record.changeStash);
      if (!applied.ok) {
        return {
          kind: "pending",
          reason: `恢复原始暂存区失败：${applied.message || "内容未完整复现"}`,
          stashSha: record.changeStash,
          detail: `${detail} after=${presenceDetail(applied.presence)}`,
          presence: applied.presence,
        };
      }
      // The index half is back. Residual content (untracked files, worktree-only
      // edits) is normally included by `apply --index`, but verify it rather
      // than assume: a partial apply must keep the record.
      const afterApply = applied.presence;
      if (!residualPresent(afterApply)) {
        const restore = await restoreResidualSnapshot(cwd, record.changeStash);
        if (!restore.ok) {
          return {
            kind: "pending",
            reason: restore.error
              ? `恢复原始暂存区后无法补回未提交的部分：${restore.error}`
              : `恢复原始暂存区后，未提交的部分与当前工作区冲突：${restore.conflicts.slice(0, 3).join(", ")}`,
            stashSha: record.changeStash,
            detail: `${detail} after=${presenceDetail(afterApply)}`,
            presence: afterApply,
          };
        }
      }
      const verified = await stashPresence(cwd, record.changeStash);
      if (!residualPresent(verified)) {
        return {
          kind: "pending",
          reason: `恢复原始暂存区后仍有内容只存在于 stash（${presenceDetail(verified)}）`,
          stashSha: record.changeStash,
          detail,
          presence: verified,
        };
      }
      if (record.unstagedStash) {
        // Reconcile the worktree entry *before* touching the change entry: it
        // reports `pending` when it cannot be verified, which returns here and
        // aborts the whole outcome. Removing the change entry first would leave
        // that entry gone while the caller was told nothing settled.
        const extra = await reconcileWorktreeStash(cwd, record.unstagedStash);
        if (extra.kind === "pending") {
          return extra;
        }
        const removed = await removeOwnStash(cwd, record.changeStash, verified);
        return {
          kind: "restored",
          detail: `已恢复追加前的暂存区（${presenceDetail(verified)}）`,
          stashRemoved: mergeRemovals(
            removed,
            extra.kind === "none" ? undefined : extra.stashRemoved
          ),
        };
      }
      return {
        kind: "restored",
        detail: `已恢复追加前的暂存区（${presenceDetail(verified)}）`,
        stashRemoved: await removeOwnStash(cwd, record.changeStash, verified),
      };
    }
    // The target was rewritten. Ancestry alone proves nothing — an aborted
    // rebase or an external `reset --hard` rewrites history too — so the staged
    // half is only confirmed when the *whole* tree entry (mode included) at
    // `HEAD` is identical to what the snapshot staged. See `stagedSnapshotInHead`.
    const committed = await stagedSnapshotInHead(cwd, record.changeStash);
    if (!committed.committed) {
      return {
        kind: "pending",
        reason: `target ${record.targetHash?.slice(0, 7) ?? "?"} 已被改写，但无法确认快照已进入 HEAD（${committed.detail}）`,
        stashSha: record.changeStash,
        detail,
        presence: change,
      };
    }
    stagedCommitted = true;
    detailForOutcome = `head:${committed.detail}`;
  }

  // The staged half is accounted for (in the index or in HEAD). The residual
  // half still has to be back in the worktree; if it is missing, put back only
  // the paths nobody has touched since the snapshot instead of clearing the
  // record while its content lives solely in the stash.
  let residualWrites: string[] = [];
  if (!residualPresent(change)) {
    const restore = await restoreResidualSnapshot(cwd, record.changeStash);
    if (!restore.ok) {
      const why = restore.error
        ? `无法补回快照中未提交的部分：${restore.error}`
        : `快照中未提交的部分与当前工作区冲突：${restore.conflicts.slice(0, 3).join(", ")}`;
      return {
        kind: "pending",
        reason: why,
        stashSha: record.changeStash,
        detail,
        presence: change,
      };
    }
    residualWrites = restore.restored;
  }
  const after = await stashPresence(cwd, record.changeStash);
  if (after.probeError) {
    return {
      kind: "pending",
      reason: `无法确认剩余改动是否已恢复：${after.probeError}`,
      stashSha: record.changeStash,
      detail: `${detail} after=${presenceDetail(after)}`,
      presence: after,
    };
  }
  if (!residualPresent(after)) {
    return {
      kind: "pending",
      reason: `快照中未提交的部分仍未恢复到工作区（${presenceDetail(after)}）`,
      stashSha: record.changeStash,
      detail,
      presence: after,
    };
  }

  // The snapshot being *visible in the index* is not proof that the append
  // happened. Only a landed amend proves it (`stagedCommitted` above). When the
  // target is still an ancestor and a rebase is still paused, the transaction is
  // live: the user's staged content is merely back where it started.
  //
  // Resolving here was the second half of the reported bug. After the fake
  // conflicts, following the toast's advice (`git add` the reported files) makes
  // the index match the snapshot, so the record cleared while the paused rebase
  // still held the original target and the append had never been amended — the
  // staged intent was dropped with no warning. Keeping the record makes the
  // banner say the append did not complete.
  //
  // `targetStillAncestor` is required so a landed amend can never reach this
  // branch: once the amend lands the original target is no longer an ancestor,
  // and `stagedCommitted` covers that case.
  //
  // After `git rebase --abort` no rebase is in progress, so the same state is a
  // genuine success (the user explicitly gave up the append) and resolves.
  if (!stagedCommitted && !record.amended && targetStillAncestor && (await isRebaseInProgress(cwd))) {
    return {
      kind: "pending",
      reason:
        "追加未完成：暂存区内容已回到工作区/索引，但尚未写入目标 commit（变基仍在进行中）。请 Abort 结束本次追加，或重新执行追加。",
      stashSha: record.changeStash,
      detail: `${detailForOutcome}；${detail}`,
      presence: change,
    };
  }

  // Settled: the transaction is over and both halves are back. Only now are the
  // transaction's own entries removed, and only if what each holds is verifiably
  // present outside it. Doing this any earlier would remove the entry while the
  // outcome is still `pending`, which is exactly the state the banner exists to
  // describe — the user would be told the append is unfinished while the only
  // record of it was deleted.
  //
  // The worktree entry is reconciled first: it can return `pending`, and that
  // must abort the whole outcome before the change entry is touched.
  let removedAll: StashRemoval[] | undefined;
  if (record.unstagedStash) {
    const extra = await reconcileWorktreeStash(cwd, record.unstagedStash);
    if (extra.kind === "pending") {
      return extra;
    }
    removedAll = mergeRemovals(
      await removeOwnStash(cwd, record.changeStash, after),
      extra.kind === "none" ? undefined : extra.stashRemoved
    );
  } else {
    removedAll = await removeOwnStash(cwd, record.changeStash, after);
  }

  return {
    kind: residualWrites.length > 0 ? "restored" : "resolved",
    detail:
      residualWrites.length > 0
        ? `已补回快照中未提交的部分（${residualWrites.slice(0, 3).join(", ")}）；${detailForOutcome}`
        : `追加内容已在 ${stagedCommitted ? "amend 后的 commit" : "工作区/索引"} 中，跳过恢复（${detailForOutcome}；${detail}）`,
    stashRemoved: removedAll,
  };
}

/**
 * Restores a keep-index worktree stash, then removes that entry if its content
 * is verifiably back.
 *
 * Restore is apply-based, never `pop`-based: a `pop` both writes and deletes, so
 * a conflict would consume the recovery copy before its content was confirmed.
 * The removal is a separate step that only runs on a positive probe, and it only
 * ever targets the sha the caller got from its own persisted record.
 */
async function reconcileWorktreeStash(
  cwd: string,
  sha: string
): Promise<PendingReconcile> {
  const presence = await stashPresence(cwd, sha);
  if (presence.listed === undefined) {
    return {
      kind: "pending",
      reason: `无法读取 stash 列表，暂时无法判断工作区快照状态：${presence.probeError ?? "git stash list 失败"}`,
      stashSha: sha,
      detail: presenceDetail(presence),
      presence,
    };
  }
  if (!presence.listed) {
    return { kind: "resolved", detail: `工作区快照 stash 已不存在（${presenceDetail(presence)}）` };
  }
  if (presence.probeError) {
    return {
      kind: "pending",
      reason: `无法确认工作区快照是否已恢复：${presence.probeError}`,
      stashSha: sha,
      detail: presenceDetail(presence),
      presence,
    };
  }
  if (presence.contentPresent) {
    return {
      kind: "resolved",
      detail: `工作区改动已存在，跳过重复 apply（${presenceDetail(presence)}）`,
      stashRemoved: await removeOwnStash(cwd, sha, presence),
    };
  }
  // `apply` (not `pop`): a conflicting pop removes the entry it failed to apply.
  const applied = await runGit(["stash", "apply", sha], { cwd });
  const after = await stashPresence(cwd, sha);
  if (!after.contentPresent || after.probeError) {
    return {
      kind: "pending",
      reason: `恢复未暂存改动失败：${(applied.stderr || applied.stdout).trim() || "内容未完整复现"}`,
      stashSha: sha,
      detail: `before=${presenceDetail(presence)} after=${presenceDetail(after)}`,
      presence: after,
    };
  }
  return {
    kind: "restored",
    detail: `已恢复未暂存改动（${presenceDetail(after)}）`,
    stashRemoved: await removeOwnStash(cwd, sha, after),
  };
}

/**
 * Whether "Reset Extension State" may clear one record.
 *
 * It decides about the *bookkeeping only*, and it deletes nothing: the reset
 * command clears records, it never removes a stash entry. A record is cleared
 * when it is orphaned or its content is verifiably back; the entry itself is
 * left alone, and the user is offered the exact manual recovery commands. A
 * stash that still holds uncommitted content keeps its record, and so does
 * anything that could not be checked — "could not read the list" is not
 * "nothing there".
 */
export function resetDecision(presence: StashPresence): {
  action: "clear" | "keep";
  reason: string;
} {
  if (presence.listed === undefined) {
    return { action: "keep", reason: "无法读取 stash 列表，无法确认记录是否为孤儿" };
  }
  if (!presence.listed) {
    return { action: "clear", reason: "stash 已不在列表中，记录为孤儿" };
  }
  if (presence.probeError) {
    return { action: "keep", reason: "无法确认 stash 内容是否已恢复" };
  }
  if (presence.contentPresent) {
    return { action: "clear", reason: "内容已在工作区，记录已解决（stash 条目本身未删除）" };
  }
  return { action: "keep", reason: "stash 仍保存未恢复的改动" };
}

/** One concrete, copy-pasteable step the user can run for a pending stash. */
export interface RecoveryCommand {
  /** What the step does, in the user's language. */
  label: string;
  /** The exact shell command, ready to paste. */
  command: string;
}

/**
 * The manual recovery menu for a stash that is still listed *and still holds
 * content the extension could not verify is back*.
 *
 * These steps exist for the pending case only: the extension will not remove an
 * entry whose content it could not confirm, so the user finishes the job. Every
 * step here is a deliberate user action; nothing is executed by the extension.
 * The banner and the toast only print them.
 *
 * `name` is the currently resolving `stash@{n}`, or undefined when the slot
 * cannot be resolved (a corrupted stash reflog is exactly that case). The apply
 * steps fall back to the sha, which Git accepts and which no concurrent
 * `stash push` can invalidate. Only the `drop` step is withheld when the name is
 * unknown: Git has no sha-addressed `stash drop`, so offering
 * `git stash drop <sha>` would print a command that always fails.
 */
export function recoveryCommands(
  name: string | undefined,
  sha: string,
  presence?: StashPresence
): RecoveryCommand[] {
  const applyTarget = name ?? sha;
  const steps: RecoveryCommand[] = [];
  // `git stash apply --index` merges the snapshot's index half into the current
  // index. When that half is *already there* every path collides and Git
  // refuses with "already exists in index ... Try without --index" (exit 1).
  // Offering it first therefore led the banner with a command guaranteed to
  // fail, at the one moment the user needs a working one. The probe knows
  // whether the index half is already in place, so the list is built from it
  // rather than from a fixed order.
  //
  // `index: "present"` alone is not enough: it also describes a snapshot with
  // *no* staged half (zero paths), where `apply --index` has nothing to merge
  // and succeeds. Only a non-empty staged half that is already in the index
  // collides. Keying on `indexPaths > 0` keeps the working command available in
  // the empty-index case while dropping the impossible one in the collision case.
  const indexAlreadyThere = presence?.index === "present" && presence.indexPaths > 0;
  if (!indexAlreadyThere) {
    steps.push({ label: "恢复暂存区与工作区改动", command: `git stash apply --index ${applyTarget}` });
  }
  steps.push({
    label: indexAlreadyThere
      ? "恢复工作区改动（暂存区内容已就位，无需 --index）"
      : "只恢复工作区改动（不改动暂存区）",
    command: `git stash apply ${applyTarget}`,
  });
  if (name) {
    // Offered last and only as an explicit user step. This entry is pending —
    // the extension could not confirm its content was back — so it never touches
    // it; the user decides. The label repeats the identity because `stash@{n}`
    // is a position, not a name.
    steps.push({
      label: `确认 ${name} 仍是 ${sha.slice(0, 7)} 后删除`,
      command: `git stash drop ${name}`,
    });
  }
  return steps;
}
