import * as fs from "fs";
import { git } from "../git/gitRunner";
import { ChatMessage, LlmConfig, LlmRequestOptions, streamChat } from "./client";

const BASE_PROMPT = `You are an expert software engineer writing a git commit message.
Given the diff of a single commit, produce a concise, conventional commit message.
Rules:
- First line: a short imperative summary under 72 characters.
- Optionally, a blank line then a body explaining what and why.
- Output ONLY the commit message text. No code fences, no commentary.`;

/** Returns the diff introduced by a single commit (parent..commit). */
export async function getCommitDiff(cwd: string, hash: string): Promise<string> {
  return git(["show", "--no-color", "--format=", hash], { cwd });
}

/** Diff of staged changes (the index). */
export async function getStagedDiff(cwd: string): Promise<string> {
  return git(["diff", "--cached", "--no-color"], { cwd });
}

/** Diff of all working-tree changes vs HEAD (tracked files). */
export async function getWorkingDiff(cwd: string): Promise<string> {
  return git(["diff", "HEAD", "--no-color"], { cwd });
}

function loadSkill(skillPath: string): string | undefined {
  if (!skillPath) {
    return undefined;
  }
  try {
    return fs.readFileSync(skillPath, "utf8");
  } catch {
    return undefined;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max) + "\n\n[diff truncated]";
}

function buildMessages(
  diff: string,
  opts: { skillPath: string; diffMaxChars: number; extraInfo?: string }
): ChatMessage[] {
  const skill = loadSkill(opts.skillPath);

  let system = BASE_PROMPT;
  if (skill) {
    system +=
      "\n\nThe user provided additional commit-message guidelines. You MUST follow them strictly:\n\n" +
      skill;
  }

  let user = `Write a commit message for the following diff:\n\n${truncate(
    diff,
    opts.diffMaxChars
  )}`;
  if (opts.extraInfo && opts.extraInfo.trim()) {
    user +=
      "\n\nAdditional information / instructions from the user (incorporate as required):\n" +
      opts.extraInfo.trim();
  }

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Generates a commit message via the LLM (batch mode) from an arbitrary diff.
 * `extraInfo` lets the user supply additional context (e.g. a link a skill
 * requires) that is appended to the prompt.
 */
export async function generateFromDiff(
  diff: string,
  cfg: LlmConfig,
  opts: { skillPath: string; diffMaxChars: number; extraInfo?: string },
  onDelta: (chunk: string) => void,
  requestOptions: LlmRequestOptions = {}
): Promise<string> {
  return streamChat(cfg, buildMessages(diff, opts), onDelta, requestOptions);
}

/** Convenience: generate a message for an existing commit. */
export async function generateMessage(
  cwd: string,
  hash: string,
  cfg: LlmConfig,
  opts: { skillPath: string; diffMaxChars: number; extraInfo?: string },
  onDelta: (chunk: string) => void,
  requestOptions: LlmRequestOptions = {}
): Promise<string> {
  const diff = await getCommitDiff(cwd, hash);
  return generateFromDiff(diff, cfg, opts, onDelta, requestOptions);
}

export { buildMessages };
