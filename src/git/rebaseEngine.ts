import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { runGit, git, GitResult } from "./gitRunner";

export type RebaseAction = "pick" | "reword" | "drop" | "edit";

export interface RebaseItem {
  hash: string;
  action: RebaseAction;
  subject: string;
}

export type RebaseBase = { root: true } | { root: false; base: string };

export interface RebasePlan {
  /** Items in git todo order: oldest first, newest last. */
  items: RebaseItem[];
  /**
   * The commit to rebase onto (the parent of the range's ORIGINAL oldest
   * commit). Must be supplied by the caller because it is independent of how
   * items are reordered. When omitted, falls back to the parent of items[0].
   */
  onto?: RebaseBase;
  /** New message applied to the single reworded commit, if any. */
  newMessage?: string;
}

export interface RebaseOutcome {
  ok: boolean;
  stopped: boolean; // rebase paused (conflict or edit) and needs continue/abort
  message: string;
}

/** Absolute path to the bundled sequence-editor script. */
function seqEditorPath(): string {
  return path.join(__dirname, "seq-editor.js");
}

/**
 * The editor command git should invoke for the todo / commit message. Uses the
 * running process's node/electron binary (process.execPath) instead of a bare
 * `node`, because `node` is frequently absent from PATH — notably on
 * vscode-server / remote hosts. On desktop VSCode, process.execPath is the
 * Electron binary, which runs as node when ELECTRON_RUN_AS_NODE=1 is set (done
 * in the child env below).
 */
function editorCommand(): string {
  return `"${process.execPath}" "${seqEditorPath()}"`;
}

/**
 * Builds the todo file text from ordered items. `drop` items are emitted as
 * explicit `drop` lines so the todo remains self-documenting.
 */
export function buildTodo(items: RebaseItem[]): string {
  return (
    items
      .map((it) => `${it.action} ${it.hash} ${it.subject}`)
      .join("\n") + "\n"
  );
}

/**
 * Resolves the rebase base ("onto"): the parent of the given commit. Falls back
 * to --root when it has no parent. Exported so callers can compute the base from
 * the range's original oldest commit before any reordering.
 */
export async function resolveBase(
  cwd: string,
  oldestHash: string
): Promise<RebaseBase> {
  const res = await runGit(["rev-parse", "--verify", "--quiet", `${oldestHash}^`], {
    cwd,
  });
  if (res.code !== 0 || !res.stdout.trim()) {
    return { root: true };
  }
  return { root: false, base: res.stdout.trim() };
}

/**
 * Executes a scripted interactive rebase. Writes the computed todo (and
 * optional new message) to temp files and drives `git rebase -i` through the
 * bundled sequence editor. Does not throw on conflict — inspect the outcome.
 */
export async function executeRebase(
  cwd: string,
  plan: RebasePlan
): Promise<RebaseOutcome> {
  if (plan.items.length === 0) {
    return { ok: true, stopped: false, message: "Nothing to do." };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grv-rebase-"));
  const todoFile = path.join(tmp, "todo");
  fs.writeFileSync(todoFile, buildTodo(plan.items), "utf8");

  const env: NodeJS.ProcessEnv = {
    GRV_TODO_FILE: todoFile,
    GIT_SEQUENCE_EDITOR: editorCommand(),
    GIT_EDITOR: editorCommand(),
    ELECTRON_RUN_AS_NODE: "1",
  };

  let msgFile: string | undefined;
  if (plan.newMessage !== undefined) {
    msgFile = path.join(tmp, "message");
    fs.writeFileSync(msgFile, plan.newMessage, "utf8");
    env.GRV_MSG_FILE = msgFile;
  }

  const base = plan.onto ?? (await resolveBase(cwd, plan.items[0].hash));
  const args = ["rebase", "-i"];
  if (base.root) {
    args.push("--root");
  } else {
    args.push(base.base);
  }

  const res: GitResult = await runGit(args, { cwd, env });

  cleanup(tmp);

  if (res.code === 0) {
    return { ok: true, stopped: false, message: "Rebase completed." };
  }

  // Non-zero: could be a conflict/stopped rebase or a hard failure.
  const stopped = await isStopped(cwd);
  return {
    ok: false,
    stopped,
    message: (res.stderr || res.stdout).trim(),
  };
}

async function isStopped(cwd: string): Promise<boolean> {
  const { isRebaseInProgress } = await import("./commitLog");
  return isRebaseInProgress(cwd);
}

function cleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/** Continues a paused rebase after conflicts are resolved / staged. */
export async function continueRebase(cwd: string): Promise<RebaseOutcome> {
  const env: NodeJS.ProcessEnv = {
    GIT_SEQUENCE_EDITOR: "true",
    GIT_EDITOR: "true",
  };
  const res = await runGit(["rebase", "--continue"], { cwd, env });
  if (res.code === 0) {
    return { ok: true, stopped: false, message: "Rebase completed." };
  }
  return {
    ok: false,
    stopped: await isStopped(cwd),
    message: (res.stderr || res.stdout).trim(),
  };
}

/** Aborts a paused rebase, restoring the pre-rebase state. */
export async function abortRebase(cwd: string): Promise<void> {
  await git(["rebase", "--abort"], { cwd });
}
