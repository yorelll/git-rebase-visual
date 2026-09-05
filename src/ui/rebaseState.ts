export type RebasePauseReason = "conflict" | "edit" | "paused" | undefined;

export interface RebasePauseState {
  conflictFiles: string[];
  conflictCount: number;
  pausedReason: RebasePauseReason;
}

/**
 * Derives the small, serializable part of webview state that describes a
 * paused rebase. Conflict state is deliberately derived from Git on every
 * refresh so the Continue button is only enabled after all unmerged paths are
 * resolved. `atEditStop` must come from the last rebase-merge todo action:
 * stopped-sha alone is also present for a replay conflict and must not be used
 * to mislabel a resolved conflict as an edit stop.
 */
export function rebasePauseState(
  rebaseInProgress: boolean,
  atEditStop: boolean,
  conflictFiles: string[]
): RebasePauseState {
  const files = rebaseInProgress ? [...new Set(conflictFiles)].sort() : [];
  return {
    conflictFiles: files,
    conflictCount: files.length,
    pausedReason: !rebaseInProgress
      ? undefined
      : files.length > 0
        ? "conflict"
        : atEditStop
          ? "edit"
          : "paused",
  };
}
