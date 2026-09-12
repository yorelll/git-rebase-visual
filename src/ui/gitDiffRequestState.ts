import { randomBytes } from "crypto";
import { FileChangeKind } from "../git/worktreeChanges";

/** A content version that can be resolved only through a registered request. */
export type GitContentVersion = "head" | "index" | "commit" | "empty";

export interface GitContentDescriptor {
  version: GitContentVersion;
  /** Full immutable commit object id for `commit` content. */
  commit?: string;
  filePath: string;
}

export interface GitContentRequest {
  repository: string;
  descriptor: GitContentDescriptor;
}

export interface GitContentRequestStore {
  create(request: GitContentRequest): string;
  resolve(id: string): GitContentRequest | undefined;
  invalidateRepository(repository: string): void;
  clear(): void;
  size(): number;
}

const fullHash = /^[0-9a-f]{40}$/i;

function validDescriptor(value: GitContentDescriptor): boolean {
  if (
    !value.filePath ||
    value.filePath.startsWith("/") ||
    value.filePath.includes("\\") ||
    value.filePath.split("/").includes("..")
  ) return false;
  if (value.version === "commit") return !!value.commit && fullHash.test(value.commit);
  return value.version === "head" || value.version === "index" || value.version === "empty";
}

/**
 * Keeps provider input opaque: the global URI scheme never accepts a repository,
 * ref, or path encoded by untrusted callers. Entries expire on lookup and the
 * bounded map is cleared with the extension/provider lifecycle.
 */
export function createGitContentRequestStore(
  options: { now?: () => number; ttlMs?: number; maxEntries?: number; token?: () => string } = {}
): GitContentRequestStore {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const maxEntries = options.maxEntries ?? 512;
  let sequence = 0;
  const token = options.token ?? (() => `${randomBytes(18).toString("base64url")}-${(++sequence).toString(36)}`);
  const entries = new Map<string, { request: GitContentRequest; expiresAt: number }>();

  const purge = () => {
    const current = now();
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(id);
    }
  };

  return {
    create(request) {
      if (!request.repository || !validDescriptor(request.descriptor)) {
        throw new Error("无效的 Git 虚拟文档请求。");
      }
      purge();
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value as string | undefined;
        if (!oldest) break;
        entries.delete(oldest);
      }
      let id = token();
      while (entries.has(id)) id = token();
      entries.set(id, {
        request: {
          repository: request.repository,
          descriptor: { ...request.descriptor },
        },
        expiresAt: now() + ttlMs,
      });
      return id;
    },
    resolve(id) {
      purge();
      const entry = entries.get(id);
      if (!entry) return undefined;
      // Move hits to the newest insertion position, making bounded eviction LRU.
      entries.delete(id);
      entries.set(id, entry);
      return {
        repository: entry.request.repository,
        descriptor: { ...entry.request.descriptor },
      };
    },
    invalidateRepository(repository) {
      for (const [id, entry] of entries) {
        if (entry.request.repository === repository) entries.delete(id);
      }
    },
    clear() {
      entries.clear();
    },
    size() {
      purge();
      return entries.size;
    },
  };
}

export type CommitFileChangeKind = "add" | "delete" | "modify" | "rename";

export interface CommitFileChange {
  kind: CommitFileChangeKind;
  path: string;
  originalPath?: string;
  /** Binary blobs deliberately use an explicit UI fallback, never UTF-8 text. */
  binary: boolean;
}

export interface CommitDiffSpec {
  left: GitContentDescriptor;
  right: GitContentDescriptor;
  title: string;
  fallbackReason?: string;
}

function label(kind: FileChangeKind | CommitFileChangeKind | undefined): string {
  switch (kind) {
    case "add": return "Add";
    case "delete": return "Delete";
    case "rename": return "Rename";
    case "untracked": return "Untracked";
    case "unmerged": return "Conflict";
    default: return "Modify";
  }
}

/** Pure parent-to-commit resolver for a selected commit file. */
export function commitDiffSpec(
  parent: string | undefined,
  commit: string,
  change: CommitFileChange
): CommitDiffSpec {
  if (change.binary) {
    return {
      left: { version: "empty", filePath: change.originalPath ?? change.path },
      right: { version: "empty", filePath: change.path },
      title: `${label(change.kind)}: ${change.path}`,
      fallbackReason: `二进制文件 ${change.path} 无法安全地以文本 Diff 打开；请使用 VS Code Explorer 或 git show --binary 查看。`,
    };
  }
  const leftPath = change.kind === "rename" ? (change.originalPath ?? change.path) : change.path;
  const left: GitContentDescriptor = !parent || change.kind === "add"
    ? { version: "empty", filePath: leftPath }
    : { version: "commit", commit: parent, filePath: leftPath };
  const right: GitContentDescriptor = change.kind === "delete"
    ? { version: "empty", filePath: change.path }
    : { version: "commit", commit, filePath: change.path };
  return {
    left,
    right,
    title: `${label(change.kind)} (parent ↔ commit): ${change.kind === "rename" && change.originalPath ? `${change.originalPath} → ` : ""}${change.path}`,
  };
}
