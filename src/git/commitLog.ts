import { git, runGit } from "./gitRunner";

export interface Commit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

export type RangeConfig =
  | { kind: "upstream" }
  | { kind: "mainBranch"; mainBranch: string }
  | { kind: "recentN"; count: number }
  | { kind: "all" };

const SEP = "\x1f"; // unit separator, safe inside git format
const REC = "\x1e"; // record separator

/**
 * The minimum Git version the extension supports (2.31.0, the first Git with
 * `--path-format=absolute`). The installed Git revision is probed lazily at
 * first use and cached for the session.
 */
export const MIN_GIT_VERSION = [2, 31, 0] as const;

let cachedGitVersion: string | undefined;

/** Returns `git --version`'s version string, or undefined when git is missing. */
export async function gitVersion(cwd: string): Promise<string | undefined> {
  if (cachedGitVersion !== undefined) {
    return cachedGitVersion;
  }
  const res = await runGit(["--version"], { cwd });
  const match = res.stdout.match(/\d+(?:\.\d+)+/);
  cachedGitVersion = match?.[0] ?? undefined;
  return cachedGitVersion;
}

/**
 * True when the installed Git is at least `MIN_GIT_VERSION`. Accepts the
 * optional feature name to be reported when the check fails; a missing git
 * binary reports a clear failure too.
 */
export async function checkGitFeature(
  cwd: string,
  feature: string = "git rebase"
): Promise<{ ok: boolean; message?: string }> {
  const version = await gitVersion(cwd);
  if (!version) {
    return { ok: false, message: "Git not found. Install Git and reopen this panel." };
  }
  const parsed = version.split(".").map((n) => Number(n) || 0);
  const tooOld =
    parsed[0] < MIN_GIT_VERSION[0] ||
    (parsed[0] === MIN_GIT_VERSION[0] &&
      (parsed[1] < MIN_GIT_VERSION[1] ||
        (parsed[1] === MIN_GIT_VERSION[1] && (parsed[2] ?? 0) < MIN_GIT_VERSION[2])));
  if (tooOld) {
    return {
      ok: false,
      message: `Git ${version} is too old for ${feature}. Git ${MIN_GIT_VERSION.join(".")} or newer is required.`,
    };
  }
  return { ok: true };
}

/**
 * Resolves the git rev-range expression for the configured display range.
 * Returns undefined when the range cannot be resolved (e.g. no upstream set).
 */
export async function resolveRange(
  cwd: string,
  cfg: RangeConfig,
  tipRef: string = "HEAD"
): Promise<{ revRange: string; hasBase: boolean } | { error: string }> {
  switch (cfg.kind) {
    case "upstream": {
      const res = await runGit(
        [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          `${tipRef}@{upstream}`,
        ],
        { cwd }
      );
      if (res.code !== 0) {
        return { error: "No upstream branch is configured for the current branch." };
      }
      return { revRange: `${tipRef}@{upstream}..${tipRef}`, hasBase: true };
    }
    case "mainBranch": {
      const res = await runGit(["rev-parse", "--verify", "--quiet", cfg.mainBranch], { cwd });
      if (res.code !== 0) {
        return { error: `Base branch '${cfg.mainBranch}' not found.` };
      }
      return { revRange: `${cfg.mainBranch}..${tipRef}`, hasBase: true };
    }
    case "recentN":
      return { revRange: `-n ${Math.max(1, cfg.count)} ${tipRef}`, hasBase: false };
    case "all":
      return { revRange: tipRef, hasBase: false };
  }
}

/**
 * When a rebase is in progress, returns the name of the branch being rebased
 * (from rebase-merge/head-name), so the UI can show that branch's commits
 * instead of failing on the detached HEAD.
 */
export async function rebasingBranch(cwd: string): Promise<string | undefined> {
  const res = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge/head-name"],
    { cwd }
  );
  if (res.code !== 0) {
    return undefined;
  }
  const fs = await import("fs");
  const abs = res.stdout.trim();
  try {
    if (fs.existsSync(abs)) {
      const ref = fs.readFileSync(abs, "utf8").trim(); // refs/heads/main
      return ref.replace(/^refs\/heads\//, "");
    }
  } catch {
    // ignore
  }
  return undefined;
}

/** Returns commits newest-first for the given resolved range. */
export async function getCommits(
  cwd: string,
  revRange: string
): Promise<Commit[]> {
  const format = ["%H", "%h", "%s", "%an", "%ad"].join(SEP) + REC;
  const args = [
    "log",
    "--date=short",
    `--pretty=format:${format}`,
    ...revRange.split(" "),
  ];
  const out = await git(args, { cwd });
  if (!out) {
    return [];
  }
  return out
    .split(REC)
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.trim().length > 0)
    .map((rec) => {
      const [hash, shortHash, subject, author, date] = rec.split(SEP);
      return { hash, shortHash, subject, author, date };
    });
}

