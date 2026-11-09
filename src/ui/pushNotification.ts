/**
 * One wording for every push notification: which kind of push ran, the commit
 * message it publishes, and the branch it lands on.
 *
 * The kind is decided by `pushBranchInternal` (the quick pick chooses
 * normal/review/custom), never inferred from the refspec afterwards: a custom
 * refspec can look exactly like a normal one, and a template can be edited to
 * target `refs/heads/*`.
 */
export type PushKind = "normal" | "review" | "custom";

/** Subjects longer than this are shortened; 60 keeps the whole line readable. */
export const PUSH_SUBJECT_LIMIT = 60;

export function pushKindLabel(kind: PushKind): string {
  switch (kind) {
    case "review":
      return "评审推送";
    case "custom":
      return "自定义推送";
    default:
      return "普通推送";
  }
}

/**
 * Shortens by code point so a surrogate pair (emoji, rare CJK) is never split.
 * A shortened subject ends with `…`; a subject of exactly the limit is kept.
 */
export function shortenSubject(subject: string, limit = PUSH_SUBJECT_LIMIT): string {
  const trimmed = subject.trim();
  const points = Array.from(trimmed);
  return points.length <= limit ? trimmed : `${points.slice(0, limit).join("")}…`;
}

/** Said instead of empty quotes when `git log` could not read the subject. */
export const PUSH_SUBJECT_UNKNOWN = "（无法读取 commit 标题）";

/**
 * Said when the refspec publishes no commit at all — a deletion
 * (`:refs/heads/obsolete`). There is nothing to name, and falling back to
 * HEAD's subject would claim a commit this push never sent.
 */
export const PUSH_SUBJECT_DELETED = "（仅删除远端 ref，未推送 commit）";

/**
 * Said instead of a branch name when the refspec does not state one we can
 * trust. A plausible-looking wrong branch is worse than an admitted unknown:
 * the notification's whole purpose is telling the user where the commits went.
 */
export const PUSH_TARGET_UNKNOWN = "（无法确定目标分支）";

const HEADS = "refs/heads/";

/**
 * Renders a destination ref the way a user reads it. Branch updates use the
 * familiar `<remote>/<branch>`; any other ref (a Gerrit review ref, a tag, an
 * exotic namespace) is shown as `<remote>:<ref>` so it is never mistaken for a
 * branch that was not touched.
 */
function describeDestination(remote: string, ref: string): string {
  if (ref.startsWith(HEADS)) {
    const branch = ref.slice(HEADS.length);
    return branch ? `${remote}/${branch}` : PUSH_TARGET_UNKNOWN;
  }
  // `HEAD` as a destination names whatever ref the remote decides, which cannot
  // be stated from here; so does a bare `refs/` prefix with no ref after it.
  if (!ref || ref === "HEAD" || ref === "refs/") {
    return PUSH_TARGET_UNKNOWN;
  }
  return `${remote}:${ref}`;
}

/**
 * The commit a refspec publishes: its source side (`sha:dest` → `sha`), or the
 * whole refspec when it has no destination. `undefined` means "cannot tell",
 * and the caller should not claim a subject rather than naming the wrong commit.
 */
export function pushSource(refspec: string): string | undefined {
  const cleaned = refspec.trim().replace(/^\+/, "");
  if (!cleaned) {
    return undefined;
  }
  const colon = cleaned.indexOf(":");
  const source = (colon < 0 ? cleaned : cleaned.slice(0, colon)).trim();
  return source || undefined;
}

/**
 * A refspec with a destination and an **empty** source (`:refs/heads/gone`)
 * deletes that remote ref and publishes nothing. `pushSource` returns
 * `undefined` for it, but so does a refspec this module cannot parse, so the
 * two cases are distinguished here rather than by falling back to HEAD's
 * subject — which named a commit the push never sent.
 */
export function isDeletionRefspec(refspec: string): boolean {
  const cleaned = refspec.trim().replace(/^\+/, "");
  if (!cleaned) {
    return false;
  }
  const colon = cleaned.indexOf(":");
  return colon >= 0 && !cleaned.slice(0, colon).trim() && !!cleaned.slice(colon + 1).trim();
}

/**
 * Where the resolved refspec actually writes, derived from its **destination**
 * side rather than from `up.ref`. The two diverge for exactly the pushes this
 * project supports: a review refspec creates `refs/for/<branch>` (not the
 * upstream branch), and a custom refspec can target any ref at all.
 *
 * A refspec with no `:` writes to a ref of the same name as its source, so only
 * a branch-shaped source can be reported with confidence; `HEAD` (the source of
 * every refspec this provider builds) cannot, and says so.
 */
export function pushDestination(
  remote: string,
  refspec: string,
  knownRemotes?: Iterable<string>
): string {
  // A remote name the caller could not resolve would be printed as if it were
  // real, and `team/origin` vs `team` differ by exactly one slash. When the
  // caller supplies the configured remote names, refuse to name an unlisted one.
  //
  // `"."` is Git's name for a local tracking upstream (`branch.<b>.remote = "."`),
  // not a remote: `./other` is not a destination any push can reach.
  if (!remote.trim() || remote === "." || (knownRemotes && !new Set(knownRemotes).has(remote))) {
    return PUSH_TARGET_UNKNOWN;
  }
  const cleaned = refspec.trim().replace(/^\+/, "");
  if (!cleaned) {
    return PUSH_TARGET_UNKNOWN;
  }
  const colon = cleaned.indexOf(":");
  if (colon < 0) {
    const source = cleaned;
    return source.startsWith(HEADS)
      ? describeDestination(remote, source)
      : PUSH_TARGET_UNKNOWN;
  }
  const destination = cleaned.slice(colon + 1).trim();
  // `src:` (empty destination) deletes the remote ref; it publishes no commit,
  // so no branch is the target.
  return destination ? describeDestination(remote, destination) : PUSH_TARGET_UNKNOWN;
}

/**
 * `普通推送："feat(cmos_sensor): add ir ispll" → origin/fpga/rle1283_rts3923`
 *
 * The refspec is deliberately absent: the target branch is the fact a user
 * needs, and a refspec makes the line unreadable. `target` must come from
 * `pushDestination`, never from the upstream ref.
 */
export function describePush(kind: PushKind, subject: string, target: string): string {
  return `${pushKindLabel(kind)}："${shortenSubject(subject) || PUSH_SUBJECT_UNKNOWN}" → ${target}`;
}

/**
 * `自定义推送：删除远端 ref → origin/obsolete`
 *
 * A deletion has no commit to quote, so it does not use the `"subject"` slot at
 * all. Writing `"<HEAD subject>"` there claimed a commit the push never sent.
 */
export function describeDeletion(kind: PushKind, target: string): string {
  return `${pushKindLabel(kind)}：删除远端 ref → ${target}`;
}
