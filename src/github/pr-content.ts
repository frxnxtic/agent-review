/**
 * PR title/body/comment-body/review-payload generation.
 * Compact, no big diffs, no raw tool logs, no secrets, no chain-of-thought.
 */
import type { ChangePackage, IntentRecord, TestEvidence } from "../types.ts";
import { redactString } from "../redact.ts";
import { createMarker } from "./marker.ts";
import type { SelectedComment } from "./selection.ts";

const RISK_ORDER = ["high", "medium", "low"] as const;

/** Derives a PR title from the session task (or the top logical change). */
export function generatePrTitle(pkg: Pick<ChangePackage, "task" | "logicalChanges">): string {
  const task = pkg.task.trim();
  if (task) return task.length > 120 ? `${task.slice(0, 117)}…` : task;
  const first = pkg.logicalChanges[0];
  return first ? first.entity : "Agent Review changes";
}

function riskCounts(pkg: ChangePackage): string {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const change of pkg.logicalChanges) counts[change.risk]++;
  const parts: string[] = [];
  if (counts.high) parts.push(`${counts.high} high`);
  if (counts.medium) parts.push(`${counts.medium} medium`);
  if (counts.low) parts.push(`${counts.low} low`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

function evidenceLine(test: TestEvidence): string | null {
  if (test.status === "passed") return `- \`${test.command}\`: passed`;
  if (test.status === "failed") return `- \`${test.command}\`: FAILED (exit ${test.exitCode ?? "signal"})`;
  return null;
}

/** Compact PR body per the spec template. */
export function generatePrBody(
  pkg: ChangePackage,
  selected: SelectedComment[],
  fileLevel: IntentRecord[],
): string {
  const lines: string[] = [
    "# Agent Review",
    "",
    "## Summary",
    `- ${pkg.logicalChanges.length} logical changes / ${pkg.changedFiles.length} files changed`,
    `- Tests: ${pkg.tests.filter((test) => test.status === "passed").length} passed` +
      (pkg.tests.some((test) => test.status !== "passed") ? ` (${pkg.tests.filter((test) => test.status !== "passed").length} failed/error)` : ""),
    `- Risks: ${riskCounts(pkg)}`,
    "",
    "## What changed",
  ];
  if (pkg.logicalChanges.length === 0) {
    lines.push("_No logical changes were recorded — see the diff._");
  } else {
    pkg.logicalChanges.forEach((change, index) => {
      lines.push(`${index + 1}. **${change.entity}** — ${redactString(change.reason)}`);
    });
  }
  if (fileLevel.length > 0) {
    lines.push("", "### File-level notes");
    for (const change of fileLevel) {
      lines.push(`- **${change.entity}** (${change.files.map((file) => `\`${file}\``).join(", ")}): ${redactString(change.reason)}`);
    }
  }
  lines.push("", "## Evidence");
  const evidence = pkg.tests.map(evidenceLine).filter((line): line is string => line !== null);
  lines.push(...(evidence.length > 0 ? evidence : ["_No test runs recorded._"]));
  lines.push("", "## Risks and limitations");
  const risks = pkg.risks.slice(0, 10).map((risk) => `- ${redactString(risk)}`);
  const limitations = pkg.limitations.slice(0, 10).map((limitation) => `- Limitation: ${redactString(limitation)}`);
  lines.push(...(risks.length + limitations.length > 0 ? [...risks, ...limitations] : ["- None recorded."]));
  lines.push(
    "",
    "## Review guidance",
    selected.length > 0
      ? `Start with the inline comments marked \`Agent context\` (${selected.length} comment${selected.length === 1 ? "" : "s"} on the current diff).`
      : "No inline comments were attached; this summary is the complete review context.",
    "",
    "_This summary and the inline comments are review CONTEXT, not guarantees of correctness._",
    "",
  );
  return lines.join("\n");
}

/** The visible + hidden-marker body of one inline comment. */
export function generateInlineCommentBody(
  comment: SelectedComment,
  sessionId: string,
  evidenceCommand?: string | undefined,
): string {
  const intent = comment.intent;
  const evidence = intent.evidence ?? evidenceCommand;
  const riskWord = intent.risk === "high" ? "High" : intent.risk === "medium" ? "Medium" : "Low";
  const lines = [
    "### Agent context",
    "",
    `**What changed:** ${intent.changeKind} — ${intent.entity}`,
    "",
    `**Why:** ${redactString(intent.reason)}`,
    "",
    `**Expected behavior:** ${redactString(intent.expectedBehavior)}`,
    "",
    `**Evidence:** ${evidence ? `\`${redactString(evidence)}\` executed${intent.evidence ? "" : " (recorded test run)"}.` : "no test run was recorded for this change."}`,
    "",
    `**Risk:** ${riskWord}${intent.limitations.length > 0 ? ` — ${redactString(intent.limitations.join("; "))}` : ""}`,
    "",
    createMarker({ sessionId, logicalChangeId: comment.logicalChangeId, version: 1 }),
  ];
  return lines.join("\n");
}

export interface ReviewPayloadComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

export interface GroupedReviewPayload {
  commit_id: string;
  event: "COMMENT";
  body: string;
  comments: ReviewPayloadComment[];
}

/** ONE grouped review payload for the whole branch review. */
export function buildGroupedReviewPayload(
  headSha: string,
  comments: Array<{ path: string; line: number; side: "RIGHT"; body: string }>,
): GroupedReviewPayload {
  return {
    commit_id: headSha,
    event: "COMMENT",
    body: "## Agent Review Context\n\nInline notes generated by Agent Review. Each comment carries a hidden marker identifying the session and logical change; reviews are replaced on update and human comments are never touched. These notes are context, not guarantees.",
    comments: comments.map((comment) => ({ path: comment.path, line: comment.line, side: "RIGHT", body: comment.body })),
  };
}

export function maxRiskLabel(selected: SelectedComment[]): string {
  for (const level of RISK_ORDER) {
    if (selected.some((comment) => comment.risk === level)) return level;
  }
  return "none";
}
