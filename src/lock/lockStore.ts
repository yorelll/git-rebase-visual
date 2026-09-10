import type { Memento } from "vscode";
import { patchId } from "../git/commitLog";

const KEY = "gitRebaseVisual.locks.v2";

interface LockEntry {
  hash: string; // the hash at lock time (for display / fallback)
  patchId?: string; // stable identity across rebase / cherry-pick
}

type LockMap = Record<string, LockEntry[]>; // repoRoot -> entries

/**
 * Persists locked commits per repository in the extension's globalState.
 *
 * Locks are matched primarily by git patch-id, which is stable across rebase
 * and cherry-pick even though the commit hash changes. The hash is kept as a
 * fallback (and for commits without a diff, such as merges). This means a
 * locked commit stays locked after you reorder history or cherry-pick it
 * elsewhere, instead of silently "unlocking" when its hash changes.
 */
export class LockStore {
  constructor(private readonly memento: Memento) {}

  private read(): LockMap {
    return this.memento.get<LockMap>(KEY, {});
  }

  private async write(map: LockMap): Promise<void> {
    await this.memento.update(KEY, map);
  }

  private entries(repoRoot: string): LockEntry[] {
    return this.read()[repoRoot] ?? [];
  }

  async lock(repoRoot: string, hash: string, pid?: string): Promise<void> {
    await this.lockMany(repoRoot, [{ hash, patchId: pid }]);
  }

  /** Writes a deduplicated multi-lock set with one memento update. */
  async lockMany(repoRoot: string, entries: Array<{ hash: string; patchId?: string }>): Promise<void> {
    const map = this.read();
    const list = [...(map[repoRoot] ?? [])];
    for (const entry of entries) {
      const exists = list.some((existing) =>
        entry.patchId ? existing.patchId === entry.patchId : existing.hash === entry.hash
      );
      if (!exists) list.push(entry);
    }
    if (list.length === 0) return;
    map[repoRoot] = list;
    await this.write(map);
  }

  /** Unlocks by matching either patch-id or hash. */
  async unlock(repoRoot: string, hash: string, pid?: string): Promise<void> {
    const map = this.read();
    const list = map[repoRoot] ?? [];
    const next = list.filter((e) => {
      const samePatch = pid && e.patchId ? e.patchId === pid : false;
      const sameHash = e.hash === hash;
      return !(samePatch || sameHash);
    });
    if (next.length === 0) {
      delete map[repoRoot];
    } else {
      map[repoRoot] = next;
    }
    await this.write(map);
  }

  /** True when the given hash/patch-id corresponds to a locked commit. */
  isLocked(repoRoot: string, hash: string, pid?: string): boolean {
    return this.entries(repoRoot).some((e) => {
      if (pid && e.patchId && e.patchId === pid) {
        return true;
      }
      return e.hash === hash;
    });
  }

  /** Whether any locks exist for this repo (used to skip patch-id computation). */
  hasLocks(repoRoot: string): boolean {
    return this.entries(repoRoot).length > 0;
  }

  /** All locked patch-ids for this repo. */
  lockedPatchIds(repoRoot: string): Set<string> {
    return new Set(
      this.entries(repoRoot)
        .map((e) => e.patchId)
        .filter((p): p is string => !!p)
    );
  }

  /** All locked hashes for this repo (fallback identity). */
  lockedHashes(repoRoot: string): Set<string> {
    return new Set(this.entries(repoRoot).map((e) => e.hash));
  }

  /**
   * Returns expected locked patch identities that were not found after a
   * rewrite. Hash-only locks intentionally do not participate: commits with no
   * patch-id (for example merges) cannot be matched safely after their hash
   * changes. Callers should pass only identities reachable before that rewrite,
   * so locks on an unrelated branch do not create a false warning.
   */
  missingPatchIds(
    repoRoot: string,
    presentPatchIds: ReadonlySet<string>,
    expectedPatchIds: ReadonlySet<string> = this.lockedPatchIds(repoRoot)
  ): string[] {
    return [...expectedPatchIds].filter((patchId) => !presentPatchIds.has(patchId));
  }

  /**
   * Computes the patch-id for a commit (helper so callers don't import both).
   */
  computePatchId(cwd: string, hash: string): Promise<string | undefined> {
    return patchId(cwd, hash);
  }
}
