import { C_LOCALE, GitResult, runGit } from "./gitRunner";
import { gitVersion, isSupportedGitVersion, MIN_GIT_VERSION } from "./commitLog";

export type ProbeRun = (
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
) => Promise<GitResult>;

export interface ProbeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export type ProbeProblem =
  | "git-not-found"
  | "version-read-failed"
  | "git-too-old"
  | "marker-rejected"
  | "probe-error";

export interface ProbeResult {
  ok: boolean;
  gitVersion?: string;
  checks: ProbeCheck[];
  problem?: ProbeProblem;
}

export interface ProbeOptions {
  /**
   * Candidate workspace folders. The probe tests the first one that is a Git
   * repository; with none (or with an empty/absent value) only the version is
   * checked. A single string is the common case.
   */
  cwd?: string | readonly string[];
  /** Injectable for tests; defaults to the real Git runner. */
  run?: ProbeRun;
  /** Injectable for tests; defaults to the cached session probe. */
  readVersion?: (cwd: string) => Promise<string | undefined>;
}

/**
 * Read-only marker-shaped commands. These are the four shapes the extension
 * relies on most; all accept `--end-of-options` on every Git this extension
 * supports, so a rejection here means the installed Git is not the one
 * `MIN_GIT_VERSION` promises.
 */
