export type RebasePauseReason = "conflict" | "edit" | "paused" | undefined;

/** Validates an exact, non-empty commit-hash selection against one snapshot. */
export function currentCommitSelection(value: unknown, currentHashes: Iterable<string>): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const known = new Set(currentHashes);
  const selected = new Set<string>();
  for (const hash of value) {
    if (typeof hash !== "string" || !/^[0-9a-f]{40}$/i.test(hash) || !known.has(hash) || selected.has(hash)) {
      return undefined;
    }
    selected.add(hash);
  }
  return [...selected];
}

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

interface ParsedTodoStep {
  /** Original commit hash when this command replays one; never inferred. */
  hash?: string;
}

/**
 * Parses one known interactive-rebase command. `exec`, `break`, and the merge
 * workflow commands are real executable steps but deliberately have no hash.
 * Unknown lines make the whole progress view unknown rather than guessing.
 */
function parseTodoStep(line: string): ParsedTodoStep | undefined | "unknown" {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const commit = trimmed.match(/^(?:pick|p|reword|r|edit|e|squash|s|fixup|f|drop|d)\s+([0-9a-f]{7,40})\b/i);
  if (commit) return { hash: commit[1] };
  if (/^(?:exec|x)\s+\S/i.test(trimmed) || /^(?:break|b|label|l|reset|t|merge|m|update-ref|u)\b/i.test(trimmed)) {
    return {};
  }
  return "unknown";
}

/**
 * Parse interactive-rebase todo/done files. A progress count is emitted only
 * when every non-comment command uses a known rebase-todo syntax. Commands
 * without an original commit (`exec`, `break`, labels, and merges) count as
 * steps but are never represented as pending hashes.
 */
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
  const parse = (lines: string[]): ParsedTodoStep[] | undefined => {
    const steps: ParsedTodoStep[] = [];
    for (const line of lines) {
      const step = parseTodoStep(line);
      if (step === "unknown") return undefined;
      if (step) steps.push(step);
    }
    return steps;
  };
  const done = parse(input.doneLines);
  const todo = parse(input.todoLines);
  if (!done || !todo) {
    // A custom/unknown backend command cannot be mapped faithfully to N/M or a
    // stable original hash. Preserve only the independently derived pause state.
    return { ...pause, pendingHashes: [] };
  }
  // A current edit is already represented by `done`; a conflict's failed pick
  // remains in todo. Both interpretations preserve the safety rule: only todo
  // hashes are pending originals.
  return {
    ...pause,
    totalSteps: done.length + todo.length,
    completedSteps: done.length,
    activeHash: /^[0-9a-f]{7,40}$/i.test(input.stoppedHash ?? "") ? input.stoppedHash : undefined,
    pendingHashes: todo.flatMap((step) => step.hash ? [step.hash] : []),
  };
}
