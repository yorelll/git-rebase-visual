import assert from "node:assert/strict";
import test from "node:test";
import { clearExpiredInlineToast, showInlineToast, visibleInlineToast } from "../src/ui/inlineToastState";

test("inline toast is transient overlay state and restores context state after expiry", () => {
  const toast = showInlineToast("已复制 hash", 100, 2500);
  assert.equal(visibleInlineToast(toast, 2599), "已复制 hash");
  assert.equal(visibleInlineToast(toast, 2600), undefined);
  assert.deepEqual(clearExpiredInlineToast(toast, 2600), {});
});
