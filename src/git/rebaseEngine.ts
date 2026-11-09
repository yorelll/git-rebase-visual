import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { C_LOCALE, runGit, withPositionals, GitResult } from "./gitRunner";

export type RebaseAction = "pick" | "reword" | "drop" | "edit" | "squash" | "fixup";

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
  // `oldestHash` comes from `this.commits`/the plan's items, i.e. a rendered
  // 40-hex hash, but `rev-parse` keeps parsing options after a positional, so
  // the marker is what makes that a property of the argument rather than of the
  // current call sites.
  const res = await runGit(
    withPositionals(["rev-parse", "--verify", "--quiet"], [`${oldestHash}^`]),
    { cwd }
  );
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
  // `-i` and `--root` are options; the base revision is a positional. They
  // cannot live in one array because the marker has to sit between them — the
  // same split `RangeArgv` forces on `git log`. `base.base` is a 40-hex hash
  // returned by `resolveBase`, but `plan.onto` is caller-supplied and a rebase
  // aborts on an unparsable argument instead of rewriting to the wrong place,
  // so the distinction is worth stating in the argv itself.
  const res: GitResult = await runGit(
    base.root
      ? ["rebase", "-i", "--root"]
      : withPositionals(["rebase", "-i"], [base.base]),
    { cwd, env }
  );

  cleanup(tmp);

  // An `edit` stop makes git exit 0 while the rebase is still in progress, so
  // exit code alone is not enough — always check whether a rebase is paused.
  const stillInProgress = await isStopped(cwd);
  if (stillInProgress) {
    return {
      ok: false,
      stopped: true,
      message: (res.stdout || res.stderr).trim() || "Rebase paused.",
    };
  }

  if (res.code === 0) {
    return { ok: true, stopped: false, message: "Rebase completed." };
  }

  // Non-zero and not paused: a hard failure.
  return {
    ok: false,
    stopped: false,
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

/**
 * Locale pinned for the abort calls whose output is parsed below.
 *
 * The collision list is recognized by its English header, so a localized Git
 * would hide it and re-create the dead end this function removes. Git also
 * prints those paths verbatim (not `core.quotePath`-escaped), so the parsed
 * entries are real paths regardless of the user's `core.quotePath`.
 *
 * The value is `C_LOCALE` from `gitRunner.ts`, the shared constant for any call
 * whose human-readable output is read. It stays under this name because both
 * call sites below are the abort path and the alias reads as one decision.
 */
const ABORT_ENV: NodeJS.ProcessEnv = C_LOCALE;

/**
 * Aborts a paused rebase, restoring the pre-rebase state.
 *
 * `git rebase --abort` resets to the pre-rebase HEAD, and the reset refuses to
 * overwrite an untracked file: "The following untracked working tree files
 * would be overwritten by reset". A transaction that restored a snapshot path
 * into the worktree while a later commit owned it leaves exactly that state, so
 * a plain abort exits 128 and the user is stuck retrying forever.
 *
 * ## This function never deletes anything
 *
 * An earlier version tried to clear that blockage automatically, deleting a
 * blocked path only when it could prove the deletion lossless. That proof was
 * wrong three times running: first the ownership test, then the attribute src
 * the reset reads, then relative `core.attributesFile` and worktree-dependent
 * smudge filters. Each fix closed one shape and left the next; the class is not
 * enumerable, because it is "every way a checkout filter can depend on
 * something other than the blob". One wrong prediction deletes bytes that may
 * exist in no commit and no stash.
 *
 * So the answer is to stop predicting. When the abort is blocked, this throws
 * with a message that tells the user what happened, that nothing was deleted,
 * and exactly what to move. The worktree is untouched and the rebase stays
 * paused, so stopping here costs nothing but a manual step.
 *
 * The one thing that is safe to assert is what Git itself said: the collision
 * wordings are parsed only to *name* the paths in that message. No branch of
 * this function removes a file, and an unrecognized failure shape is re-thrown
 * verbatim rather than guessed at.
 */
export async function abortRebase(cwd: string): Promise<void> {
  const res = await runGit(["rebase", "--abort"], { cwd, env: ABORT_ENV });
  if (res.code === 0) {
    return;
  }
  const blocked = untrackedCollisions(res.stderr) ?? untrackedCollisions(res.stdout);
  if (!blocked) {
    const directories = directoryCollisions(res.stderr) ?? directoryCollisions(res.stdout);
    if (directories) {
      throw new Error(directoryCollisionMessage(directories, await describeStash(cwd)));
    }
    // Unrecognized failure. Nothing is deleted anywhere in this function, so an
    // unparsed collision shape cannot lead to a deletion; the raw Git output is
    // the most useful thing to show.
    throw new Error((res.stderr || res.stdout).trim() || `git rebase --abort exit ${res.code}`);
  }
  throw new Error(untrackedCollisionMessage(blocked, await describeStash(cwd)));
}

/**
 * What this function may honestly say about the user's changes and a stash.
 *
 * The previous message asserted unconditionally that "the original changes are
 * still intact in the stash". With `gitRebaseVisual.autoStash` off — or for a
 * rebase the user started by hand — `git stash list` is empty, so the very first
 * command a worried user runs contradicts the reassurance that was supposed to
 * calm them. A safety message cannot state something the reader can falsify in
 * one command, so the claim is measured instead of assumed.
 *
 * Regardless of the answer, the *other* half stays true and is asserted in both
 * cases: nothing was deleted, and the rebase is still paused with the worktree
 * exactly as the user left it. That is the part that actually protects them.
 */
interface StashClaim {
  /** One self-contained sentence, no trailing punctuation beyond its own. */
  clause: string;
}

/** Builds the stash sentence from what `git stash list` actually reports. */
async function describeStash(cwd: string): Promise<StashClaim> {
  const res = await runGit(["stash", "list", "--format=%gd"], { cwd, env: ABORT_ENV });
  const counted = res.code === 0;
  const entries = counted ? res.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0) : [];
  if (entries.length > 0) {
    // A count is all this function verified. Saying "your changes are in there"
    // would assert something about the *contents* of entries it never read, so
    // it reports the observable fact and leaves the conclusion to the user.
    return {
      clause: `\`git stash list\` 现在有 ${entries.length} 条记录，都还在列表里。`,
    };
  }
  if (!counted) {
    // The listing itself failed, so there is no count to report either way. Say
    // only what this function knows for certain: it did not touch the worktree.
    return { clause: `本扩展没有改动过你的工作区。` };
  }
  // Checked, and empty. Saying "your work is in the stash" here is exactly the
  // sentence a single `git stash list` would contradict.
  return {
    clause: `\`git stash list\` 现在为空，没有 stash 副本可以依赖；但你的工作区原封未动，内容就在原处。`,
  };
}

