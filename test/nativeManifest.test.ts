import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const manifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")
) as {
  contributes: {
    commands: Array<{ command: string }>;
    menus: { "view/item/context": Array<{ command: string; when?: string }> };
  };
};

const allCommitContexts = [
  "gitRebaseVisual.commit",
  "gitRebaseVisual.commit.locked",
  "gitRebaseVisual.commit.batch",
  "gitRebaseVisual.commit.batch.contiguous",
  "gitRebaseVisual.commit.locked.batch",
  "gitRebaseVisual.commit.locked.batch.contiguous",
];

function contextMenu(command: string): { command: string; when?: string } {
  const item = manifest.contributes.menus["view/item/context"].find((entry) => entry.command === command);
  assert.ok(item, `missing context-menu contribution for ${command}`);
  return item;
}

test("native manifest exposes working AI compose on the working section", () => {
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === "gitRebaseVisual.worktree.workingAiMessage"));
  assert.match(
    contextMenu("gitRebaseVisual.worktree.workingAiMessage").when ?? "",
    /viewItem == gitRebaseVisual\.worktree\.workingSection/
  );
});

test("native manifest retains readonly commit actions for locked and batch contexts only", () => {
  for (const command of [
    "gitRebaseVisual.commit.copyHash",
    "gitRebaseVisual.commit.copyMessage",
    "gitRebaseVisual.commit.openDiff",
    "gitRebaseVisual.commit.generateDiff",
  ]) {
    const when = contextMenu(command).when ?? "";
    for (const context of allCommitContexts) {
      assert.match(when, new RegExp(`viewItem == ${context.replaceAll(".", "\\.")}`), `${command} missing ${context}`);
    }
  }

  for (const command of [
    "gitRebaseVisual.commit.reword",
    "gitRebaseVisual.commit.aiMessage",
    "gitRebaseVisual.commit.rebaseTo",
    "gitRebaseVisual.commit.appendStaged",
    "gitRebaseVisual.commit.squash",
    "gitRebaseVisual.commit.fixup",
    "gitRebaseVisual.commit.drop",
  ]) {
    const when = contextMenu(command).when ?? "";
    assert.match(when, /viewItem == gitRebaseVisual\.commit/);
    assert.doesNotMatch(when, /locked/, `${command} must remain unavailable for locked contexts`);
  }
  assert.doesNotMatch(
    contextMenu("gitRebaseVisual.commit.bulkDrop").when ?? "",
    /locked/,
    "a batch containing any locked commit must not offer a rewrite drop route"
  );
});
