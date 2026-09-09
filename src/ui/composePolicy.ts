/**
 * A paused rebase may open a draft/copy surface for staged or working changes.
 * The host still blocks generation and every apply path while paused.
 */
export function isDraftOnlyComposeAllowedDuringRebase(
  mode: string,
  messageOnly: boolean
): boolean {
  return messageOnly && (mode === "staged" || mode === "working");
}
