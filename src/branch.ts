import type { AgentReviewConfig } from "./config.ts";
import { branchExists, createBranch, currentBranch, isGitRepo } from "./git.ts";

export const DEFAULT_PROTECTED_BRANCHES: string[] = ["main", "master", "develop"];

export function isProtectedBranch(branch: string | null, protectedBranches: string[] = DEFAULT_PROTECTED_BRANCHES): boolean {
  if (!branch) return false;
  return protectedBranches.includes(branch);
}

/** "Add refresh token rotation!" -> "add-refresh-token-rotation" (max 40 chars). */
export function slugifyTask(task: string, maxLength = 40): string {
  const slug = task
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const clipped = slug.slice(0, maxLength);
  return clipped.replace(/-+$/g, "");
}

export function proposeBranchName(task: string, prefix = "agent/"): string {
  return `${prefix}${slugifyTask(task)}`;
}

export type BranchDecision =
  | { action: "not-a-repo" }
  | { action: "used-current"; branch: string }
  | { action: "created"; branch: string; fromProtected: boolean }
  | { action: "switched"; branch: string }
  | { action: "requires-confirmation"; proposedBranch: string; currentBranch: string }
  | { action: "error"; code: "BRANCH_EXISTS" | "DETACHED_HEAD"; message: string };

/**
 * Branch workflow. Never destructive: creates or switches only,
 * and never touches a protected branch without an explicit confirm flag.
 */
export async function resolveWorkingBranch(
  projectRoot: string,
  options: {
    task: string;
    branch?: string | undefined;
    protectedBranches?: string[];
    autoCreateBranch?: boolean;
    confirm?: boolean;
  },
  config?: AgentReviewConfig,
): Promise<BranchDecision> {
  if (!(await isGitRepo(projectRoot))) return { action: "not-a-repo" };

  const protectedBranches = config?.protectedBranches ?? options.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES;
  const prefix = config?.branchPrefix ?? "agent/";
  const current = await currentBranch(projectRoot);
  if (!current) {
    return { action: "error", code: "DETACHED_HEAD", message: "detached HEAD — switch to a branch first" };
  }

  const desired = options.branch?.trim() || proposeBranchName(options.task, prefix);

  if (!isProtectedBranch(current, protectedBranches)) {
    if (desired === current) return { action: "used-current", branch: current };
    if (await branchExists(projectRoot, desired)) {
      return { action: "switched", branch: desired };
    }
    if (options.autoCreateBranch === false) return { action: "used-current", branch: current };
    if (options.confirm && (await createBranch(projectRoot, desired))) {
      return { action: "created", branch: desired, fromProtected: false };
    }
    return { action: "used-current", branch: current };
  }

  // Current branch is protected: propose a feature branch, create only on explicit confirmation.
  if (await branchExists(projectRoot, desired)) {
    return {
      action: "error",
      code: "BRANCH_EXISTS",
      message: `branch "${desired}" already exists — switch to it manually or pass a different name`,
    };
  }
  if (options.autoCreateBranch !== false && options.confirm) {
    if (await createBranch(projectRoot, desired)) {
      return { action: "created", branch: desired, fromProtected: true };
    }
    return { action: "error", code: "BRANCH_EXISTS", message: `failed to create branch "${desired}"` };
  }
  return { action: "requires-confirmation", proposedBranch: desired, currentBranch: current };
}
