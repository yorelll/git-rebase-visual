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

const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT = 120_000;

/**
 * Runs a git command and resolves with its output. Never rejects on non-zero
 * exit code — inspect `code` on the result instead. Output and execution time
 * are bounded so a pathological repository or unavailable remote cannot keep
 * the extension host alive indefinitely.
 */
export function runGit(args: string[], opts: GitRunOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let stoppedReason: string | undefined;
    let settled = false;
    const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT;

    const stop = (reason: string) => {
      if (stoppedReason) {
        return;
      }
      stoppedReason = reason;
      child.kill();
    };
    const timer = setTimeout(
      () => stop(`git ${args[0] ?? "command"} timed out after ${timeout}ms`),
      timeout
    );
    const onAbort = () => stop(`git ${args[0] ?? "command"} was cancelled`);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) {
      onAbort();
    }

    const append = (stream: "stdout" | "stderr", data: Buffer) => {
      if (settled || stoppedReason) {
        return;
      }
      const text = data.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(text) > maxBuffer) {
        stop(`git ${args[0] ?? "command"} exceeded the ${maxBuffer}-byte output limit`);
        return;
      }
      if (stream === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
    };

    child.stdout.on("data", (d: Buffer) => append("stdout", d));
    child.stderr.on("data", (d: Buffer) => append("stderr", d));
    child.on("error", (error) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (stoppedReason) {
        stderr = `${stderr}${stderr ? "\n" : ""}${stoppedReason}`;
      }
      resolve({ code: stoppedReason ? -1 : code ?? -1, stdout, stderr });
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
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
