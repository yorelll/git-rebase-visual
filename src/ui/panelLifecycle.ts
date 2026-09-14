/**
 * Owns one replaceable UI panel without letting an old disposal callback clear a
 * newer panel. The UI adapter retains panel-specific subscriptions separately.
 */
export class PanelLifecycle<T> {
  private active?: PanelLease<T>;
  private nextId = 1;

  open(panel: T): PanelLease<T> {
    const lease = new PanelLease(this, this.nextId++, panel);
    this.active = lease;
    return lease;
  }

  current(): T | undefined {
    return this.active?.panel;
  }

  private release(lease: PanelLease<T>): void {
    if (this.active === lease) this.active = undefined;
  }

  _release(lease: PanelLease<T>): void {
    this.release(lease);
  }
}

export class PanelLease<T> {
  private released = false;

  constructor(
    private readonly owner: PanelLifecycle<T>,
    readonly id: number,
    readonly panel: T
  ) {}

  /** Idempotent: native onDidDispose and extension cleanup can both call it. */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.owner._release(this);
  }
}
