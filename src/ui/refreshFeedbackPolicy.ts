export type RefreshSource = "command" | "webview" | "poll" | "ready";

/** Manual refresh receives visible inline confirmation; automatic traffic stays quiet. */
export function refreshFeedback(source: RefreshSource): string | undefined {
  return source === "command" || source === "webview" ? "已刷新" : undefined;
}