const MARKER_CHECKS: { name: string; args: string[] }[] = [
  { name: "rev-parse", args: ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD"] },
  { name: "log", args: ["log", "-1", "--pretty=%s", "--end-of-options", "HEAD"] },
  { name: "rev-list", args: ["rev-list", "--count", "--end-of-options", "HEAD"] },
  {
    name: "for-each-ref",
    args: ["for-each-ref", "--format=%(refname)", "--end-of-options", "refs/heads"],
  },
];

const MARKER_REJECTION_PATTERNS = [
  /(?:unknown|unrecognized|invalid|unsupported|unexpected)\s+(?:option|argument)[^\n]*end-of-options/i,
  /end-of-options[^\n]*(?:unknown|unrecognized|invalid|unsupported|unexpected)/i,
  /error:\s*unknown option [`'"]?end-of-options/i,
  // Git 2.34's `checkout` wording: the marker is read as a second ref.
  /only one reference expected/i,
];

/** True when Git failed *because* it did not accept the marker itself. */
export function isMarkerRejection(result: GitResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`;
  return MARKER_REJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

/** Normalises the single-folder and multi-root forms into a non-empty list. */
function candidateFolders(cwd: ProbeOptions["cwd"]): string[] {
  if (cwd === undefined) {
    return [];
  }
  const folders = typeof cwd === "string" ? [cwd] : cwd;
  return folders.filter((folder) => folder.length > 0);
}

/**
 * True when the version read failed because the `git` executable itself could
 * not be spawned. Everything else — a wrapper script, a permissions error, a
 * timeout, or a command that printed no version — is a version *read* failure,
 * not proof that Git is absent. `finalize` in `runGit` rejects with the spawn
 * error itself, so `ENOENT` is the one unambiguous "missing binary" signal.
 */
function isMissingGitError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Checks whether this Git installation can run the extension's argv shapes.
 *
 * Version first, then — only when a workspace folder is a repository — the
 * marker-shaped commands. An ordinary non-zero exit (for example a repository
 * with an unborn HEAD) is *not* a capability failure: it proves the marker was
 * accepted and the command reached Git's normal resolution logic.
 */
export async function probeGitCapabilities(options: ProbeOptions = {}): Promise<ProbeResult> {
  const run = options.run ?? runGit;
  const readVersion = options.readVersion ?? ((cwd: string) => gitVersion(cwd));
  const checks: ProbeCheck[] = [];
  const candidates = candidateFolders(options.cwd);

  let version: string | undefined;
  let readError: unknown;
  try {
    version = await readVersion(candidates[0] ?? process.cwd());
  } catch (error) {
    readError = error;
  }
  const supported = isSupportedGitVersion(version);
  checks.push({
    name: "git-version",
    ok: supported,
    detail: version
      ? `git ${version} (minimum ${MIN_GIT_VERSION.join(".")})`
      : readError
        ? `git --version did not run: ${String(readError)}`
        : "git --version did not report a version",
  });
  if (!version) {
    return {
      ok: false,
      checks,
      // A missing binary is `ENOENT`. Anything else — a wrapper script, a
      // permission error, a timeout, or a command that printed no version —
      // is a failed *read*, and telling the user to install Git would hide the
      // real cause. The two problems get separate messages below.
      problem: isMissingGitError(readError) ? "git-not-found" : "version-read-failed",
    };
  }
  if (!supported) {
    return { ok: false, checks, problem: "git-too-old", gitVersion: version };
  }

  if (candidates.length === 0) {
    checks.push({ name: "repository", ok: true, detail: "no workspace folder; marker checks skipped" });
    return { ok: true, checks, gitVersion: version };
  }

  // One read-only `rev-parse` per candidate, stopping at the first repository.
  // In a multi-root workspace the first folder may not be a repository;
  // blindly using index 0 would skip every marker check and still report
  // success, while the folder that needs checking is never visited.
  let cwd: string | undefined;
  const skipped: string[] = [];
  let repoProbeError: unknown;
  for (const candidate of candidates) {
    let repoCheck: GitResult;
    try {
      repoCheck = await run(["rev-parse", "--show-toplevel"], { cwd: candidate, env: C_LOCALE });
    } catch (error) {
      repoProbeError = error;
      skipped.push(`${candidate}: did not run (${String(error)})`);
      continue;
    }
    if (repoCheck.code === 0) {
      cwd = candidate;
      break;
    }
    skipped.push(`${candidate}: ${firstLine(repoCheck.stderr) || `exit ${repoCheck.code}`}`);
  }

  if (!cwd) {
    if (repoProbeError !== undefined) {
      // A spawn failure is not evidence that the folders are not repositories.
      return {
        ok: false,
        checks: [...checks, { name: "repository", ok: false, detail: skipped.join("; ") }],
        problem: "probe-error",
        gitVersion: version,
      };
    }
    checks.push({
      name: "repository",
      ok: true,
      detail: `not a Git repository; marker checks skipped (${skipped.join("; ")})`,
    });
    return { ok: true, checks, gitVersion: version };
  }

  checks.push({
    name: "repository",
    ok: true,
    detail:
      skipped.length === 0
        ? "Git repository"
        : `Git repository: ${cwd} (skipped ${skipped.join("; ")})`,
  });

  let rejected = false;
  let errored = false;
  for (const check of MARKER_CHECKS) {
    let result: GitResult;
    try {
      result = await run(check.args, { cwd, env: C_LOCALE });
    } catch (error) {
      // A runner exception is not evidence that Git rejected the marker; it
      // could be a spawn failure or a broken wrapper. Report it separately so
      // the warning below does not send the user after the wrong problem.
      errored = true;
      checks.push({ name: check.name, ok: false, detail: `did not run: ${String(error)}` });
      continue;
    }
    const markerRejected = result.code !== 0 && isMarkerRejection(result);
    if (markerRejected) {
      rejected = true;
      checks.push({
        name: check.name,
        ok: false,
        detail: `exit ${result.code}: ${firstLine(result.stderr || result.stdout)}`,
      });
    } else {
      checks.push({
        name: check.name,
        ok: true,
        detail:
          result.code === 0
            ? "exit 0; marker accepted"
            : `exit ${result.code}; marker accepted (ordinary failure)`,
      });
    }
  }

  if (rejected) {
    return { ok: false, checks, problem: "marker-rejected", gitVersion: version };
  }
  if (errored) {
    return { ok: false, checks, problem: "probe-error", gitVersion: version };
  }
  return { ok: true, checks, gitVersion: version };
}

export interface ActivationProbeOptions extends ProbeOptions {
  extensionVersion: string;
  notifyInfo: (message: string) => unknown;
  notifyWarning: (message: string) => unknown;
  log: (level: "info" | "warn", message: string) => void;
}

export interface ActivationProbe {
  /** Runs at most once; later calls return the same promise. Never rejects. */
  run(): Promise<ProbeResult>;
  readonly runs: number;
}

function failureMessage(extensionVersion: string, result: ProbeResult): string {
  switch (result.problem) {
    case "git-not-found":
      return `Git Rebase Visual ${extensionVersion} 已启用，但未找到 Git；请安装 Git ${MIN_GIT_VERSION.join(".")}+ 或查看日志。`;
    case "version-read-failed":
      // Git may be installed but unreachable: a wrapper script, a permissions
      // problem, a timeout, or a command that prints no version. "Install Git"
      // would send the user after the wrong problem.
      return `Git Rebase Visual ${extensionVersion} 已启用，但无法读取 Git 版本（git --version 未能运行或未返回版本）；请确认 PATH 中的 git 可执行文件（可能是包装脚本）与权限，详情见日志。`;
    case "git-too-old":
      return `Git Rebase Visual ${extensionVersion} 已启用，但 Git ${result.gitVersion} 低于最低要求 ${MIN_GIT_VERSION.join(".")}；请升级 Git 或查看日志。`;
    case "marker-rejected":
      // The version already passed the minimum check, so "upgrade Git" would
      // be the wrong remedy. The usual cause is a different git on PATH (or a
      // wrapper/alias) than the one that reported the version.
      return `Git Rebase Visual ${extensionVersion} 已启用，但 Git ${result.gitVersion} 不支持扩展需要的参数形式；请确认 PATH 中的 git 与版本报告一致（可能是包装脚本或别名），详情见日志。`;
    default:
      return `Git Rebase Visual ${extensionVersion} 已启用，但无法完成 Git 兼容性检查（Git ${result.gitVersion ?? "unknown"}）；请查看日志。`;
  }
}

/**
 * Wires the read-only capability check to the notification and log surfaces.
 *
 * The returned `run` is idempotent and never rejects: activation calls it
 * fire-and-forget, and nothing in message handling or `refresh()` touches it.
 */
export function createActivationProbe(options: ActivationProbeOptions): ActivationProbe {
  let resultPromise: Promise<ProbeResult> | undefined;
  let runs = 0;

  const run = (): Promise<ProbeResult> => {
    if (resultPromise) {
      return resultPromise;
    }
    runs += 1;
    resultPromise = (async () => {
      let result: ProbeResult;
      try {
        result = await probeGitCapabilities(options);
      } catch (error) {
        result = {
          ok: false,
          checks: [],
          problem: "probe-error",
          gitVersion: undefined,
        };
        try {
          options.log("warn", `Git check threw: ${String(error)}`);
        } catch {
          // A logger failure must not escape activation.
        }
      }

      try {
        for (const check of result.checks) {
          options.log(
            check.ok ? "info" : "warn",
            `${check.name}: ${check.ok ? "pass" : "FAIL"} — ${check.detail}`
          );
        }
        options.log(
          result.ok ? "info" : "warn",
          result.ok
            ? `Git checks passed (git ${result.gitVersion})`
            : `Git checks failed (${result.problem}, git ${result.gitVersion ?? "unknown"})`
        );
      } catch {
        // Logging is diagnostic only.
      }

      try {
        if (result.ok) {
          options.notifyInfo(`Git Rebase Visual ${options.extensionVersion} 已启用`);
        } else {
          options.notifyWarning(failureMessage(options.extensionVersion, result));
        }
      } catch {
        // Showing a notification must never reject into the extension host.
      }
      return result;
    })();
    return resultPromise;
  };

  return {
    run,
    get runs() {
      return runs;
    },
  };
}
