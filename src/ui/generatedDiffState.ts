export interface GeneratedDiffCommit {
  hash: string;
  shortHash: string;
}

export interface GeneratedDiffSnapshotResult {
  content: string;
  truncated: boolean;
}

/**
 * Validates an exact full-hash selection against the current host snapshot.
 * A multi-commit generated Diff represents one timeline range, so it must be
 * contiguous. The returned order is always canonical oldest-first regardless
 * of message ordering; unknown, duplicate, stale, or gapped selections fail.
 */
export function generatedDiffCommits(
  commitsNewestFirst: readonly GeneratedDiffCommit[],
  value: unknown
): GeneratedDiffCommit[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const known = new Map(commitsNewestFirst.map((commit) => [commit.hash, commit]));
  const selected = new Set<string>();
  for (const hash of value) {
    if (typeof hash !== "string" || !/^[0-9a-f]{40}$/i.test(hash) || !known.has(hash) || selected.has(hash)) {
      return undefined;
    }
    selected.add(hash);
  }
  const oldestFirst = [...commitsNewestFirst].reverse();
  const selectedIndexes = oldestFirst
    .map((commit, index) => selected.has(commit.hash) ? index : -1)
    .filter((index) => index >= 0);
  const first = selectedIndexes[0]!;
  const last = selectedIndexes.at(-1)!;
  if (last - first + 1 !== selected.size) return undefined;
  return oldestFirst.slice(first, last + 1);
}

/**
 * Revalidates selection after asynchronous Git reads and before publishing the
 * snapshot. A refresh that changes either its members or timeline order must
 * not turn an older request into a current generated document.
 */
export function generatedDiffSelectionIsCurrent(
  initial: readonly GeneratedDiffCommit[],
  commitsNewestFirst: readonly GeneratedDiffCommit[],
  value: unknown
): boolean {
  const current = generatedDiffCommits(commitsNewestFirst, value);
  return !!current && current.length === initial.length && current.every(
    (commit, index) => commit.hash === initial[index]?.hash
  );
}

/** The request's canonical revision must still name the exact host snapshot. */
export function generatedDiffRequestIsCurrent(
  initial: readonly GeneratedDiffCommit[],
  commitsNewestFirst: readonly GeneratedDiffCommit[],
  value: unknown,
  requestRevision: unknown,
  currentRevision: number
): boolean {
  return requestRevision === currentRevision &&
    generatedDiffSelectionIsCurrent(initial, commitsNewestFirst, value);
}

/** Builds one frozen generated-Diff string from exact commit snapshots. */
export async function buildGeneratedDiffSnapshot(
  commits: readonly GeneratedDiffCommit[],
  readCommit: (commit: GeneratedDiffCommit) => Promise<string>,
  maxChars = 2_000_000
): Promise<GeneratedDiffSnapshotResult> {
  const first = commits[0]?.shortHash ?? "unknown";
  const last = commits.at(-1)?.shortHash ?? "unknown";
  let content = commits.length > 1
    ? `# Git Rebase Visual: ${first}..${last}（${commits.length} 个连续 commit）的 Diff\n\n按当前时间轴从早到晚拼接；多选仅支持无空洞的连续 commit 区间。\n\n`
    : `# Git Rebase Visual: ${first} 的 Diff\n\n`;
  let truncated = false;
  for (const commit of commits) {
    const chunk = await readCommit(commit);
    if (content.length + chunk.length > maxChars) {
      content += chunk.slice(0, Math.max(0, maxChars - content.length));
      truncated = true;
      break;
    }
    content += chunk;
    if (!content.endsWith("\n")) content += "\n";
  }
  content += truncated
    ? `\n\n[输出已在 ${maxChars.toLocaleString()} 字符处截断；二进制内容仅以 Git binary patch 形式表示。]\n`
    : "\n[说明：二进制文件由 Git 以 binary patch 或摘要表示。]\n";
  return { content, truncated };
}
