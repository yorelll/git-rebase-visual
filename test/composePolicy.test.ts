import assert from "node:assert/strict";
import test from "node:test";
import { isDraftOnlyAiGenerationAllowedDuringRebase, isDraftOnlyComposeAllowedDuringRebase } from "../src/ui/composePolicy";

test("only draft-only staged or working compose can open during a rebase", () => {
  assert.equal(isDraftOnlyComposeAllowedDuringRebase("staged", true), true);
  assert.equal(isDraftOnlyComposeAllowedDuringRebase("working", true), true);
  assert.equal(isDraftOnlyComposeAllowedDuringRebase("staged", false), false);
  assert.equal(isDraftOnlyComposeAllowedDuringRebase("working", false), false);
  assert.equal(isDraftOnlyComposeAllowedDuringRebase("commit", true), false);
  assert.equal(isDraftOnlyComposeAllowedDuringRebase("commit", false), false);
});

test("AI generation at a rebase stop remains draft-only and rejects conflicts", () => {
  assert.equal(isDraftOnlyAiGenerationAllowedDuringRebase("staged", true, false), true);
  assert.equal(isDraftOnlyAiGenerationAllowedDuringRebase("working", true, false), true);
  assert.equal(isDraftOnlyAiGenerationAllowedDuringRebase("staged", false, false), false);
  assert.equal(isDraftOnlyAiGenerationAllowedDuringRebase("commit", true, false), false);
  assert.equal(isDraftOnlyAiGenerationAllowedDuringRebase("staged", true, true), false);
});
