import { randomBytes } from "crypto";

export interface GeneratedDiffSnapshot {
  repository: string;
  content: string;
  language: string;
}

export interface GeneratedDiffSnapshotStore {
  create(snapshot: GeneratedDiffSnapshot): string;
  resolve(id: string): GeneratedDiffSnapshot | undefined;
  invalidateRepository(repository: string): void;
  clear(): void;
  size(): number;
}

/**
 * Bounded, opaque storage for generated-Diff snapshots. The URI only contains a
 * random request ID: it cannot be repurposed to request an arbitrary repository
 * or Git object. Content is copied on creation and never recomputed after a Git
 * refresh, so an open virtual document remains the exact generated snapshot.
 */
export function createGeneratedDiffSnapshotStore(
  options: { now?: () => number; ttlMs?: number; maxEntries?: number; token?: () => string } = {}
): GeneratedDiffSnapshotStore {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const maxEntries = options.maxEntries ?? 64;
  let sequence = 0;
  const token = options.token ?? (() => `${randomBytes(18).toString("base64url")}-${(++sequence).toString(36)}`);
  const entries = new Map<string, { snapshot: GeneratedDiffSnapshot; expiresAt: number }>();

  const purge = () => {
    const current = now();
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(id);
    }
  };

  return {
    create(snapshot) {
      if (!snapshot.repository || typeof snapshot.content !== "string" || !snapshot.language) {
        throw new Error("无效的生成 Diff 快照。");
      }
      purge();
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value as string | undefined;
        if (!oldest) break;
        entries.delete(oldest);
      }
      let id = token();
      while (entries.has(id)) id = token();
      entries.set(id, {
        snapshot: { ...snapshot },
        expiresAt: now() + ttlMs,
      });
      return id;
    },
    resolve(id) {
      purge();
      const entry = entries.get(id);
      if (!entry) return undefined;
      // A resolved document counts as recently used but stays immutable.
      entries.delete(id);
      entries.set(id, entry);
      return { ...entry.snapshot };
    },
    invalidateRepository(repository) {
      for (const [id, entry] of entries) {
        if (entry.snapshot.repository === repository) entries.delete(id);
      }
    },
    clear() {
      entries.clear();
    },
    size() {
      purge();
      return entries.size;
    },
  };
}
