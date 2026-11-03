import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildTodo, shellQuote } from "../src/git/rebaseEngine";

test("buildTodo writes oldest-first rebase actions with a final newline", () => {
  assert.equal(
    buildTodo([
      { hash: "a".repeat(40), action: "pick", subject: "first" },
      { hash: "b".repeat(40), action: "reword", subject: "second" },
      { hash: "c".repeat(40), action: "drop", subject: "third" },
    ]),
    `pick ${"a".repeat(40)} first\nreword ${"b".repeat(40)} second\ndrop ${"c".repeat(40)} third\n`
  );
});

test("buildTodo creates an empty todo for no commits", () => {
  assert.equal(buildTodo([]), "\n");
});

/**
 * Every filename the abort message may have to quote.
 *
 * The list is deliberate rather than illustrative: each entry is a character
 * class that breaks a different naive quoting scheme. `'` is impossible inside
 * POSIX single quotes, `"`, `` ` ``, `$` and `\` are expansion/escape syntax,
 * a space and a newline split words, a leading `-` turns the operand into an
 * option without `--`, and a non-ASCII name exercises the encoding path. The
 * last entry is the hostile payload from the review: pasted into a shell with
 * naive quoting it runs `touch OWNED`.
 */
const HOSTILE_NAMES = [
  "it's.txt",
  'quo"te.txt',
  "back`tick.txt",
  "dol$lar.txt",
  "sp ace.txt",
  "new\nline.txt",
  "-dash.txt",
  "uni-é.txt",
  "back\\slash.txt",
  "pwn'; touch OWNED; echo '.txt",
];

/**
 * Proves the quoting is *correct*, not merely different.
 *
 * Eyeballing `'it'\''s.txt'` cannot distinguish a right answer from a plausible
 * one, so this feeds each quoted name to a real `sh -c 'printf %s …'` and
 * compares the byte string that comes back. `printf %s` is the right sink: no
 * word splitting, no glob expansion, no trailing newline to confuse the
 * comparison with the name itself.
 *
 * The extension never executes these strings — their only purpose is to be
 * copied — which is exactly why a wrong one is a real defect and why this test
 * has to use a real shell rather than a model of one.
 */
test("shellQuote round-trips every hostile filename through a real POSIX shell", (t) => {
  const probe = spawnSync("sh", ["-c", "printf %s ok"], { encoding: "utf8" });
  if (probe.error || probe.stdout !== "ok") {
    // No POSIX shell on PATH (a Windows machine without Git's usr/bin). Skip
    // loudly rather than passing silently: a skipped proof is not a proof.
    t.skip("no `sh` on PATH; the round-trip proof needs a real POSIX shell");
    return;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "grv-quote-"));
  try {
    for (const name of HOSTILE_NAMES) {
      const quoted = shellQuote(name);
      const res = spawnSync("sh", ["-c", `printf %s ${quoted}`], { cwd: scratch, encoding: "utf8" });
      assert.equal(res.status, 0, `the shell accepted the quoted form of ${JSON.stringify(name)}`);
      assert.equal(res.stdout, name, `the quoted form of ${JSON.stringify(name)} round-trips to the same bytes`);
    }
    // The payload must not have run. This is the assertion that turns "the
    // string looks quoted" into "pasting it does not execute anything".
    assert.equal(fs.existsSync(path.join(scratch, "OWNED")), false, "the hostile payload did not execute");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("shellQuote leaves an ordinary name alone and never emits an empty word", () => {
  assert.equal(shellQuote("plain.txt"), "'plain.txt'");
  // A name that is only a quote character: close, escaped quote, reopen. The odd
  // shape is the point — it is what makes the result a single valid word.
  assert.equal(shellQuote("'"), "''\\'''");
  assert.equal(shellQuote(""), "''");
  // And the odd shape must still round-trip, not just look plausible.
  const probe = spawnSync("sh", ["-c", "printf %s ok"], { encoding: "utf8" });
  if (!probe.error && probe.stdout === "ok") {
    assert.equal(spawnSync("sh", ["-c", `printf %s ${shellQuote("'")}`], { encoding: "utf8" }).stdout, "'");
  }
});
