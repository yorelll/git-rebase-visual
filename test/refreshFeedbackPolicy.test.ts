import assert from "node:assert/strict";
import test from "node:test";
import { refreshFeedback } from "../src/ui/refreshFeedbackPolicy";

test("only manual command and webview refresh show inline feedback", () => {
  assert.equal(refreshFeedback("command"), "已刷新");
  assert.equal(refreshFeedback("webview"), "已刷新");
  assert.equal(refreshFeedback("poll"), undefined, "1.5s status polling stays quiet");
  assert.equal(refreshFeedback("ready"), undefined, "initial ready refresh stays quiet");
});
