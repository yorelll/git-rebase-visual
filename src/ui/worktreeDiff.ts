import * as path from "path";
import * as vscode from "vscode";
import { runGit } from "../git/gitRunner";
import { WorktreeChange } from "../git/worktreeChanges";
import {
  CommitFileChange,
  GitContentDescriptor,
  GitContentRequestStore,
  commitDiffSpec,
  createGitContentRequestStore,
} from "./gitDiffRequestState";
import { DiffVersion, worktreeDiffSpec } from "./worktreeDiffState";

const SCHEME = "git-rebase-visual-content";
const MAX_CONTENT_BYTES = 12 * 1024 * 1024;

/** Opaque public-API URI for a request already authorized by this extension. */
export function gitContentUri(store: GitContentRequestStore, repository: string, descriptor: GitContentDescriptor): vscode.Uri {
  const id = store.create({ repository, descriptor });
  return vscode.Uri.from({ scheme: SCHEME, path: "/content", query: encodeURIComponent(id) });
}

function repositoryFileUri(repository: string, filePath: string): vscode.Uri {
  const absolute = path.resolve(repository, filePath);
  const relative = path.relative(repository, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Git 状态返回了仓库外路径；未打开文件。");
  }
  return vscode.Uri.file(absolute);
}

function descriptorFor(version: Exclude<DiffVersion, "working">, filePath: string): GitContentDescriptor {
  return { version, filePath };
}

function sideUri(
  store: GitContentRequestStore,
  repository: string,
  version: DiffVersion,
  filePath: string
): vscode.Uri {
  return version === "working"
    ? repositoryFileUri(repository, filePath)
    : gitContentUri(store, repository, descriptorFor(version, filePath));
}

function gitObject(descriptor: GitContentDescriptor): string | undefined {
  switch (descriptor.version) {
    case "head": return `HEAD:${descriptor.filePath}`;
    case "index": return `:${descriptor.filePath}`;
    case "commit": return `${descriptor.commit}:${descriptor.filePath}`;
    case "empty": return undefined;
  }
}

/**
 * Public TextDocumentContentProvider for opaque, extension-authorized Git
 * requests. It never decodes a repository/ref/path from URI text.
 */
export class GitContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  constructor(private readonly requests: GitContentRequestStore = createGitContentRequestStore()) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let id: string;
    try {
      id = decodeURIComponent(uri.query);
    } catch {
      return "无法解析 Git Rebase Visual 虚拟文档请求。";
    }
    const request = this.requests.resolve(id);
    if (!request) return "[Git Rebase Visual: 此虚拟文档请求已失效。]";
    if (request.descriptor.version === "empty") return "";
    const object = gitObject(request.descriptor);
    if (!object) return "";
    const result = await runGit(["show", "--no-ext-diff", object], {
      cwd: request.repository,
      maxBuffer: MAX_CONTENT_BYTES,
    });
    if (result.code !== 0) {
      return `[Git Rebase Visual: ${request.descriptor.version} side is unavailable for ${request.descriptor.filePath}]\n${result.stderr || result.stdout}`;
    }
    // Git's runner is intentionally text-only. Binary files are detected from
    // `--numstat` before creating a request and therefore never reach here.
    return result.stdout;
  }

  invalidateRepository(repository: string): void {
    this.requests.invalidateRepository(repository);
  }

  dispose(): void {
    this.requests.clear();
  }
}

/** Opens a real VS Code two-editor Diff using only stable public APIs. */
export async function openWorktreeDiff(
  store: GitContentRequestStore,
  repository: string,
  change: WorktreeChange
): Promise<{ fallback?: string }> {
  const spec = worktreeDiffSpec(change);
  if (spec.fallbackReason) return { fallback: spec.fallbackReason };
  await vscode.commands.executeCommand(
    "vscode.diff",
    sideUri(store, repository, spec.left, spec.leftPath),
    sideUri(store, repository, spec.right, spec.rightPath),
    spec.title,
    { preview: true }
  );
  return {};
}

/** Opens one already-selected parent-to-commit file comparison. */
export async function openCommitFileDiff(
  store: GitContentRequestStore,
  repository: string,
  parent: string | undefined,
  commit: string,
  change: CommitFileChange
): Promise<{ fallback?: string }> {
  const spec = commitDiffSpec(parent, commit, change);
  if (spec.fallbackReason) return { fallback: spec.fallbackReason };
  await vscode.commands.executeCommand(
    "vscode.diff",
    gitContentUri(store, repository, spec.left),
    gitContentUri(store, repository, spec.right),
    spec.title,
    { preview: true }
  );
  return {};
}

export { SCHEME as gitContentScheme };
