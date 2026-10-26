import * as fs from "fs";
import * as pathModule from "path";
import { runGit } from "./gitRunner";

/**
 * # The guarantee
 *
 * **This module never deletes a stash.**
 *
 * Every automatic recovery step is apply-only (`git stash apply`, never
 * `git stash pop`, and no `git stash drop` anywhere). A record may be cleared
 * only after its content has been *positively confirmed* present in the
 * worktree, the index, or `HEAD`; when confirmation fails the record, the
 * banner and the stash all stay. The worst outcome of a misjudgement is
 * therefore "an extra stash left behind", never "the only copy deleted".
 *
 * That is a deliberate trade. The earlier design decided *whether to drop* on
 * inferred containment, and two review rounds found it wrong in different
 * shapes (mode-blind blob comparison, revert-shaped amends, renames, unrelated
 * commits writing the same bytes). With the deletion gone, the decision no
 * longer has to be perfect — it only decides whether a piece of bookkeeping and
 * an actionable banner stay on screen.
 *
 * Deleting a stash is a user action; `recoveryCommands` gives the exact command
 * for each step so the banner can offer it verbatim.
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
   * conflict: treat it as restored, leaving the stash exactly where it is.
   */
  contentPresent: boolean;
  /** Every part, including index placement, was positively verified. */
  complete: boolean;
  /** Human-readable probe failure, surfaced in the warning when there is one. */
  probeError?: string;
}

/**
 * A recovery stash that is still listed after its content was confirmed back.
 *
 * This extension never deletes a stash automatically: `stash apply` keeps the
 * recovery copy on purpose, so a misjudged restore leaves an extra stash rather
 * than losing the only one. A settled record therefore commonly leaves a
 * redundant stash behind, and the user is told about it with an exact command.
 */
export interface StashKept {
  /** Human stash name (`stash@{n}`) when a slot still resolves to `sha`. */
  name?: string;
  sha: string;
}

/**
 * The invariant this module guarantees: **no outcome ever removes a stash.**
 *
 * `resolved` and `restored` mean "the record may be cleared because its content
 * was positively confirmed present in the worktree, index or HEAD". They never
 * mean "the recovery copy is gone" — `stashKept` records the copy that is still
 * there, and deleting it is a deliberate user action outside this module.
 */
export type PendingReconcile =
  | { kind: "none" }
  /** The record is moot or its content is already back; clear it silently. */
  | { kind: "resolved"; detail: string; stashKept?: StashKept }
  /** This pass restored the content; clear the record and report success. */
  | { kind: "restored"; detail: string; stashKept?: StashKept }
  /** Content is still only in a stash, or could not be verified; keep and warn. */
  | { kind: "pending"; reason: string; stashSha: string; detail: string };

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Every stash sha currently listed, newest first, or undefined when the listing
 * itself failed. The distinction matters: a corrupted `refs/stash` reflog makes
 * `git stash list` print nothing, and treating that as "the stash is gone"
 * silently discards the only record of uncommitted work.
 */
export async function stashShas(cwd: string): Promise<string[] | undefined> {
  const res = await runGit(["stash", "list", "--format=%H"], { cwd });
  if (res.code !== 0) {
    return undefined;
  }
  const shas = res.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (shas.length === 0) {
    // `git stash list` exits 0 with empty output when the reflog is unreadable
    // even though `refs/stash` still points at a real stash commit. An empty
    // listing is therefore ambiguous and must not be trusted as "none exist".
    const ref = await refsStashSha(cwd);
    if (ref && !shas.includes(ref)) {
      return undefined;
    }
  }
  return shas;
}

/**
 * The commit `refs/stash` points at. This is the only signal that survives a
 * corrupted stash reflog: `git stash list` then prints nothing and still exits
 * 0, so an empty listing alone must never be read as "the stash is gone".
 */
export async function refsStashSha(cwd: string): Promise<string | undefined> {
  const res = await runGit(["rev-parse", "--verify", "--quiet", "refs/stash"], { cwd });
  return res.code === 0 ? nonEmpty(res.stdout) : undefined;
}

/** Current `stash@{n}` name for a stash sha, or undefined when it is gone. */
export async function stashNameForSha(cwd: string, sha: string): Promise<string | undefined> {
  const list = await runGit(["stash", "list", "--format=%gd%x1f%H"], { cwd });
  if (list.code !== 0) {
    return undefined;
  }
  const entry = list.stdout
    .split("\n")
    .map((line) => line.split("\x1f"))
    .find(([, hash]) => hash?.trim() === sha);
  return entry?.[0]?.trim() || undefined;
}

