import { RangeConfig } from "../git/commitLog";

export interface BranchContextInput {
  branchName?: string;
  upstreamRef?: string;
  aheadCount?: number;
  behindCount?: number;
  range: RangeConfig;
  rebasing: boolean;
}

export interface BranchContext {
  branchName: string;
  upstreamRef: string;
  aheadCount: number;
  behindCount: number;
  rangeLabel: string;
}

export function rangeLabel(range: RangeConfig): string {
  switch (range.kind) {
    case "upstream": return "范围：upstream..HEAD";
    case "mainBranch": return `范围：${range.mainBranch}..HEAD`;
    case "recentN": return `范围：最近 ${Math.max(1, range.count)} 个 commit`;
    case "all": return "范围：当前分支全部历史";
  }
}

/** Converts optional Git query results into explicit, UI-safe context text. */
export function branchContext(input: BranchContextInput): BranchContext {
  return {
    branchName: input.branchName ?? (input.rebasing ? "detached HEAD（变基中）" : "detached HEAD"),
    upstreamRef: input.upstreamRef ?? "未配置 upstream",
    aheadCount: Math.max(0, input.aheadCount ?? 0),
    behindCount: Math.max(0, input.behindCount ?? 0),
    rangeLabel: rangeLabel(input.range),
  };
}
