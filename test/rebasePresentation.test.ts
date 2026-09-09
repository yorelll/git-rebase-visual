import assert from "node:assert/strict";
import test from "node:test";
import { branchContext, rangeLabel } from "../src/ui/rebasePresentation";

test("branch context exposes branch, upstream and divergence", () => {
  assert.deepEqual(branchContext({
    branchName: "feature/ui", upstreamRef: "origin/feature/ui", aheadCount: 3, behindCount: 2,
    range: { kind: "upstream" }, rebasing: false,
  }), {
    branchName: "feature/ui", upstreamRef: "origin/feature/ui", aheadCount: 3, behindCount: 2,
    rangeLabel: "范围：upstream..HEAD",
  });
});

test("branch context gives explicit detached and no-upstream labels", () => {
  const value = branchContext({ range: { kind: "recentN", count: 5 }, rebasing: true });
  assert.equal(value.branchName, "detached HEAD（变基中）");
  assert.equal(value.upstreamRef, "未配置 upstream");
  assert.equal(value.rangeLabel, "范围：最近 5 个 commit");
  assert.equal(rangeLabel({ kind: "mainBranch", mainBranch: "develop" }), "范围：develop..HEAD");
  assert.equal(rangeLabel({ kind: "all" }), "范围：当前分支全部历史");
});
