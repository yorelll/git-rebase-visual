import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  DEFAULT_LOG_RETENTION,
  LOG_FOLDER_PREFIX,
  FileLogger,
  formatLogLine,
  logDirectory,
  redactLogLine,
  rotatedLogFileName,
  sessionLogFileName,
} from "../src/diagnostics/fileLogger";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "grv-log-test-"));
}

test("log directory lives under the temp dir and is version-scoped", () => {
  const dir = logDirectory("0.8.0", "C:\\tmp");
  assert.equal(dir, path.join("C:\\tmp", "log", `${LOG_FOLDER_PREFIX}-0.8.0`));
});

test("log directory sanitizes an unsafe version segment", () => {
  const dir = logDirectory("0.8.0-beta/../evil", "/tmp");
  assert.equal(path.basename(dir), `${LOG_FOLDER_PREFIX}-0.8.0-beta_.._evil`);
  assert.equal(path.dirname(dir), path.join("/tmp", "log"));
});

test("an empty version falls back to 0.0.0 instead of an empty folder name", () => {
  assert.equal(path.basename(logDirectory("", "/tmp")), `${LOG_FOLDER_PREFIX}-0.0.0`);
});

test("session file names are timestamped and unique per host/rotation", () => {
  const at = new Date("2026-02-03T04:05:06.789Z");
  assert.equal(sessionLogFileName(at, 4242), "session-2026-02-03T04-05-06-789Z-4242.log");
  assert.equal(sessionLogFileName(at, 4242, 2), "session-2026-02-03T04-05-06-789Z-4242-2.log");
});

test("rotated names keep the .log extension and add an index", () => {
  assert.equal(rotatedLogFileName("session-a.log", 1), "session-a.1.log");
  assert.equal(rotatedLogFileName("no-extension", 3), "no-extension");
});

test("redaction removes credentials from URLs, headers and key=value pairs", () => {
  assert.equal(
    redactLogLine("fetch https://user:token@example.com/repo.git"),
    "fetch https://***@example.com/repo.git"
  );
  assert.equal(redactLogLine("authorization: Bearer abc.def"), "authorization: ***");
  assert.equal(redactLogLine("Authorization: Basic dXNlcg=="), "Authorization: ***");
  assert.equal(redactLogLine("api_key=sk-123"), "api_key=***");
  assert.equal(redactLogLine("token: ghp_abc"), "token: ***");
  assert.equal(redactLogLine("password=hunter2 done"), "password=*** done");
  assert.equal(redactLogLine("curl --api-key sk-123 x"), "curl --api-key *** x");
  assert.equal(redactLogLine("nothing to hide"), "nothing to hide");
});

test("redaction is idempotent", () => {
  const once = redactLogLine("clone https://user:token@host/repo api_key=abc");
  assert.equal(redactLogLine(once), once);
});

test("log lines are formatted with timestamp, level and operation", () => {
  const line = formatLogLine(new Date("2026-02-03T04:05:06.789Z"), "warn", "git", "git status token=abc");
  assert.equal(line, "[2026-02-03T04:05:06.789Z] [warn] git: git status token=***");
});

