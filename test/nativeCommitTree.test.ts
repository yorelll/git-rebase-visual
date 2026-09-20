import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";

const hash = "a".repeat(40);

class FakeMarkdownString {
  value = "";
  isTrusted = false;
  appendMarkdown(value: string): void { this.value += value; }
}

class FakeTreeItem {
  id?: string;
  description?: string;
  tooltip?: unknown;
  contextValue?: string;
  iconPath?: unknown;
  command?: { command: string };
  constructor(readonly label: string) {}
}

const fakeVsCode = {
  MarkdownString: FakeMarkdownString,
  TreeItem: FakeTreeItem,
  TreeItemCollapsibleState: { None: 0 },
  ThemeIcon: class { constructor(readonly id: string) {} },
  EventEmitter: class {},
};

function withNativeTree<T>(callback: (native: typeof import("../src/ui/nativeCommitTree")) => T): T {
  const moduleLoader = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = function(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === "vscode") return fakeVsCode;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return callback(require("../src/ui/nativeCommitTree") as typeof import("../src/ui/nativeCommitTree"));
  } finally {
    moduleLoader._load = originalLoad;
  }
}

test("native commit item has a workbench tooltip and context value", () => withNativeTree((native) => {
  const item = native.nativeCommitTreeItem({
    kind: "commit",
    commit: {
      hash,
      shortHash: hash.slice(0, 8),
      subject: "Use native context menu",
      author: "Test User",
      authorEmail: "test@example.test",
      date: "2026-09-14",
    },
    locked: false,
    stopped: false,
    pending: false,
    detail: {
      author: "Test User",
      email: "test@example.test",
      relDate: "now",
      absDate: "2026-09-14 12:00",
      message: "Use native context menu\n\nBody",
      stat: "1 file changed, 1 insertion(+)",
    },
  }) as unknown as FakeTreeItem;
  assert.equal(native.nativeCommitTreeViewId, "gitRebaseVisual.commits");
  assert.equal(native.nativeCommitTreeMime, "application/vnd.code.tree.gitrebasevisual.commits");
  assert.equal(item.contextValue, "gitRebaseVisual.commit");
  assert.ok(item.tooltip instanceof FakeMarkdownString);
  assert.match((item.tooltip as FakeMarkdownString).value, new RegExp(hash));
  assert.match((item.tooltip as FakeMarkdownString).value, /Use native context menu/);
  assert.equal(item.command?.command, "gitRebaseVisual.commit.copyHash");
}));

test("untracked worktree item carries a distinct native delete context", () => withNativeTree((native) => {
  const item = native.nativeCommitTreeItem({
    kind: "worktree",
    side: "working",
    change: {
      path: "tmp/generated.bin",
      staged: false,
      unstaged: true,
      worktreeKind: "untracked",
      conflicted: false,
    },
  }) as unknown as FakeTreeItem;
  assert.equal(item.contextValue, "gitRebaseVisual.worktree.untracked");
  assert.match(String(item.label), /tmp\/generated\.bin/);
}));
