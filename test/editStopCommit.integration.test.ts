import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import test from "node:test";
import { fullMessage, isRebaseInProgress } from "../src/git/commitLog";
import { abortRebase, executeRebase, resolveBase } from "../src/git/rebaseEngine";
import { writeEditStopCommit } from "../src/ui/editStopCommit";
import { commitFile, createRepo, git, removeRepo } from "./helpers/gitTestRepo";

async function startEditStop(cwd: string): Promise<{ target: string; tip: string }> {
  const base = commitFile(cwd, "base.txt", "base\n", "base");
  const target = commitFile(cwd, "target.txt", "target\n", "feat: target\n\nChange-Id: I123\nSigned-off-by: Test <test@example.com>");
  const tip = commitFile(cwd, "tip.txt", "tip\n", "tip");
  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, base),
    items: [
      { hash: base, action: "pick", subject: "base" },
      { hash: target, action: "edit", subject: "feat: target" },
      { hash: tip, action: "pick", subject: "tip" },
    ],
  });
  assert.equal(outcome.stopped, true);
  return { target, tip };
}

test("edit-stop amend keeps original trailers through the real Git write", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  await startEditStop(cwd);
  fs.writeFileSync(path.join(cwd, "target.txt"), "amended\n", "utf8");
  git(cwd, ["add", "target.txt"]);

  await writeEditStopCommit(cwd, "amend", "feat: amended\n\nCorrect target");
  assert.equal(
    await fullMessage(cwd, "HEAD"),
    "feat: amended\n\nCorrect target\n\nChange-Id: I123\nSigned-off-by: Test <test@example.com>"
  );
  assert.equal(await isRebaseInProgress(cwd), true);
  await abortRebase(cwd);
});

test("edit-stop new commit does not inherit the stopped commit trailer block", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  await startEditStop(cwd);
  fs.writeFileSync(path.join(cwd, "new.txt"), "new\n", "utf8");
  git(cwd, ["add", "new.txt"]);

  await writeEditStopCommit(cwd, "new", "feat: follow-up\n\nSeparate change");
  const message = await fullMessage(cwd, "HEAD");
  assert.equal(message, "feat: follow-up\n\nSeparate change");
  assert.equal(message.includes("Change-Id: I123"), false);
  assert.equal(await isRebaseInProgress(cwd), true);
  await abortRebase(cwd);
});

test("edit-stop writer refuses an empty staged index before creating a commit", async (t) => {
  const cwd = createRepo();
  t.after(async () => {
    await abortRebase(cwd);
    removeRepo(cwd);
  });
  await startEditStop(cwd);
  await assert.rejects(() => writeEditStopCommit(cwd, "amend", "feat: should not write"), /暂存区为空/);
});

test("a real edit stop remains writable when the next todo command is another edit", async (t) => {
  const cwd = createRepo();
  t.after(async () => {
    await abortRebase(cwd);
    removeRepo(cwd);
  });
  const base = commitFile(cwd, "base.txt", "base\n", "base");
  const first = commitFile(cwd, "first.txt", "first\n", "first\n\nChange-Id: I111");
  const second = commitFile(cwd, "second.txt", "second\n", "second");
  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, base),
    items: [
      { hash: base, action: "pick", subject: "base" },
      { hash: first, action: "edit", subject: "first" },
      { hash: second, action: "edit", subject: "second" },
    ],
  });
  assert.equal(outcome.stopped, true);
  fs.writeFileSync(path.join(cwd, "first.txt"), "amended\n", "utf8");
  git(cwd, ["add", "first.txt"]);

  await writeEditStopCommit(cwd, "amend", "first: amended");
  assert.equal(await fullMessage(cwd, "HEAD"), "first: amended\n\nChange-Id: I111");
});
