import Module from "node:module";

/**
 * Minimal `vscode` module stub for provider-level tests.
 *
 * `src/ui/rebaseViewProvider.ts` imports `vscode` at module load. The tests need
 * the real class (to exercise dismissal, the lock and reset behaviour), so the
 * module loader is patched before the import. Only the surface the provider
 * touches is implemented; anything else throws so a missing stub is loud rather
 * than silently undefined.
 */
export interface StubState {
  /** Every message pushed to `vscode.window.show*Message`, newest last. */
  messages: { level: string; text: string; items: string[] }[];
  /** Every `workspaceState`/`globalState` write, for record assertions. */
  mementoWrites: { key: string; value: unknown }[];
  outputLines: string[];
  workspaceFolders: { uri: { fsPath: string } }[] | undefined;
  /** Value returned by showWarningMessage/showInformationMessage. */
  choice?: string;
}

export const stub: StubState = {
  messages: [],
  mementoWrites: [],
  outputLines: [],
  workspaceFolders: undefined,
  choice: undefined,
};

function memoryMemento() {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback?: T): T | undefined =>
      (data.has(key) ? (data.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => {
      data.set(key, value);
      stub.mementoWrites.push({ key, value });
    },
    keys: () => [...data.keys()],
  };
}

function disposable() {
  return { dispose() {} };
}

const vscodeStub = {
  version: "1.85.0",
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { SourceControl: 1, Notification: 2, Window: 10 },
  ViewColumn: { One: 1, Two: 2, Active: -1 },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: "file", path: p, with: () => vscodeStub.Uri.file(p) }),
    joinPath: (base: any, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join("/"), scheme: "file", path: [base.path, ...parts].join("/") }),
    parse: (value: string) => ({ fsPath: value, scheme: "file", path: value }),
  },
  Disposable: class {
    constructor(private readonly fn: () => void = () => undefined) {}
    dispose() { this.fn(); }
  },
  EventEmitter: class {
    event = () => disposable();
    fire() {}
    dispose() {}
  },
  commands: {
    executeCommand: async () => undefined,
    registerCommand: () => disposable(),
  },
  env: {
    clipboard: { writeText: async () => undefined },
    openExternal: async () => true,
  },
  window: {
    createOutputChannel: () => ({
      appendLine: (line: string) => stub.outputLines.push(line),
      append: (line: string) => stub.outputLines.push(line),
      show: () => undefined,
      dispose: () => undefined,
    }),
    createStatusBarItem: () => ({
      text: "",
      tooltip: "",
      command: "",
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
    }),
    createWebviewPanel: () => ({
      webview: { html: "", onDidReceiveMessage: () => disposable(), postMessage: async () => true, asWebviewUri: (uri: unknown) => uri, cspSource: "" },
      onDidDispose: () => disposable(),
      reveal: () => undefined,
      dispose: () => undefined,
    }),
    showWarningMessage: async (text: string, ...items: string[]) => {
      stub.messages.push({ level: "warn", text, items });
      return stub.choice;
    },
    showInformationMessage: async (text: string, ...items: string[]) => {
      stub.messages.push({ level: "info", text, items });
      return stub.choice;
    },
    showErrorMessage: async (text: string, ...items: string[]) => {
      stub.messages.push({ level: "error", text, items });
      return stub.choice;
    },
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showTextDocument: async () => ({}),
    withProgress: async (_opts: unknown, task: (value: unknown, token: unknown) => Promise<unknown>) =>
      task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => disposable() }),
    onDidChangeActiveTextEditor: () => disposable(),
    onDidChangeTextEditorSelection: () => disposable(),
    onDidChangeWindowState: () => disposable(),
  },
  workspace: {
    get workspaceFolders() {
      return stub.workspaceFolders;
    },
    getConfiguration: () => ({
      get: <T>(_key: string, fallback?: T): T | undefined => fallback,
    }),
    onDidChangeConfiguration: () => disposable(),
    onDidChangeTextDocument: () => disposable(),
    onDidCreateFiles: () => disposable(),
    onDidDeleteFiles: () => disposable(),
    onDidRenameFiles: () => disposable(),
    onDidSaveTextDocument: () => disposable(),
    openTextDocument: async () => ({ getText: () => "" }),
    asRelativePath: (value: string) => value,
    fs: { readFile: async () => Buffer.from(""), writeFile: async () => undefined },
  },
};

/** Installs the stub exactly once, and reports whether it is installed. */
export function installVscodeStub(): void {
  const loader = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  if ((loader as any).__grvStubbed) {
    return;
  }
  const original = loader._load;
  loader._load = function patched(request: string, parent: unknown, isMain: boolean) {
    if (request === "vscode") {
      return vscodeStub;
    }
    return original.call(this, request, parent, isMain);
  };
  (loader as any).__grvStubbed = true;
}

/** Resets observable stub state between tests (keeps installed stubs). */
export function resetStub(): void {
  stub.messages.length = 0;
  stub.mementoWrites.length = 0;
  stub.outputLines.length = 0;
  stub.workspaceFolders = undefined;
  stub.choice = undefined;
}

/** Memento pair plus a fake extension context. */
export function createExtensionContext(extensionPath = "/tmp/grv-ext") {
  const workspaceState = memoryMemento();
  const globalState = memoryMemento();
  return {
    subscriptions: [] as { dispose(): void }[],
    extensionPath,
    extensionUri: vscodeStub.Uri.file(extensionPath),
    extension: { packageJSON: { version: "0.8.0" }, extensionPath },
    workspaceState,
    globalState,
  };
}

export { vscodeStub };
