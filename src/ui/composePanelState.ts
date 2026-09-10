import { ComposePayload } from "./composePanel";

export interface ComposeSessionPayload extends ComposePayload {
  /** Identifies the exact target/revision that opened the editor surface. */
  sessionId: string;
  revision: number;
}

/**
 * Stores the most recent payload only after a listener-ready acknowledgement.
 * A dirty browser draft remains authoritative across a reload of the same
 * session; a different target/revision intentionally replaces it.
 */
export interface ComposeDraft {
  sessionId: string;
  revision: number;
  draft: string;
}

function sessionKey(sessionId: string, revision: number): string {
  return `${sessionId}|${revision}`;
}

function matchesComposeDraft(payload: ComposeSessionPayload, draft?: ComposeDraft): boolean {
  return !!draft && draft.sessionId === payload.sessionId && draft.revision === payload.revision;
}

/**
 * Queues the newest host payload until the document has installed its listener.
 * `composeReady` is an acknowledgement for the currently rendered document, not
 * authority to replace a different session's dirty draft.
 */
export class ComposePanelDelivery {
  private ready = false;
  private latest?: ComposeSessionPayload;
  private acknowledgedKey?: string;

  update(payload: ComposeSessionPayload): ComposeSessionPayload | undefined {
    this.latest = payload;
    return this.ready ? payload : undefined;
  }

  markReady(sessionId?: unknown, revision?: unknown): ComposeSessionPayload | undefined {
    this.ready = true;
    this.acknowledgedKey = typeof sessionId === "string" && typeof revision === "number"
      ? sessionKey(sessionId, revision)
      : undefined;
    return this.latest;
  }

  /** A UI draft is valid only for the exact target/revision that created it. */
  shouldReplaceDraft(sessionId: unknown, revision: unknown): boolean {
    if (!this.latest || typeof sessionId !== "string" || typeof revision !== "number") return true;
    return this.latest.sessionId !== sessionId || this.latest.revision !== revision;
  }

  /**
   * Returns an exact recovery copy only. A stale draft must never be offered to
   * the current payload merely because `latest` happens to describe another
   * target during a refresh race.
   */
  draftFor(payload: ComposeSessionPayload, draft?: ComposeDraft): string | undefined {
    return draft && matchesComposeDraft(payload, draft) ? draft.draft : undefined;
  }

  reset(): void {
    this.ready = false;
    this.acknowledgedKey = undefined;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get acknowledged(): boolean {
    return !!this.acknowledgedKey;
  }

  get latestPayload(): ComposeSessionPayload | undefined {
    return this.latest;
  }
}

export function composeSessionKey(sessionId: string, revision: number): string {
  return sessionKey(sessionId, revision);
}

export { matchesComposeDraft };
