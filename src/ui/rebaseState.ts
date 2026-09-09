export type RebasePauseReason = "conflict" | "edit" | "paused" | undefined;

export interface RebasePauseState {
  conflictFiles: string[];
  conflictCount: number;
  pausedReason: RebasePauseReason;
}

export interface RebaseProgressState extends RebasePauseState {
  /** Executable todo steps. undefined means an external backend cannot be read reliably. */
  totalSteps?: number;
  completedSteps?: number;
  activeHash?: string;
  /** Original hashes that Git has not replayed and must never look stable. */
  pendingHashes: string[];
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

/** Parse interactive-rebase todo/done lines. Comments and commands without a hash are ignored. */
export function rebaseProgressState(input: {
  rebaseInProgress: boolean;
  atEditStop: boolean;
  conflictFiles: string[];
  doneLines?: string[];
  todoLines?: string[];
  stoppedHash?: string;
}): RebaseProgressState {
  const pause = rebasePauseState(input.rebaseInProgress, input.atEditStop, input.conflictFiles);
  if (!input.rebaseInProgress || !input.doneLines || !input.todoLines) {
    return { ...pause, pendingHashes: [] };
  }
  const parse = (lines: string[]) => lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.match(/^(?:pick|p|reword|r|edit|e|squash|s|fixup|f|drop|d)\s+([0-9a-f]{7,40})\b/i)?.[1])
    .filter((hash): hash is string => !!hash);
  const done = parse(input.doneLines);
  const todo = parse(input.todoLines);
  // A current edit is already represented by `done`; a conflict's failed pick
  // remains in todo. Both interpretations preserve the safety rule: only todo
  // hashes are pending originals.
  return {
    ...pause,
    totalSteps: done.length + todo.length,
    completedSteps: done.length,
    activeHash: input.stoppedHash,
    pendingHashes: todo,
  };
}
