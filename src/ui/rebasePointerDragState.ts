import { ReorderPlacement, reorderAround } from "./rebaseReorderState";

export interface ReorderAvailability {
  rebaseInProgress: boolean;
  filterActive: boolean;
  locked: boolean;
}

/** Shared policy expression for UI adapters: disabled sources never start a session. */
export function canStartReorder(availability: ReorderAvailability): boolean {
  return !availability.rebaseInProgress && !availability.filterActive && !availability.locked;
}

export interface PointerDragSession {
  sourceHash: string;
  revision: number;
  pointerId: number;
}

export interface PointerDropTarget {
  anchorHash: string;
  placement: ReorderPlacement;
}

export function beginPointerDrag(sourceHash: string, revision: number, pointerId: number): PointerDragSession {
  return { sourceHash, revision, pointerId };
}

export function pointerDropIntent(
  session: PointerDragSession,
  target: PointerDropTarget,
  canonicalOrder: readonly string[]
): { sourceHash: string; anchorHash: string; placement: ReorderPlacement; revision: number; order: string[] } | undefined {
  const order = reorderAround(canonicalOrder, session.sourceHash, target.anchorHash, target.placement);
  return order ? { ...session, anchorHash: target.anchorHash, placement: target.placement, order } : undefined;
}

/**
 * Native TreeView DnD always inserts before the dropped commit. The controller
 * never mutates provider rows while dragging, so there is no normal-flow hint
 * row or list shift; it only sends this immutable canonical intent on drop.
 */
export function nativeTreeDropIntent(
  sourceHash: string,
  targetHash: string,
  canonicalOrder: readonly string[],
  revision: number
): { sourceHash: string; anchorHash: string; placement: "before"; revision: number; order: string[] } | undefined {
  const order = reorderAround(canonicalOrder, sourceHash, targetHash, "before");
  return order ? { sourceHash, anchorHash: targetHash, placement: "before", revision, order } : undefined;
}

/** Returns the canonical one-step keyboard move, including its complete order. */
export function oneStepReorderIntent(
  canonicalOrder: readonly string[],
  sourceHash: string,
  direction: "up" | "down",
  revision: number
): { sourceHash: string; anchorHash: string; placement: ReorderPlacement; revision: number; order: string[] } | undefined {
  const index = canonicalOrder.indexOf(sourceHash);
  if (index < 0) return undefined;
  const anchorHash = direction === "up" ? canonicalOrder[index - 1] : canonicalOrder[index + 1];
  if (!anchorHash) return undefined;
  const placement: ReorderPlacement = direction === "up" ? "before" : "after";
  const order = reorderAround(canonicalOrder, sourceHash, anchorHash, placement);
  return order ? { sourceHash, anchorHash, placement, revision, order } : undefined;
}
