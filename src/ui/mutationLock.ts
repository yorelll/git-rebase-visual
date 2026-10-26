/**
 * Identifies who currently owns the host-side write lock. A naked boolean
 * cannot explain a rejection, and cannot be released once the owning promise
 * has settled without clearing it.
 */
export interface MutationOwner {
  id: number;
  /** Machine action name, e.g. `reorder` or `push`. */
  action: string;
  /** Short human label shown in the busy message, e.g. 「变基」. */
  label: string;
  /** Where the mutation came from, e.g. `webview:reorder` or `command`. */
  source: string;
  startedAt: number;
  /** Set when the owner's task promise settled, even if release was lost. */
  settled?: boolean;
}

export interface MutationRejection {
  ok: false;
  owner: MutationOwner;
  /** Human-readable owner description, e.g. `“变基” (reorder, webview, 12s)`. */
  description: string;
  /** A stale owner (watchdog deadline exceeded) may be force-released. */
  stale: boolean;
}

export type MutationAcquireResult =
  | { ok: true; owner: MutationOwner }
  | { ok: false; owner: MutationOwner | undefined };

/** Default deadline after which a lock is considered stuck and actionable. */
export const DEFAULT_STALE_AFTER_MS = 90_000;

export interface MutationLockOptions {
  now?: () => number;
  /** A lock older than this is reported as stale (never auto-released). */
  staleAfterMs?: number;
}

/**
 * Owned, observable replacement for `private busy = false`.
 *
 * The lock never decides policy on its own; it only answers "who owns a write
 * right now?" and whether that owner has outlived its deadline. Releasing is
 * idempotent and owner-checked, so a late `finally` from a superseded owner can
 * never clear the lock of a newer one.
 */
export class MutationLock {
  private currentOwner?: MutationOwner;
  private nextId = 1;
  private readonly now: () => number;
  readonly staleAfterMs: number;

