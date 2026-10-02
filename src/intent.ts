import crypto from "node:crypto";
import type { ChangeKind, IntentRecord, RiskLevel } from "./types.ts";
import { makeEvent, appendEvent, readEventsOfType } from "./events.ts";
import type { AgentSession } from "./types.ts";

const CHANGE_KINDS: ChangeKind[] = ["added", "modified", "removed", "refactored"];
const RISK_LEVELS: RiskLevel[] = ["low", "medium", "high"];

export function isChangeKind(value: unknown): value is ChangeKind {
  return typeof value === "string" && CHANGE_KINDS.includes(value as ChangeKind);
}

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === "string" && RISK_LEVELS.includes(value as RiskLevel);
}

export interface IntentInput {
  entity: string;
  files: string[];
  changeKind: ChangeKind;
  reason: string;
  expectedBehavior: string;
  risk: RiskLevel;
  relatedTask?: string | undefined;
  alternatives?: string[];
  limitations?: string[];
  evidence?: string | undefined;
}

export async function recordIntent(
  projectRoot: string,
  session: Pick<AgentSession, "id"> | null,
  input: IntentInput,
): Promise<IntentRecord> {
  if (!input.entity?.trim()) throw new Error("entity is required");
  if (!Array.isArray(input.files) || input.files.length === 0) throw new Error("files must be a non-empty array");
  if (!isChangeKind(input.changeKind)) throw new Error(`changeKind must be one of: ${CHANGE_KINDS.join(", ")}`);
  if (!input.reason?.trim()) throw new Error("reason is required");
  if (!input.expectedBehavior?.trim()) throw new Error("expectedBehavior is required");
  if (!isRiskLevel(input.risk)) throw new Error(`risk must be one of: ${RISK_LEVELS.join(", ")}`);

  const intent: IntentRecord = {
    id: crypto.randomUUID(),
    sessionId: session?.id ?? null,
    recordedAt: new Date().toISOString(),
    entity: input.entity.trim(),
    files: input.files,
    changeKind: input.changeKind,
    reason: input.reason.trim(),
    expectedBehavior: input.expectedBehavior.trim(),
    risk: input.risk,
    ...(input.relatedTask ? { relatedTask: input.relatedTask } : {}),
    alternatives: input.alternatives ?? [],
    limitations: input.limitations ?? [],
    ...(input.evidence ? { evidence: input.evidence } : {}),
  };

  await appendEvent(projectRoot, makeEvent("intent.recorded", "intent", { ...intent }, session?.id ?? null));
  return intent;
}

export async function readIntents(projectRoot: string, sessionId?: string): Promise<IntentRecord[]> {
  const events = await readEventsOfType(projectRoot, "intent.recorded", sessionId);
  return events
    .map((event) => event.payload as unknown as IntentRecord)
    .filter((intent) => typeof intent?.entity === "string" && Array.isArray(intent?.files));
}
