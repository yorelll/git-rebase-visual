import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as ts from "typescript";
import {
  END_OF_OPTIONS_DENIED_SUBCOMMANDS,
  END_OF_OPTIONS,
  subcommandOf,
  withPositionals,
} from "../src/git/gitRunner";

interface DeniedCall {
  file: string;
  line: number;
  command: string;
}

/**
 * Parses `source` instead of grep-ing it, so a multi-line call shape such as
 *
 *   withPositionals(
 *     ["checkout"],
 *     [sha]
 *   )
 *
 * is found just as reliably as the one-line form, and call-like text inside a
 * comment or string is never mistaken for a call. `file` is only used for the
 * failure message.
 *
 * ## Coverage boundary (deliberately stated, not implied)
 *
 * Only a call whose callee is the identifier `withPositionals`, `runGit` or
 * `git` and whose first argument is an *array literal* is scanned. `git` is the
 * same runner's throwing entry point, so it has to be included. These shapes
 * still escape the scan:
 *
 *   - an import alias (`import { withPositionals as wp }`);
 *   - a variable argv (`runGit(args)` where `args` was assembled earlier — e.g.
 *     `pushGuard.pushRefspec` builds an array that `pushGit` passes as a
 *     variable; the `withPositionals` call that built it *is* scanned);
 *   - spread elements (`[...argv, END_OF_OPTIONS]`) and computed arrays.
 *
 * Today `src/` has no alias, and every marker-using argv starts in a scanned
 * array literal. For the shapes above, only the runtime check inside
 * `withPositionals` remains — a direct `git(variableArgv)` carrying the marker
 * would bypass both layers. Adding a new entry point therefore means adding it
 * to `SCANNED_CALLEES`, not assuming this scan is exhaustive.
 */
const SCANNED_CALLEES = new Set(["withPositionals", "runGit", "git"]);

