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

test("paused-rebase UI/read traffic is traced but never becomes a warning mutation", () => {
  const view = new WebviewProtocolState();
  for (const [type, source] of [
    ["refresh", "poll"], ["pointermove", "pointer"], ["selection", "selection"],
    ["compositionupdate", "ime"], ["toast", "toast"], ["openWorktreeDiff", "file"],
  ] as const) view.observe(type, source, true);
  view.openMenu();
  view.closeMenuFromHost();
  const trace = view.snapshot();
  assert.equal(trace.mutationCount, 0);
  assert.equal(trace.warningCount, 0);
  assert.equal(trace.hostCloseCount, 1);
  assert.equal(trace.menuOpen, false);
  assert.equal(trace.sources.length, 6);
});

test("paused-rebase unsafe writes alone count as warning candidates", () => {
  const view = new WebviewProtocolState();
  view.observe("reorder", "keyboard", true);
  view.observe("continueRebase", "banner", true);
  const trace = view.snapshot();
  assert.equal(trace.mutationCount, 2);
  assert.equal(trace.warningCount, 1);
});
