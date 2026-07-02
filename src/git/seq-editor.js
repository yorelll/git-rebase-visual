#!/usr/bin/env node
// Standalone editor script invoked by git as GIT_SEQUENCE_EDITOR / GIT_EDITOR.
// git calls it as: node seq-editor.js <fileToEdit>
// We overwrite that file with content the extension prepared beforehand,
// selected via environment variables. This turns the "interactive" rebase
// into a fully scripted one.
//
//   GRV_TODO_FILE : path to a file whose contents replace the rebase todo list
//   GRV_MSG_FILE  : path to a file whose contents replace a commit message
//
// Distinguishing which one to apply is done by the target filename: git uses
// "git-rebase-todo" for the sequence editor and a COMMIT_EDITMSG-like path for
// message editing.

const fs = require("fs");
const path = require("path");

const target = process.argv[2];
if (!target) {
  process.exit(0);
}

const base = path.basename(target);
const todoFile = process.env.GRV_TODO_FILE;
const msgFile = process.env.GRV_MSG_FILE;

try {
  if (base === "git-rebase-todo" && todoFile && fs.existsSync(todoFile)) {
    fs.copyFileSync(todoFile, target);
  } else if (msgFile && fs.existsSync(msgFile)) {
    // Any non-todo editor invocation during our rebase is a message edit.
    fs.copyFileSync(msgFile, target);
  }
  // Otherwise leave the file untouched (git keeps its default content).
} catch (e) {
  process.stderr.write(String(e && e.message ? e.message : e));
  process.exit(1);
}

process.exit(0);
