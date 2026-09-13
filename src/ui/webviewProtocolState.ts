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
const mutationActions = new Set([
  "reorder", "drop", "bulkDrop", "bulkLock", "rebaseTo", "lock", "unlock",
  "openCompose", "generate", "apply", "appendStaged", "continueRebase", "abortRebase",
  "skipRebase", "undo", "showUndoHistory", "squash", "fixup", "commitEditAmend", "commitEditNew",
  // These perform git add, git restore, or an explicitly confirmed disk delete.
  "stageFile", "restoreFile",
]);

const readActions = new Set([
  "copyHash", "copyMessage", "openDiff", "generateDiff", "bulkGenerateDiff", "openWorktreeDiff", "requestDetail",
  "copyText", "openLlmSettings", "ready", "refresh",
]);

/**
 * Classifies messages by their host-side effect, not by their visual origin.
 * Every Git/index/worktree/disk write is serialized as a mutation.
 */
export function webviewMessageIntent(type: string): WebviewMessageIntent {
  if (mutationActions.has(type)) return "mutation";
  return readActions.has(type) ? "read" : "ui";
}

/**
 * Whether a message targets a commit from the rendered canonical snapshot.
 * Worktree file actions deliberately do not use this guard: they identify a
 * path and re-read porcelain status immediately before their own operation.
 */
export function requiresCurrentCommitHash(message: {
  type: string;
  mode?: unknown;
  thenEdit?: unknown;
  hash?: unknown;
  [key: string]: unknown;
}): boolean {
  const commitHashActions = new Set([
    "copyHash", "copyMessage", "openDiff", "generateDiff", "requestDetail",
    "drop", "rebaseTo", "lock", "unlock", "appendStaged", "squash", "fixup",
  ]);
  // At an edit stop, openCompose is separately bound to the verified stopped
  // SHA, which can temporarily be outside the normal branch-range snapshot.
  const editStopCompose =
    message.type === "openCompose" &&
    message.mode === "commit" &&
    message.thenEdit === true &&
    typeof message.hash === "string";
  return (
    commitHashActions.has(message.type) ||
    ((message.type === "openCompose" || message.type === "apply") &&
      message.mode === "commit" &&
      !editStopCompose)
  );
}

/**
 * Explicit edit-stop policy. File staging/restoration is intentionally allowed
 * while paused so the edit-stop SCM section remains usable; all other rewrite
 * actions are denied unless a dedicated compose exception is checked by the host.
 */
export function allowedPausedRebaseMutation(type: string): boolean {
  return new Set([
    "continueRebase", "abortRebase", "skipRebase", "commitEditAmend", "commitEditNew",
    "stageFile", "restoreFile",
  ]).has(type);
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
