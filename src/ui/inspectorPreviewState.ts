export type InspectorActionKind = "single" | "batch";

export interface InspectorSession {
  id: number;
  kind: "preview" | InspectorActionKind;
  hash?: string;
}

type Owner =
  | { state: "preview-pending"; session: InspectorSession }
  | { state: "preview-shown"; session: InspectorSession }
  | { state: "preview-closing"; session: InspectorSession }
  | { state: "action"; session: InspectorSession };

/**
 * Serializes asynchronous hover previews with explicit action inspectors.
 * A slow Git detail query may never replace an action panel started after it,
 * and a queued hover dismissal may close only the preview it owns.
 */
export class InspectorPreviewCoordinator {
  private nextId = 1;
  private owner?: Owner;

  beginPreview(hash: string): InspectorSession | undefined {
    // An explicit right-click/keyboard action panel owns the companion surface
    // until external editor interaction closes it. Hover must not replace it.
    if (this.owner?.state === "action") return undefined;
    const session: InspectorSession = { id: this.nextId++, kind: "preview", hash };
    this.owner = { state: "preview-pending", session };
    return session;
  }

  canShowPreview(session: InspectorSession): boolean {
    return this.owner?.state === "preview-pending" && this.same(this.owner.session, session);
  }

  showPreview(session: InspectorSession): boolean {
    if (!this.canShowPreview(session)) return false;
    this.owner = { state: "preview-shown", session };
    return true;
  }

  beginAction(kind: InspectorActionKind): InspectorSession {
    const session: InspectorSession = { id: this.nextId++, kind };
    this.owner = { state: "action", session };
    return session;
  }

  canShowAction(session: InspectorSession): boolean {
    return this.owner?.state === "action" && this.same(this.owner.session, session);
  }

  /**
   * Invalidates only a matching hover. A shown preview becomes closing so a
   * delayed timer can prove it still owns the visual panel before closing it.
   */
  dismissPreview(hash: unknown): { session: InspectorSession; shouldClose: boolean } | undefined {
    if (typeof hash !== "string") return undefined;
    const current = this.owner;
    if (!current || current.session.kind !== "preview" || current.session.hash !== hash) return undefined;
    if (current.state === "preview-pending") {
      this.owner = undefined;
      return { session: current.session, shouldClose: false };
    }
    if (current.state === "preview-shown") {
      this.owner = { state: "preview-closing", session: current.session };
      return { session: current.session, shouldClose: true };
    }
    return undefined;
  }

  canClosePreview(session: InspectorSession): boolean {
    return this.owner?.state === "preview-closing" && this.same(this.owner.session, session);
  }

  finishPreviewClose(session: InspectorSession): boolean {
    if (!this.canClosePreview(session)) return false;
    this.owner = undefined;
    return true;
  }

  /** External editor interaction invalidates any in-flight preview/action. */
  invalidate(): void {
    this.owner = undefined;
    this.nextId += 1;
  }

  private same(left: InspectorSession, right: InspectorSession): boolean {
    return left.id === right.id && left.kind === right.kind && left.hash === right.hash;
  }
}
