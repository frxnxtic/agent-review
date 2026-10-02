import type { ObservedEventType } from "./types.ts";
import { truncateUtf8 } from "./redact.ts";

/**
 * Pure mapping of OpenCode bus/hook observations onto Agent Review event types.
 *
 * Documented limitations (OpenCode 1.18.23 has no literal session.started /
 * session.ended bus events):
 *   - opencode `session.created` → observed as `session.started`
 *   - opencode `session.idle`    → NOT mapped (fires after every response;
 *                                  ending a session on idle would be wrong)
 *   - explicit session end happens via build_package (finalizes the session)
 */

export interface MappedObservation {
  type: ObservedEventType;
  source: string;
  payload: Record<string, unknown>;
}

export function mapFileEdited(file: string): MappedObservation {
  return { type: "file.changed", source: "opencode:file.edited", payload: { file } };
}

export function mapSessionCreated(opencodeSessionId: string): MappedObservation {
  return { type: "session.started", source: "opencode:session.created", payload: { opencodeSessionId } };
}

export interface ToolObservationInput {
  tool: string;
  callID: string;
  sessionID: string;
  args?: unknown;
}

export function mapToolStart(input: ToolObservationInput): MappedObservation {
  const isBash = input.tool === "bash";
  const rawCommand = isBash && typeof (input.args as { command?: unknown })?.command === "string"
    ? (input.args as { command: string }).command
    : undefined;
  const payload: Record<string, unknown> = {
    tool: input.tool,
    callID: input.callID,
    sessionID: input.sessionID,
  };
  if (rawCommand !== undefined) payload.command = rawCommand;
  return {
    type: isBash ? "command.started" : "tool.started",
    source: `opencode:tool.execute.before:${input.tool}`,
    payload,
  };
}

export interface ToolCompletionInput extends ToolObservationInput {
  durationMs: number;
  title?: string | undefined;
  output?: string | undefined;
  metadata?: unknown;
}

export function mapToolCompletion(input: ToolCompletionInput): MappedObservation {
  const isBash = input.tool === "bash";
  const exitCode = extractExitCode(input.metadata);
  const payload: Record<string, unknown> = {
    tool: input.tool,
    callID: input.callID,
    sessionID: input.sessionID,
    durationMs: input.durationMs,
    success: exitCode === undefined ? undefined : exitCode === 0,
    exitCode,
  };
  if (typeof input.title === "string" && input.title.length > 0) {
    payload.title = truncateUtf8(input.title, 200).text;
  }
  if (typeof input.output === "string" && input.output.length > 0) {
    // Small tail only — full output is capped at the command layer.
    payload.outputTail = truncateUtf8(input.output.slice(-500), 500).text;
  }
  if (isBash && typeof (input.args as { command?: unknown })?.command === "string") {
    payload.command = (input.args as { command: string }).command;
  }
  return {
    type: isBash ? "command.completed" : "tool.completed",
    source: `opencode:tool.execute.after:${input.tool}`,
    payload,
  };
}

function extractExitCode(metadata: unknown): number | undefined {
  if (metadata === null || typeof metadata !== "object") return undefined;
  const candidate = (metadata as { exit?: unknown; exitCode?: unknown }).exit ??
    (metadata as { exitCode?: unknown }).exitCode;
  return typeof candidate === "number" ? candidate : undefined;
}
