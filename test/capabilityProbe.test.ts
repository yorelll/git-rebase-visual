import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createActivationProbe, ProbeRun } from "../src/git/capabilityProbe";
import {
  gitVersionSync,
  isSupportedGitVersion,
  knownGitVersion,
  parseGitVersion,
} from "../src/git/commitLog";
import { C_LOCALE, GitResult } from "../src/git/gitRunner";

const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });
const failed = (code: number, stderr: string): GitResult => ({ code, stdout: "", stderr });

const SUCCESS_VERSION = "2.53.0.windows.2";

function harness(options: {
  version?: string;
  gitRun?: ProbeRun;
  cwd?: string | readonly string[];
  extensionVersion?: string;
  readVersion?: () => Promise<string | undefined>;
}) {
  const messages: { level: "info" | "warn"; text: string }[] = [];
  const logs: { level: "info" | "warn"; message: string }[] = [];
  const calls: { args: string[]; cwd: string; env?: NodeJS.ProcessEnv }[] = [];

  const run: ProbeRun = options.gitRun ?? (async () => ok());

  const probe = createActivationProbe({
    extensionVersion: options.extensionVersion ?? "9.9.9",
    cwd: options.cwd ?? "C:/repo",
    run: async (args, opts) => {
      calls.push({ args, cwd: opts.cwd, env: opts.env });
      return run(args, opts);
    },
    readVersion: options.readVersion ?? (async () => options.version ?? SUCCESS_VERSION),
    notifyInfo: (text) => {
      messages.push({ level: "info", text });
    },
    notifyWarning: (text) => {
      messages.push({ level: "warn", text });
    },
    log: (level, message) => {
      logs.push({ level, message });
    },
  });

  return { probe, messages, logs, calls };
}

/** A runner that answers `rev-parse --show-toplevel` as a repository. */
function repoRunner(markerResult: GitResult): ProbeRun {
  return async (args) => {
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return ok("C:/repo\n");
    }
    return markerResult;
  };
}

test("success shows exactly one info notification naming only the version", async () => {
  const { probe, messages, calls } = harness({ gitRun: repoRunner(ok("HEAD\n")) });
  const result = await probe.run();

  assert.equal(result.ok, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].level, "info");
  assert.equal(messages[0].text, "Git Rebase Visual 9.9.9 已启用");
  assert.doesNotMatch(messages[0].text, /probe|探测|自检|capabilit/i);
  const env = { LC_ALL: "C" };
  assert.deepEqual(calls, [
    { args: ["rev-parse", "--show-toplevel"], cwd: "C:/repo", env },
    {
      args: ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD"],
      cwd: "C:/repo",
      env,
    },
    {
      args: ["log", "-1", "--pretty=%s", "--end-of-options", "HEAD"],
      cwd: "C:/repo",
      env,
    },
    { args: ["rev-list", "--count", "--end-of-options", "HEAD"], cwd: "C:/repo", env },
    {
      args: ["for-each-ref", "--format=%(refname)", "--end-of-options", "refs/heads"],
      cwd: "C:/repo",
      env,
    },
  ]);
  assert.deepEqual(calls[0].env, C_LOCALE);
  assert.equal(probe.runs, 1);
});

test("Git below the minimum warns and never reports success", async () => {
  const { probe, messages, logs, calls } = harness({
    version: "2.30.0",
    gitRun: repoRunner(ok()),
  });
  const result = await probe.run();

  assert.equal(result.ok, false);
  assert.equal(result.problem, "git-too-old");
  assert.equal(calls.length, 0, "an unsupported Git is rejected before any command runs");
  assert.equal(messages.filter((message) => message.level === "info").length, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].level, "warn");
  assert.match(messages[0].text, /2\.30\.0/);
  assert.match(messages[0].text, /2\.31\.0/);
  assert.ok(logs.some((line) => /FAIL/.test(line.message) && /git-version/.test(line.message)));
});

test("a marker-rejecting Git is detected and warned about", async () => {
  const { probe, messages, logs } = harness({
    version: "2.31.0",
    gitRun: repoRunner(failed(128, "fatal: only one reference expected, 2 given.\n")),
  });
  const result = await probe.run();

  assert.equal(result.ok, false);
  assert.equal(result.problem, "marker-rejected");
  assert.equal(messages.filter((message) => message.level === "info").length, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].level, "warn");
  assert.match(messages[0].text, /2\.31\.0/);
  assert.match(messages[0].text, /参数形式/);
  // The version already passed the minimum check; "upgrade to 2.31+" would be
  // nonsensical advice.
  assert.doesNotMatch(messages[0].text, /升级 Git 到 2\.31/);
  assert.ok(
    logs.some((line) => line.level === "warn" && /rev-parse: FAIL/.test(line.message)),
    "the per-check failure is logged"
  );
});

test("a thrown runner error is reported as an error, not as marker rejection", async () => {
  const { probe, messages, logs } = harness({
    version: "2.31.0",
    gitRun: (async (args: string[]) => {
      if (args.includes("--show-toplevel")) {
        return ok("C:/repo\n");
      }
      throw new Error("spawn failed");
    }) as ProbeRun,
  });
  const result = await probe.run();

  assert.equal(result.ok, false);
  assert.equal(result.problem, "probe-error");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].level, "warn");
  assert.ok(logs.some((line) => /FAIL/.test(line.message) && /spawn failed/.test(line.message)));
});

