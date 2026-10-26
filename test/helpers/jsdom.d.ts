/**
 * Minimal ambient declaration for jsdom.
 *
 * The repository does not depend on `@types/jsdom`: it targets the DOM APIs a
 * real webview has, and layering jsdom's structurally different window type on
 * top only produces false type errors. This shim types exactly what the webview
 * harness uses, so `test/` can be type-checked together with `src/`.
 */
declare module "jsdom" {
  export interface JSDOMOptions {
    runScripts?: "dangerously" | "outside-only";
    url?: string;
    pretendToBeVisual?: boolean;
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: Window & typeof globalThis;
    serialize(): string;
  }
}

/** Trace hook the webview installs for DOM assertions. */
interface Window {
  __grvUiTrace(): Record<string, any>;
}
