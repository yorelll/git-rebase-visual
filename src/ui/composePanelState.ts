import { ComposePayload } from "./composePanel";

/**
 * Keeps the newest compose payload until a webview explicitly confirms that its
 * message listener has been installed. This makes panel creation/reload timing
 * independent from postMessage delivery timing.
 */
export class ComposePanelDelivery {
  private ready = false;
  private latest?: ComposePayload;

  update(payload: ComposePayload): ComposePayload | undefined {
    this.latest = payload;
    return this.ready ? payload : undefined;
  }

  markReady(): ComposePayload | undefined {
    this.ready = true;
    return this.latest;
  }

  reset(): void {
    this.ready = false;
  }

  get isReady(): boolean {
    return this.ready;
  }
}
