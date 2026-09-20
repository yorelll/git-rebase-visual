/**
 * Small LRU cache for immutable commit metadata. Git commit objects cannot
 * change, so an entry remains correct until the repository changes; the size
 * limit prevents a long-running TreeView from retaining an unbounded history.
 */
export class CommitDetailCache<T> {
  private readonly values = new Map<string, T>();
  private readonly pending = new Map<string, Promise<T>>();

  constructor(private readonly maxEntries = 64) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("maxEntries must be a positive integer.");
    }
  }

  get(key: string): T | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    // Map insertion order is the LRU order. Refresh the accessed entry.
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  /** Coalesces concurrent reads for one immutable commit and caches successes. */
  getOrLoad(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const request = load().then((value) => {
      this.pending.delete(key);
      this.values.set(key, value);
      while (this.values.size > this.maxEntries) {
        const oldest = this.values.keys().next().value as string | undefined;
        if (!oldest) break;
        this.values.delete(oldest);
      }
      return value;
    }, (error) => {
      this.pending.delete(key);
      throw error;
    });
    this.pending.set(key, request);
    return request;
  }

  clear(): void {
    this.values.clear();
    this.pending.clear();
  }

  get size(): number {
    return this.values.size;
  }
}