/**
 * Paths named by the "Updating the following directories would lose untracked
 * files in them" error.
 *
 * Git uses different wording when a *directory* sits where the reset wants to
 * write a file (or when the reset would have to delete a directory holding
 * untracked files). Recognizing it separately lets the error name the directory
 * and give advice that fits a directory, instead of showing raw Git output.
 */
function directoryCollisions(output: string): string[] | undefined {
  return pathsUnderHeader(output, /Updating the following directories would lose untracked files/i);
}

/** Paths named by the "untracked working tree files would be overwritten" error. */
function untrackedCollisions(output: string): string[] | undefined {
  return pathsUnderHeader(output, /untracked working tree files would be overwritten/i);
}

/** Extracts the tab-indented path list that follows a Git collision header. */
function pathsUnderHeader(output: string, header: RegExp): string[] | undefined {
  if (!header.test(output)) {
    return undefined;
  }
  const lines = output.split(/\r?\n/);
  const paths: string[] = [];
  let collecting = false;
  for (const line of lines) {
    if (header.test(line)) {
      collecting = true;
      continue;
    }
    if (!collecting) {
      continue;
    }
    // The list is indented one tab and ends at the first non-indented line.
    if (/^\t/.test(line)) {
      paths.push(line.slice(1));
      continue;
    }
    if (line.trim().length === 0) {
      collecting = false;
      continue;
    }
    break;
  }
  return paths.length > 0 ? paths : undefined;
}