function deniedCallsIn(source: string, file: string): DeniedCall[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: DeniedCall[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      SCANNED_CALLEES.has(node.expression.text)
    ) {
      const callee = node.expression.text;
      const first = node.arguments[0];
      if (first && ts.isArrayLiteralExpression(first)) {
        // `withPositionals` appends the marker itself; a direct `runGit`/`git`
        // argv is only relevant when it already carries the marker.
        const usesMarker =
          callee === "withPositionals" ||
          first.elements.some(
            (element) =>
              (ts.isIdentifier(element) && element.text === "END_OF_OPTIONS") ||
              (ts.isStringLiteral(element) && element.text === END_OF_OPTIONS)
          );
        if (!usesMarker) {
          ts.forEachChild(node, visit);
          return;
        }
        const literals = first.elements
          .filter((element): element is ts.StringLiteral => ts.isStringLiteral(element))
          .map((element) => element.text);
        // Use the production parser, not a copy: global options with separate
        // values (`-c protocol.version=2 checkout`) must not hide the command.
        const command = subcommandOf(literals);
        if (Object.prototype.hasOwnProperty.call(END_OF_OPTIONS_DENIED_SUBCOMMANDS, command)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          found.push({ file, line: line + 1, command });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

function typescriptFilesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...typescriptFilesUnder(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

test("withPositionals refuses a denied subcommand at runtime", () => {
  assert.throws(
    () => withPositionals(["checkout"], ["HEAD"]),
    /checkout.*--end-of-options.*"--" separator/s
  );
  assert.throws(
    () => withPositionals(["stash", "store"], ["HEAD"]),
    /stash store.*--end-of-options.*40-hex/s
  );
  // A global option's separate value must not hide the subcommand.
  assert.throws(
    () => withPositionals(["-c", "protocol.version=2", "checkout"], ["HEAD"]),
    /checkout.*--end-of-options.*"--" separator/s
  );
  // `git stash` accepts options before its subcommand, so the nested
  // subcommand must be resolved past them.
  assert.throws(
    () => withPositionals(["stash", "--quiet", "store"], ["HEAD"]),
    /stash store.*--end-of-options.*40-hex/s
  );
  assert.throws(
    () => withPositionals(["stash", "-m", "msg", "store"], ["HEAD"]),
    /stash store.*--end-of-options.*40-hex/s
  );
  // A non-store stash subcommand is not denied. `stash apply --index` is the
  // realistic shape: `--index` belongs to `apply`, not to `stash`.
  assert.deepEqual(withPositionals(["stash", "apply", "--index"], ["HEAD"]), [
    "stash",
    "apply",
    "--index",
    END_OF_OPTIONS,
    "HEAD",
  ]);
  // `-m store` is a message, not the `store` subcommand, and a bare
  // `git stash` has no nested subcommand at all: neither may be misclassified.
  assert.equal(subcommandOf(["stash", "-m", "store"]), "stash");
  assert.equal(subcommandOf(["stash"]), "stash");
  assert.equal(subcommandOf(["stash", "--quiet"]), "stash");
  assert.deepEqual(withPositionals(["log", "-1"], ["HEAD"]), [
    "log",
    "-1",
    END_OF_OPTIONS,
    "HEAD",
  ]);
});

test("the detector finds denied calls, including multi-line and commented-out shapes", () => {
  // Positive controls: the guard must not be vacuous. These mirror the two
  // denied subcommands and both call layouts.
  assert.deepEqual(deniedCallsIn('withPositionals(["checkout"], [`${sha}^3`])', "one-line.ts"), [
    { file: "one-line.ts", line: 1, command: "checkout" },
  ]);
  assert.deepEqual(
    deniedCallsIn(
      'withPositionals(\n  ["stash", "store"],\n  [sha]\n)',
      "multi-line.ts"
    ),
    [{ file: "multi-line.ts", line: 1, command: "stash store" }]
  );
  assert.deepEqual(
    deniedCallsIn(
      'withPositionals(["-c", "protocol.version=2", "checkout"], [sha])',
      "global-option.ts"
    ),
    [{ file: "global-option.ts", line: 1, command: "checkout" }]
  );
  // A direct runGit call is caught only when it carries the marker; the same
  // checkout argv without the marker is exactly the supported shape.
  assert.deepEqual(
    deniedCallsIn(
      'runGit(["checkout", END_OF_OPTIONS, "--", path], { cwd })',
      "direct.ts"
    ),
    [{ file: "direct.ts", line: 1, command: "checkout" }]
  );
  assert.deepEqual(
    deniedCallsIn('runGit(["checkout", `${sha}^3`, "--", path], { cwd })', "allowed.ts"),
    []
  );
  assert.deepEqual(
    deniedCallsIn('runGit(["log", "-1", END_OF_OPTIONS, "HEAD"], { cwd })', "log.ts"),
    []
  );
  // `git` is the same runner's throwing entry point; a marker-carrying denied
  // call through it must be caught too.
  assert.deepEqual(
    deniedCallsIn('git(["checkout", END_OF_OPTIONS, "--", path], { cwd })', "git-helper.ts"),
    [{ file: "git-helper.ts", line: 1, command: "checkout" }]
  );
  assert.deepEqual(
    deniedCallsIn('git(["checkout", `${sha}^3`, "--", path], { cwd })', "git-allowed.ts"),
    []
  );
  // The nested `stash <option> store` shape resolves to the denied key; a
  // non-store stash subcommand stays green.
  assert.deepEqual(
    deniedCallsIn(
      'withPositionals(["stash", "--quiet", "store"], [sha])',
      "stash-option.ts"
    ),
    [{ file: "stash-option.ts", line: 1, command: "stash store" }]
  );
  assert.deepEqual(
    deniedCallsIn(
      'withPositionals(["stash", "apply", "--index"], [sha])',
      "stash-apply.ts"
    ),
    []
  );
  // A denied word in a comment or in the positionals is not a denied command.
  assert.deepEqual(
    deniedCallsIn(
      '// withPositionals(["checkout"], [x])\nwithPositionals(["log", "-1"], ["checkout"])',
      "safe.ts"
    ),
    []
  );
});

test("no source file passes a denied subcommand to --end-of-options", () => {
  const root = join(process.cwd(), "src");
  const denied = typescriptFilesUnder(root).flatMap((file) =>
    deniedCallsIn(readFileSync(file, "utf8"), file)
  );
  assert.deepEqual(
    denied,
    [],
    `withPositionals/runGit/git must not put --end-of-options after a denied subcommand:\n${denied
      .map((call) => `${call.file}:${call.line} ${call.command}`)
      .join("\n")}`
  );
});
