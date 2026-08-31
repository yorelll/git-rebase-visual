import assert from "node:assert/strict";
import test from "node:test";
import { resolveRefspec } from "../src/git/pushGuard";

const upstream = { remote: "origin", branch: "feature/topic", ref: "origin/feature/topic" };

test("resolveRefspec defaults to an explicit branch ref", () => {
  assert.equal(resolveRefspec(upstream, "HEAD"), "HEAD:refs/heads/feature/topic");
});

test("resolveRefspec substitutes all supported template placeholders", () => {
  assert.equal(
    resolveRefspec(upstream, "abc123", "${tip}:refs/for/${branch}"),
    "abc123:refs/for/feature/topic"
  );
});

test("resolveRefspec treats whitespace-only template as default", () => {
  assert.equal(resolveRefspec(upstream, "HEAD", "  "), "HEAD:refs/heads/feature/topic");
});
