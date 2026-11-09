import assert from "node:assert/strict";
import test from "node:test";
import { branchContext, NOTE_DETAIL_LIMIT, rangeLabel, upstreamNoteDetail } from "../src/ui/rebasePresentation";

test("branch context exposes branch, upstream and divergence", () => {
  assert.deepEqual(branchContext({
    branchName: "feature/ui", upstreamRef: "origin/feature/ui", aheadCount: 3, behindCount: 2,
    range: { kind: "upstream" }, rebasing: false,
  }), {
    branchName: "feature/ui", upstreamRef: "origin/feature/ui", aheadCount: 3, behindCount: 2,
    // Present-but-undefined is the contract: the key always exists so the
    // webview can test it directly, and `undefined` means "the counts are real".
    upstreamNote: undefined,
    rangeLabel: "范围：upstream..HEAD",
  });
});

test("branch context carries the reason when the counts could not be computed", () => {
  const value = branchContext({
    branchName: "master",
    upstreamRef: "-evil/master",
    aheadCount: 0,
    behindCount: 0,
    upstreamNote: "  无法计算与 -evil/master 的领先/落后（usage: git rev-list …）  ",
    range: { kind: "upstream" },
    rebasing: false,
  });
  // Trimmed, because the caller interpolates Git's stderr which ends in a
  // newline; rendering it raw would leave a dangling gap in the context line.
  assert.equal(value.upstreamNote, "无法计算与 -evil/master 的领先/落后（usage: git rev-list …）");
  // The counts are still 0 here, which is exactly why the note must be shown
  // instead of them: 0/0 is indistinguishable from "in sync".
  assert.equal(value.aheadCount, 0);
  assert.equal(value.behindCount, 0);
  // An all-whitespace note is not a message; it must not render an empty slot.
  assert.equal(
    branchContext({ upstreamNote: "   ", range: { kind: "all" }, rebasing: false }).upstreamNote,
    undefined
  );
});

/**
 * 新发现 6: the context bar is one line (`height: 29px; white-space: nowrap;
 * text-overflow: ellipsis`), so Git's multi-line stderr cannot be interpolated
 * whole — the browser collapses it and the clipped tail is the `fatal:` line
 * that names the reason.
 */