/** True when a rebase (interactive or otherwise) is currently in progress. */
export async function isRebaseInProgress(cwd: string): Promise<boolean> {
  const [merge, apply] = await Promise.all(
    ["rebase-merge", "rebase-apply"].map((name) =>
      runGit(["rev-parse", "--path-format=absolute", "--git-path", name], { cwd })
    )
  );
  const fs = await import("fs");
  for (const abs of [merge.stdout.trim(), apply.stdout.trim()].filter(Boolean)) {
    try {
      if (fs.existsSync(abs)) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

/** Returns the current branch name, or undefined when detached. */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  const res = await runGit(["symbolic-ref", "--short", "-q", "HEAD"], { cwd });
  return res.code === 0 ? res.stdout.trim() : undefined;
}

/**
 * When a rebase is paused (edit stop or after a resolved step), returns the
 * full hash of the commit it stopped at, or undefined if unavailable.
 */
export async function rebaseStoppedSha(cwd: string): Promise<string | undefined> {
  const res = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge/stopped-sha"],
    { cwd }
  );
  if (res.code !== 0) {
    return undefined;
  }
  const fs = await import("fs");
  const abs = res.stdout.trim();
  try {
    if (fs.existsSync(abs)) {
      const sha = fs.readFileSync(abs, "utf8").trim();
      // Expand to full hash for reliable comparison.
      const full = await runGit(["rev-parse", sha], { cwd });
      return full.code === 0 ? full.stdout.trim() : sha;
    }
  } catch {
    // ignore
  }
  return undefined;
}

/** Returns the repository top-level directory, or undefined when not a repo. */
export async function repoRoot(cwd: string): Promise<string | undefined> {
  const res = await runGit(["rev-parse", "--show-toplevel"], { cwd });
  return res.code === 0 ? res.stdout.trim() : undefined;
}

/** Returns the full commit message (subject + body) for a commit. */
export async function fullMessage(cwd: string, hash: string): Promise<string> {
  return git(["log", "-1", "--pretty=format:%B", hash], { cwd });
}

/**
 * True when `ancestor` is an ancestor of (or equal to) `descendant`.
 * `merge-base --is-ancestor` exits 0 when the relationship holds.
 */
export async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  const res = await runGit(
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd }
  );
  return res.code === 0;
}

export interface CommitDetail {
  author: string;
  email: string;
  relDate: string;
  absDate: string;
  message: string;
  stat: string; // e.g. "8 files changed, 30 insertions(+), 2843 deletions(-)"
}

/**
 * Parses `git show --numstat` output into a human-readable summary. Structured
 * columns (added/deleted per path) avoid the locale-sensitive text parsing of
 * `--shortstat`. Lines that are not `<added>\t<deleted>\t<path>` (commit hash
 * headers, subjects, merge lines) are skipped; binary/rename lines (`-` in a
 * column) count as changed files without +/- contributions.
 */
export function summarizeNumstat(numstat: string[]): string {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat) {
    const parts = line.trim().split("\t");
    if (parts.length < 3) {
      continue; // header/blank/subject line — not a numstat data row
    }
    files += 1;
    // A `-` in either column marks a binary/rename row: count it as a changed
    // file but omit its +/- contributions (matching `--shortstat`).
    if (parts[0] === "-" || parts[1] === "-") {
      continue;
    }
    const added = Number(parts[0]);
    const deleted = Number(parts[1]);
    if (Number.isFinite(added)) {
      insertions += added;
    }
    if (Number.isFinite(deleted)) {
      deletions += deleted;
    }
  }
  if (files === 0) {
    return "";
  }
  const parts = [`${files} file${files === 1 ? "" : "s"} changed`];
  if (insertions > 0) {
    parts.push(`${insertions} insertion${insertions === 1 ? "" : "s"}(+)`);
  }
  if (deletions > 0) {
    parts.push(`${deletions} deletion${deletions === 1 ? "" : "s"}(-)`);
  }
  return parts.join(", ");
}

