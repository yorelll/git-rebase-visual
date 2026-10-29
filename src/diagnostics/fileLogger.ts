import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Retention: keep the newest N session files, then remove older ones. */
export const DEFAULT_LOG_RETENTION = 10;
/** A single session file rotates once it exceeds this size. */
export const DEFAULT_LOG_MAX_BYTES = 4 * 1024 * 1024;
/** Folder-name prefix inside the per-user log root. */
export const LOG_FOLDER_PREFIX = "git-rebase-visual";

/**
 * Absolute log directory for this extension version:
 * `<home>/tmp/log/git-rebase-visual-<version>`.
 *
 * It lives **under the user's home**, not the system temp directory: logs are
 * something the user asks for and attaches to a bug report, so they must be
 * findable at a predictable path (`~/tmp/log/...` on Linux and macOS,
 * `C:\Users\<user>\tmp\log\...` on Windows). 0.8.0 wrote to `os.tmpdir()`,
 * which is `/tmp` on Linux — a location users do not browse.
 *
 * The version segment keeps diagnostics from different builds apart. `home` is
 * injectable so tests never depend on the machine they run on.
 */
export function logDirectory(version: string, home: string = os.homedir()): string {
  const safeVersion = String(version || "0.0.0").replace(/[^0-9A-Za-z._-]/g, "_");
  return path.join(home, "tmp", "log", `${LOG_FOLDER_PREFIX}-${safeVersion}`);
}

/**
 * Root that pre-0.8.1 builds wrote their log folders under (`os.tmpdir()/log`).
 * Only ever read, to tell the user once where their older logs are; nothing
 * writes here any more. The note names this *root* rather than a versioned
 * subfolder: old folders carry the version that wrote them, so a 0.8.1 install
 * has no matching folder there and naming one would invent a directory.
 */
export function legacyLogRoot(tmpdir: string = os.tmpdir()): string {
  return path.join(tmpdir, "log");
}

/** Session file name. Timestamped so multiple hosts can coexist. */
export function sessionLogFileName(at: Date = new Date(), pid: number = process.pid, index = 0): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  return `session-${stamp}-${pid}${index > 0 ? `-${index}` : ""}.log`;
}

