#!/usr/bin/env node
// Packages the extension into dist-vsix/.
//
// `vsce package --out <dir>/` does NOT create the directory: when it is absent,
// vsce treats the argument as a file name and writes a zip literally called
// `dist-vsix`, exiting 0. That breaks a fresh checkout (and the release
// workflow, which expects dist-vsix/<name>.vsix). Creating the directory here
// keeps the behaviour identical on cmd.exe, PowerShell and POSIX shells, where
// a shell-level `mkdir -p` would only work on the latter two.
//
// `--out` is passed an explicit file name as well: with the directory already
// present vsce accepts either form, and pinning the name means a future vsce
// change cannot silently relocate the artifact.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "dist-vsix");
const version = require(path.join(root, "package.json")).version;
const target = path.join(outDir, `git-rebase-visual-${version}.vsix`);

// `--verify-only` re-runs the allowlist check against the artifact already in
// dist-vsix/, without packaging again.
//
// The release workflow used to repeat the 12-entry list in a heredoc, so adding
// a file meant editing it in two places and a half-done edit failed in CI rather
// than at the source. With this flag the workflow calls the same code that runs
// locally, and the list exists once.
const verifyOnly = process.argv.includes("--verify-only");

// What the VSIX is allowed to contain, exactly.
//
// `.vscodeignore` is a *blacklist*: a new top-level directory that nobody adds
// to it ships silently, and neither this script nor CI used to notice. This list
// inverts that. Building the package is now an explicit decision — add an entry
// here when you add a file, and the diff shows exactly what the user will get.
const expectedEntries = [
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/.gitignore",
  "extension/LICENSE.txt",
  "extension/package.json",
  "extension/readme.md",
  "extension/dist/extension.js",
  "extension/dist/seq-editor.js",
  "extension/media/extension-icon.png",
  "extension/media/icon.svg",
  "extension/media/main.js",
  "extension/media/style.css",
];

if (verifyOnly) {
  // No packaging, no directory creation: verify exactly the file that exists.
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    console.error(`--verify-only: ${target} does not exist. Run \`npm run package\` first.`);
    process.exit(1);
  }
  verifyAllowlist(target);
  process.exit(0);
}

// `mkdirSync(..., {recursive:true})` throws EEXIST when the path is a regular
// file with that name — the exact artifact the old `--out dist-vsix/` invocation
// produced. Replace that raw EEXIST with a message that names the cause and the
// fix, so the next person does not have to rediscover why the directory is a file.
if (fs.existsSync(outDir) && !fs.statSync(outDir).isDirectory()) {
  console.error(
    `${outDir} exists but is not a directory. It is probably the zip that ` +
      "`vsce package --out dist-vsix/` wrote before the directory existed. " +
      "Delete that file and re-run `npm run package`."
  );
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const result = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules", "@vscode", "vsce", "vsce"),
    "package",
    "--no-dependencies",
    "--out",
    target,
  ],
  { cwd: root, stdio: "inherit" }
);

if (result.error) {
  console.error(String(result.error));
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
  console.error(`vsce reported success but did not produce ${target}`);
  process.exit(1);
}

verifyAllowlist(target);

/** Compares the artifact's entry set to `expectedEntries`, or exits 1. */
function verifyAllowlist(file) {
  const actual = listEntries(file);
  const missing = expectedEntries.filter((entry) => !actual.includes(entry));
  const unexpected = actual.filter((entry) => !expectedEntries.includes(entry));
  if (missing.length > 0 || unexpected.length > 0) {
    console.error("The VSIX contents do not match the expected allowlist.");
    if (unexpected.length > 0) {
      console.error(`  Unexpected entries (would ship to users):\n${unexpected.map((e) => `    + ${e}`).join("\n")}`);
      console.error(
        "  If one of these belongs in the package, add it to `expectedEntries` in\n" +
          "  scripts/package-vsix.js on purpose. If not, exclude it in .vscodeignore."
      );
    }
    if (missing.length > 0) {
      console.error(`  Missing entries (the package is incomplete):\n${missing.map((e) => `    - ${e}`).join("\n")}`);
    }
    process.exit(1);
  }
  console.log(`VSIX contents match the allowlist (${actual.length} entries).`);
}

/** Reads the entry names out of the produced VSIX. */
function listEntries(file) {
  const { execFileSync } = require("child_process");
  // `unzip -Z1` is available on the POSIX runners and in Git for Windows. A
  // Node-only reader would avoid the dependency, but the release workflow
  // already uses `unzip` for the same check, so failing loudly here if it is
  // absent is consistent rather than silently skipping the assertion.
  const out = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.endsWith("/"));
}