/** Fetches rich details for a commit, used for the hover tooltip. */
export async function commitDetail(cwd: string, hash: string): Promise<CommitDetail> {
  const fmt = ["%an", "%ae", "%ar", "%ad", "%B"].join("\x1f");
  const meta = await git(
    ["show", "-s", "--date=format:%Y-%m-%d %H:%M", `--pretty=format:${fmt}`, hash],
    { cwd }
  );
  const [author, email, relDate, absDate, message] = meta.split("\x1f");

  // Structured stat: `--numstat` prints "added\tdeleted\tpath" per changed file,
  // using "-" for binary files and omitting rename targets. Preferred over
  // parsing the localized `--shortstat` prose. `--format=%H` keeps the header
  // minimal (a bare hash the summarizer skips).
  const numstat = await runGit(
    ["show", "--numstat", "--format=%H", "--no-color", hash],
    { cwd }
  );
  const statLine = summarizeNumstat(numstat.stdout.split("\n"));
  if (statLine) {
    return { author, email, relDate, absDate, message, stat: statLine };
  }
  // Fallback: parse the last `--shortstat` summary line (locale-dependent).
  const statRes = await runGit(
    ["show", "--shortstat", "--oneline", "--no-color", hash],
    { cwd }
  );
  const shortstatLine =
    statRes.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /files? changed|insertion|deletion/.test(l))
      .pop() ?? "";
  return { author, email, relDate, absDate, message, stat: shortstatLine };
}

export interface WorkingStatus {
  hasStaged: boolean;
  hasUnstaged: boolean; // includes untracked
}

/** Reports whether there are staged and/or unstaged (incl. untracked) changes. */
export async function workingStatus(cwd: string): Promise<WorkingStatus> {
  const res = await runGit(["status", "--porcelain"], { cwd });
  let hasStaged = false;
  let hasUnstaged = false;
  for (const line of res.stdout.split("\n")) {
    if (line.length < 2) {
      continue;
    }
    const x = line[0]; // staged column
    const y = line[1]; // worktree column
    if (line.startsWith("??")) {
      hasUnstaged = true;
      continue;
    }
    if (x !== " " && x !== "?") {
      hasStaged = true;
    }
    if (y !== " " && y !== "?") {
      hasUnstaged = true;
    }
  }
  return { hasStaged, hasUnstaged };
}

/** True when the working tree has any staged or unstaged changes. */
export async function isDirty(cwd: string): Promise<boolean> {
  const res = await runGit(["status", "--porcelain"], { cwd });
  return res.stdout.trim().length > 0;
}

/** Returns paths that Git marks as unresolved in the index. */
export async function conflictedFiles(cwd: string): Promise<string[]> {
  const res = await runGit(["diff", "--name-only", "--diff-filter=U"], { cwd });
  return res.stdout.split("\n").map((path) => path.trim()).filter(Boolean);
}

/**
 * In-memory session cache for patch-id lookups. The patch-id of a commit is
 * stable unless the commit itself is rewritten, and a refresh can ask for the
 * same hash multiple times (hover detail + lock check + push guard). Caching
 * avoids repeating the two git calls (`diff-tree` + `patch-id`) per lookup.
 * Keyed by absolute repo root so concurrent worktrees never collide.
 */
const patchIdCache = new Map<string, string | undefined>();

/** Clears the in-memory patch-id cache (used between tests and on demand). */
export function clearPatchIdCache(): void {
  patchIdCache.clear();
}

/**
 * Computes a stable patch-id for a commit's diff. The patch-id stays the same
 * across cherry-pick and rebase (as long as the diff is unchanged), so it is a
 * reliable identity for "the same change" even when the commit hash changes.
 * Returns undefined for commits with no diff (e.g. merges).
 *
 * Results are memoized for the current extension session keyed by
 * `<repoRoot>:<hash>`; call `clearPatchIdCache()` to force a fresh computation
 * (tests do this between cases).
 */
export async function patchId(cwd: string, hash: string): Promise<string | undefined> {
  const root = (await repoRoot(cwd)) ?? cwd;
  const key = `${root}:${hash}`;
  if (patchIdCache.has(key)) {
    return patchIdCache.get(key);
  }
  // `--root` includes root commits (whose parent-less diff-tree output is
  // otherwise empty); it is harmless on non-root commits.
  const diff = await runGit(["diff-tree", "-p", "--no-color", "--root", hash], { cwd });
  if (diff.code !== 0 || !diff.stdout.trim()) {
    patchIdCache.set(key, undefined);
    return undefined;
  }
  const res = await runGit(["patch-id", "--stable"], { cwd, input: diff.stdout });
  if (res.code !== 0) {
    patchIdCache.set(key, undefined);
    return undefined;
  }
  const id = res.stdout.trim().split(/\s+/)[0] || undefined;
  patchIdCache.set(key, id);
  return id;
}
