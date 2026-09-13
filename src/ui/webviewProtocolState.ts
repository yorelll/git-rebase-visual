export interface WebviewProtocolTrace {
  postMessageCount: number;
  persistedStateCount: number;
  menuOpen: boolean;
  menuScrollCloseCount: number;
  hostCloseCount: number;
  mutationCount: number;
  warningCount: number;
  sources: string[];
}

export type WebviewMessageIntent = "ui" | "read" | "mutation";

/**
 * Classifies webview traffic before host handling. Only explicit Git-writing
 * actions are mutations; refresh, pointer, focus, selection, composition and
 * toast traffic must remain notification-free during a paused rebase.
 */
export function webviewMessageIntent(type: string): WebviewMessageIntent {
  return new Set([
    "reorder", "drop", "bulkDrop", "bulkLock", "rebaseTo", "lock", "unlock",
    "openCompose", "generate", "apply", "appendStaged", "continueRebase", "abortRebase",
    "skipRebase", "undo", "showUndoHistory", "squash", "fixup", "commitEditAmend", "commitEditNew",
  ]).has(type) ? "mutation" : new Set([
    "copyHash", "copyMessage", "openDiff", "generateDiff", "bulkGenerateDiff", "openWorktreeDiff", "stageFile", "requestDetail",
    "copyText", "openLlmSettings", "ready", "refresh",
  ]).has(type) ? "read" : "ui";
}

/** True when this message is allowed to write while an external rebase pauses. */
export function allowedPausedRebaseMutation(type: string): boolean {
  return new Set(["continueRebase", "abortRebase", "skipRebase", "commitEditAmend", "commitEditNew", "stageFile"]).has(type);
}

/**
 * Models the deliberately local scroll-close behavior used by the commits
 * webview. Closing an already-open menu changes only DOM-local state: it must
 * not post a host mutation or persist UI state.
 */
export class WebviewProtocolState {
  private trace: WebviewProtocolTrace = {
    postMessageCount: 0,
    persistedStateCount: 0,
    menuOpen: false,
    menuScrollCloseCount: 0,
    hostCloseCount: 0,
    mutationCount: 0,
    warningCount: 0,
    sources: [],
  };

  openMenu(): void {
    this.trace.menuOpen = true;
  }

  closeMenuFromScroll(): void {
    this.trace.menuScrollCloseCount += 1;
    this.trace.menuOpen = false;
  }

  postMessage(): void {
    this.trace.postMessageCount += 1;
  }

  persistState(): void {
    this.trace.persistedStateCount += 1;
  }

  closeMenuFromHost(): void {
    this.trace.hostCloseCount += 1;
    this.trace.menuOpen = false;
  }

  observe(type: string, source: string, pausedRebase: boolean): void {
    this.trace.sources.push(`${source}:${type}`);
    if (webviewMessageIntent(type) === "mutation") {
      this.trace.mutationCount += 1;
      if (pausedRebase && !allowedPausedRebaseMutation(type)) this.trace.warningCount += 1;
    }
  }

  snapshot(): Readonly<WebviewProtocolTrace> {
    return { ...this.trace };
  }
}
