/**
 * Agent Review — OpenCode plugin (thin adapter).
 *
 * Domain logic lives in sibling modules; this file only wires the plugin
 * hooks and the custom tools. All dangerous operations require explicit
 * user confirmation (`confirm: true` + permission ask). Nothing here pushes,
 * merges, creates PRs or runs destructive git commands.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { getActiveSession } from "./session.ts";
import { makeEvent, appendEvent } from "./events.ts";
import { mapFileEdited, mapToolStart, mapToolCompletion, type ToolCompletionInput } from "./recorder.ts";
import {
  TOOL_DESCRIPTIONS,
  handleStart,
  handleCheckpoint,
  handleRecordIntent,
  handleRunTests,
  handleBuildPackage,
  handleStatus,
  handleRollback,
  handleGithubStatus,
  handlePreparePr,
  handlePublishPr,
  handleUpdateReview,
} from "./handlers.ts";

export const AgentReviewPlugin: Plugin = async (input) => {
  const projectRoot = input.worktree || input.directory;
  /** callID -> observation context for tool.execute.after duration bookkeeping. */
  const inFlight = new Map<string, { tool: string; startedAt: number; args: unknown; sessionID: string }>();

  /** Records one observation into the journal if a review session is active. */
  async function recordIfActive(observation: { type: Parameters<typeof makeEvent>[0]; source: string; payload: Record<string, unknown> }, opencodeSessionId?: string) {
    const session = await getActiveSession(projectRoot);
    if (!session) return;
    await appendEvent(
      projectRoot,
      makeEvent(observation.type, observation.source, { ...observation.payload, opencodeSessionId }, session.id),
    );
  }

  return {
    event: async ({ event }) => {
      try {
        if (event.type === "file.edited") {
          await recordIfActive(mapFileEdited(event.properties.file));
        }
      } catch {
        // Journaling must never break the host session.
      }
    },

    "tool.execute.before": async (hookInput, output) => {
      try {
        const entry = {
          tool: hookInput.tool,
          startedAt: Date.now(),
          args: output.args,
          sessionID: hookInput.sessionID,
        };
        inFlight.set(hookInput.callID, entry);
        await recordIfActive(mapToolStart({ ...entry, callID: hookInput.callID }), hookInput.sessionID);
      } catch {
        // Journaling must never break the host session.
      }
    },

    "tool.execute.after": async (hookInput, output) => {
      try {
        const entry = inFlight.get(hookInput.callID);
        inFlight.delete(hookInput.callID);
        if (!entry) return;
        const completion: ToolCompletionInput = {
          tool: entry.tool,
          callID: hookInput.callID,
          sessionID: entry.sessionID,
          args: entry.args,
          durationMs: Date.now() - entry.startedAt,
          title: typeof output.title === "string" ? output.title : undefined,
          output: typeof output.output === "string" ? output.output : undefined,
          metadata: output.metadata,
        };
        await recordIfActive(mapToolCompletion(completion), entry.sessionID);
      } catch {
        // Journaling must never break the host session.
      }
    },

    tool: {
      agent_review_start: tool({
        description: TOOL_DESCRIPTIONS.agent_review_start,
        args: {
          task: tool.schema.string().describe("The feature/task this session works on"),
          branch: tool.schema.string().optional().describe("Desired working branch name (default: agent/<task-slug>)"),
          autoCreateBranch: tool.schema.boolean().optional().describe("Create the feature branch if needed (default true)"),
          confirm: tool.schema.boolean().optional().describe("Explicit user confirmation for branch creation on a protected branch"),
        },
        execute: (args) => handleStart(projectRoot, args),
      }),

      agent_review_checkpoint: tool({
        description: TOOL_DESCRIPTIONS.agent_review_checkpoint,
        args: {
          reason: tool.schema.string().describe("Why this checkpoint is taken"),
        },
        execute: (args) => handleCheckpoint(projectRoot, args),
      }),

      agent_review_record_intent: tool({
        description: TOOL_DESCRIPTIONS.agent_review_record_intent,
        args: {
          entity: tool.schema.string().describe("The entity or area being changed"),
          files: tool.schema.array(tool.schema.string()).describe("Files involved"),
          changeKind: tool.schema.enum(["added", "modified", "removed", "refactored"]),
          reason: tool.schema.string().describe("Why the change is made"),
          expectedBehavior: tool.schema.string().describe("Expected behavior after the change"),
          risk: tool.schema.enum(["low", "medium", "high"]),
          relatedTask: tool.schema.string().optional(),
          alternatives: tool.schema.array(tool.schema.string()).optional(),
          limitations: tool.schema.array(tool.schema.string()).optional(),
          evidence: tool.schema.string().optional().describe("Verifiable evidence (command output, test names)"),
        },
        execute: (args) => handleRecordIntent(projectRoot, args),
      }),

      agent_review_run_tests: tool({
        description: TOOL_DESCRIPTIONS.agent_review_run_tests,
        args: {
          command: tool.schema.string().describe("Single test command, e.g. npm test"),
          reason: tool.schema.string().describe("Why these tests are run"),
        },
        execute: (args) => handleRunTests(projectRoot, args),
      }),

      agent_review_build_package: tool({
        description: TOOL_DESCRIPTIONS.agent_review_build_package,
        args: {
          includeDiff: tool.schema.boolean().optional().describe("Embed the git diff into the package (default from config)"),
          keepActive: tool.schema.boolean().optional().describe("Do not end the session after building"),
        },
        execute: (args) => handleBuildPackage(projectRoot, args),
      }),

      agent_review_status: tool({
        description: TOOL_DESCRIPTIONS.agent_review_status,
        args: {},
        execute: () => handleStatus(projectRoot),
      }),

      agent_review_rollback: tool({
        description: TOOL_DESCRIPTIONS.agent_review_rollback,
        args: {
          checkpointId: tool.schema.string().optional().describe("Checkpoint to restore; omit to list available checkpoints"),
          confirm: tool.schema.boolean().optional().describe("Explicit user confirmation to restore"),
        },
        execute: (args) => handleRollback(projectRoot, args),
      }),

      agent_review_github_status: tool({
        description: TOOL_DESCRIPTIONS.agent_review_github_status,
        args: {
          baseBranch: tool.schema.string().optional().describe("Base branch override (default from config)"),
        },
        execute: (args) => handleGithubStatus(projectRoot, args),
      }),

      agent_review_prepare_pr: tool({
        description: TOOL_DESCRIPTIONS.agent_review_prepare_pr,
        args: {
          baseBranch: tool.schema.string().optional().describe("Base branch for the PR diff mapping (default from config)"),
          maxInlineComments: tool.schema.number().optional().describe("Cap on inline comments (default 8)"),
        },
        execute: (args) => handlePreparePr(projectRoot, args),
      }),

      agent_review_publish_pr: tool({
        description: TOOL_DESCRIPTIONS.agent_review_publish_pr,
        args: {
          baseBranch: tool.schema.string().optional().describe("Base branch (default from config)"),
          title: tool.schema.string().optional().describe("PR title (default: generated from the Change Package)"),
          allowCommit: tool.schema.boolean().optional().describe("Create a git commit of the current changes (default false)"),
          allowPush: tool.schema.boolean().optional().describe("Push the branch with plain git push -u origin <branch>, never force (default false)"),
          createDraft: tool.schema.boolean().optional().describe("Create a Draft PR if none exists (default true)"),
          publishInlineComments: tool.schema.boolean().optional().describe("Publish the grouped inline review (default true)"),
          confirmed: tool.schema.boolean().optional().describe("Explicit user confirmation — REQUIRED for any external action"),
        },
        execute: (args) => handlePublishPr(projectRoot, args),
      }),

      agent_review_update_github_review: tool({
        description: TOOL_DESCRIPTIONS.agent_review_update_github_review,
        args: {
          pullRequestNumber: tool.schema.number().optional().describe("PR number (default: last published)"),
          confirmed: tool.schema.boolean().optional().describe("Explicit user confirmation — REQUIRED to publish the updated review"),
        },
        execute: (args) => handleUpdateReview(projectRoot, args),
      }),
    },
  };
};

// NOTE: this module must export EXACTLY ONE function — OpenCode treats every
// exported function as a plugin instance and calls it with the plugin input.
