import assert from "node:assert/strict";
import test from "node:test";
import { WebviewProtocolState } from "../src/ui/webviewProtocolState";

test("scroll closes a menu without posting a host mutation or persisting state", () => {
  const view = new WebviewProtocolState();
  view.openMenu();
  const before = view.snapshot();
  view.closeMenuFromScroll();
  const after = view.snapshot();

  assert.equal(before.menuOpen, true);
  assert.equal(after.menuOpen, false);
  assert.equal(after.menuScrollCloseCount, 1);
  assert.equal(after.postMessageCount, before.postMessageCount);
  assert.equal(after.persistedStateCount, before.persistedStateCount);
});