test("a truly missing Git is reported as git-not-found", async () => {
  const missing = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
  const { probe, messages, calls } = harness({
    gitRun: repoRunner(ok("HEAD\n")),
    readVersion: async () => {
      throw missing;
    },
  });
  const result = await probe.run();

  assert.equal(result.ok, false);
  assert.equal(result.problem, "git-not-found");
  assert.equal(calls.length, 0, "no repository probing after a failed version read");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].level, "warn");
  assert.match(messages[0].text, /未找到 Git/);
});

test("a wrapper or permission failure reading git --version is version-read-failed", async () => {
  const { probe, messages, calls } = harness({
    gitRun: repoRunner(ok("HEAD\n")),
    readVersion: async () => {
      throw new Error("EACCES: permission denied");
    },
  });
  const result = await probe.run();

  assert.equal(result.ok, false);
  assert.equal(result.problem, "version-read-failed");
  assert.equal(calls.length, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].level, "warn");
  assert.match(messages[0].text, /git --version/);
  assert.match(messages[0].text, /PATH/);
  assert.doesNotMatch(messages[0].text, /未找到 Git/);
});

test("git --version that prints no version is version-read-failed", async () => {
  const { probe, messages, logs } = harness({
    readVersion: async () => undefined,
  });
  const result = await probe.run();

  assert.equal(result.ok, false);
  assert.equal(result.problem, "version-read-failed");
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /未能运行或未返回版本/);
  assert.doesNotMatch(messages[0].text, /未找到 Git/);
  assert.ok(
    logs.some((line) => /git-version: FAIL/.test(line.message)),
    "the failed version check is logged"
  );
});

test("the session exposes the probed Git version to the log header and OutputChannel", () => {
  assert.equal(parseGitVersion("git version 2.34.1.windows.1"), "2.34.1");
  assert.equal(isSupportedGitVersion("2.31.0"), true);
  assert.equal(isSupportedGitVersion("2.30.9"), false);
  assert.equal(isSupportedGitVersion(undefined), false);

  const version = gitVersionSync();
  assert.match(version ?? "", /^\d+\.\d+/);
  assert.equal(knownGitVersion(), version);

  const extension = readFileSync(join(process.cwd(), "src/extension.ts"), "utf8");
  assert.match(extension, /git=\$\{detectedGitVersion \?\? "not-found"\}/);
  const provider = readFileSync(
    join(process.cwd(), "src/ui/rebaseViewProvider.ts"),
    "utf8"
  );
  assert.match(
    provider,
    /Git Rebase Visual \$\{buildVersion\} · git \$\{knownGitVersion\(\) \?\? "unknown"\}/
  );
});

test("an ordinary non-zero exit is not a capability failure", async () => {
  const { probe, messages } = harness({
    version: "2.31.0",
    gitRun: repoRunner(failed(1, "fatal: Needed a single revision\n")),
  });
  const result = await probe.run();

  assert.equal(result.ok, true);
  assert.equal(result.problem, undefined);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].level, "info");
});

test("a non-repository workspace runs only the version check", async () => {
  const { probe, messages, calls } = harness({
    gitRun: async (args) =>
      args.includes("--show-toplevel") ? failed(128, "fatal: not a git repository\n") : ok(),
  });
  const result = await probe.run();

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].level, "info");
});

test("multi-root probes the first folder that is a repository", async () => {
  const { probe, messages, calls } = harness({
    cwd: ["C:/not-a-repo", "C:/repo"],
    gitRun: async (args, opts) => {
      if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
        return opts.cwd === "C:/repo"
          ? ok("C:/repo\n")
          : failed(128, "fatal: not a git repository\n");
      }
      return ok("HEAD\n");
    },
  });
  const result = await probe.run();

  assert.equal(result.ok, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].level, "info");
  assert.equal(calls[0].cwd, "C:/not-a-repo");
  assert.equal(calls[1].cwd, "C:/repo");
  // Every marker check runs in the folder that is actually a repository.
  assert.ok(calls.slice(2).every((call) => call.cwd === "C:/repo"));
  assert.equal(calls.length, 6);
});

test("multi-root with no repository runs only the version check", async () => {
  const { probe, messages, calls, logs } = harness({
    cwd: ["C:/one", "C:/two"],
    gitRun: async (args) => {
      if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
        return failed(128, "fatal: not a git repository\n");
      }
      return ok("HEAD\n");
    },
  });
  const result = await probe.run();

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2, "one read-only probe per candidate, no marker checks");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].level, "info");
  assert.ok(
    logs.some((line) => /repository: pass .*C:\/one.*C:\/two/.test(line.message)),
    "the log records that both folders were skipped"
  );
});

test("no workspace folder runs only the version check", async () => {
  const { probe, messages, calls } = harness({ cwd: "" });
  const result = await probe.run();

  assert.equal(result.ok, true);
  assert.equal(calls.length, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].level, "info");
});

test("the probe runs once per activation, however many callers ask", async () => {
  const { probe, messages, calls } = harness({ gitRun: repoRunner(ok("HEAD\n")) });

  await Promise.all([probe.run(), probe.run()]);
  await probe.run();

  assert.equal(probe.runs, 1);
  assert.equal(calls.length, 5);
  assert.equal(messages.length, 1);
});

test("message handling and refresh cannot trigger the activation probe", () => {
  const provider = readFileSync(
    join(process.cwd(), "src/ui/rebaseViewProvider.ts"),
    "utf8"
  );
  assert.doesNotMatch(provider, /capabilityProbe|createActivationProbe|probeGitCapabilities/);
});
