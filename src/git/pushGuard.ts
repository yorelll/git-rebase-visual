import { git, runGit } from "./gitRunner";
import { patchId } from "./commitLog";

export interface UpstreamInfo {
  remote: string;
  branch: string; // remote-side branch name
  ref: string; // e.g. origin/main
}

/** Resolves the upstream remote/branch for HEAD, or undefined when unset. */
export async function getUpstream(cwd: string): Promise<UpstreamInfo | undefined> {
  const res = await runGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { cwd }
  );
  if (res.code !== 0) {
    return undefined;
  }
  const ref = res.stdout.trim(); // e.g. origin/main
  const slash = ref.indexOf("/");
  if (slash < 0) {
    return undefined;
  }
  return {
    remote: ref.slice(0, slash),
    branch: ref.slice(slash + 1),
    ref,
  };
}

/**
 * Returns the commit hashes that would be published by pushing up to `tip`:
 * the range @{upstream}..tip (full hashes, any order).
 */
export async function pushRange(cwd: string, tip: string): Promise<string[]> {
  const out = await git(["rev-list", `@{upstream}..${tip}`], { cwd });
  return out ? out.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

/**
 * Returns the hashes in the push range that correspond to locked commits,
 * matched by hash OR by patch-id (stable across rebase / cherry-pick). A
 * non-empty result means the push must be rejected.
 */
export async function lockedInPush(
  cwd: string,
  tip: string,
  lockedHashes: Set<string>,
  lockedPatchIds: Set<string>
): Promise<string[]> {
  if (lockedHashes.size === 0 && lockedPatchIds.size === 0) {
    return [];
  }
  const range = await pushRange(cwd, tip);
  const blocked: string[] = [];
  for (const h of range) {
    if (lockedHashes.has(h)) {
      blocked.push(h);
      continue;
    }
    if (lockedPatchIds.size > 0) {
      const pid = await patchId(cwd, h);
      if (pid && lockedPatchIds.has(pid)) {
        blocked.push(h);
      }
    }
  }
  return blocked;
}

/**
 * Resolves a refspec from an optional template. Supported placeholders:
 *   ${tip}    -> the commit being pushed
 *   ${branch} -> the upstream branch name
 * When no template is given, defaults to a normal branch update
 * `<tip>:refs/heads/<branch>`. A template like `${tip}:refs/for/master`
 * targets a Gerrit-style review ref.
 */
export function resolveRefspec(
  up: UpstreamInfo,
  tip: string,
  template?: string
): string {
  if (!template || !template.trim()) {
    return `${tip}:refs/heads/${up.branch}`;
  }
  return template
    .replace(/\$\{tip\}/g, tip)
    .replace(/\$\{branch\}/g, up.branch);
}

/**
 * Pushes the given refspec. Uses --force-with-lease for normal branch updates
 * (so a concurrent remote change aborts instead of clobbering), but NOT for
 * review refs (refs/for/*, refs/drafts/*), where force semantics don't apply.
 */
export async function pushRefspec(
  cwd: string,
  up: UpstreamInfo,
  refspec: string
): Promise<void> {
  const isReview = /:refs\/(for|drafts)\//.test(refspec);
  const args = ["push"];
  if (!isReview) {
    args.push(`--force-with-lease=${up.branch}`);
  }
  args.push(up.remote, refspec);
  await git(args, { cwd });
}
