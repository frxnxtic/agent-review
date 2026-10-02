/**
 * Stable hidden HTML marker tying a published GitHub comment back to the
 * Agent Review session + logical change. Used to find and replace ONLY the
 * plugin's own comments — never human or other-bot comments.
 */

export interface MarkerData {
  sessionId: string;
  logicalChangeId: string;
  version: number;
}

export function createMarker(data: MarkerData): string {
  return `<!-- agent-review:session=${data.sessionId};change=${data.logicalChangeId};version=${data.version} -->`;
}

export function parseMarker(body: string | null | undefined): MarkerData | null {
  if (!body) return null;
  const match = /<!--\s*agent-review:session=([^;\s>]+);change=([^;\s>]+);version=(\d+)\s*-->/.exec(body);
  if (!match) return null;
  return { sessionId: match[1]!, logicalChangeId: match[2]!, version: Number(match[3]) };
}
