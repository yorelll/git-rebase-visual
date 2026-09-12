/**
 * A paused rebase may open a draft/copy surface for staged or working changes.
 * The host still blocks every apply path while paused.
 */
export function isDraftOnlyComposeAllowedDuringRebase(
  mode: string,
  messageOnly: boolean
): boolean {
  return messageOnly && (mode === "staged" || mode === "working");
}

/** AI is safe only when it is equally draft-only; it never performs Git writes. */
export function isDraftOnlyAiGenerationAllowedDuringRebase(
  mode: string,
  messageOnly: boolean,
  hasConflicts: boolean
): boolean {
  return !hasConflicts && isDraftOnlyComposeAllowedDuringRebase(mode, messageOnly);
}