/**
 * Quotes one path for a POSIX shell using single quotes.
 *
 * The previous version wrapped the path in `'…'` without escaping, so a legal
 * filename containing a single quote produced `mv -- 'it's.txt' 'it's.txt.bak'`
 * — a command that fails (or, for a name like `pwn'; touch OWNED; echo '.txt`,
 * one that *runs something else* when pasted). The extension never executes
 * these strings, but their whole purpose is to be copied, so a wrong command is
 * a real defect.
 *
 * Single quotes disable every expansion a POSIX shell performs (no `$`, no
 * backtick, no `\`, no glob). The only character that cannot appear inside them
 * is `'` itself, and the standard fix is to close the quote, emit an escaped
 * `'`, and reopen: `'it'\''s.txt'`. Paths may also contain newlines, which stay
 * literal inside the quotes. `test/rebaseEngine.test.ts` proves this by feeding
 * every hostile name to a real `sh -c 'printf %s …'` and comparing the bytes
 * that come back, rather than merely eyeballing the quoting — and by asserting
 * the hostile payload did not create a file.
 */
export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** Total entries actually listed: the cap plus what it stands for. */
const COLLISION_LIST_LIMIT = 5;

/**
 * The message for an abort blocked by untracked files.
 *
 * It has to work for someone who has never read this code and is looking at a
 * failed recovery they did not ask for. In order: what happened, that nothing
 * was deleted, how to fix it, that their work is safe, and what to do if a
 * listed file is a build artifact. The displayed paths are the exact text Git
 * reported (that is what the user has to find); the copyable commands quote
 * them for a shell, which is a different requirement.
 *
 * `stash` is passed in rather than assumed: with `autoStash` off and an empty
 * `git stash list`, claiming "your changes are still in the stash" is something
 * the user can falsify in one command, and a safety message must not do that.
 */
function untrackedCollisionMessage(paths: string[], stash: StashClaim): string {
  const shown = paths.slice(0, COLLISION_LIST_LIMIT);
  const more = paths.length > shown.length ? `（另有 ${paths.length - shown.length} 个未在这里列出）` : "";
  const listing = shown.map((item) => `  ${item}`).join("\n");
  const rename = shown.map((item) => `  mv -- ${shellQuote(item)} ${shellQuote(`${item}.bak`)}`).join("\n");
  return [
    `Abort 被阻止：以下未跟踪文件会被回退到变基前的提交时覆盖，因此 git rebase --abort 没有执行：`,
    listing + more,
    ``,
    `没有删除任何文件。这些文件仍在原处，内容与执行本次 Abort 之前完全一致。`,
    ``,
    `请把它们移出仓库（或改名），然后重新执行 Abort。可以直接复制的命令：`,
    rename,
    `Windows 上也可以在资源管理器里重命名或把这些文件拖到仓库外面——效果相同。`,
    ``,
    `你的改动没有丢。${stash.clause}变基也仍停在暂停状态，停在这里不会有任何损失，只是需要你手动完成这一步。`,    ``,
    `如果你确认上面某个文件只是构建产物、不需要保留，可以自己删除它再重试 Abort——但这个判断由你来做，扩展不会替你删。`,
  ].join("\n");
}

/**
 * The message for an abort blocked by untracked *directories*.
 *
 * Git words this differently, and a directory cannot be moved with a single
 * `mv` without thought, so the guidance names the directory and leaves the move
 * to the user. Same guarantees as the file case: nothing was deleted.
 */
function directoryCollisionMessage(directories: string[], stash: StashClaim): string {
  const listing = directories.map((item) => `  ${item}`).join("\n");
  return [
    `Abort 被阻止：以下未跟踪目录会被回退到变基前的提交时替换，因此 git rebase --abort 没有执行：`,
    listing,
    ``,
    `没有删除任何文件，也没有删除任何目录。它们仍在原处，内容与执行本次 Abort 之前完全一致。`,
    ``,
    `请先把这些目录移到仓库外（例如重命名或整体备份），再重新执行 Abort。`,
    ``,
    `你的改动没有丢。${stash.clause}变基也仍停在暂停状态，停在这里不会有任何损失，只是需要你手动完成这一步。`,    ``,
    `如果你确认某个目录里的内容只是构建产物、不需要保留，可以自己删除后再重试 Abort——但这个判断由你来做，扩展不会替你删。`,
  ].join("\n");
}
