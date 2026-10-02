import type { ChangePackage, IntentRecord, TestEvidence } from "./types.ts";

const RISK_ORDER: IntentRecord["risk"][] = ["high", "medium", "low"];

function formatTests(tests: TestEvidence[]): string[] {
  if (tests.length === 0) return ["_No test runs were recorded._"];
  return tests.map((test, index) => {
    const lines = [
      `### Run ${index + 1}`,
      `- Command: \`${test.command}\``,
      `- Result: **${test.status}** (exit code: ${test.exitCode ?? "signal"})`,
      `- Duration: ${test.durationMs} ms`,
      `- Working directory: \`${test.workingDirectory}\``,
    ];
    if (test.stderrSummary.trim()) {
      lines.push(`- Notes: stderr captured (${test.stderrSummary.trim().split("\n").length} lines, redacted and truncated)`);
    }
    return lines.join("\n");
  });
}

function formatIntents(intents: IntentRecord[]): string[] {
  if (intents.length === 0) return ["_No intents were recorded. See Changed Files and the diff for the raw picture._"];
  const sorted = [...intents].sort((a, b) => RISK_ORDER.indexOf(a.risk) - RISK_ORDER.indexOf(b.risk));
  return sorted.map((intent, index) => {
    const lines = [
      `### ${index + 1}. ${intent.entity}`,
      `- What changed: ${intent.changeKind} in ${intent.files.map((file) => `\`${file}\``).join(", ")}`,
      `- Why: ${intent.reason}`,
      `- Expected behavior: ${intent.expectedBehavior}`,
      `- Risk: ${intent.risk}`,
    ];
    if (intent.relatedTask) lines.push(`- Related task: ${intent.relatedTask}`);
    if (intent.alternatives.length > 0) lines.push(`- Alternatives considered: ${intent.alternatives.join("; ")}`);
    if (intent.limitations.length > 0) lines.push(`- Limitations: ${intent.limitations.join("; ")}`);
    return lines.join("\n");
  });
}

/** Human-readable review summary. No raw long logs — everything capped/redacted upstream. */
export function renderReview(
  changePackage: ChangePackage,
  diff: string | undefined,
): string {
  const { session, agentMetadata } = changePackage;
  const files = changePackage.changedFiles
    .map((file) => `- \`${file.path}\` — ${file.kind} (${file.language}, +${file.insertions}/−${file.deletions})`)
    .join("\n");

  const summaryText =
    changePackage.logicalChanges.length > 0
      ? changePackage.logicalChanges.map((intent) => `${intent.entity}: ${intent.reason}`).join(" ")
      : "Changes were made without recorded intents; see Logical Changes / diff.";

  const sections: string[] = [
    "# Agent Review",
    "",
    "## Task",
    changePackage.task,
    "",
    "## Session",
    `- Session ID: ${session.id}`,
    `- Branch: ${changePackage.branch}`,
    `- Started: ${session.startedAt}`,
    `- Finished: ${session.endedAt ?? "_still active_"}`,
    "",
    "## Summary",
    summaryText,
    "",
    "## Logical Changes",
    "",
    ...formatIntents(changePackage.logicalChanges),
    "",
    "## Test Evidence",
    "",
    ...formatTests(changePackage.tests),
    "",
    "## Risks",
    changePackage.risks.length > 0 ? changePackage.risks.map((risk) => `- ${risk}`).join("\n") : "- None detected.",
    "",
    "## Limitations",
    changePackage.limitations.map((limitation) => `- ${limitation}`).join("\n"),
    "",
    "## Changed Files",
    files || "_No changes detected._",
    "",
  ];

  if (changePackage.commits.length > 0) {
    sections.push(
      "## Commits",
      ...changePackage.commits.map((commit) => `- \`${commit.hash.slice(0, 10)}\` ${commit.subject} (${commit.author}, ${commit.date})`),
      "",
    );
  }

  if (diff && diff.trim().length > 0) {
    sections.push("## Diff", "```diff", diff, "```", "");
  }

  sections.push(
    "## Agent Activity",
    `- Tool calls: ${agentMetadata.toolCalls}`,
    `- Commands: ${agentMetadata.commands}`,
    `- Checkpoints: ${agentMetadata.checkpoints}`,
    `- Test runs: ${agentMetadata.tests}`,
    `- Journal events: ${agentMetadata.events}`,
    "",
    `_Generated: ${changePackage.generatedAt} · schema ${changePackage.schemaVersion}_`,
    "",
  );

  return sections.join("\n");
}
