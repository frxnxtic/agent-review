/**
 * Agent Review — MCP stdio server (thin adapter for Claude Code and other MCP hosts).
 *
 * Exposes the same tools as the OpenCode plugin via the shared handlers in
 * handlers.ts. Project root: AGENT_REVIEW_PROJECT_ROOT, else CLAUDE_PROJECT_DIR,
 * else the server's cwd. Nothing is written to stdout except MCP protocol frames.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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

export function resolveProjectRoot(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  return env.AGENT_REVIEW_PROJECT_ROOT || env.CLAUDE_PROJECT_DIR || cwd;
}

function text(payload: string) {
  return { content: [{ type: "text" as const, text: payload }] };
}

export function createServer(projectRoot: string): McpServer {
  const server = new McpServer({ name: "agent-review", version: "0.1.0" });

  server.registerTool("agent_review_start", {
    description: TOOL_DESCRIPTIONS.agent_review_start,
    inputSchema: {
      task: z.string().describe("The feature/task this session works on"),
      branch: z.string().optional().describe("Desired working branch name (default: agent/<task-slug>)"),
      autoCreateBranch: z.boolean().optional().describe("Create the feature branch if needed (default true)"),
      confirm: z.boolean().optional().describe("Explicit user confirmation for branch creation on a protected branch"),
    },
  }, async (args) => text(await handleStart(projectRoot, args)));

  server.registerTool("agent_review_checkpoint", {
    description: TOOL_DESCRIPTIONS.agent_review_checkpoint,
    inputSchema: {
      reason: z.string().describe("Why this checkpoint is taken"),
    },
  }, async (args) => text(await handleCheckpoint(projectRoot, args)));

  server.registerTool("agent_review_record_intent", {
    description: TOOL_DESCRIPTIONS.agent_review_record_intent,
    inputSchema: {
      entity: z.string().describe("The entity or area being changed"),
      files: z.array(z.string()).describe("Files involved"),
      changeKind: z.enum(["added", "modified", "removed", "refactored"]),
      reason: z.string().describe("Why the change is made"),
      expectedBehavior: z.string().describe("Expected behavior after the change"),
      risk: z.enum(["low", "medium", "high"]),
      relatedTask: z.string().optional(),
      alternatives: z.array(z.string()).optional(),
      limitations: z.array(z.string()).optional(),
      evidence: z.string().optional().describe("Verifiable evidence (command output, test names)"),
    },
  }, async (args) => text(await handleRecordIntent(projectRoot, args)));

  server.registerTool("agent_review_run_tests", {
    description: TOOL_DESCRIPTIONS.agent_review_run_tests,
    inputSchema: {
      command: z.string().describe("Single test command, e.g. npm test"),
      reason: z.string().describe("Why these tests are run"),
    },
  }, async (args) => text(await handleRunTests(projectRoot, args)));

  server.registerTool("agent_review_build_package", {
    description: TOOL_DESCRIPTIONS.agent_review_build_package,
    inputSchema: {
      includeDiff: z.boolean().optional().describe("Embed the git diff into the package (default from config)"),
      keepActive: z.boolean().optional().describe("Do not end the session after building"),
    },
  }, async (args) => text(await handleBuildPackage(projectRoot, args)));

  server.registerTool("agent_review_status", {
    description: TOOL_DESCRIPTIONS.agent_review_status,
    inputSchema: {},
  }, async () => text(await handleStatus(projectRoot)));

  server.registerTool("agent_review_rollback", {
    description: TOOL_DESCRIPTIONS.agent_review_rollback,
    inputSchema: {
      checkpointId: z.string().optional().describe("Checkpoint to restore; omit to list available checkpoints"),
      confirm: z.boolean().optional().describe("Explicit user confirmation to restore"),
    },
  }, async (args) => text(await handleRollback(projectRoot, args)));

  server.registerTool("agent_review_github_status", {
    description: TOOL_DESCRIPTIONS.agent_review_github_status,
    inputSchema: {
      baseBranch: z.string().optional().describe("Base branch override (default from config)"),
    },
  }, async (args) => text(await handleGithubStatus(projectRoot, args)));

  server.registerTool("agent_review_prepare_pr", {
    description: TOOL_DESCRIPTIONS.agent_review_prepare_pr,
    inputSchema: {
      baseBranch: z.string().optional().describe("Base branch for the PR diff mapping (default from config)"),
      maxInlineComments: z.number().optional().describe("Cap on inline comments (default 8)"),
    },
  }, async (args) => text(await handlePreparePr(projectRoot, args)));

  server.registerTool("agent_review_publish_pr", {
    description: TOOL_DESCRIPTIONS.agent_review_publish_pr,
    inputSchema: {
      baseBranch: z.string().optional().describe("Base branch (default from config)"),
      title: z.string().optional().describe("PR title (default: generated from the Change Package)"),
      allowCommit: z.boolean().optional().describe("Create a git commit of the current changes (default false)"),
      allowPush: z.boolean().optional().describe("Push the branch with plain git push -u origin <branch>, never force (default false)"),
      createDraft: z.boolean().optional().describe("Create a Draft PR if none exists (default true)"),
      publishInlineComments: z.boolean().optional().describe("Publish the grouped inline review (default true)"),
      confirmed: z.boolean().optional().describe("Explicit user confirmation — REQUIRED for any external action"),
    },
  }, async (args) => text(await handlePublishPr(projectRoot, args)));

  server.registerTool("agent_review_update_github_review", {
    description: TOOL_DESCRIPTIONS.agent_review_update_github_review,
    inputSchema: {
      pullRequestNumber: z.number().optional().describe("PR number (default: last published)"),
      confirmed: z.boolean().optional().describe("Explicit user confirmation — REQUIRED to publish the updated review"),
    },
  }, async (args) => text(await handleUpdateReview(projectRoot, args)));

  return server;
}

if (process.argv[1]?.endsWith("mcp.ts")) {
  const server = createServer(resolveProjectRoot());
  await server.connect(new StdioServerTransport());
}
