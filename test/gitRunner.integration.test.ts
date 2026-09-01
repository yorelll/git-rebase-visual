import assert from "node:assert/strict";
import test from "node:test";
import { runGit } from "../src/git/gitRunner";
import { createRepo, removeRepo } from "./helpers/gitTestRepo";

test("runGit returns a non-zero result rather than throwing for Git failures", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  const result = await runGit(["rev-parse", "--verify", "missing-ref"], { cwd });
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
});

test("runGit enforces an output limit", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  const result = await runGit(["config", "--list"], { cwd, maxBuffer: 1 });
  assert.equal(result.code, -1);
  assert.match(result.stderr, /output limit/);
});

test("runGit tracks output bytes across stdout and stderr", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  const result = await runGit(["config", "--list"], { cwd, maxBuffer: 16 * 1024 });
  assert.equal(result.code, 0);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 16 * 1024);
});

test("runGit honours an already-aborted signal", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  const controller = new AbortController();
  controller.abort();
  const result = await runGit(["status"], { cwd, signal: controller.signal });
  assert.equal(result.code, -1);
  assert.match(result.stderr, /cancelled/);
});
