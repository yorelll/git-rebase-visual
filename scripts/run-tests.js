/**
 * Runs the whole test suite by handing every file to Node's own test runner.
 *
 * Why this enumerates in Node instead of using a glob in package.json:
 *
 * 1. CI pins Node 20 (`.github/workflows/release.yml`, `node-version: 20`), and
 *    `node --test` only started accepting glob patterns in Node 22. On Node 20 a
 *    quoted glob argument is a literal path: it matches no files, so the suite
 *    would report zero tests or fail outright. This is the reason that matters —
 *    a glob command would break the release gate in CI.
 * 2. Shell expansion of `*` and `**` differs between bash and cmd.exe, so the
 *    command would not mean the same thing on every platform. Enumerating here
 *    makes the file list identical everywhere and needs no shell features.
 * 3. An empty enumeration is reported as an error instead of a green zero-test
 *    run.
 *
 * Historical note: an earlier version of this repository had
 * `test/index.test.ts`, an aggregator that imported every other test file. With
 * that file present a glob matched the aggregator *and* the files it imported,
 * so the whole suite ran twice — measured at `tests 550` for a 275-test suite.
 * That is why the aggregator was deleted. It is not the reason for enumeration:
 * with the aggregator gone the glob no longer double-counts, and that is exactly
 * why the reason has to be recorded precisely rather than restated from memory.
 *
 * The concurrency is fixed at 3 on purpose. `docs/research/test-performance.md`
 * measured that going to 6 saves about 15 s and produced two flaky failures in
 * one of two runs. There is no reason to buy 15 s with a flaky release gate.
 *
 * Every flag after `--` is forwarded to the test runner, so
 * `node scripts/run-tests.js -- --experimental-test-coverage` is the coverage
 * invocation. The exit code is the runner's, so a failing test still fails the
 * release gate.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const testDirectory = path.join(root, "test");
const files = fs
  .readdirSync(testDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map((entry) => path.join(testDirectory, entry.name))
  .sort();

// Enumeration is deliberately top-level only: `test/helpers/` and fixture
// repositories must never be run as suites. A silently skipped file is the
// failure mode to guard against, so anything below the top level that looks like
// a suite aborts the run and names it. Two shapes are covered: a real
// `*.test.ts` in a subdirectory, and a nested path that is a symlink (to a file
// or to a directory) — `Dirent.isDirectory()` is lstat-based, so a linked
// directory would otherwise be walked straight past and its tests never run.
function collectStrays(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      found.push(`${full} (symlink; not followed)`);
    } else if (entry.isDirectory()) {
      for (const child of fs.readdirSync(full, { withFileTypes: true })) {
        if (child.isFile() && child.name.endsWith(".test.ts")) found.push(path.join(full, child.name));
      }
      found.push(...collectStrays(full));
    }
  }
  return found;
}

// Skipped because it is not a regular file (for example a symlink) and so was
// not enumerated, yet it looks like a test file.
const unenumerated = fs
  .readdirSync(testDirectory, { withFileTypes: true })
  .filter((entry) => !entry.isFile() && entry.name.endsWith(".test.ts"))
  .map((entry) => path.join(testDirectory, entry.name));

const strays = [...collectStrays(testDirectory), ...unenumerated];

if (strays.length > 0) {
  console.error("Test files were found that this runner does not execute (move them to test/ or add them to the runner):");
  for (const stray of strays) console.error(`  ${path.relative(root, stray)}`);
  process.exit(1);
}

if (files.length === 0) {
  console.error("No test files found under", testDirectory);
  process.exit(1);
}

const forwarded = process.argv.slice(2).filter((argument) => argument !== "--");
const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const args = [tsx, "--test", "--test-concurrency=3", ...forwarded, ...files];

// `process.execPath` rather than a bare `tsx`: the binary on PATH may be a
// different Node, and on Windows `node_modules/.bin/tsx` is a `.cmd` shim that
// only `cmd.exe` can launch. Spawning the runner with the current Node works in
// every shell the repository is developed in.
const child = spawn(process.execPath, args, { stdio: "inherit", cwd: root });
child.on("error", (error) => {
  console.error(`Test runner could not start (${process.execPath}): ${error.message}`);
  process.exit(1);
});
child.on("close", (code, signal) => {
  if (signal) {
    console.error(`Test runner terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
