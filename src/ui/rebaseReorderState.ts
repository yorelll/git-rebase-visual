export type ReorderPlacement = "before" | "after";

export interface ReorderRequest {
  [key: string]: unknown;
  sourceHash?: unknown;
  anchorHash?: unknown;
  placement?: unknown;
  revision?: unknown;
  /** Full oldest-first canonical todo order proposed by the webview. */
  order?: unknown;
}

export interface AcceptedReorder {
  sourceHash: string;
  anchorHash: string;
  placement: ReorderPlacement;
  order: string[];
  affectedCount: number;
}

/**
 * Rebuilds the only valid full todo order for a drag session. The webview is a
 * projection and is never trusted to decide which hidden commits move.
 */
export function reorderAround(
  canonicalOrder: readonly string[],
  sourceHash: string,
  anchorHash: string,
  placement: ReorderPlacement
): string[] | undefined {
  if (sourceHash === anchorHash) return undefined;
  const order = [...canonicalOrder];
  const sourceIndex = order.indexOf(sourceHash);
  const anchorIndex = order.indexOf(anchorHash);
  if (sourceIndex < 0 || anchorIndex < 0) return undefined;
  order.splice(sourceIndex, 1);
  const destination = order.indexOf(anchorHash);
  if (destination < 0) return undefined;
  order.splice(destination + (placement === "after" ? 1 : 0), 0, sourceHash);
  return order;
}

/**
 * Accepts only a current drag session's exact complete canonical order. A
 * stale/partial/malformed client order is rejected before a rebase can start.
 */
export function validateReorderRequest(
  request: ReorderRequest,
  canonicalOrder: readonly string[],
  revision: number,
  lockedHashes: ReadonlySet<string>
): { ok: true; value: AcceptedReorder } | { ok: false; reason: string } {
  if (request.revision !== revision) {
    return { ok: false, reason: "拖拽会话已过期；commit 列表已刷新。" };
  }
  if (
    typeof request.sourceHash !== "string" ||
    typeof request.anchorHash !== "string" ||
    (request.placement !== "before" && request.placement !== "after")
  ) {
    return { ok: false, reason: "拖拽请求缺少有效 source、anchor 或 placement。" };
  }
  if (lockedHashes.has(request.sourceHash)) {
    return { ok: false, reason: "已锁定的 commit 不能被拖动。" };
  }
  const expected = reorderAround(canonicalOrder, request.sourceHash, request.anchorHash, request.placement);
  if (!expected) {
    return { ok: false, reason: "拖拽目标不在当前完整 commit 列表中。" };
  }
  if (
    !Array.isArray(request.order) ||
    request.order.length !== expected.length ||
    request.order.some((hash, index) => hash !== expected[index])
  ) {
    return { ok: false, reason: "拖拽请求不是当前完整 canonical todo 顺序；已取消重排。" };
  }
  const before = canonicalOrder.indexOf(request.sourceHash);
  const after = expected.indexOf(request.sourceHash);
  return {
    ok: true,
    value: {
      sourceHash: request.sourceHash,
      anchorHash: request.anchorHash,
      placement: request.placement,
      order: expected,
      affectedCount: Math.abs(before - after) + 1,
    },
  };
}
