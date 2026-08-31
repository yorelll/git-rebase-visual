import assert from "node:assert/strict";
import test from "node:test";
import { applyTrailers, splitTrailers } from "../src/git/message";

test("splitTrailers separates a recognized trailing trailer block", () => {
  const message = "feat: add timeline\n\nDetails.\n\nChange-Id: I123\nSigned-off-by: Test <t@example.com>\n";
  assert.deepEqual(splitTrailers(message), {
    body: "feat: add timeline\n\nDetails.",
    trailers: "Change-Id: I123\nSigned-off-by: Test <t@example.com>",
  });
});

test("splitTrailers keeps arbitrary trailers adjacent to recognized trailers", () => {
  const message = "fix: restore review\n\nBug: 123\nChange-Id: I123\n";
  assert.deepEqual(splitTrailers(message), {
    body: "fix: restore review",
    trailers: "Bug: 123\nChange-Id: I123",
  });
});

test("splitTrailers does not classify an isolated body line as a trailer", () => {
  const message = "docs: explain Signed-off-by: syntax\n";
  assert.deepEqual(splitTrailers(message), {
    body: "docs: explain Signed-off-by: syntax",
    trailers: "",
  });
});

test("applyTrailers preserves original trailer block when editing body", () => {
  const original = "old subject\n\nChange-Id: I123\nSigned-off-by: Test <t@example.com>\n";
  assert.equal(
    applyTrailers("new subject\n\nNew details", original),
    "new subject\n\nNew details\n\nChange-Id: I123\nSigned-off-by: Test <t@example.com>\n"
  );
});

test("applyTrailers uses an intentionally edited trailing block", () => {
  const original = "old subject\n\nChange-Id: I123\n";
  assert.equal(
    applyTrailers("new subject\n\nChange-Id: I456", original),
    "new subject\n\nChange-Id: I456\n"
  );
});

test("applyTrailers handles messages without trailers", () => {
  assert.equal(applyTrailers("new subject  ", "old subject"), "new subject\n");
});