interface PathsProbe {
  paths: string[];
  ok: boolean;
  error?: string;
}

/** Paths changed between two revisions, NUL-split so spaces survive. */
async function changedPaths(cwd: string, from: string, to: string): Promise<PathsProbe> {
  const res = await runGit(["diff", "--name-only", "-z", from, to], { cwd });
  if (res.code !== 0) {
    return { paths: [], ok: false, error: nonEmpty(res.stderr) ?? `git diff exit ${res.code}` };
  }
  return { paths: res.stdout.split("\0").map((entry) => entry.trim()).filter(Boolean), ok: true };
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
    const [, , blob] = entry.slice(0, tab).split(" ");
    blobs.set(entry.slice(tab + 1), blob);
  }
  return { kind: "entries", blobs };
}

/** Hashes a worktree path exactly as Git would store it. */
async function worktreeBlob(cwd: string, filePath: string): Promise<string | undefined> {
  const res = await runGit(["hash-object", `--path=${filePath}`, "--", filePath], { cwd });
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
    // "Untouched" must be measured against the snapshot, never against HEAD:
    // once the user commits newer content, worktree == HEAD again and a
    // HEAD-relative check calls the path clean, overwrites that newer committed
    // content with the stale snapshot, and drops the recovery copy. The snapshot
    // blob itself is the only valid baseline — anything else at the path is a
    // conflict. (The case worktree == snapshot blob returned above; so only an
    // absent path is safe to write.)
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
      { cwd }
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
      { cwd }
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

/** Whether the parts of a snapshot that live only in the worktree are back. */
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
  if (!staged.ok) {
    probeError = `无法读取暂存快照的变更路径：${staged.error}`;
  } else if (staged.paths.length === 0) {
    parts.index = "present";
  } else {
    const diff = await runGit(["diff", "--cached", "--quiet", `${sha}^2`, "--", ...staged.paths], { cwd });
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
    const diff = await runGit(["diff", "--quiet", sha, "--", ...worktreeChanges.paths], { cwd });
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
      const unstagedDiff = await runGit(["diff", "--quiet", sha, "--", ...unstagedChanges.paths], { cwd });
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
 * A stash that is still listed once its content was confirmed present.
 *
 * Nothing here removes it. The extension never deletes a stash automatically:
 * an `apply` that was judged wrong leaves an extra stash, never a missing one.
 * Reporting the copy is what lets the banner name the exact command a user can
 * run when they are satisfied the stash is redundant.
 */
async function keptStash(cwd: string, sha: string, presence: StashPresence): Promise<StashKept | undefined> {
  if (presence.listed !== true) {
    return undefined;
  }
  return { name: await stashNameForSha(cwd, sha), sha };
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
  const res = await runGit(["ls-tree", "-z", rev, "--", filePath], { cwd });
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
 * `complete` is the post-condition: every part of the snapshot, including index
 * placement, has to be positively observed. A partial apply therefore reports
 * failure and the record stays pending.
 */
async function applyIndex(
  cwd: string,
  sha: string
): Promise<{ ok: boolean; message: string; presence: StashPresence }> {
  const res = await runGit(["stash", "apply", "--index", sha], { cwd });
  const presence = await stashPresence(cwd, sha);
  return {
    ok: presence.complete,
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
    };
  }
  if (presence.contentPresent) {
    // `stash apply` never removes the recovery copy, so re-applying an
    // already-present snapshot would only duplicate or conflict. The stash stays
    // listed; the user may drop it themselves once satisfied.
    return {
      kind: "resolved",
      detail: `内容已在工作区，跳过重复 apply（${detail}）`,
      stashKept: await keptStash(cwd, sha, presence),
    };
  }

  const applied = await applyIndex(cwd, sha);
  if (!applied.ok) {
    return {
      kind: "pending",
      reason: `apply --index 未能在工作区复现完整内容：${applied.message || "未知原因"}`,
      stashSha: sha,
      detail: `${detail} after=${presenceDetail(applied.presence)}`,
    };
  }
  return {
    kind: "restored",
    detail: `已恢复 autostash 内容（${presenceDetail(applied.presence)}）`,
    stashKept: await keptStash(cwd, sha, applied.presence),
  };
}

/**
 * Reconciles one append transaction. The stored `targetHash` decides whether the
 * amend ever landed: while it is still an ancestor of HEAD the staged snapshot
 * belongs back in the index, and no recovery stash is ever deleted.
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
    };
  }
  if (change.probeError) {
    return {
      kind: "pending",
      reason: `无法确认追加快照是否已恢复：${change.probeError}`,
      stashSha: record.changeStash,
      detail,
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
        };
      }
      let kept = await keptStash(cwd, record.changeStash, verified);
      if (record.unstagedStash) {
        const extra = await reconcileWorktreeStash(cwd, record.unstagedStash);
        if (extra.kind === "pending") {
          return extra;
        }
        kept = (extra.kind === "none" ? undefined : extra.stashKept) ?? kept;
      }
      return {
        kind: "restored",
        detail: `已恢复追加前的暂存区（${presenceDetail(verified)}）`,
        stashKept: kept,
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
    };
  }
  if (!residualPresent(after)) {
    return {
      kind: "pending",
      reason: `快照中未提交的部分仍未恢复到工作区（${presenceDetail(after)}）`,
      stashSha: record.changeStash,
      detail,
    };
  }

  // Both halves are accounted for. Nothing is removed from the stash list: the
  // recovery copy stays, and the outcome names it so the banner can offer the
  // explicit `git stash drop` that only the user may run.
  let kept = await keptStash(cwd, record.changeStash, after);
  if (record.unstagedStash) {
    const extra = await reconcileWorktreeStash(cwd, record.unstagedStash);
    if (extra.kind === "pending") {
      return extra;
    }
    kept = (extra.kind === "none" ? undefined : extra.stashKept) ?? kept;
  }

  if (residualWrites.length > 0) {
    return {
      kind: "restored",
      detail: `已补回快照中未提交的部分（${residualWrites.slice(0, 3).join(", ")}）；${detailForOutcome}`,
      stashKept: kept,
    };
  }
  return {
    kind: "resolved",
    detail: `追加内容已在 ${stagedCommitted ? "amend 后的 commit" : "工作区/索引"} 中，跳过恢复（${detailForOutcome}；${detail}）`,
    stashKept: kept,
  };
}

/**
 * Restores a keep-index worktree stash. Apply-based, never `pop`-based: a `pop`
 * both writes and deletes, so a conflict would consume the recovery copy. The
 * stash is left in place for the user.
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
    };
  }
  if (presence.contentPresent) {
    return {
      kind: "resolved",
      detail: `工作区改动已存在，跳过重复 apply（${presenceDetail(presence)}）`,
      stashKept: await keptStash(cwd, sha, presence),
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
    };
  }
  return {
    kind: "restored",
    detail: `已恢复未暂存改动（${presenceDetail(after)}）`,
    stashKept: await keptStash(cwd, sha, after),
  };
}

/**
 * Whether "Reset Extension State" may clear one record.
 *
 * It decides about the *bookkeeping only*. The reset command never runs
 * `git stash drop`, so this answer cannot delete anything: `clear` means "the
 * record is orphaned or its content is verifiably back", and the stash (if any)
 * is left exactly where it is. A stash that still holds uncommitted content
 * keeps its record, and so does anything that could not be checked — "could not
 * read the list" is not "nothing there".
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
    return { action: "clear", reason: "内容已在工作区，记录已解决（stash 本体保留）" };
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
 * The manual recovery menu for a stash that is still listed.
 *
 * These are the only ways content leaves a stash, and every one of them is a
 * deliberate user action. Nothing here is executed by the extension; the
 * banner and the toast print them so the user can choose.
 *
 * `name` is the currently resolving `stash@{n}`, or undefined when the slot
 * cannot be resolved (a corrupted stash reflog is exactly that case). The apply
 * steps fall back to the sha, which Git accepts and which no concurrent
 * `stash push` can invalidate. Only the `drop` step is withheld when the name is
 * unknown: Git has no sha-addressed `stash drop`, so offering
 * `git stash drop <sha>` would print a command that always fails.
 */
export function recoveryCommands(name: string | undefined, sha: string): RecoveryCommand[] {
  const applyTarget = name ?? sha;
  const steps: RecoveryCommand[] = [
    { label: "恢复暂存区与工作区改动", command: `git stash apply --index ${applyTarget}` },
    { label: "只恢复工作区改动（不改动暂存区）", command: `git stash apply ${applyTarget}` },
  ];
  if (name) {
    // Offered last and only as an explicit user step: it is the one irreversible
    // action, so it is never automatic and never first. The label repeats the
    // identity because `stash@{n}` is a position, not a name.
    steps.push({
      label: `确认 ${name} 仍是 ${sha.slice(0, 7)} 后删除`,
      command: `git stash drop ${name}`,
    });
  }
  return steps;
}
