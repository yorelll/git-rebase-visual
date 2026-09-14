export interface CanonicalSnapshotInput {
  repository: string;
  branch?: string;
  range: string;
  rebaseInProgress: boolean;
  hashesNewestFirst: readonly string[];
  lockedHashes: ReadonlySet<string>;
}

/**
 * Produces the safety identity for an actionable commit timeline. Refreshes that
 * only update worktree counts, authors, or other presentation details preserve
 * the identity; history/range/rebase/lock changes invalidate old reorder intent.
 */
export function canonicalSnapshotKey(input: CanonicalSnapshotInput): string {
  return [
    input.repository,
    input.branch ?? "",
    input.range,
    input.rebaseInProgress ? "rebase" : "normal",
    ...input.hashesNewestFirst,
    "locks",
    ...[...input.lockedHashes].sort(),
  ].join("\0");
}

/** Advances the public revision only when the actionable timeline changed. */
export function nextCanonicalSnapshotRevision(
  previous: { key?: string; revision: number },
  input: CanonicalSnapshotInput
): { key: string; revision: number } {
  const key = canonicalSnapshotKey(input);
  return {
    key,
    revision: previous.key === key ? previous.revision : previous.revision + 1,
  };
}
