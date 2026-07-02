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
    const map = this.read();
    const list = map[repoRoot] ?? [];
    // De-dupe by patchId when present, else by hash.
    const exists = list.some((e) =>
      pid ? e.patchId === pid : e.hash === hash
    );
    if (!exists) {
      list.push({ hash, patchId: pid });
      map[repoRoot] = list;
      await this.write(map);
    }
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
   * Computes the patch-id for a commit (helper so callers don't import both).
   */
  computePatchId(cwd: string, hash: string): Promise<string | undefined> {
    return patchId(cwd, hash);
  }
}
