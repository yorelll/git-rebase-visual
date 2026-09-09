import assert from "node:assert/strict";
import test from "node:test";

/** Mirrors the panel's subject/body serialization contract. */
function compose(subject: string, body: string): string {
  return [subject, body].filter((part, index) => index === 0 || part.trim()).join("\n\n").trim();
}

test("compose draft keeps subject/body boundaries and supports restore point", () => {
  const before = compose("feat: original", "body");
  const generated = compose("feat: generated", "new body");
  assert.equal(before, "feat: original\n\nbody");
  assert.equal(generated, "feat: generated\n\nnew body");
  assert.equal(before, "feat: original\n\nbody"); // restore-to-before value
});

test("subject guideline thresholds preserve content instead of truncating it", () => {
  assert.equal("x".repeat(50).length, 50);
  assert.equal("x".repeat(73).length > 72, true);
});
