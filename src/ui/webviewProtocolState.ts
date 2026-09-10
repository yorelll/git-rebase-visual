export interface WebviewProtocolTrace {
  postMessageCount: number;
  persistedStateCount: number;
  menuOpen: boolean;
  menuScrollCloseCount: number;
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

  snapshot(): Readonly<WebviewProtocolTrace> {
    return { ...this.trace };
  }
}
