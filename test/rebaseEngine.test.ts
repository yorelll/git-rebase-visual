import assert from "node:assert/strict";
import test from "node:test";
import { buildTodo } from "../src/git/rebaseEngine";

test("buildTodo writes oldest-first rebase actions with a final newline", () => {
  assert.equal(
    buildTodo([
      { hash: "a".repeat(40), action: "pick", subject: "first" },
      { hash: "b".repeat(40), action: "reword", subject: "second" },
      { hash: "c".repeat(40), action: "drop", subject: "third" },
    ]),
    `pick ${"a".repeat(40)} first\nreword ${"b".repeat(40)} second\ndrop ${"c".repeat(40)} third\n`
  );
});

test("buildTodo creates an empty todo for no commits", () => {
  assert.equal(buildTodo([]), "\n");
});
