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
}

/**
 * Runs a git command and resolves with its output. Never rejects on non-zero
 * exit code — inspect `code` on the result instead.
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
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));

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