test("the count-failure detail is the last stderr line, on one line, and bounded", () => {
  // The measured shape: two `error:` lines then the `fatal:` line that names
  // the corrupt object. Taking the last line is what keeps that last part.
  const measured =
    "error: inflate: data stream error (incorrect header check)\r\n" +
    "error: unable to unpack 0123456789abcdef header\r\n" +
    "fatal: loose object 0123456789abcdef (stored in .git/objects/01/23456789abcdef) is corrupt\n";
  const detail = upstreamNoteDetail({ code: 128, stdout: "", stderr: measured });
  assert.equal(
    detail,
    "fatal: loose object 0123456789abcdef (stored in .git/objects/01/23456789abcdef) is corrupt",
    "the last non-empty, CRLF-trimmed line is the one shown"
  );
  assert.doesNotMatch(detail, /\n/, "one line, because the bar is one line");

  // 新发现 1: the last non-empty line is not always the reason. Measured shape
  // (Git 2.53, `git rev-list --left-right --count ghost/master...HEAD`, exit
  // 128): the last line is a usage hint, so "last non-empty" would show
  // `'git <command> [<revision>...] -- [<file>...]'` and lose the real cause.
  const unknownRevision =
    "fatal: ambiguous argument 'ghost/master...HEAD': unknown revision or path not in the working tree.\n" +
    "Use '--' to separate paths from revisions, like this:\n" +
    "'git <command> [<revision>...] -- [<file>...]'\n";
  assert.equal(
    upstreamNoteDetail({ code: 128, stdout: "", stderr: unknownRevision }),
    "fatal: ambiguous argument 'ghost/master...HEAD': unknown revision or path not in the working tree.",
    "the tagged fatal/error line wins over a trailing usage hint"
  );
  // The tagged-line rule must not change the corrupt-object answer: its last
  // line is already the `fatal:` one, asserted above.
  // A stream with no tagged line at all still falls back to the last non-empty
  // line rather than to the exit code — otherwise this rule would discard the
  // only thing Git said.
  assert.equal(
    upstreamNoteDetail({ code: 1, stdout: "", stderr: "warning: something\nplain tail\n" }),
    "plain tail"
  );

  // A long single line is bounded so the note cannot push the rest of the
  // context bar (branch, upstream, range) out of view.
  const long = "x".repeat(NOTE_DETAIL_LIMIT + 40);
  const bounded = upstreamNoteDetail({ code: 128, stdout: "", stderr: long });
  assert.equal(Array.from(bounded).length, NOTE_DETAIL_LIMIT + 1, "limit plus the ellipsis");
  assert.equal(bounded.endsWith("…"), true);
  assert.equal(bounded.startsWith("x".repeat(10)), true, "the head is kept, because it names the object");

  // Code points, not UTF-16 units: cutting a surrogate pair in half renders a
  // lone surrogate (a replacement glyph) instead of a clean ellipsis.
  //
  // The string MIXES a BMP character with an astral one, and that is the
  // stronger fixture. On a pure astral string the code-point length assertion
  // below still kills the mutant: a pure 145-code-point input (`𝄞`×145, which
  // is also 290 UTF-16 units) comes out at 141 code points with the correct
  // implementation and at 71 with a UTF-16 slice, so 141 ≠ 71 and the assertion
  // fails. What never fires on a pure astral string is the lone-surrogate
  // assertion, because given pairs starting at offset 0 every even 140-unit
  // boundary lands exactly between two pairs. Prefixing one BMP character
  // shifts every pair to an odd offset, so the boundary falls inside a pair and
  // BOTH assertions become live. (U+2728 `✨` was used here before and was
  // useless for this: it is BMP with UTF-16 length 1, i.e. not a surrogate pair
  // at all.)
  const mixed = "a" + "\u{1D11E}".repeat(NOTE_DETAIL_LIMIT + 5);
  const mixedDetail = upstreamNoteDetail({ code: 128, stdout: "", stderr: mixed });
  assert.equal(Array.from(mixedDetail).length, NOTE_DETAIL_LIMIT + 1, "140 code points plus the ellipsis");
  assert.doesNotMatch(
    mixedDetail,
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    "no lone surrogate: a UTF-16 slice would leave half a pair before the ellipsis"
  );
  assert.equal(mixedDetail.includes("�"), false, "and therefore no replacement glyph");

  // No stderr at all must still say something: `（）` would read as a formatting
  // bug rather than as a Git failure.
  assert.equal(upstreamNoteDetail({ code: 129, stdout: "0\t2", stderr: "  \n\n" }), "git rev-list 退出码 129");
  // Exactly at the limit is kept whole; no gratuitous ellipsis.
  const exact = "y".repeat(NOTE_DETAIL_LIMIT);
  assert.equal(upstreamNoteDetail({ code: 128, stdout: "", stderr: exact }), exact);
  // The limit gates on code points, not UTF-16 units. The inputs above cannot
  // tell the two measures apart — the long ones are > 140 under both, `exact` is
  // 140 under both — which is why the gate could be changed to `last.length`
  // with this whole file still green. This input sits in the one window that
  // separates them: 140 code points but 141 UTF-16 units, so a gate written as
  // `last.length > NOTE_DETAIL_LIMIT` would append an ellipsis to a line that is
  // not over the limit.
  const codePointLimit = "a".repeat(NOTE_DETAIL_LIMIT - 1) + "\u{1D11E}";
  assert.equal(Array.from(codePointLimit).length, NOTE_DETAIL_LIMIT, "140 code points");
  assert.equal(codePointLimit.length, NOTE_DETAIL_LIMIT + 1, "but 141 UTF-16 units");
  assert.equal(
    upstreamNoteDetail({ code: 128, stdout: "", stderr: codePointLimit }),
    codePointLimit,
    "unchanged, with no ellipsis: the gate counts code points"
  );
  // And the boundary is exact, not merely "somewhere past 140": one code point
  // over must be truncated. Without this, a gate written as
  // `chars.length > NOTE_DETAIL_LIMIT + 1` passes the whole file while leaving a
  // 141-code-point line untruncated.
  const overByOne = "a".repeat(NOTE_DETAIL_LIMIT) + "\u{1D11E}";
  assert.equal(Array.from(overByOne).length, NOTE_DETAIL_LIMIT + 1, "141 code points");
  assert.equal(overByOne.length, NOTE_DETAIL_LIMIT + 2, "142 UTF-16 units");
  assert.equal(
    upstreamNoteDetail({ code: 128, stdout: "", stderr: overByOne }),
    "a".repeat(NOTE_DETAIL_LIMIT) + "…",
    "one code point over is truncated to the limit plus the ellipsis"
  );
  // The fixture above cannot separate "gate +1" from "gate on UTF-16 units +1":
  // it is 141 code points but 142 units, so a mutant that both measures in units
  // and widens by one would still truncate it. All-BMP input makes the two
  // measures equal, so it pins the gate to exactly `> NOTE_DETAIL_LIMIT` code
  // points no matter which side the implementation counts.
  const overByOneBmp = "a".repeat(NOTE_DETAIL_LIMIT + 1);
  assert.equal(overByOneBmp.length, NOTE_DETAIL_LIMIT + 1, "141 code points and 141 UTF-16 units");
  assert.equal(
    upstreamNoteDetail({ code: 128, stdout: "", stderr: overByOneBmp }),
    "a".repeat(NOTE_DETAIL_LIMIT) + "…",
    "the gate is exactly one over the limit, not two"
  );
});

test("branch context gives explicit detached and no-upstream labels", () => {
  const value = branchContext({ range: { kind: "recentN", count: 5 }, rebasing: true });
  assert.equal(value.branchName, "detached HEAD（变基中）");
  assert.equal(value.upstreamRef, "未配置 upstream");
  assert.equal(value.rangeLabel, "范围：最近 5 个 commit");
  assert.equal(rangeLabel({ kind: "mainBranch", mainBranch: "develop" }), "范围：develop..HEAD");
  assert.equal(rangeLabel({ kind: "all" }), "范围：当前分支全部历史");
});
