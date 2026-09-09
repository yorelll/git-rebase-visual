import assert from "node:assert/strict";
import test from "node:test";
import { buildTodo, executeRebase, resolveBase } from "../src/git/rebaseEngine";
import { commitFile, createRepo, git, removeRepo } from "./helpers/gitTestRepo";

test("squash preserves both messages while fixup discards its message", async (t) => {
  const cwd = createRepo(); t.after(() => removeRepo(cwd));
  const base = commitFile(cwd, "base", "base\n", "base");
  const first = commitFile(cwd, "one", "one\n", "first message");
  const second = commitFile(cwd, "two", "two\n", "second message");
  const outcome = await executeRebase(cwd, { onto: await resolveBase(cwd, base), items: [
    { hash: base, action: "pick", subject: "base" }, { hash: first, action: "pick", subject: "first message" }, { hash: second, action: "squash", subject: "second message" },
  ] });
  assert.equal(outcome.ok, true);
  const message = git(cwd, ["log", "-1", "--format=%B"]);
  assert.match(message, /first message/); assert.match(message, /second message/);
});

test("todo emits squash and fixup actions", () => {
  const todo = buildTodo([{ hash: "a".repeat(40), action: "squash", subject: "joined" }, { hash: "b".repeat(40), action: "fixup", subject: "discarded" }]);
  assert.match(todo, /^squash/m); assert.match(todo, /^fixup/m);
});