/** Rotation file name for a session that exceeded its size budget. */
export function rotatedLogFileName(fileName: string, index: number): string {
  return fileName.replace(/\.log$/, `.${index}.log`);
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // URL userinfo: https://user:token@host -> https://***@host
  [/(https?:\/\/)[^\s/@]+@/gi, "$1***@"],
  // Authorization headers carry the scheme plus the credential; drop both.
  [/(authorization:)[^\n]*/gi, "$1 ***"],
  // Common key/value shapes in argv, env dumps and HTTP bodies.
  [/((?:api[_-]?key|apikey|token|secret|password|passwd|pwd)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1***"],
  [/(--(?:api-key|token|password|secret)(?:=|\s+))\S+/gi, "$1***"],
];

/**
 * Removes credentials from a diagnostic line. Reused for the OutputChannel and
 * file logs; idempotent so re-logging already-redacted text is safe.
 */
export function redactLogLine(message: string): string {
  let safe = String(message ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    safe = safe.replace(pattern, replacement);
  }
  return safe;
}

/** Formats one file-log line. Pure so tests never touch the disk. */
export function formatLogLine(
  at: Date,
  level: "debug" | "info" | "warn" | "error",
  operation: string,
  message: string
): string {
  return `[${at.toISOString()}] [${level}] ${operation}: ${redactLogLine(message)}`;
}

export interface LoggerIo {
  mkdirSync: typeof fs.mkdirSync;
  appendFileSync: typeof fs.appendFileSync;
  readdirSync: typeof fs.readdirSync;
  statSync: typeof fs.statSync;
  unlinkSync: typeof fs.unlinkSync;
  renameSync: typeof fs.renameSync;
}

export interface FileLoggerOptions {
  directory: string;
  fileName?: string;
  retention?: number;
  maxBytes?: number;
  now?: () => Date;
  /** Injectable IO so tests can simulate a read-only disk without VS Code. */
  io?: Partial<LoggerIo>;
}

/**
 * Append-only session logger.
 *
 * Design constraints:
 * - never throws and never blocks the UI: a read-only temp dir, a full disk or
 *   a disappearing folder degrade to silence (the OutputChannel still works);
 * - one file per extension-host session, rotated by size, with retention so the
 *   folder cannot grow unbounded.
 */
export class FileLogger {
  private readonly directory: string;
  private readonly retention: number;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private readonly io: LoggerIo;
  private fileName: string;
  private bytesWritten = 0;
  private rotation = 0;
  private disabled = false;

  constructor(options: FileLoggerOptions) {
    this.directory = options.directory;
    this.retention = Math.max(1, options.retention ?? DEFAULT_LOG_RETENTION);
    this.maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_LOG_MAX_BYTES);
    this.now = options.now ?? (() => new Date());
    this.io = {
      mkdirSync: fs.mkdirSync,
      appendFileSync: fs.appendFileSync,
      readdirSync: fs.readdirSync,
      statSync: fs.statSync,
      unlinkSync: fs.unlinkSync,
      renameSync: fs.renameSync,
      ...options.io,
    };
    this.fileName = options.fileName ?? sessionLogFileName(this.now());
  }

  /** Current log file (changes only after size rotation). */
  get path(): string {
    return path.join(this.directory, this.fileName);
  }

  get logFolder(): string {
    return this.directory;
  }

  /** True once a write failed; the caller can stop retrying expensive work. */
  get isDisabled(): boolean {
    return this.disabled;
  }

  /** Creates the folder, prunes old sessions and writes a session header. */
  start(context: string[] = []): void {
    try {
      this.io.mkdirSync(this.directory, { recursive: true });
      this.prune();
      this.bytesWritten = 0;
      this.write("info", "session", ["启动", ...context].filter(Boolean).join(" | "));
    } catch {
      this.disabled = true;
    }
  }

  /** Creates the folder without starting a new session (for "reveal logs"). */
  ensureDirectory(): string {
    try {
      this.io.mkdirSync(this.directory, { recursive: true });
    } catch {
      // Callers only show the path; a missing folder is not fatal.
    }
    return this.directory;
  }

  info(operation: string, message: string): void {
    this.write("info", operation, message);
  }

  warn(operation: string, message: string): void {
    this.write("warn", operation, message);
  }

  error(operation: string, message: string, error?: unknown): void {
    const detail = error instanceof Error
      ? `${message} | ${error.stack ?? error.message}`
      : error !== undefined
        ? `${message} | ${String(error)}`
        : message;
    this.write("error", operation, detail);
  }

  /** Files currently present in the log directory, newest first. */
  listSessions(): string[] {
    return this.entries().map((entry) => entry.full);
  }

  private entries(): Array<{ name: string; full: string; mtime: number }> {
    try {
      return this.io
        .readdirSync(this.directory)
        .filter((name) => name.endsWith(".log"))
        .map((name) => {
          const full = path.join(this.directory, name);
          let mtime = 0;
          try {
            mtime = this.io.statSync(full).mtimeMs;
          } catch {
            mtime = 0;
          }
          return { name, full, mtime };
        })
        .sort((left, right) => right.mtime - left.mtime);
    } catch {
      return [];
    }
  }

  private write(level: "info" | "warn" | "error", operation: string, message: string): void {
    if (this.disabled) return;
    try {
      this.rotateIfNeeded();
      const line = formatLogLine(this.now(), level, operation, message) + "\n";
      this.io.appendFileSync(this.path, line, "utf8");
      this.bytesWritten += Buffer.byteLength(line);
    } catch {
      // Never let diagnostics break the extension; the OutputChannel still works.
      this.disabled = true;
    }
  }

  /** Moves the current file aside once it exceeds `maxBytes`. */
  private rotateIfNeeded(): void {
    if (this.bytesWritten === 0 || this.bytesWritten < this.maxBytes) return;
    this.rotation += 1;
    const nextPath = path.join(this.directory, rotatedLogFileName(this.fileName, this.rotation));
    try {
      this.io.renameSync(this.path, nextPath);
      this.bytesWritten = 0;
    } catch {
      // If rotation is impossible, truncating would lose data; switch to a fresh
      // session file name so logging continues without unbounded growth.
      this.fileName = sessionLogFileName(this.now(), process.pid, this.rotation);
      this.bytesWritten = 0;
    }
  }

  /** Removes all but the newest `retention` session files. */
  private prune(): void {
    const entries = this.entries();
    for (const entry of entries.slice(this.retention)) {
      try {
        this.io.unlinkSync(entry.full);
      } catch {
        // A file another host still has open simply survives this pass.
      }
    }
  }
}
