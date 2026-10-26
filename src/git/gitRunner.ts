import { spawn } from "child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  /** Maximum combined stdout/stderr bytes retained in memory (default: 50 MiB). */
  maxBuffer?: number;
  /** Kill an unresponsive Git process after this many milliseconds (default: 120s). */
  timeout?: number;
  /** Cancels the Git process when the signal is aborted. */
  signal?: AbortSignal;
}

export interface GitInvocationLog {
  args: readonly string[];
  cwd: string;
  code: number;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT = 120_000;
/**
 * Grace period after the direct child exits, used to flush output already
 * buffered in the pipes. Completion is never tied to the `close` event: a
 * grandchild that inherited stdout/stderr can keep those pipes open forever.
 * The quiet period restarts while data is still arriving; the hard cap keeps a
 * huge output from delaying completion indefinitely.
 */
const EXIT_FLUSH_QUIET_MS = 50;
const EXIT_FLUSH_MAX_MS = 1_000;
/**
 * Backstop settlement deadline after a kill. Settlement normally follows the
 * tree kill itself, so this only fires if a killer never reports back; it must
 * stay comfortably above `TASKKILL_TIMEOUT_MS` for that reason.
 */
const KILL_SETTLE_MS = 6_000;

let invocationObserver: ((entry: GitInvocationLog) => void) | undefined;

/**
 * Installs a process-wide observer for finished Git invocations (file logger).
 * The observer must never affect execution; failures are swallowed.
 */
export function setGitInvocationObserver(
  observer: ((entry: GitInvocationLog) => void) | undefined
): void {
  invocationObserver = observer;
}

interface StopState {
  reason: string;
  timedOut: boolean;
  cancelled: boolean;
}

/**
 * How long `taskkill` gets to walk the tree before the direct kill fires.
 *
 * On Windows `taskkill /T /F` finds the descendants *through the tree root*. If
 * the direct `child.kill()` runs first, the root is already gone when
 * `taskkill` enumerates, it exits 128 ("no running instance found"), and every
 * grandchild survives while still holding the repository — an orphaned hook
 * shell keeps `index.lock` and the temp directory. So the direct kill must wait
 * for `taskkill`'s turn.
 *
 * The bound has to cover `taskkill` *starting*, not just walking: a cold
 * `taskkill.exe` spawn on Windows can take a few hundred milliseconds, and a
 * bound shorter than that reintroduces the very race it exists to prevent
 * (observed at 150 ms — the guard fired first and the hook shell survived).
 * Waiting here costs nothing caller-visible: settlement is bounded separately by
 * `KILL_SETTLE_MS`, and this promise is not awaited by `finalize`.
 */
const TASKKILL_TIMEOUT_MS = 5_000;

/**
 * Asks Git's process tree to die. A direct `child.kill()` only signals Git
 * itself; a rebase editor or hook that inherited the pipes would survive and
 * keep running, so on Windows `taskkill /T /F` is asked to walk the tree first.
 *
 * This is best-effort, not a guarantee: `taskkill` enumerates descendants
 * through the tree root, so a grandchild that has already detached (or is
 * created while the walk runs) survives with no parent to find it. That is a
 * process leak, not a correctness problem — settlement no longer waits on the
 * inherited stdio (see the `exit`-based settlement below), so a surviving
 * grandchild cannot block the extension host or hold the caller's deadline.
 *
 * Resolves once the tree kill has been attempted (bounded), so the caller can
 * keep settlement under its own deadline without racing the tree walk.
 */
function killProcessTree(
  child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }
): Promise<void> {
  const pid = child.pid;
  // The direct kill is the fallback for every platform, but on Windows it must
  // not run before `taskkill` had its chance (see TASKKILL_TIMEOUT_MS).
  const directKill = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  };

  if (pid === undefined) {
    directKill();
    return Promise.resolve();
  }

  if (process.platform === "win32") {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        resolve();
      };
      // Bounded: a hung or missing `taskkill` must never delay the kill itself.
      const guard = setTimeout(finish, TASKKILL_TIMEOUT_MS);
      let killer: ReturnType<typeof spawn>;
      try {
        killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {
        finish();
        return;
      }
      killer.on("error", finish);
      // `close` (not `exit`): the process is gone once its stdio is closed, and
      // stdio is ignored here, so the tree walk has finished either way.
      killer.on("close", finish);
      // A hung killer must not pin the extension host after the caller settled.
      killer.unref();
    }).then(() => {
      directKill();
    });
  }

  // The child runs in its own process group (`detached`); negating the pid
  // signals the whole group, including grandchildren that inherited stdio.
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // group already gone or not signalable
  }
  directKill();
  return Promise.resolve();
}

/**
 * Runs a git command and resolves with its output. Never rejects on non-zero
 * exit code — inspect `code` on the result instead. Output and execution time
 * are bounded so a pathological repository or unavailable remote cannot keep
 * the extension host alive indefinitely.
 *
 * Settlement is driven by the child's `exit` event (plus buffered-output drain
 * or a short flush grace), never by `close`: `close` waits for every inherited
 * stdio pipe, and a lingering grandchild can delay it indefinitely.
 */
