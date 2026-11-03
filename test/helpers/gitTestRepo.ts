import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Runs Git with extra environment variables and returns trimmed stdout.
 *
 * Needed to reproduce shapes where Git's answer depends on where it runs from —
 * for example a relative `core.attributesFile`, which resolves against the
 * process's working directory rather than the repository.
 */
export function gitEnv(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();
}

/**
 * Runs Git and returns its exit code instead of throwing. Needed for probes
 * whose non-zero exit *is* the expected result (`rev-parse --verify`,
 * `cat-file -e`, `diff --quiet`), where `git()` would abort the test.
 */
export function gitExit(cwd: string, args: string[]): number {
  try {
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    return 0;
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    return typeof status === "number" ? status : 1;
  }
}

export function createRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grv-test-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Git Rebase Visual Test"]);
  return dir;
}

export function commitFile(
  cwd: string,
  filename: string,
  content: string,
  message: string
): string {
  fs.writeFileSync(path.join(cwd, filename), content, "utf8");
  git(cwd, ["add", filename]);
  git(cwd, ["commit", "-qm", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

export function removeRepo(cwd: string): void {
  fs.rmSync(cwd, { recursive: true, force: true });
}

/**
 * Aborts any in-progress rebase and deletes the repo.
 *
 * `git rebase --abort` refuses when an untracked file would be overwritten by
 * the reset that returns to the original HEAD. That is exactly the state these
 * append tests leave behind: the later commit's path was restored as an
 * untracked file while the edited target predates it. Removing untracked files
 * first lets the abort complete; the repo is about to be deleted anyway.
 */
export function cleanupRepo(cwd: string): void {
  const rebaseState = git(cwd, ["rev-parse", "--git-path", "rebase-merge"]);
  if (fs.existsSync(path.join(cwd, rebaseState))) {
    if (gitExit(cwd, ["rebase", "--abort"]) !== 0) {
      gitExit(cwd, ["clean", "-fdq"]);
      if (gitExit(cwd, ["rebase", "--abort"]) !== 0) {
        gitExit(cwd, ["rebase", "--quit"]);
      }
    }
  }
  removeRepo(cwd);
}
