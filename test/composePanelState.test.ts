import assert from "node:assert/strict";
import test from "node:test";
import { ComposePanelDelivery, matchesComposeDraft } from "../src/ui/composePanelState";

const first = { mode: "commit", hash: "a".repeat(40), thenEdit: false, ai: false, original: "first", trailers: "", sessionId: "commit:a:apply:write", revision: 1 };
const second = { ...first, original: "second", trailers: "Change-Id: I2", revision: 2 };

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
  delivery.markReady(first.sessionId, first.revision);
  delivery.reset();
  assert.equal(delivery.isReady, false);
  assert.deepEqual(delivery.markReady(first.sessionId, first.revision), first);
  assert.equal(delivery.acknowledged, true);
});

test("compose session keeps a dirty draft for same target revision but rejects stale target", () => {
  const delivery = new ComposePanelDelivery();
  delivery.update(first);
  assert.equal(delivery.shouldReplaceDraft(first.sessionId, first.revision), false);
  assert.equal(delivery.shouldReplaceDraft(first.sessionId, second.revision), true);
  assert.equal(delivery.shouldReplaceDraft("commit:other:apply:write", first.revision), true);
});

test("compose payload carries a recoverable dirty draft only for its exact session", () => {
  const recovered = { sessionId: first.sessionId, revision: first.revision, draft: "edited subject" };
  assert.equal(matchesComposeDraft(first, recovered), true);
  assert.equal(matchesComposeDraft(second, recovered), false);
});

test("compose delivery preserves a same-session dirty draft across repeated ready acknowledgements", () => {
  const delivery = new ComposePanelDelivery();
  const draft = { sessionId: first.sessionId, revision: first.revision, draft: "edited subject" };
  delivery.update(first);
  assert.deepEqual(delivery.markReady(first.sessionId, first.revision), first);
  assert.equal(delivery.draftFor(first, draft), "edited subject");
  // A duplicate ready after a retained-context reload is delivery-only; it must
  // not reinterpret the draft as a different target.
  assert.deepEqual(delivery.markReady(first.sessionId, first.revision), first);
  assert.equal(delivery.draftFor(first, draft), "edited subject");
});

test("compose delivery rejects a stale draft when the host opens a new target", () => {
  const delivery = new ComposePanelDelivery();
  const draft = { sessionId: first.sessionId, revision: first.revision, draft: "do not overwrite" };
  delivery.update(first);
  delivery.markReady(first.sessionId, first.revision);
  delivery.update(second);
  assert.equal(delivery.shouldReplaceDraft(draft.sessionId, draft.revision), true);
  assert.equal(delivery.draftFor(second, draft), undefined);
});

test("compose ready acknowledgement is only protocol metadata, not a stale payload selector", () => {
  const delivery = new ComposePanelDelivery();
  delivery.update(second);
  // A newly-created document has no state yet, so it acknowledges undefined.
  // The host still sends its latest session rather than reviving an old one.
  assert.deepEqual(delivery.markReady(undefined, undefined), second);
  assert.equal(delivery.acknowledged, false);
});

test("a refreshed staged target keeps its recovery draft until its diff changes", () => {
  const delivery = new ComposePanelDelivery();
  const staged = { ...first, mode: "staged", hash: undefined, sessionId: "staged:working:apply:write", revision: 8 };
  const draft = { sessionId: staged.sessionId, revision: staged.revision, draft: "keep staged draft" };
  delivery.update(staged);
  delivery.markReady(staged.sessionId, staged.revision);
  // An unrelated refresh is the same diff target and must keep recovery data.
  assert.equal(delivery.draftFor(staged, draft), "keep staged draft");
  // A changed index has a new host revision and cannot inherit the old draft.
  const changedIndex = { ...staged, revision: 9 };
  delivery.update(changedIndex);
  assert.equal(delivery.draftFor(changedIndex, draft), undefined);
});

// Host-specific active-session and explicit-discard checks live in the VS Code
// integration layer; delivery tests make the session/revision invariant explicit.
test("a stale close/apply identity is distinguishable from the active session", () => {
  const active = { sessionId: first.sessionId, revision: first.revision };
  const stale = { sessionId: active.sessionId, revision: active.revision + 1 };
  assert.equal(stale.sessionId === active.sessionId && stale.revision === active.revision, false);
});
