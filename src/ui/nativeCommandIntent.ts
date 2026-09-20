import { NativeCommitTreeElement } from "./nativeCommitTree";

export interface NativeCommandIntent {
  type: string;
  hash?: string;
  hashes?: string[];
  path?: string;
  side?: "working" | "staged";
  revision?: number;
}

/**
 * Converts a native TreeView invocation into the same host-side intent as a
 * legacy UI action. In particular a single Generate Diff carries the canonical
 * revision just like bulk generation, so it cannot bypass stale-snapshot checks.
 */
export function nativeCommandIntent(
  type: string,
  element: NativeCommitTreeElement | undefined,
  canonicalRevision: number,
  selectedHashes: readonly string[] = []
): NativeCommandIntent | undefined {
  if ((type === "stageAllFiles" || type === "discardAllFiles" || type === "unstageAllFiles") && element?.kind !== "message") return undefined;
  const intent: NativeCommandIntent = { type };
  if (element?.kind === "commit") {
    intent.hash = element.commit.hash;
    if (type === "generateDiff") intent.revision = canonicalRevision;
  }
  if (element?.kind === "worktree") {
    intent.path = element.change.path;
    intent.side = element.side === "working" ? "working" : "staged";
  }
  if (element?.kind === "message" && element.rebase?.stoppedCommit) intent.hash = element.rebase.stoppedCommit.commit.hash;
  if (type === "bulkLock" || type === "bulkDrop" || type === "bulkGenerateDiff") {
    // VS Code invokes a context command with the row under the pointer. Never
    // let that row authorize an unrelated existing multi-selection.
    if (
      element?.kind !== "commit" ||
      selectedHashes.length < 2 ||
      !selectedHashes.includes(element.commit.hash)
    ) return undefined;
    delete intent.hash;
    intent.hashes = [...selectedHashes];
    if (type === "bulkGenerateDiff") intent.revision = canonicalRevision;
  }
  return intent;
}
