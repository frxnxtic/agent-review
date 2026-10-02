import { spawn } from "node:child_process";
import { truncateUtf8 } from "./redact.ts";
import { REVIEW_DIR_NAME } from "./paths.ts";

/**
 * All external processes run through this gate:
 * spawn(file, args[]) with shell: false — user strings never reach `sh -c`.
 */
export interface CmdResult {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export async function runCommand(
  cwd: string,
  file: string,
  args: string[],
  maxOutputBytes = 10 * 1024,
  timeoutMs = 10 * 60_000,
): Promise<CmdResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, shell: false });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let truncated = false;

    const collect = (target: Buffer, chunk: Buffer): { buffer: Buffer; dropped: boolean } => {
      const room = maxOutputBytes - target.length;
      if (room <= 0) return { buffer: target, dropped: true };
      if (chunk.length <= room) return { buffer: Buffer.concat([target, chunk]), dropped: false };
      return { buffer: Buffer.concat([target, chunk.subarray(0, room)]), dropped: true };
    };

    const timer = setTimeout(() => {
      truncated = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      const next = collect(stdout, chunk);
      stdout = next.buffer;
      if (next.dropped) truncated = true;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const next = collect(stderr, chunk);
      stderr = next.buffer;
      if (next.dropped) truncated = true;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = truncateUtf8(stdout.toString("utf8"), maxOutputBytes);
      const err = truncateUtf8(stderr.toString("utf8"), maxOutputBytes);
      resolve({
        code,
        stdout: out.text,
        stderr: err.text,
        truncated: truncated || out.truncated || err.truncated,
      });
    });
  });
}

export async function git(
  projectRoot: string,
  args: string[],
  maxOutputBytes = 512 * 1024,
): Promise<CmdResult> {
  return runCommand(projectRoot, "git", args, maxOutputBytes);
}

export async function isGitRepo(projectRoot: string): Promise<boolean> {
  try {
    const result = await git(projectRoot, ["rev-parse", "--show-toplevel"]);
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function gitHead(projectRoot: string): Promise<string | null> {
  const result = await git(projectRoot, ["rev-parse", "HEAD"]);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

export async function currentBranch(projectRoot: string): Promise<string | null> {
  const result = await git(projectRoot, ["branch", "--show-current"]);
  const name = result.stdout.trim();
  return result.code === 0 && name.length > 0 ? name : null;
}

export async function gitStatusShort(projectRoot: string): Promise<string[]> {
  const result = await git(projectRoot, ["status", "--short", "--untracked-files=all"]);
  if (result.code !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

/** File paths only, status prefixes stripped. The plugin's own data dir is excluded. */
export async function changedFilePaths(projectRoot: string): Promise<string[]> {
  const lines = await gitStatusShort(projectRoot);
  const paths = new Set<string>();
  for (const line of lines) {
    const rest = line.slice(3).trim();
    if (!rest || rest.startsWith(REVIEW_DIR_NAME + "/") || rest === REVIEW_DIR_NAME) continue;
    // Rename entries look like "R  old -> new".
    const rename = /^(.+) -> (.+)$/.exec(rest);
    paths.add(rename ? rename[2]!.trim() : rest);
  }
  return [...paths];
}

export async function branchExists(projectRoot: string, branch: string): Promise<boolean> {
  const result = await git(projectRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return result.code === 0;
}

/** Creates a branch off the current HEAD. Never force, never deletes. */
export async function createBranch(projectRoot: string, branch: string): Promise<boolean> {
  const result = await git(projectRoot, ["checkout", "-b", branch]);
  return result.code === 0;
}

/** Switches to an existing branch (plain checkout, no force, keeps working tree). */
export async function checkoutBranch(projectRoot: string, branch: string): Promise<boolean> {
  const result = await git(projectRoot, ["checkout", branch]);
  return result.code === 0;
}

export async function diffNameOnly(projectRoot: string, base: string = "HEAD"): Promise<string[]> {
  const result = await git(projectRoot, ["diff", "--name-only", base]);
  if (result.code !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function diffStat(projectRoot: string, base: string = "HEAD"): Promise<string> {
  const result = await git(projectRoot, ["diff", "--stat", base]);
  return result.code === 0 ? result.stdout.trim() : "";
}

export async function diffPatch(projectRoot: string, base: string = "HEAD", maxBytes = 20 * 1024): Promise<string> {
  const result = await git(projectRoot, ["diff", base], maxBytes);
  return result.code === 0 ? result.stdout : "";
}

export interface CommitInfoRaw {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

export async function listCommits(projectRoot: string, range: string): Promise<CommitInfoRaw[]> {
  const result = await git(projectRoot, [
    "log",
    "--pretty=format:%H%x1f%s%x1f%an%x1f%aI",
    range,
  ]);
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.split("\x1f"))
    .filter((parts): parts is [string, string, string, string] => parts.length === 4)
    .map(([hash, subject, author, date]) => ({ hash, subject, author, date }));
}
