import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { GitInvocationLog, runGit, setGitInvocationObserver } from "../src/git/gitRunner";
import { createRepo, git, removeRepo } from "./helpers/gitTestRepo";

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

test("runGit settles on exit even when a Git hook leaves a grandchild with open pipes", async (t) => {
  const cwd = createRepo();
  const marker = path.join(cwd, "release-hook");
  const pidFile = path.join(cwd, "grandchild.pid");
  // The background subshell inherits git's stdout/stderr and never exits on its
  // own, so Node would never emit `close` for the git process. `exit` does fire.
  //
  // The loop is bounded by a deadline as well as the marker: if `removeRepo`
  // wins the race, the marker can never be created again (its parent directory
  // is gone), and an unbounded loop would spin `sleep 0.1` forever in a deleted
  // temp directory. That is a test-process leak, not a product behaviour.
  const hook = path.join(cwd, ".git", "hooks", "pre-commit");
  fs.writeFileSync(
    hook,
    [
      "#!/bin/sh",
      `( i=0; while [ ! -f "${marker.replace(/\\/g, "/")}" ] && [ $i -lt 200 ]; do sleep 0.1; i=$((i+1)); done ) &`,
      `child=$!`,
      `echo "$(cat /proc/$child/winpid 2>/dev/null || echo $child)" > "${pidFile.replace(/\\/g, "/")}"`,
    ].join("\n") + "\n",
    "utf8"
  );
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(path.join(cwd, "hooked.txt"), "x", "utf8");
  git(cwd, ["add", "hooked.txt"]);
  t.after(async () => {
    // Let the lingering shell leave before the repo is deleted, and only then
    // remove the directory the shell is standing in.
    fs.writeFileSync(marker, "go", "utf8");
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      await waitFor(() => !isProcessAlive(pid), 10_000, "the hook's grandchild left before cleanup");
    }
    removeRepo(cwd);
  });
  const started = Date.now();
  const result = await runGit(
    ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-m", "hook"],
    { cwd, timeout: 20_000 }
  );
  const elapsed = Date.now() - started;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(elapsed < 10_000, `commit settled after ${elapsed}ms instead of on exit`);
});

