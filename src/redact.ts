/**
 * Secret redaction for anything persisted by Agent Review.
 * Applied to every event payload and captured command output.
 */

const REDACTION = "[REDACTED]";

const PATTERNS: RegExp[] = [
  // PEM private keys (multi-line).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Bearer / authorization headers.
  /\bBearer\s+[\w._\-/+=]{8,}/gi,
  // Token assignment shapes: api_key=..., "password": ..., token: ...
  // A bare space is NOT a separator — otherwise phrases like "token rotation" redact.
  /\b(api[_-]?key|apikey|secret|token|password|passwd|pwd|authorization|auth)["']?\s*[:=]\s*["']?[\w._\-/+=]{6,}["']?/gi,
  // Common token prefixes (OpenAI, GitHub, Slack, AWS).
  /\b(?:sk|ghp|gho|ghu|ghs|github_pat|xoxa|xoxb|xoxp|AKIA)[-_][\w\-]{10,}/g,
  // Connection strings with credentials: scheme://user:password@host...
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|ftps?|https?):\/\/[^\s:@/]+:[^\s@/]+@[^\s"']+/g,
];

export function redactString(input: string): string {
  let output = input;
  for (const pattern of PATTERNS) {
    output = output.replace(pattern, (match) => {
      // Keep the scheme for connection strings so the message stays readable.
      const connMatch = /^(\w+(?:\+\w+)?:\/\/)[^@]*@/.exec(match);
      return connMatch ? `${connMatch[1]}${REDACTION}@${REDACTION}` : REDACTION;
    });
  }
  return output;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth-limit]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactValue(inner, depth + 1);
    }
    return result;
  }
  return value;
}

/** UTF-8-safe truncation that never splits a multi-byte character. */
export function truncateUtf8(input: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(input, "utf8");
  if (buffer.length <= maxBytes) return { text: input, truncated: false };
  const slice = buffer.subarray(0, maxBytes);
  // Drop an incomplete trailing code unit sequence.
  let end = slice.length;
  while (end > 0 && (slice[end - 1]! & 0b1100_0000) === 0b1000_0000) end--;
  if (end > 0 && (slice[end - 1]! & 0b1100_0000) === 0b1100_0000) end--;
  return { text: `${slice.subarray(0, Math.max(end, 0)).toString("utf8")}\n…[truncated]`, truncated: true };
}

export function redactAndTruncate(input: string, maxBytes: number): { text: string; truncated: boolean } {
  const { text, truncated } = truncateUtf8(input, maxBytes);
  return { text: redactString(text), truncated };
}