  constructor(options: MutationLockOptions = {}) {
    this.now = options.now ?? Date.now;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  /** Returns the live owner, or undefined when no mutation is in flight. */
  current(): MutationOwner | undefined {
    return this.currentOwner;
  }

  /** True while any mutation holds the lock (stale owners included). */
  isBusy(): boolean {
    return this.currentOwner !== undefined;
  }

  /** Milliseconds the current owner has held the lock. */
  elapsedMs(): number {
    return this.currentOwner ? Math.max(0, this.now() - this.currentOwner.startedAt) : 0;
  }

  /** True when the current owner exceeded the watchdog deadline. */
  isStale(): boolean {
    return this.currentOwner ? this.elapsedMs() >= this.staleAfterMs : false;
  }

  /**
   * Attempts to acquire the lock. On failure the caller receives the current
   * owner so the rejection can name it; it never waits.
   */
  tryAcquire(entry: { action: string; label: string; source: string }): MutationAcquireResult {
    if (this.currentOwner) {
      return { ok: false, owner: this.currentOwner };
    }
    const owner: MutationOwner = {
      id: this.nextId++,
      action: entry.action,
      label: entry.label,
      source: entry.source,
      startedAt: this.now(),
    };
    this.currentOwner = owner;
    return { ok: true, owner };
  }

  /**
   * Releases the lock held by `owner`. A different (newer) owner is untouched,
   * which makes a late cleanup from a superseded mutation harmless.
   */
  release(owner: MutationOwner | undefined): boolean {
    if (!this.currentOwner || this.currentOwner !== owner) {
      return false;
    }
    this.currentOwner = undefined;
    return true;
  }

  /**
   * Recovery path for a lock whose owner promise never settled (or whose
   * release was otherwise lost). Deliberately can also clear a lock that is not
   * yet "stale": the caller must first re-read Git state and confirm the write
   * is really gone.
   */
  forceRelease(): MutationOwner | undefined {
    const previous = this.currentOwner;
    this.currentOwner = undefined;
    return previous;
  }

  /**
   * Records that the owner's task promise settled. If its `finally` release was
   * lost, `reapSettled()` frees the lock on the next message instead of leaving
   * the user stuck behind a mutation that already finished.
   */
  markSettled(owner: MutationOwner | undefined): void {
    if (owner) owner.settled = true;
  }

  /** Releases the current owner when its task already settled. */
  reapSettled(): MutationOwner | undefined {
    if (!this.currentOwner?.settled) return undefined;
    const previous = this.currentOwner;
    this.currentOwner = undefined;
    return previous;
  }

  /** Builds the actionable rejection payload shared by every busy message. */
  rejection(owner: MutationOwner | undefined, nowMs = this.now()): MutationRejection | undefined {
    if (!owner) return undefined;
    const seconds = Math.max(0, Math.round((nowMs - owner.startedAt) / 1000));
    const description = `“${owner.label}” (${owner.action}, ${shortSource(owner.source)}, ${seconds}s)`;
    return {
      ok: false,
      owner,
      description,
      stale: nowMs - owner.startedAt >= this.staleAfterMs,
    };
  }
}

/** Collapses `webview:worktree-mutation` to `webview` for compact messages. */
export function shortSource(source: string): string {
  const colon = source.indexOf(":");
  return colon > 0 ? source.slice(0, colon) : source;
}

/**
 * Human labels used in busy/stuck messages. The machine action name is already
 * in the message, so this only needs to be recognizable at a glance. Kept next
 * to the lock so every caller names the same action the same way.
 */
const MUTATION_LABELS: Record<string, string> = {
  reorder: "变基重排",
  drop: "删除 commit",
  bulkDrop: "批量删除",
  bulkLock: "批量锁定",
  rebaseTo: "停靠变基",
  lock: "锁定 commit",
  unlock: "解除锁定",
  openCompose: "编辑 message",
  generate: "AI 生成",
  apply: "应用 message",
  appendStaged: "追加暂存区",
  continueRebase: "Continue",
  abortRebase: "Abort",
  skipRebase: "Skip",
  undo: "撤销",
  showUndoHistory: "操作历史",
  squash: "squash",
  fixup: "fixup",
  commitEditAmend: "amend",
  commitEditNew: "新建 commit",
  stageFile: "暂存文件",
  restoreFile: "恢复文件",
  stageAllFiles: "暂存全部",
  discardAllFiles: "恢复全部改动",
  unstageAllFiles: "撤销全部暂存",
  push: "推送",
};

/** Display label for an action; unknown actions fall back to their machine name. */
export function mutationActionLabel(action: string): string {
  return MUTATION_LABELS[action] ?? action;
}

/**
 * Inline busy message naming the actual owner. Kept short enough for a toast;
 * the force-release action is a separate recovery command.
 */
export function busyRejectionMessage(rejection: MutationRejection): string {
  return `正在执行 ${rejection.description}；请等待完成或运行“强制解除”。`;
}

/**
 * Watchdog message: names the owner, states the elapsed time, and offers the
 * recovery action without implying the Git state is known to be broken.
 */
export function staleLockMessage(rejection: MutationRejection, elapsedMs: number): string {
  return `操作 ${rejection.description} 已超过 ${Math.round(elapsedMs / 1000)}s 未完成（id ${rejection.owner.id}）。若本地 Git 操作已结束，可强制解除并刷新。`;
}

/** One-line diagnostic recorded when a component is suspected to be stuck. */
export function staleLockDiagnostic(rejection: MutationRejection, elapsedMs: number): string {
  const owner = rejection.owner;
  return [
    "mutation-stuck",
    `id=${owner.id}`,
    `action=${owner.action}`,
    `label=${owner.label}`,
    `source=${owner.source}`,
    `startedAt=${new Date(owner.startedAt).toISOString()}`,
    `elapsedMs=${elapsedMs}`,
  ].join(" ");
}