test("a timeout settles exactly once and reaps the grandchild", async (t) => {
  const cwd = createRepo();
  const pidFile = path.join(cwd, "grandchild.pid");
  const hook = path.join(cwd, ".git", "hooks", "pre-commit");
  // The hook sleeps well past the timeout and leaves a grandchild looping
  // forever; a direct kill would leave that grandchild alive.
  //
  // `$!` is an MSYS pid, not a Windows pid, so probing it with `process.kill`
  // (a Windows pid API under Git-Bash) tested an unrelated namespace: the
  // assertion was vacuous when it passed and could false-fail. `/proc/$!/winpid`
  // maps it to the process the OS actually knows. Linux has no such file, so
  // the raw pid is used there, which is the same namespace `process.kill` uses.
  fs.writeFileSync(
    hook,
    [
      "#!/bin/sh",
      "( while :; do sleep 0.1; done ) &",
      `child=$!`,
      `echo "$(cat /proc/$child/winpid 2>/dev/null || echo $child)" > "${pidFile.replace(/\\/g, "/")}"`,
      // Wait far past the 1.5 s timeout, but in short sleeps: `sleep 30` survives
      // the tree kill as an orphan and is invisible to it, so a single long
      // sleep would sit in the process table for half a minute after the test.
      // Any sleep that *is* caught is reaped; one that is not exits almost at once.
      "( i=0; while [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done )",
    ].join("\n") + "\n",
    "utf8"
  );
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(path.join(cwd, "hooked.txt"), "x", "utf8");
  git(cwd, ["add", "hooked.txt"]);

  const observed: GitInvocationLog[] = [];
  setGitInvocationObserver((entry) => observed.push(entry));
  t.after(async () => {
    setGitInvocationObserver(undefined);
    // The reaped tree may hold the temp directory for a moment on Windows.
    await waitForRemoval(cwd);
  });

  // The probe is only meaningful if it can see a live process, so that is
  // asserted first: the grandchild must still be running while the hook blocks,
  // and must be gone afterwards. A pid that was never valid fails the first
  // check instead of passing the second one for the wrong reason.
  const started = Date.now();
  const commit = runGit(
    ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-m", "timeout"],
    { cwd, timeout: 3_000 }
  );
  // The file appears before `echo` finishes writing it, so wait for a usable
  // value rather than for existence.
  let grandchild = 0;
  let rawPid = "";
  await waitFor(
    () => {
      try {
        rawPid = fs.readFileSync(pidFile, "utf8").trim();
      } catch {
        return false;
      }
      const parsed = Number(rawPid);
      if (!Number.isInteger(parsed) || parsed <= 0) return false;
      grandchild = parsed;
      return true;
    },
    10_000,
    "the hook recorded its grandchild"
  );
  assert.equal(
    isProcessAlive(grandchild),
    true,
    `pid ${grandchild} was not a live process, so the reap check would be vacuous`
  );

  const result = await commit;
  const elapsed = Date.now() - started;
  assert.equal(result.code, -1);
  assert.match(result.stderr, /timed out/);
  // The hook waits 30s in 0.1s sleeps; settling before that proves the timeout
  // won rather than the child finishing. The bound stays generous for a loaded
  // CI machine.
  assert.ok(elapsed < 20_000, `timeout settled after ${elapsed}ms`);
  assert.equal(observed.length, 1, "the invocation observer fires once");
  assert.equal(observed[0].timedOut, true);
  assert.equal(observed[0].code, -1);
  // Any accidentally lingering observer settlement would show up as a second
  // entry after the deadline.
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(observed.length, 1, "the timeout did not resolve twice");
  // The grandchild would still be looping (and pin the repo) if the direct
  // child alone had been killed.
  await waitFor(() => !isProcessAlive(grandchild), 5_000, "the grandchild process was reaped");
});

/**
 * Probes existence without delivering a signal. The pid must be in this OS's
 * namespace: under Git-Bash a shell's `$!` is an MSYS pid, which maps to no
 * Windows process, so `/proc/<msys>/winpid` is what the hook records.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Removes a temp repo, retrying a transient Windows lock on a just-killed child. */
async function waitForRemoval(cwd: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      removeRepo(cwd);
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

test("an abort settles exactly once and does not resolve twice", async (t) => {
  const cwd = createRepo();
  const hook = path.join(cwd, ".git", "hooks", "pre-commit");
  // The abort fires 400 ms in, so the hook must still be running at that point.
  // A fast hook (`cat > /dev/null`) can finish first on a quick CI runner, which
  // made this test resolve with code 0 and assert a cancellation that never
  // happened. A bounded sleep loop keeps the child alive deterministically and
  // still exits on its own if the kill does not arrive.
  fs.writeFileSync(
    hook,
    "#!/bin/sh\n# Bounded so a failed kill cannot leave a permanent orphan.\ni=0\nwhile [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done\n",
    "utf8"
  );
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(path.join(cwd, "hooked.txt"), "x", "utf8");
  git(cwd, ["add", "hooked.txt"]);
  t.after(() => removeRepo(cwd));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 400);
  t.after(() => clearTimeout(timer));
  let observerCalls = 0;
  setGitInvocationObserver(() => {
    observerCalls += 1;
  });
  t.after(() => setGitInvocationObserver(undefined));

  const result = await runGit(
    ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-m", "abort"],
    { cwd, timeout: 20_000, signal: controller.signal }
  );
  // Give any accidental second settlement a chance to fire before asserting.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(result.code, -1);
  assert.match(result.stderr, /cancelled/);
  assert.equal(observerCalls, 1);
});