export function runGit(args: string[], opts: GitRunOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
      // A POSIX process group lets the timeout/abort path kill grandchildren.
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let stopState: StopState | undefined;
    let settled = false;
    let exited = false;
    let exitCode = -1;
    let stdoutEnded = false;
    let stderrEnded = false;
    let exitGraceTimer: NodeJS.Timeout | undefined;
    let exitFlushDeadline = 0;
    let killSettleTimer: NodeJS.Timeout | undefined;
    const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT;

    /** Settles exactly once and releases every listener, timer and pipe. */
    const finalize = (code: number, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitGraceTimer) clearTimeout(exitGraceTimer);
      if (killSettleTimer) clearTimeout(killSettleTimer);
      exitGraceTimer = undefined;
      killSettleTimer = undefined;
      opts.signal?.removeEventListener("abort", onAbort);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners("exit");
      // Destroying the pipes releases a lingering grandchild's inherited handles
      // and unref keeps a detached process group from pinning the host.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      child.unref();
      if (stopState) {
        stderr = `${stderr}${stderr ? "\n" : ""}${stopState.reason}`;
      }
      const finalCode = stopState ? -1 : code;
      const observer = invocationObserver;
      if (observer) {
        try {
          observer({
            args: [...args],
            cwd: opts.cwd,
            code: finalCode,
            durationMs: Date.now() - startedAt,
            timedOut: stopState?.timedOut === true,
            cancelled: stopState?.cancelled === true,
          });
        } catch {
          // diagnostics must never break Git execution
        }
      }
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve({ code: finalCode, stdout, stderr });
    };

    /** After exit, settle as soon as both pipes ended; otherwise use the grace. */
    const settleAfterExitIfDrained = () => {
      if (!exited || stopState) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };

    /**
     * Schedules the flush grace. Called on exit and again whenever data still
     * arrives afterwards, so a large buffered output is not truncated while a
     * grandchild that never closes the pipe cannot delay completion past the cap.
     */
    const scheduleExitFlush = () => {
      if (!exited || stopState) return;
      if (exitGraceTimer) clearTimeout(exitGraceTimer);
      const remaining = Math.max(0, exitFlushDeadline - Date.now());
      exitGraceTimer = setTimeout(() => finalize(exitCode), Math.min(EXIT_FLUSH_QUIET_MS, remaining));
    };

    const stop = (reason: string, kind: "timeout" | "cancelled" | "limit") => {
      if (stopState) {
        return;
      }
      stopState = { reason, timedOut: kind === "timeout", cancelled: kind === "cancelled" };
      // Once `exit` fired the pid may already belong to another process on a
      // recycled-pid OS; during the flush grace there is nothing left to kill.
      if (exited) {
        killSettleTimer = setTimeout(() => finalize(exitCode), KILL_SETTLE_MS);
        return;
      }
      // The tree kill runs bounded and in order (taskkill first on Windows, then
      // the direct kill). Settlement follows the kill rather than racing it: a
      // fixed 250 ms deadline used to settle while `taskkill` was still walking
      // the tree, so the caller returned with the hook shell alive, still
      // holding the repository, and `removeRepo` failed with EPERM. The timer
      // below is now only a backstop for a killer that never reports back.
      killProcessTree(child).then(() => {
        if (!settled) finalize(exitCode);
      });
      killSettleTimer = setTimeout(() => finalize(exitCode), KILL_SETTLE_MS);
    };

    const timer = setTimeout(
      () => stop(`git ${args[0] ?? "command"} timed out after ${timeout}ms`, "timeout"),
      timeout
    );
    const onAbort = () => stop(`git ${args[0] ?? "command"} was cancelled`, "cancelled");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) {
      onAbort();
    }

    const append = (stream: "stdout" | "stderr", data: Buffer) => {
      if (settled || stopState) {
        return;
      }
      const text = data.toString();
      const bytes = Buffer.byteLength(text);
      if (outputBytes + bytes > maxBuffer) {
        stop(`git ${args[0] ?? "command"} exceeded the ${maxBuffer}-byte output limit`, "limit");
        return;
      }
      outputBytes += bytes;
      if (stream === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
      // Output that landed after `exit` must still be flushed before settling.
      scheduleExitFlush();
    };

    child.stdout?.on("data", (d: Buffer) => append("stdout", d));
    child.stderr?.on("data", (d: Buffer) => append("stderr", d));
    child.stdout?.on("end", () => {
      stdoutEnded = true;
      settleAfterExitIfDrained();
    });
    child.stderr?.on("end", () => {
      stderrEnded = true;
      settleAfterExitIfDrained();
    });
    child.on("error", (error) => finalize(-1, error));
    child.on("exit", (code) => {
      exited = true;
      exitCode = code ?? -1;
      if (stopState) {
        finalize(-1);
        return;
      }
      // Never wait on inherited pipes: flush buffered output, then settle even
      // if a grandchild still holds stdout/stderr open.
      exitFlushDeadline = Date.now() + EXIT_FLUSH_MAX_MS;
      scheduleExitFlush();
      settleAfterExitIfDrained();
    });

    if (opts.input !== undefined) {
      // The process may exit before consuming stdin; EPIPE must stay silent.
      child.stdin?.on("error", () => undefined);
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });
}

/** Runs git and throws if the command fails. Returns trimmed stdout. */
export async function git(args: string[], opts: GitRunOptions): Promise<string> {
  const res = await runGit(args, opts);
  if (res.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${res.code}): ${res.stderr.trim()}`);
  }
  return res.stdout.trim();
}
