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
 * resolved.
 */
export function rebasePauseState(
  rebaseInProgress: boolean,
  stoppedAt: string | undefined,
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
        : stoppedAt
          ? "edit"
          : "paused",
  };
}
