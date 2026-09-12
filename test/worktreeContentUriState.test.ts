import assert from "node:assert/strict";
import test from "node:test";
import { decodeGitContentRequest, encodeGitContentRequest } from "../src/ui/worktreeContentUriState";

test("virtual diff content URI state round-trips each controlled Git side", () => {
  const request = { repository: "C:/repo with space", version: "index" as const, filePath: "a file [x].txt" };
  assert.deepEqual(decodeGitContentRequest(encodeGitContentRequest(request)), request);
  assert.equal(decodeGitContentRequest("not-json"), undefined);
  assert.equal(decodeGitContentRequest(encodeURIComponent(JSON.stringify({ ...request, version: "working" }))), undefined);
});
