import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";

type DisposeListener = () => void;
type MessageListener = (message: any) => void;

class FakeDisposable {
  disposed = false;
  constructor(private readonly onDispose: () => void) {}
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onDispose();
  }
}

class FakeWebview {
  html = "";
  readonly posted: any[] = [];
  private readonly messages: Array<{ listener: MessageListener; disposable: FakeDisposable }> = [];
  cspSource = "fake-csp";

  postMessage(message: any): Thenable<boolean> {
    this.posted.push(message);
    return Promise.resolve(true);
  }

  onDidReceiveMessage(listener: MessageListener): FakeDisposable {
    const record = { listener, disposable: undefined as unknown as FakeDisposable };
    const disposable = new FakeDisposable(() => undefined);
    record.disposable = disposable;
    this.messages.push(record);
    return disposable;
  }

  fireMessage(message: any): void {
    for (const { listener, disposable } of this.messages) {
      if (!disposable.disposed) listener(message);
    }
  }

  activeMessageListeners(): number {
    return this.messages.filter(({ disposable }) => !disposable.disposed).length;
  }
}

class FakeWebviewPanel {
  title = "";
  disposed = false;
  readonly webview = new FakeWebview();
  private readonly disposeListeners: Array<{ listener: DisposeListener; disposable: FakeDisposable }> = [];

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fireNativeDispose(false);
  }

  onDidDispose(listener: DisposeListener): FakeDisposable {
    const record = { listener, disposable: undefined as unknown as FakeDisposable };
    const disposable = new FakeDisposable(() => undefined);
    record.disposable = disposable;
    this.disposeListeners.push(record);
    return disposable;
  }

  /** Simulates a callback queued by VS Code before an old listener was disposed. */
  fireNativeDispose(includeDisposed: boolean): void {
    for (const { listener, disposable } of this.disposeListeners) {
      if (includeDisposed || !disposable.disposed) listener();
    }
  }

  activeDisposeListeners(): number {
    return this.disposeListeners.filter(({ disposable }) => !disposable.disposed).length;
  }
}

class FakeVsCodeFactory {
  readonly panels: FakeWebviewPanel[] = [];
  readonly createCalls: Array<{ options: any; webviewOptions: any }> = [];
  readonly api = {
    window: {
      createWebviewPanel: (_viewType: string, _title: string, options: any, webviewOptions: any) => {
        this.createCalls.push({ options, webviewOptions });
        const panel = new FakeWebviewPanel();
        this.panels.push(panel);
        return panel;
      },
    },
    ViewColumn: { Beside: 2 },
  };
}

function payload(shortHash: string) {
  return {
    kind: "single" as const,
    revision: 1,
    commit: {
      hash: shortHash.padEnd(40, "a"),
      shortHash,
      subject: `subject-${shortHash}`,
      author: "Reviewer",
      date: "today",
      locked: false,
    },
    llmConfigured: true,
    rebaseInProgress: false,
    hasStaged: false,
  };
}

test("CommitInspectorPanel adapter survives host close, delayed old dispose, and repeated reopen without listener accumulation", () => {
  const factory = new FakeVsCodeFactory();
  const moduleLoader = Module as unknown as {
    _load(request: string, parent: unknown, isMain: boolean): unknown;
  };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "vscode") return factory.api;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    // Load the actual adapter only after its VS Code runtime dependency is faked.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CommitInspectorPanel } = require("../src/ui/commitInspectorPanel") as typeof import("../src/ui/commitInspectorPanel");
    const received: any[] = [];
    const inspector = new CommitInspectorPanel({} as any, (message: any) => received.push(message));

    inspector.open(payload("first"));
    const first = factory.panels[0]!;
    assert.deepEqual(factory.createCalls[0]?.options, { viewColumn: 2, preserveFocus: true }, "opening inspector preserves the existing active editor and cannot self-trigger its close bridge");
    assert.equal(first.disposed, false, "panel remains open immediately after creation");
    assert.equal(first.webview.posted.length, 1);
    assert.equal(first.webview.activeMessageListeners(), 1);
    assert.equal(first.activeDisposeListeners(), 1);

    // A subsequent real external editor change invokes the host bridge and closes
    // the panel. The explicit close models that public provider callback.
    inspector.close();
    assert.equal(first.disposed, true);
    assert.equal(first.webview.activeMessageListeners(), 0);
    assert.equal(first.activeDisposeListeners(), 0);

    inspector.open(payload("second"));
    const second = factory.panels[1]!;
    assert.equal(factory.panels.length, 2, "host close followed by right-click creates a new inspector");
    assert.equal(second.webview.posted.length, 1);
    assert.equal(second.webview.activeMessageListeners(), 1);
    assert.equal(second.activeDisposeListeners(), 1);

    first.fireNativeDispose(true); // a delayed old callback must not clear second
    inspector.open(payload("second-again"));
    assert.equal(factory.panels.length, 2, "delayed old dispose preserves the current panel");
    assert.equal(second.webview.posted.length, 2, "current panel receives the next show payload exactly once");
    assert.equal(second.webview.activeMessageListeners(), 1);
    assert.equal(second.activeDisposeListeners(), 1);

    second.webview.fireMessage({ type: "copyHash" });
    assert.deepEqual(received, [{ type: "copyHash" }], "message listener is attached exactly once to the current panel");
    inspector.close();
    assert.equal(second.webview.activeMessageListeners(), 0);
    assert.equal(second.activeDisposeListeners(), 0);

    inspector.open(payload("third"));
    const third = factory.panels[2]!;
    assert.equal(factory.panels.length, 3, "second host close permits another reopen");
    assert.equal(third.webview.activeMessageListeners(), 1);
    assert.equal(third.activeDisposeListeners(), 1);
    inspector.dispose();
    assert.equal(third.webview.activeMessageListeners(), 0);
    assert.equal(third.activeDisposeListeners(), 0);
  } finally {
    moduleLoader._load = originalLoad;
  }
});