test("a session writes a header plus entries into the versioned folder", () => {
  const root = tempRoot();
  try {
    const logger = new FileLogger({ directory: logDirectory("0.8.0", root) });
    logger.start(["version=0.8.0"]);
    logger.info("git", "git status");
    logger.warn("mutation", "id=1 action=reorder");
    assert.equal(path.dirname(logger.path), logDirectory("0.8.0", root));
    assert.match(path.basename(logger.path), /^session-.*\.log$/);
    const content = fs.readFileSync(logger.path, "utf8");
    assert.match(content, /\[info\] session: 启动 \| version=0\.8\.0/);
    assert.match(content, /\[info\] git: git status/);
    assert.match(content, /\[warn\] mutation: id=1 action=reorder/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("error entries include the stack trace", () => {
  const root = tempRoot();
  try {
    const logger = new FileLogger({ directory: logDirectory("0.8.0", root) });
    logger.start();
    logger.error("git", "rebase failed", new Error("boom"));
    const content = fs.readFileSync(logger.path, "utf8");
    assert.match(content, /\[error\] git: rebase failed \| Error: boom/);
    assert.match(content, /fileLogger\.test/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("secrets written through the logger are redacted on disk", () => {
  const root = tempRoot();
  try {
    const logger = new FileLogger({ directory: logDirectory("0.8.0", root) });
    logger.start();
    logger.info("git", "git push https://user:secret@example.com/repo.git");
    const content = fs.readFileSync(logger.path, "utf8");
    assert.doesNotMatch(content, /secret@/);
    assert.match(content, /https:\/\/\*\*\*@example\.com/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the session rotates to a new file once the size budget is exceeded", () => {
  const root = tempRoot();
  try {
    const directory = logDirectory("0.8.0", root);
    const logger = new FileLogger({ directory, maxBytes: 1024 });
    logger.start();
    const original = logger.path;
    for (let index = 0; index < 40; index += 1) {
      logger.info("webview", `action=scroll index=${index} ${"x".repeat(60)}`);
    }
    const files = fs.readdirSync(directory).filter((name) => name.endsWith(".log"));
    assert.ok(files.length > 1, `expected rotation, got ${files.join(", ")}`);
    assert.ok(files.some((name) => name.endsWith(".1.log")), "rotation uses a .1.log sibling");
    assert.ok(fs.existsSync(original));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retention keeps only the newest session files", () => {
  const root = tempRoot();
  try {
    const directory = logDirectory("0.8.0", root);
    fs.mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 6; index += 1) {
      const file = path.join(directory, `session-old-${index}.log`);
      fs.writeFileSync(file, "old\n");
      const stamp = new Date(2020, 0, 1 + index);
      fs.utimesSync(file, stamp, stamp);
    }
    const logger = new FileLogger({ directory, retention: 2 });
    logger.start();
    const sessions = logger.listSessions();
    assert.ok(sessions.length <= 3, `got ${sessions.length} sessions`);
    assert.ok(sessions.includes(logger.path));
    assert.deepEqual(
      sessions.filter((name) => name.includes("session-old")).length,
      2,
      "only the newest retained files survive"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("default retention is a positive number of sessions", () => {
  assert.ok(DEFAULT_LOG_RETENTION >= 1);
});

test("a read-only log directory disables logging without throwing", () => {
  const directory = path.join(os.tmpdir(), "grv-log-test-readonly", String(process.pid));
  const logger = new FileLogger({
    directory,
    io: {
      mkdirSync: () => {
        throw new Error("EACCES");
      },
    } as any,
  });
  assert.doesNotThrow(() => logger.start());
  assert.doesNotThrow(() => logger.info("git", "git status"));
  assert.doesNotThrow(() => logger.error("git", "boom", new Error("x")));
  assert.equal(logger.isDisabled, true);
  assert.equal(logger.listSessions().length, 0);
});

test("an append failure disables the logger after the first error", () => {
  let appends = 0;
  const logger = new FileLogger({
    directory: path.join(os.tmpdir(), "grv-log-test-append"),
    io: {
      mkdirSync: () => undefined,
      appendFileSync: () => {
        appends += 1;
        throw new Error("ENOSPC");
      },
    } as any,
  });
  logger.start();
  logger.info("git", "git status");
  logger.info("git", "git log");
  assert.equal(appends, 1, "later writes are skipped once disabled");
  assert.equal(logger.isDisabled, true);
});

test("a failed rotation falls back to a fresh session file name", () => {
  const written: string[] = [];
  const logger = new FileLogger({
    directory: "/virtual/log",
    maxBytes: 1024,
    io: {
      mkdirSync: () => undefined,
      appendFileSync: (file: fs.PathOrFileDescriptor) => {
        written.push(String(file));
      },
      renameSync: () => {
        throw new Error("EBUSY");
      },
      readdirSync: () => [],
      statSync: () => {
        throw new Error("ENOENT");
      },
      unlinkSync: () => undefined,
    } as any,
  });
  logger.start();
  for (let index = 0; index < 40; index += 1) {
    logger.info("webview", "x".repeat(80));
  }
  assert.equal(logger.isDisabled, false, "a busy rename must not stop logging");
  const distinct = new Set(written);
  assert.ok(distinct.size > 1, "logging continues in a new file");
});
