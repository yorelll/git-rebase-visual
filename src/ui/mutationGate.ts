import { WebviewMessageIntent, allowedPausedRebaseMutation, webviewMessageIntent } from "./webviewProtocolState";

export interface MutationGateState {
  busy: boolean;
  pausedRebase: boolean;
}

export type MutationGateDecision =
  | { kind: "handle"; intent: WebviewMessageIntent }
  | { kind: "busy"; intent: "mutation" }
  | { kind: "blockedPaused"; intent: "mutation" };

/**
 * Host-side entry decision shared by tests and RebaseViewProvider. File writes
 * can be allowed at an edit stop without ceasing to be serialized mutations.
 */
export function mutationGateDecision(
  type: string,
  state: MutationGateState,
  options: { pausedException?: boolean } = {}
): MutationGateDecision {
  const intent = webviewMessageIntent(type);
  if (intent !== "mutation") return { kind: "handle", intent };
  if (state.busy) return { kind: "busy", intent };
  if (state.pausedRebase && !allowedPausedRebaseMutation(type) && !options.pausedException) {
    return { kind: "blockedPaused", intent };
  }
  return { kind: "handle", intent };
}
