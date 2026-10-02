/**
 * Claude Code PostToolUse hook — the counterpart of the OpenCode plugin's
 * file.edited / tool.execute.after journaling. Reads the hook JSON from stdin
 * and appends one event to events.jsonl when a review session is active.
 * Always exits 0: journaling must never break the host session.
 */
import path from "node:path";
import type { ObservedEventType } from "./types.ts";
import { getActiveSession } from "./session.ts";
import { makeEvent, appendEvent } from "./events.ts";
import { truncateUtf8 } from "./redact.ts";

export interface ClaudeHookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
}

export interface MappedHookObservation {
  type: ObservedEventType;
  source: string;
  payload: Record<string, unknown>;
}

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function mapClaudeToolUse(input: ClaudeHookInput, projectRoot: string): MappedHookObservation | null {
  const toolName = input.tool_name;
  if (!toolName) return null;
  const toolInput = input.tool_input ?? {};
  const base = { tool: toolName, claudeSessionId: input.session_id };

  if (FILE_TOOLS.has(toolName)) {
    const raw = toolInput.file_path ?? toolInput.notebook_path;
    if (typeof raw !== "string") return null;
    const file = path.isAbsolute(raw) ? path.relative(projectRoot, raw) : raw;
    return { type: "file.changed", source: `claude:PostToolUse:${toolName}`, payload: { ...base, file } };
  }

  if (toolName === "Bash") {
    const payload: Record<string, unknown> = { ...base };
    if (typeof toolInput.command === "string") payload.command = toolInput.command;
    const response = input.tool_response as { stdout?: unknown; interrupted?: unknown } | undefined;
    if (typeof response?.stdout === "string" && response.stdout.length > 0) {
      payload.outputTail = truncateUtf8(response.stdout.slice(-500), 500).text;
    }
    if (typeof response?.interrupted === "boolean") payload.interrupted = response.interrupted;
    return { type: "command.completed", source: "claude:PostToolUse:Bash", payload };
  }

  return { type: "tool.completed", source: `claude:PostToolUse:${toolName}`, payload: base };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function runHook(raw: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const input = JSON.parse(raw) as ClaudeHookInput;
  const projectRoot = env.AGENT_REVIEW_PROJECT_ROOT || env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const session = await getActiveSession(projectRoot);
  if (!session) return;
  const observation = mapClaudeToolUse(input, projectRoot);
  if (!observation) return;
  await appendEvent(projectRoot, makeEvent(observation.type, observation.source, observation.payload, session.id));
}

if (process.argv[1]?.endsWith("claude-hook.ts")) {
  try {
    await runHook(await readStdin());
  } catch {
    // Journaling must never break the host session.
  }
  process.exit(0);
}
