import assert from "node:assert/strict";
import test from "node:test";
import { ComposePanelDelivery } from "../src/ui/composePanelState";

const first = { mode: "commit", thenEdit: false, ai: false, original: "first", trailers: "" };
const second = { ...first, original: "second", trailers: "Change-Id: I2" };

test("compose delivery waits for listener readiness then sends latest payload", () => {
  const delivery = new ComposePanelDelivery();
  assert.equal(delivery.update(first), undefined);
  assert.deepEqual(delivery.update(second), undefined);
  assert.deepEqual(delivery.markReady(), second);
  assert.deepEqual(delivery.update(first), first);
});

test("compose delivery resends the latest payload after a webview reload", () => {
  const delivery = new ComposePanelDelivery();
  delivery.update(first);
  delivery.markReady();
  delivery.reset();
  assert.equal(delivery.isReady, false);
  assert.deepEqual(delivery.markReady(), first);
});
