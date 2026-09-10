import { fullMessage, conflictedFiles, rebaseAtEditStop, rebaseStoppedSha, workingStatus } from "../git/commitLog";
import { git } from "../git/gitRunner";
import { applyTrailers } from "../git/message";

export type EditStopCommitKind = "amend" | "new";

/** Resolves the only commit that may be written at an interactive edit stop. */
export async function ensureEditStopTarget(cwd: string): Promise<string> {
  const [atEdit, stopped, conflicts] = await Promise.all([
    rebaseAtEditStop(cwd),
    rebaseStoppedSha(cwd),
    conflictedFiles(cwd),
  ]);
  if (!atEdit || !stopped || conflicts.length > 0) {
    throw new Error("当前不是可提交的 edit 停靠；冲突必须先解决并暂存。 ");
  }
  return stopped;
}

/**
 * Performs the Git write after verifying a real edit stop and staged content.
 * An amend retains the target's trailers; a new commit deliberately has no
 * inherited trailer block, preventing duplicated review identities.
 */
export async function writeEditStopCommit(
  cwd: string,
  kind: EditStopCommitKind,
  message: string
): Promise<{ stopped: string; finalMessage: string }> {
  const stopped = await ensureEditStopTarget(cwd);
  const status = await workingStatus(cwd);
  if (!status.hasStaged) throw new Error("暂存区为空；请先在 SCM 中暂存改动。 ");
  if (!message.trim()) throw new Error("Commit message 不能为空。");

  const original = kind === "amend" ? await fullMessage(cwd, stopped) : "";
  const finalMessage = applyTrailers(message, original);
  await git(kind === "amend" ? ["commit", "--amend", "-F", "-"] : ["commit", "-F", "-"], {
    cwd,
    input: finalMessage,
  });
  return { stopped, finalMessage };
}
