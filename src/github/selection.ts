/**
 * Inline-comment selection: bounded, low-noise, prioritized.
 * - only changes with semantic intent or risk >= medium
 * - risk=high first, then security/permissions/data-migrations/public-API/payment/authentication/destructive topics
 * - never the same logical change twice, never obvious rename/formatting-only changes
 * - cap at maxInlineComments (default 8)
 */
import type { IntentRecord } from "../types.ts";
import type { InlineCommentCandidate, UnmappedChange } from "./diff-mapper.ts";
import { isFormattingOnlyIntent } from "./filters.ts";

export const DEFAULT_MAX_INLINE_COMMENTS = 8;

const TOPIC_PATTERN =
  /\b(security|permission|permissions|auth|authentication|authorization|secret|secrets|credential|credentials|token|password|migration|migrations|schema migration|public api|api surface|payment|payments|billing|destructive|delete|deletion|encrypt|crypto|injection|sanitiz|validat|race|concurrency|lock)\b/i;

export interface SelectedComment {
  id: string;
  logicalChangeId: string;
  path: string;
  line: number;
  side: "RIGHT";
  risk: "low" | "medium" | "high";
  intent: IntentRecord;
}

export interface SelectionResult {
  selected: SelectedComment[];
  /** File-level summaries for logical changes with no mappable diff line. */
  fileLevel: IntentRecord[];
  skipped: Array<{ logicalChangeId: string; reason: string }>;
}

function priority(intent: IntentRecord): number {
  if (intent.risk === "high") return 0;
  if (TOPIC_PATTERN.test(`${intent.entity} ${intent.reason} ${intent.expectedBehavior}`)) return 1;
  if (intent.risk === "medium") return 2;
  return 3;
}

/** Pure selection over pre-mapped candidates. Testable without git. */
export function selectInlineComments(
  intents: IntentRecord[],
  candidates: InlineCommentCandidate[],
  unmapped: UnmappedChange[],
  maxInlineComments: number = DEFAULT_MAX_INLINE_COMMENTS,
): SelectionResult {
  const byChange = new Map<string, InlineCommentCandidate>();
  for (const candidate of candidates) {
    if (!byChange.has(candidate.logicalChangeId)) byChange.set(candidate.logicalChangeId, candidate);
  }
  const candidateChanges = new Set(byChange.keys());

  const eligible = intents.filter((intent) => {
    if (!candidateChanges.has(intent.id)) return false;
    if (intent.risk === "low" && !TOPIC_PATTERN.test(`${intent.entity} ${intent.reason} ${intent.expectedBehavior}`)) return false;
    if (isFormattingOnlyIntent(intent)) return false;
    if (intent.changeKind === "removed") return false;
    return true;
  });

  eligible.sort((a, b) => priority(a) - priority(b));

  const selected: SelectedComment[] = [];
  const skipped: Array<{ logicalChangeId: string; reason: string }> = [];
  for (const intent of eligible) {
    if (selected.length >= Math.max(0, maxInlineComments)) {
      skipped.push({ logicalChangeId: intent.id, reason: `inline-comment cap reached (${maxInlineComments})` });
      continue;
    }
    const candidate = byChange.get(intent.id)!;
    selected.push({
      id: `comment_${String(selected.length + 1).padStart(3, "0")}`,
      logicalChangeId: intent.id,
      path: candidate.path,
      line: candidate.line,
      side: "RIGHT",
      risk: intent.risk,
      intent,
    });
  }

  const selectedChanges = new Set(selected.map((comment) => comment.logicalChangeId));
  const fileLevel = intents.filter(
    (intent) => !candidateChanges.has(intent.id) && !selectedChanges.has(intent.id) && !isFormattingOnlyIntent(intent),
  );

  for (const unmappedEntry of unmapped) {
    if (!skipped.some((entry) => entry.logicalChangeId === unmappedEntry.logicalChangeId)) {
      skipped.push({ logicalChangeId: unmappedEntry.logicalChangeId, reason: unmappedEntry.reason });
    }
  }

  return { selected, fileLevel, skipped };
}
