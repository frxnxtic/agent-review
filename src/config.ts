import fs from "node:fs/promises";
import { REVIEW_FILES, reviewDir, reviewFile } from "./paths.ts";

export interface GitHubConfig {
  enabled: boolean;
  defaultBaseBranch: string;
  createDraftPullRequest: boolean;
  maxInlineComments: number;
  publishSummary: boolean;
  publishInlineComments: boolean;
  skipGeneratedFiles: boolean;
  skipLockfiles: boolean;
  updateMode: "replace-agent-comments";
}

export interface AgentReviewConfig {
  schemaVersion: "agent-review/v1";
  /** Branches the plugin will never act on without explicit confirmation. */
  protectedBranches: string[];
  /** Prefix for agent-proposed feature branches. */
  branchPrefix: string;
  /** Per-command captured stdout/stderr cap, in bytes. */
  maxCapturedOutputBytes: number;
  /** Per-file diff cap embedded into the Change Package, in bytes. */
  maxDiffBytesPerFile: number;
  /** Default for build_package's includeDiff. */
  includeDiffInPackageByDefault: boolean;
  /** Redact secret-looking values before persisting events/results. */
  redactionEnabled: boolean;
  /**
   * When true, change-package.json and review.md are intended for git.
   * The journal (events.jsonl), session.json, checkpoints/ and snapshots/
   * stay gitignored regardless.
   */
  commitArtifacts: boolean;
  /** GitHub Draft PR review integration (MVP stage 3). Disabled by default. */
  github: GitHubConfig;
}

export const DEFAULT_GITHUB_CONFIG: GitHubConfig = {
  enabled: false,
  defaultBaseBranch: "main",
  createDraftPullRequest: true,
  maxInlineComments: 8,
  publishSummary: true,
  publishInlineComments: true,
  skipGeneratedFiles: true,
  skipLockfiles: true,
  updateMode: "replace-agent-comments",
};

export const DEFAULT_CONFIG: AgentReviewConfig = {
  schemaVersion: "agent-review/v1",
  protectedBranches: ["main", "master", "develop"],
  branchPrefix: "agent/",
  maxCapturedOutputBytes: 10 * 1024,
  maxDiffBytesPerFile: 20 * 1024,
  includeDiffInPackageByDefault: true,
  redactionEnabled: true,
  commitArtifacts: true,
  github: DEFAULT_GITHUB_CONFIG,
};

/**
 * Merges a stored config file forward: flat legacy fields are kept, missing
 * `github` keys fall back to defaults, and the aspirational nested shape
 * (`git.protectedBranches`, `github.*`) is accepted.
 */
function mergeForward(raw: Record<string, unknown>): AgentReviewConfig {
  const merged: AgentReviewConfig = {
    ...DEFAULT_CONFIG,
    ...(raw as Partial<AgentReviewConfig>),
    github: { ...DEFAULT_GITHUB_CONFIG, ...((raw.github as Partial<GitHubConfig> | undefined) ?? {}) },
  };
  const nestedGit = raw.git as { protectedBranches?: string[] } | undefined;
  if (nestedGit && Array.isArray(nestedGit.protectedBranches) && !("protectedBranches" in raw)) {
    merged.protectedBranches = nestedGit.protectedBranches;
  }
  return merged;
}

export async function loadOrCreateConfig(projectRoot: string): Promise<AgentReviewConfig> {
  const file = reviewFile(projectRoot, "config");
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    return mergeForward(raw);
  } catch {
    const config = DEFAULT_CONFIG;
    await fs.mkdir(reviewDir(projectRoot), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return config;
  }
}

export const CONFIG_FILE_NAME = REVIEW_FILES.config;
