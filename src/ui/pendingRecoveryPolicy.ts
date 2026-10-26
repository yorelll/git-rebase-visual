/**
 * Pure policy for surfacing pending-recovery warnings.
 *
 * Recovery runs on a 1.5 s poll, so warning on every pass would spam the user
 * with an unstoppable loop of identical messages. A warning is emitted once per
 * distinct `(stash sha, reason)` pair; repeats only reach the file log. The
 * returned state is immutable so tests can assert the exact sequence.
 */
export interface PendingWarningState {
  /** Keys already surfaced, in first-seen order. */
  readonly seen: readonly string[];
  /**
   * The single persistent banner currently shown, or undefined when dismissed
   * or cleared. The text lives here so the banner is rendered from this state
   * rather than re-derived from the record on every refresh — otherwise a
   * dismissal would be undone by the very next poll.
   */
  readonly banner?: { readonly key: string; readonly text: string };
}

export const EMPTY_PENDING_WARNINGS: PendingWarningState = { seen: [] };

/** Stable identity for one warning: a different stash or reason warns again. */
export function pendingWarningKey(stashSha: string, reason: string): string {
  return `${stashSha}::${reason}`;
}

/** Text of the banner currently armed, or undefined when none is shown. */
export function currentBannerText(state: PendingWarningState): string | undefined {
  return state.banner?.text;
}

/**
 * Records a pending finding. `shouldNotify` is true only the first time this
 * exact key is seen, so polling cannot re-notify; the banner stays armed while
 * the same problem persists and re-arms only for a different key.
 *
 * An armed banner's *text* is refreshed on every pass, because it names a
 * `stash@{n}` slot and slots are positions: a concurrent `git stash push` moves
 * the same stash to `stash@{1}` while the key (sha + reason) is unchanged. The
 * key governs notification, the text governs what the user is told to run, and
 * freezing the latter at first sighting would print a command that now targets
 * a different stash. A *dismissed* banner (key seen, nothing armed) stays
 * dismissed — the text refresh must not resurrect it.
 */
export function observePendingWarning(
  state: PendingWarningState,
  stashSha: string,
  reason: string,
  text: string
): { state: PendingWarningState; shouldNotify: boolean; key: string } {
  const key = pendingWarningKey(stashSha, reason);
  if (state.seen.includes(key)) {
    // Already surfaced: no repeated toast. If the banner is still armed, update
    // its text so a shifted slot is re-described; if the user dismissed it, it
    // stays dismissed rather than reappearing on the next poll.
    if (state.banner && state.banner.key === key && state.banner.text !== text) {
      return { state: { seen: state.seen, banner: { key, text } }, shouldNotify: false, key };
    }
    return { state, shouldNotify: false, key };
  }
  return {
    state: { seen: [...state.seen, key], banner: { key, text } },
    shouldNotify: true,
    key,
  };
}

/** Clears the banner and forgets seen keys once no pending record remains. */
export function clearPendingWarnings(state: PendingWarningState): PendingWarningState {
  return state.seen.length === 0 && state.banner === undefined ? state : EMPTY_PENDING_WARNINGS;
}

/** Dismisses the banner without re-arming the same warning. */
export function dismissPendingWarning(state: PendingWarningState): PendingWarningState {
  return state.banner === undefined ? state : { seen: state.seen };
}

/**
 * Single-flight key for a recovery pass. It is keyed by the persisted record's
 * identity, so overlapping refreshes for the same record coalesce into one
 * in-flight restore instead of queueing Git writes.
 */
export function recoveryKey(kind: "stash" | "append", identity: string): string {
  return `${kind}:${identity}`;
}

/** Whether a caller may start recovery, or must await the existing promise. */
export function shouldStartRecovery(inFlight: ReadonlySet<string>, key: string): boolean {
  return !inFlight.has(key);
}

/**
 * Single-flight runner for recovery work. Overlapping refreshes (the 1.5 s poll,
 * workspace events, read messages) all await the same promise per record, so a
 * `stash apply` is never started twice and no unbounded queue can build up.
 */
export class RecoveryCoordinator {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }
    // Register the slot before the task is invoked. Starting the async body
    // first would let a synchronous throw from `task` run its `finally`
    // (deleting the map entry) before the entry was ever set, which caches a
    // rejected promise for `key` and permanently poisons it.
    let start!: () => void;
    const gate = new Promise<void>((resolve) => {
      start = resolve;
    });
    const work = gate.then(async () => {
      try {
        return await task();
      } finally {
        this.inFlight.delete(key);
      }
    });
    this.inFlight.set(key, work);
    start();
    return work;
  }

  /** Number of records currently being recovered (test/diagnostic surface). */
  get size(): number {
    return this.inFlight.size;
  }
}

/**
 * Outcome shape the recovery loop needs; the Git module supplies the rest.
 *
 * Note what is absent: there is no "dropped" channel. A settled recovery may
 * report the stash it *kept* (`stashKept`), never one it removed — the
 * extension never deletes a stash automatically.
 */
export interface RecoverableOutcome {
  kind: "none" | "resolved" | "restored" | "pending";
  /** Diagnostic detail; present on every concrete outcome but not modelled here. */
  detail?: string;
  stashKept?: { name?: string; sha: string };
}

export interface RecoveryHooks<R extends RecoverableOutcome> {
  pendingStash(): string | undefined;
  pendingAppend(): { changeStash: string } | undefined;
  reconcileStash(sha: string): Promise<R>;
  reconcileAppend(record: { changeStash: string }): Promise<R>;
  settleStash(outcome: R, sha: string): Promise<void>;
  settleAppend(outcome: R, record: { changeStash: string }): Promise<void>;
  /**
   * Runs the Git-writing part of a pass under a lock. Returning `undefined`
   * means the lock was busy and the work was skipped (never queued), so the
   * next poll retries. Without this hook the pass runs unlocked.
   */
  locked?<T>(work: () => Promise<T>): Promise<T | undefined>;
}

/**
 * Runs one reconciliation pass. Each persisted record is reconciled exactly once
 * per pass even when refreshes overlap, and settling (clearing the record or
 * arming a warning) happens inside the same single-flight slot so a second pass
 * can never settle the same record twice.
 *
 * The whole pass shares one lock acquisition: recovery issues six to fourteen
 * sequential Git calls, and a poll must never start a `stash apply` while a
 * user-initiated rebase is writing the same index.
 */
export async function runPendingRecovery<R extends RecoverableOutcome>(
  coordinator: RecoveryCoordinator,
  hooks: RecoveryHooks<R>
): Promise<{ stash?: R; append?: R }> {
  const runPass = async (): Promise<{ stash?: R; append?: R }> => {
    const result: { stash?: R; append?: R } = {};

    const stashSha = hooks.pendingStash();
    if (stashSha) {
      result.stash = await coordinator.run(recoveryKey("stash", stashSha), async () => {
        const outcome = await hooks.reconcileStash(stashSha);
        await hooks.settleStash(outcome, stashSha);
        return outcome;
      });
    }

    // Re-read after the stash pass: settling may already have cleared the record.
    const append = hooks.pendingAppend();
    if (append) {
      result.append = await coordinator.run(recoveryKey("append", append.changeStash), async () => {
        const outcome = await hooks.reconcileAppend(append);
        await hooks.settleAppend(outcome, append);
        return outcome;
      });
    }

    return result;
  };

  if (hooks.locked) {
    const result = await hooks.locked(runPass);
    // Lock busy: not an error and not a settlement. The record is untouched and
    // the next refresh retries it.
    return result ?? {};
  }
  return runPass();
}
