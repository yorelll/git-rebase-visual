import { DiffVersion } from "./worktreeDiffState";

export interface GitContentRequest {
  repository: string;
  version: Exclude<DiffVersion, "working">;
  filePath: string;
}

/** Serializable, URI-query-safe description of one virtual Git content side. */
export function encodeGitContentRequest(request: GitContentRequest): string {
  return encodeURIComponent(JSON.stringify(request));
}

/** Rejects malformed URI data before any Git process can be invoked. */
export function decodeGitContentRequest(query: string): GitContentRequest | undefined {
  try {
    const value = JSON.parse(decodeURIComponent(query));
    if (
      typeof value?.repository === "string" &&
      typeof value?.filePath === "string" &&
      (value.version === "head" || value.version === "index" || value.version === "empty")
    ) {
      return value;
    }
  } catch {
    // invalid virtual URI
  }
  return undefined;
}
