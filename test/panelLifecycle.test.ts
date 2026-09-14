import assert from "node:assert/strict";
import test from "node:test";
import { PanelLifecycle } from "../src/ui/panelLifecycle";

test("panel lifecycle repeatedly closes and reopens without an old dispose clearing a successor", () => {
  const lifecycle = new PanelLifecycle<{ name: string }>();
  const first = lifecycle.open({ name: "first" });
  assert.equal(lifecycle.current()?.name, "first");
  first.release(); // editor-area close
  assert.equal(lifecycle.current(), undefined);

  const second = lifecycle.open({ name: "second" });
  assert.equal(lifecycle.current()?.name, "second");
  first.release(); // a delayed old native disposal must not clear second
  assert.equal(lifecycle.current()?.name, "second");
  second.release();
  assert.equal(lifecycle.current(), undefined);

  const third = lifecycle.open({ name: "third" });
  assert.equal(lifecycle.current()?.name, "third", "right-click can reopen after two close cycles");
  third.release();
  assert.equal(lifecycle.current(), undefined);
});
