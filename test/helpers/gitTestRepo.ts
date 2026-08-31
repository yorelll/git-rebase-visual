import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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
