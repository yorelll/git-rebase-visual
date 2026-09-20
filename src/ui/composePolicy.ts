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

/** Decision used by the native working-section AI command before opening Compose. */
export type WorkingAiComposeDecision =
  | { kind: "unconfigured" }
  | { kind: "compose"; messageOnly: boolean };

/**
 * Normal working AI composition may commit after explicit user approval. During
 * a paused rebase it must be a copy-only draft; missing LLM configuration never
 * opens a Compose surface that cannot generate.
 */
export function workingAiComposeDecision(
  llmConfigured: boolean,
  rebaseInProgress: boolean
): WorkingAiComposeDecision {
  if (!llmConfigured) return { kind: "unconfigured" };
  return { kind: "compose", messageOnly: rebaseInProgress };
}

/**
 * Builds the exact native working-section Compose request. Keeping this pure
 * makes normal, unconfigured and paused-rebase policy independently testable.
 */
export function nativeWorkingAiComposeRequest(
  llmConfigured: boolean,
  rebaseInProgress: boolean
): { type: "openCompose"; mode: "working"; ai: true; thenEdit: false; messageOnly: boolean } | undefined {
  const decision = workingAiComposeDecision(llmConfigured, rebaseInProgress);
  return decision.kind === "compose"
    ? { type: "openCompose", mode: "working", ai: true, thenEdit: false, messageOnly: decision.messageOnly }
    : undefined;
}
