import * as path from "path";
import * as vscode from "vscode";
import { runGit } from "../git/gitRunner";
import { WorktreeChange } from "../git/worktreeChanges";
import { DiffVersion, worktreeDiffSpec } from "./worktreeDiffState";
import { decodeGitContentRequest, encodeGitContentRequest } from "./worktreeContentUriState";

const SCHEME = "git-rebase-visual-content";

/** Stable public-API URI for one controlled immutable Git content side. */
export function gitContentUri(repository: string, version: Exclude<DiffVersion, "working">, filePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: "/content", query: encodeGitContentRequest({ repository, version, filePath }) });
}

function repositoryFileUri(repository: string, filePath: string): vscode.Uri {
  const absolute = path.resolve(repository, filePath);
  const relative = path.relative(repository, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Git 状态返回了仓库外路径；未打开文件。 ");
  return vscode.Uri.file(absolute);
}

function sideUri(repository: string, version: DiffVersion, filePath: string): vscode.Uri {
  return version === "working" ? repositoryFileUri(repository, filePath) : gitContentUri(repository, version, filePath);
}

/** Public TextDocumentContentProvider for HEAD, index, and deliberate empty sides. */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const request = decodeGitContentRequest(uri.query);
    if (!request) return "无法解析 Git Rebase Visual 虚拟文档请求。";
    if (request.version === "empty") return "";
    const object = request.version === "head" ? `HEAD:${request.filePath}` : `:${request.filePath}`;
    const result = await runGit(["show", "--no-ext-diff", object], { cwd: request.repository, maxBuffer: 12 * 1024 * 1024 });
    if (result.code !== 0) return `[Git Rebase Visual: ${request.version} side is unavailable for ${request.filePath}]\n${result.stderr || result.stdout}`;
    return result.stdout;
  }
}

/** Opens a real VS Code two-editor Diff using only stable public APIs. */
export async function openWorktreeDiff(repository: string, change: WorktreeChange): Promise<{ fallback?: string }> {
  const spec = worktreeDiffSpec(change);
  if (spec.fallbackReason) return { fallback: spec.fallbackReason };
  await vscode.commands.executeCommand("vscode.diff", sideUri(repository, spec.left, spec.leftPath), sideUri(repository, spec.right, spec.rightPath), spec.title, { preview: true });
  return {};
}

export { SCHEME as gitContentScheme };
