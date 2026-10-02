/**
 * Unit tests for the GitHub Pull Request Review Adapter (MVP stage 3).
 * All offline: no network, no real gh.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGitHubRemote } from "../src/github/remote.ts";
import { isGeneratedFile, isLockfile, isFormattingOnlyIntent } from "../src/github/filters.ts";
import { createMarker, parseMarker } from "../src/github/marker.ts";
import { addedLinesInDiff, firstAddedLine } from "../src/github/diff-mapper.ts";
import { selectInlineComments, DEFAULT_MAX_INLINE_COMMENTS } from "../src/github/selection.ts";
import { generatePrTitle, generatePrBody, generateInlineCommentBody, buildGroupedReviewPayload } from "../src/github/pr-content.ts";
import { GhCliGitHubAdapter, GH_AUTH_MESSAGE } from "../src/github/adapter.ts";
import { loadOrCreateConfig } from "../src/config.ts";
import type { ChangePackage, IntentRecord } from "../src/types.ts";

function intent(overrides: Partial<IntentRecord> = {}): IntentRecord {
  return {
    id: overrides.id ?? "change_001",
    sessionId: "session_001",
    recordedAt: new Date().toISOString(),
    entity: "auth hardening",
    files: ["src/auth.ts"],
    changeKind: "modified",
    reason: "tokens were static",
    expectedBehavior: "tokens rotate",
    risk: "medium",
    alternatives: [],
    limitations: [],
    ...overrides,
  };
}

test("parseGitHubRemote: SSH form", () => {
  const parsed = parseGitHubRemote("git@github.com:owner/repo.git");
  assert.deepEqual(parsed, { owner: "owner", repo: "repo", slug: "owner/repo" });
});

test("parseGitHubRemote: HTTPS form", () => {
  const parsed = parseGitHubRemote("https://github.com/owner/repo.git");
  assert.deepEqual(parsed, { owner: "owner", repo: "repo", slug: "owner/repo" });
});

test("parseGitHubRemote: ssh:// form and no .git suffix", () => {
  assert.equal(parseGitHubRemote("ssh://git@github.com/o/r")?.slug, "o/r");
  assert.equal(parseGitHubRemote("https://github.com/o/r")?.slug, "o/r");
});

test("parseGitHubRemote: non-GitHub and garbage return null", () => {
  assert.equal(parseGitHubRemote("git@gitlab.com:o/r.git"), null);
  assert.equal(parseGitHubRemote("not a url"), null);
  assert.equal(parseGitHubRemote(""), null);
});

test("generated-file and lockfile filters", () => {
  for (const file of ["dist/bundle.js", "app.min.js", "coverage/lcov.info", "snapshots/test.snap", "assets/x.map"]) {
    assert.ok(isGeneratedFile(file), file);
  }
  for (const file of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Gemfile.lock", "Cargo.lock"]) {
    assert.ok(isLockfile(file), file);
  }
  assert.ok(!isGeneratedFile("src/auth.ts"));
  assert.ok(!isLockfile("src/auth.ts"));
});

test("formatting-only detection", () => {
  assert.ok(isFormattingOnlyIntent({ entity: "rename var", reason: "rename and reformat only", changeKind: "refactored" }));
  assert.ok(!isFormattingOnlyIntent({ entity: "auth", reason: "rotate refresh tokens on use", changeKind: "modified" }));
});

test("marker: create and parse roundtrip; human comments have no marker", () => {
  const marker = createMarker({ sessionId: "s1", logicalChangeId: "c1", version: 1 });
  assert.deepEqual(parseMarker(`text\n${marker}\nend`), { sessionId: "s1", logicalChangeId: "c1", version: 1 });
  assert.equal(parseMarker("a human comment"), null);
});

test("diff hunk parsing computes head-side line numbers", () => {
  const diff = [
    "diff --git a/src/auth.ts b/src/auth.ts",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1,3 +1,4 @@",
    " context",
    "+added at line 2",
    " context2",
    "-deleted",
    "+added at line 4",
  ].join("\n");
  const parsed = addedLinesInDiff(diff);
  assert.equal(parsed.path, "src/auth.ts");
  assert.deepEqual(parsed.lines, [2, 4]);
  assert.equal(firstAddedLine(diff), 2);
});

function fakeCandidate(id: string, file: string, line: number) {
  return { logicalChangeId: id, path: file, line, side: "RIGHT" as const };
}

test("selection: high risk first, cap, dedupe per logical change, skip low/noise", () => {
  const intents = [
    intent({ id: "low", entity: "docs banner", risk: "medium", reason: "tweak wording of the banner" }),
    intent({ id: "high", risk: "high", reason: "publishes secrets if env missing" }),
    intent({ id: "medium", risk: "medium", reason: "adds migration for audit table" }),
    intent({ id: "format", risk: "medium", reason: "reformat only, prettier pass" }),
  ];
  const candidates = [fakeCandidate("low", "a.ts", 1), fakeCandidate("high", "b.ts", 5), fakeCandidate("high", "b2.ts", 9), fakeCandidate("medium", "c.ts", 3), fakeCandidate("format", "d.ts", 2)];
  const result = selectInlineComments(intents, candidates, [], 2);
  assert.equal(result.selected.length, 2);
  assert.equal(result.selected[0]!.logicalChangeId, "high");
  assert.equal(result.selected[1]!.logicalChangeId, "medium");
  assert.equal(result.selected[0]!.id, "comment_001");
  assert.ok(result.skipped.some((skip) => skip.logicalChangeId === "low" && skip.reason.includes("cap")));
});

test("selection: default cap is 8", () => {
  assert.equal(DEFAULT_MAX_INLINE_COMMENTS, 8);
});

test("selection: unmapped changes become file-level fallbacks and skipped reasons", () => {
  const intents = [intent({ id: "c1", risk: "high" }), intent({ id: "c2", risk: "medium" })];
  const result = selectInlineComments(intents, [fakeCandidate("c2", "b.ts", 4)], [
    { logicalChangeId: "c1", entity: "auth", path: "a.ts", reason: "no added line for this file in the PR diff" },
  ]);
  assert.equal(result.selected.length, 1);
  assert.ok(result.fileLevel.some((change) => change.id === "c1"));
  assert.ok(result.skipped.some((skip) => skip.logicalChangeId === "c1"));
});

test("PR title generation", () => {
  const pkg = { task: "Add refresh token rotation", logicalChanges: [] } as unknown as ChangePackage;
  assert.equal(generatePrTitle(pkg), "Add refresh token rotation");
  const fallback = { task: "", logicalChanges: [{ entity: "auth hardening" }] } as unknown as ChangePackage;
  assert.equal(generatePrTitle(fallback), "auth hardening");
});

function fakePackage(): ChangePackage {
  return {
    schemaVersion: "agent-review/v1",
    session: { id: "s1", startedAt: "now", endedAt: null, status: "active" },
    task: "Rotate refresh tokens",
    branch: "agent/rotate",
    commits: [],
    changedFiles: [],
    logicalChanges: [intent()],
    tests: [{ command: "npm test", startedAt: "a", finishedAt: "b", durationMs: 5, exitCode: 0, status: "passed", stdoutSummary: "", stderrSummary: "", workingDirectory: "." }],
    risks: ["1 intent(s) marked high risk: auth hardening."],
    limitations: ["revocation list deferred"],
    agentMetadata: { toolCalls: 0, commands: 0, checkpoints: 0, tests: 1, events: 0 },
    generatedAt: "now",
  };
}

test("PR body: compact template with summary, evidence, risks, guidance; no secrets", () => {
  const pkg = fakePackage();
  const body = generatePrBody(pkg, [], [intent({ id: "c9" })]);
  assert.ok(body.startsWith("# Agent Review"));
  assert.ok(body.includes("## Summary"));
  assert.ok(body.includes("1 logical changes / 0 files changed"));
  assert.ok(body.includes("Tests: 1 passed"));
  assert.ok(body.includes("`npm test`: passed"));
  assert.ok(body.includes("- High:") || body.includes("1 intent(s) marked high risk"));
  assert.ok(body.includes("- Limitation: revocation list deferred"));
  assert.ok(body.includes("## Review guidance"));
  assert.ok(!body.includes("```diff"));
  assert.ok(!body.includes("GH_TOKEN"));
});

test("inline comment body carries what/why/evidence/risk + hidden marker", () => {
  const intents = [intent({ id: "c1", risk: "high" })];
  const candidates = [fakeCandidate("c1", "src/auth.ts", 42)];
  const { selected } = selectInlineComments(intents, candidates, []);
  const body = generateInlineCommentBody(selected[0]!, "session_001", "npm test");
  assert.ok(body.includes("### Agent context"));
  assert.ok(body.includes("**What changed:**"));
  assert.ok(body.includes("**Why:**"));
  assert.ok(body.includes("**Evidence:** `npm test`"));
  assert.ok(body.includes("**Risk:** High"));
  assert.ok(body.includes("<!-- agent-review:session=session_001;change=c1;version=1 -->"));
});

test("grouped review payload: one payload, line + side RIGHT, commit_id present", () => {
  const payload = buildGroupedReviewPayload("abc123", [
    { path: "src/auth.ts", line: 42, side: "RIGHT", body: "### Agent context\n\n..." },
    { path: "src/db.ts", line: 7, side: "RIGHT", body: "### Agent context\n\n..." },
  ]);
  assert.equal(payload.event, "COMMENT");
  assert.equal(payload.commit_id, "abc123");
  assert.equal(payload.comments.length, 2);
  for (const comment of payload.comments) {
    assert.equal(comment.side, "RIGHT");
    assert.equal(typeof comment.line, "number");
    assert.ok(!("position" in comment));
  }
});

test("safe behavior when gh is unavailable: status degrades, never throws", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-review-gh-missing-"));
  const config = await loadOrCreateConfig(root);
  const adapter = new GhCliGitHubAdapter(root, config, "definitely-not-gh-xyz");
  const status = await adapter.status();
  assert.equal(status.available, false);
  assert.equal(status.authenticated, false);
  assert.ok(status.problems.some((problem) => problem.includes(GH_AUTH_MESSAGE)));
  assert.equal(status.repository, null);
});

test("safe behavior when no GitHub remote: problem entry, no throw", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-review-gh-noremote-"));
  const config = await loadOrCreateConfig(root);
  const adapter = new GhCliGitHubAdapter(root, config, "definitely-not-gh-xyz");
  const status = await adapter.status();
  assert.ok(status.problems.some((problem) => problem.includes("origin")));
});

test("confirmed:false performs no external action (no gh spawn)", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-review-gh-nospawn-"));
  const log = path.join(root, "gh-calls.log");
  const fakeGh = path.join(root, "fake-gh.sh");
  await fs.writeFile(fakeGh, `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`, { mode: 0o755 });
  const config = await loadOrCreateConfig(root);
  config.github.enabled = true;
  const adapter = new GhCliGitHubAdapter(root, config, fakeGh);
  const result = await adapter.publishPullRequest({ confirmed: false });
  assert.equal(result.status, "confirmation-required");
  await assert.rejects(fs.access(log));
});

test("config merges forward: nested github keys fill from defaults", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-review-gh-config-"));
  await fs.mkdir(path.join(root, ".agent-review"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".agent-review", "config.json"),
    JSON.stringify({ schemaVersion: "agent-review-config/v1", git: { protectedBranches: ["trunk"] }, github: { enabled: true, maxInlineComments: 3 } }),
    "utf8",
  );
  const config = await loadOrCreateConfig(root);
  assert.equal(config.github.enabled, true);
  assert.equal(config.github.maxInlineComments, 3);
  assert.equal(config.github.defaultBaseBranch, "main");
  assert.equal(config.github.updateMode, "replace-agent-comments");
  assert.equal(config.redactionEnabled, true);
});

test("redaction: a fake GH_TOKEN never reaches rendered artifacts", () => {
  const secret = "ghp_16charactersXXXXXXXXXXX";
  const pkg = fakePackage();
  pkg.risks.push(`token leaked: ${secret}`);
  const body = generatePrBody(pkg, [], []);
  assert.ok(!body.includes(secret));
  const intents = [intent({ id: "c1", risk: "high", reason: `uses token=${secret}` })];
  const { selected } = selectInlineComments(intents, [fakeCandidate("c1", "a.ts", 1)], []);
  const commentBody = generateInlineCommentBody(selected[0]!, "s", undefined);
  assert.ok(!commentBody.includes(secret));
});
