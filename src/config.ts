import * as vscode from "vscode";
import { RangeConfig } from "./git/commitLog";
import { LlmConfig } from "./llm/client";

const SECTION = "gitRebaseVisual";

export function getRangeConfig(): RangeConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  const kind = c.get<string>("commitRange", "upstream");
  switch (kind) {
    case "mainBranch":
      return { kind: "mainBranch", mainBranch: c.get<string>("mainBranch", "main") };
    case "recentN":
      return { kind: "recentN", count: c.get<number>("recentCount", 20) };
    case "all":
      return { kind: "all" };
    case "upstream":
    default:
      return { kind: "upstream" };
  }
}

export function getLlmConfig(): LlmConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    baseUrl: c.get<string>("llm.baseUrl", ""),
    apiKey: c.get<string>("llm.apiKey", ""),
    model: c.get<string>("llm.model", "fast"),
  };
}

export function getLlmExtras(): {
  skillPath: string;
  diffMaxChars: number;
  timeout: number;
} {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    skillPath: c.get<string>("llm.skillPath", ""),
    diffMaxChars: c.get<number>("diffMaxChars", 12000),
    timeout: Math.max(1000, c.get<number>("llm.timeoutMs", 120000)),
  };
}

export function getPushRefspecTemplate(): string {
  return vscode.workspace
    .getConfiguration(SECTION)
    .get<string>("push.refspecTemplate", "");
}

export function getAutoStash(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<boolean>("autoStash", true);
}

export function isLlmConfigured(): boolean {
  const cfg = getLlmConfig();
  return cfg.baseUrl.trim().length > 0 && cfg.apiKey.trim().length > 0;
}
