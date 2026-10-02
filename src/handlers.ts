/**
 * Host-neutral tool handlers shared by the OpenCode plugin (plugin.ts) and the
 * MCP server (mcp.ts). Each handler takes the project root and the tool args
 * and returns the serialized JSON payload; errors are serialized, never thrown.
 */
import { startSession, getActiveSession, loadSession, AgentReviewError } from "./session.ts";
import { createCheckpoint, restoreCheckpoint, listCheckpoints } from "./checkpoints.ts";
import { recordIntent } from "./intent.ts";
import { runTestCommand } from "./tests.ts";
import { buildChangePackage } from "./package-builder.ts";
import { getSessionStatus } from "./status.ts";
import { githubStatus, githubPreparePullRequest, githubPublishPullRequest, githubUpdateReview } from "./github-workflow.ts";

const JSON_OK = "agent-review";

export function serialize(payload: Record<string, unknown>): string {
  return JSON.stringify({ result: JSON_OK, ...payload }, null, 2);
}

export function errorMessage(error: unknown): string {
  if (error instanceof AgentReviewError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export const TOOL_DESCRIPTIONS = {
  agent_review_start:
    "Start an Agent Review session: verify git, check the current branch (propose an agent/<slug> feature branch when on a protected branch), record the task, and create the first checkpoint. Pass confirm:true after the user approves branch creation.",
  agent_review_checkpoint:
    "Create a checkpoint: record current git HEAD, git status, changed files, and a local restorable snapshot of the changed files.",
  agent_review_record_intent:
    "Record the structured reason for a logical change (entity, files, kind, why, expected behavior, risk, alternatives, limitations). This is evidence, not reasoning: state only verifiable facts and explicit decisions.",
  agent_review_run_tests:
    "Run ONE explicitly provided test command (no shell metacharacters, destructive programs rejected). The command and its evidence (exit code, duration, capped redacted output) are recorded.",
  agent_review_build_package:
    "Build the Change Package (change-package.json) and the human-readable review.md from the session journal, git diff and test evidence. This finalizes the session unless keepActive is true.",
  agent_review_status:
    "Show the active Agent Review session state: branch, event/checkpoint/test counts, changed files, Change Package state.",
  agent_review_rollback:
    "Restore files from a chosen checkpoint snapshot. Requires explicit confirm:true (a safety checkpoint is taken first). Never deletes files and never runs git reset.",
  agent_review_github_status:
    "Read-only GitHub readiness check: gh CLI presence and auth, origin remote (owner/repo), current/base branch, and any existing OPEN PR for the current branch. No external state change; never throws.",
  agent_review_prepare_pr:
    "LOCAL ONLY — never pushes, never creates PRs. Rebuilds the Change Package, maps logical changes to PR-diff lines, generates the PR body and inline-comment previews under .agent-review/github/ (pr-preview.json, pr-body.md, inline-comments.preview.json, publish-plan.md).",
  agent_review_publish_pr:
    "External actions (commit/push/draft PR/grouped review). Runs ONLY with confirmed:true — otherwise returns the preview and performs NOTHING. Draft PR by default; never merges; never duplicates an existing open PR.",
  agent_review_update_github_review:
    "After a new commit/push on an existing PR: re-map logical changes to the new head diff and republish the grouped review. Identifies the plugin's OWN comments by a hidden marker and replaces only those — human and other-bot comments are never touched. Publishes only with confirmed:true.",
} as const;

export type ToolName = keyof typeof TOOL_DESCRIPTIONS;

const NO_SESSION = "no active session — call agent_review_start first";

export async function handleStart(
  projectRoot: string,
  args: { task: string; branch?: string; autoCreateBranch?: boolean; confirm?: boolean },
): Promise<string> {
  try {
    const result = await startSession(projectRoot, args);
    if (result.confirmationRequired) {
      return serialize({
        status: "confirmation-required",
        message: `Current branch "${result.confirmationRequired.currentBranch}" is protected. Propose creating branch "${result.confirmationRequired.proposedBranch}". Ask the user, then re-invoke with confirm:true.`,
        proposedBranch: result.confirmationRequired.proposedBranch,
      });
    }
    return serialize({
      status: "started",
      sessionId: result.session?.id,
      branch: result.session?.workingBranch,
      checkpointId: result.checkpoint?.id,
      warning: result.warning,
    });
  } catch (error) {
    return serialize({ status: "error", error: errorMessage(error) });
  }
}

export async function handleCheckpoint(projectRoot: string, args: { reason: string }): Promise<string> {
  try {
    const session = await getActiveSession(projectRoot);
    if (!session) return serialize({ status: "error", error: NO_SESSION });
    const checkpoint = await createCheckpoint(projectRoot, session, args.reason);
    return serialize({ status: "created", checkpointId: checkpoint.id, restorable: checkpoint.restorable, changedFiles: checkpoint.changedFiles.length });
  } catch (error) {
    return serialize({ status: "error", error: errorMessage(error) });
  }
}

export async function handleRecordIntent(projectRoot: string, args: Parameters<typeof recordIntent>[2]): Promise<string> {
  try {
    const session = await getActiveSession(projectRoot);
    if (!session) return serialize({ status: "error", error: NO_SESSION });
    const intent = await recordIntent(projectRoot, session, args);
    return serialize({ status: "recorded", intentId: intent.id });
  } catch (error) {
    return serialize({ status: "error", error: errorMessage(error) });
  }
}

export async function handleRunTests(projectRoot: string, args: { command: string; reason: string }): Promise<string> {
  try {
    const session = await getActiveSession(projectRoot);
    if (!session) return serialize({ status: "error", error: NO_SESSION });
    const evidence = await runTestCommand(projectRoot, session, args.command, args.reason);
    return serialize({ status: evidence.status, evidence });
  } catch (error) {
    return serialize({ status: "error", error: errorMessage(error) });
  }
}

export async function handleBuildPackage(projectRoot: string, args: { includeDiff?: boolean; keepActive?: boolean }): Promise<string> {
  try {
    const session = await loadSession(projectRoot);
    if (!session) return serialize({ status: "error", error: "no review session found — call agent_review_start first" });
    const result = await buildChangePackage(projectRoot, args);
    return serialize({
      status: "built",
      changePackagePath: result.changePackagePath,
      reviewPath: result.reviewPath,
      changedFiles: result.changePackage.changedFiles.length,
      risks: result.changePackage.risks,
      sessionStatus: result.changePackage.session.status,
    });
  } catch (error) {
    return serialize({ status: "error", error: errorMessage(error) });
  }
}

export async function handleStatus(projectRoot: string): Promise<string> {
  try {
    const report = await getSessionStatus(projectRoot);
    return serialize({ status: report.active ? "active" : "inactive", ...report });
  } catch (error) {
    return serialize({ status: "error", error: errorMessage(error) });
  }
}

export async function handleRollback(projectRoot: string, args: { checkpointId?: string; confirm?: boolean }): Promise<string> {
  try {
    if (!args.checkpointId) {
      const checkpoints = await listCheckpoints(projectRoot);
      return serialize({
        status: "list",
        checkpoints: checkpoints.map((checkpoint) => ({
          id: checkpoint.id,
          createdAt: checkpoint.createdAt,
          reason: checkpoint.reason,
          restorable: checkpoint.restorable,
          changedFiles: checkpoint.changedFiles.length,
        })),
        message: "Ask the user which checkpoint to restore, then re-invoke with checkpointId and confirm:true.",
      });
    }
    if (args.confirm !== true) {
      return serialize({
        status: "confirmation-required",
        message: `Restoring checkpoint ${args.checkpointId} overwrites the listed files. Get explicit user approval first, then re-invoke with confirm:true.`,
      });
    }
    const result = await restoreCheckpoint(projectRoot, args.checkpointId);
    return serialize({
      status: "restored",
      restored: result.restored,
      safetyCheckpointId: result.safetyCheckpointId,
      note: "Files restored from snapshot only; no git reset, no deletions.",
    });
  } catch (error) {
    return serialize({ status: "error", error: errorMessage(error) });
  }
}

export async function handleGithubStatus(projectRoot: string, args: { baseBranch?: string }): Promise<string> {
  try {
    const result = await githubStatus(projectRoot, args);
    return serialize({ status: "ok", ...result });
  } catch (error) {
    return serialize({ status: "error", error: errorMessage(error) });
  }
}

export async function handlePreparePr(projectRoot: string, args: { baseBranch?: string; maxInlineComments?: number }): Promise<string> {
  try {
    const result = await githubPreparePullRequest(projectRoot, args);
    return serialize({
      status: result.status,
      baseBranch: result.baseBranch,
      headBranch: result.headBranch,
      title: result.title,
      summary: result.summary,
      inlineComments: result.inlineComments,
      fileLevelCount: result.fileLevelCount,
      skipped: result.skipped,
      artifacts: result.artifacts,
    });
  } catch (error) {
    return serialize({ status: "error", error: errorMessage(error) });
  }
}

export async function handlePublishPr(projectRoot: string, args: Parameters<typeof githubPublishPullRequest>[1]): Promise<string> {
  try {
    const result = await githubPublishPullRequest(projectRoot, args);
    return serialize({ ...result });
  } catch (error) {
    return serialize({ status: "error", error: errorMessage(error) });
  }
}

export async function handleUpdateReview(projectRoot: string, args: Parameters<typeof githubUpdateReview>[1]): Promise<string> {
  try {
    const result = await githubUpdateReview(projectRoot, args);
    return serialize({ ...result });
  } catch (error) {
    return serialize({ status: "error", error: errorMessage(error) });
  }
}
