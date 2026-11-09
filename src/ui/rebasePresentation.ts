import { RangeConfig } from "../git/commitLog";

/** Keeps the note well inside one ellipsised context line. */
export const NOTE_DETAIL_LIMIT = 140;

/**
 * Git tags the line carrying the reason. Usage hints and warnings are untagged.
 *
 * Known limit of preferring the LAST tagged line: if a real failure were
 * followed by another tagged line (say a hook or a cleanup step failing
 * afterwards), that later line would win and the cause would be lost. The
 * alternative — preferring the first tagged line — is worse: the corrupt-object
 * shape prints two `error:` lines before the `fatal:` line that names the
 * object, so "first" would pick the less specific line.
 *
 * No real Git shape that inverts the two has been found. The shapes tried, and
 * why each one does not: a corrupt commit-graph exits 0 and never reaches this
 * code; a corrupt loose object prints `fatal:` last; an unknown revision prints
 * `fatal:` first with the trailing usage hint untagged; missing alternates print
 * `error:` first and then `fatal:`; two corrupt objects still end on `fatal:`.
 * Revisit only if a real shape appears — do not add a "last `fatal:`, else last
 * `error:`" rule for a shape nobody has observed.
 */
const REASON_LINE = /^(fatal|error):/;

/**
 * The single line shown to the user when the ahead/behind count fails.
 *
 * Git's stderr for this failure is multi-line, but `.branch-context` is
 * `height: 29px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis`.
 * Interpolating the whole thing means the browser collapses it to one line and
 * clips the tail.
 *
 * So prefer the **last line tagged `fatal:` or `error:`**, and only fall back to
 * the last non-empty line when there is none. Taking the last non-empty line
 * unconditionally was wrong for a measured shape: `git rev-list` on an unknown
 * revision prints
 *
 *     fatal: ambiguous argument 'ghost/master...HEAD': unknown revision or path not in the working tree.
 *     Use '--' to separate paths from revisions, like this:
 *     'git <command> [<revision>...] -- [<file>...]'
 *
 * where the last line is Git's *usage hint*, not the reason. There is no line
 * Git is guaranteed to print, so match the tags it does use instead.
 *
 * Falls back to the exit code rather than an empty string: a silent `（）` would
 * read as a formatting bug instead of a Git failure.
 */
export function upstreamNoteDetail(counts: { code: number; stdout: string; stderr: string }): string {
  // `\r?\n` rather than `\n`: the stderr came off a pipe on Windows and can
  // still carry CRLF when a hook wrote it.
  const lines = counts.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // Last tagged line, not the first: the corrupt-object shape ends with the
  // `fatal:` line that names the object, which is more specific than its two
  // preceding `error:` lines.
  const last = [...lines].reverse().find((line) => REASON_LINE.test(line)) ?? lines[lines.length - 1];
  if (!last) {
    return `git rev-list 退出码 ${counts.code}`;
  }
  // Truncation keeps the head of the `fatal:` line — that is the half naming the
  // object; the tail ("… is corrupt") is the generic half. Counting by code
  // point rather than by UTF-16 unit so a path with an astral character is not
  // cut into a lone surrogate.
  const chars = Array.from(last);
  return chars.length > NOTE_DETAIL_LIMIT
    ? `${chars.slice(0, NOTE_DETAIL_LIMIT).join("")}…`
    : last;
}

export interface BranchContextInput {
  branchName?: string;
  upstreamRef?: string;
  aheadCount?: number;
  behindCount?: number;
  /**
   * Why ahead/behind could not be computed, when they could not. `undefined`
   * means "nothing to report": either the counts are real, or there is no
   * upstream at all — that case is already stated by `upstreamRef` defaulting to
   * `未配置 upstream`, and saying it twice would read as two separate faults.
   *
   * Scope, which is narrower than "any reason the counts are unknown": this is
   * set only when an upstream **did** resolve but counting against it failed.
   * A pruned, never-fetched, dangling, symref-broken or non-commit tracking ref
   * is reported as `[gone]` by `%(upstream:track)`, so `getUpstream` returns
   * `undefined` before any counting happens and this field is never filled;
   * `upstreamRef` defaults to `未配置 upstream` in that case. If a future change
   * widens the `[gone]` test, those shapes would start arriving here.
   *
   * It is one shared slot on purpose: one field any caller can fill cannot drift
   * out of step with a second precondition check.
   */
  upstreamNote?: string;
  range: RangeConfig;
  rebasing: boolean;
}

export interface BranchContext {
  branchName: string;
  upstreamRef: string;
  aheadCount: number;
  behindCount: number;
  upstreamNote?: string;
  rangeLabel: string;
}

export function rangeLabel(range: RangeConfig): string {
  switch (range.kind) {
    case "upstream": return "范围：upstream..HEAD";
    case "mainBranch": return `范围：${range.mainBranch}..HEAD`;
    case "recentN": return `范围：最近 ${Math.max(1, range.count)} 个 commit`;
    case "all": return "范围：当前分支全部历史";
  }
}

/** Converts optional Git query results into explicit, UI-safe context text. */
export function branchContext(input: BranchContextInput): BranchContext {
  return {
    branchName: input.branchName ?? (input.rebasing ? "detached HEAD（变基中）" : "detached HEAD"),
    upstreamRef: input.upstreamRef ?? "未配置 upstream",
    aheadCount: Math.max(0, input.aheadCount ?? 0),
    behindCount: Math.max(0, input.behindCount ?? 0),
    upstreamNote: input.upstreamNote?.trim() || undefined,
    rangeLabel: rangeLabel(input.range),
  };
}
