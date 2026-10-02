import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { ObservedEvent, ObservedEventType } from "./types.ts";
import { REVIEW_FILES, reviewDir, reviewFile } from "./paths.ts";
import { loadOrCreateConfig } from "./config.ts";
import { redactValue } from "./redact.ts";

export function makeEvent(
  type: ObservedEventType,
  source: string,
  payload: Record<string, unknown> = {},
  sessionId: string | null = null,
): ObservedEvent {
  return {
    id: crypto.randomUUID(),
    sessionId,
    timestamp: new Date().toISOString(),
    type,
    source,
    payload,
  };
}

/** Append-only journal write. Redaction is applied here — defense in depth. */
export async function appendEvent(projectRoot: string, event: ObservedEvent): Promise<ObservedEvent> {
  const config = await loadOrCreateConfig(projectRoot);
  const payload = config.redactionEnabled ? (redactValue(event.payload) as Record<string, unknown>) : event.payload;
  const line = `${JSON.stringify({ ...event, payload })}\n`;
  await fs.mkdir(reviewDir(projectRoot), { recursive: true });
  await fs.appendFile(reviewFile(projectRoot, "events"), line, "utf8");
  return { ...event, payload };
}

export async function readEvents(projectRoot: string): Promise<ObservedEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(reviewFile(projectRoot, "events"), "utf8");
  } catch {
    return [];
  }
  const events: ObservedEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as ObservedEvent);
    } catch {
      // A torn/partial trailing line must never break reads — skip it.
    }
  }
  return events;
}

export async function readEventsOfType(
  projectRoot: string,
  type: ObservedEventType,
  sessionId?: string,
): Promise<ObservedEvent[]> {
  const all = await readEvents(projectRoot);
  return all.filter((event) => event.type === type && (sessionId === undefined || event.sessionId === sessionId));
}

export async function countEvents(projectRoot: string, sessionId?: string): Promise<number> {
  const all = await readEvents(projectRoot);
  return sessionId === undefined ? all.length : all.filter((event) => event.sessionId === sessionId).length;
}

export const EVENTS_FILE_NAME = REVIEW_FILES.events;
