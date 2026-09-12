export interface InlineToastState {
  message?: string;
  expiresAt?: number;
}

/**
 * Pure presentation state: the context bar keeps its fixed box and the toast
 * merely overlays it. Hosts/webviews can test expiration without DOM timing.
 */
export function showInlineToast(message: string, now: number, duration = 2500): InlineToastState {
  return { message, expiresAt: now + Math.max(0, duration) };
}

export function visibleInlineToast(state: InlineToastState, now: number): string | undefined {
  return state.expiresAt !== undefined && now < state.expiresAt ? state.message : undefined;
}

export function clearExpiredInlineToast(state: InlineToastState, now: number): InlineToastState {
  return visibleInlineToast(state, now) ? state : {};
}
