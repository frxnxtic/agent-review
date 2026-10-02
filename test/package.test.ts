import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startSession } from "../src/session.ts";
import { recordIntent } from "../src/intent.ts";
import { runTestCommand } from "../src/tests.ts";
import { buildChangePackage } from "../src/package-builder.ts";
import { renderReview } from "../src/review.ts";
import { readEventsOfType } from "../src/events.ts";

function initRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-review-pkg-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@e.c"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test Author"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: root });
  execFileSync("git", ["checkout", "-q", "-b", "feature/x"], { cwd: root });
  return root;
}

async function seededSession() {
  const root = initRepo();
  const session = await startSession(root, { task: "add refresh token rotation" });
  await fs.writeFile(path.join(root, "auth.ts"), "export function rotate() {}\n");
  await recordIntent(root, session.session!, {
    entity: "auth token rotation",
    files: ["auth.ts"],
    changeKind: "added",
    reason: "tokens never rotated, sessions lived forever",
    expectedBehavior: "refresh tokens rotate on every use",
    risk: "medium",
    alternatives: ["sliding sessions"],
    limitations: ["no revocation list yet"],
  });
  await runTestCommand(root, session.session!, process.execPath + " --version", "sanity");
  return { root, session: session.session! };
}

test("Change Package is valid, schemaVersioned and complete", async () => {
  const { root, session } = await seededSession();
  const result = await buildChangePackage(root, {});
  const pkg = result.changePackage;

  assert.equal(pkg.schemaVersion, "agent-review/v1");
  assert.equal(pkg.session.id, session.id);
  assert.equal(pkg.task, "add refresh token rotation");
  assert.equal(pkg.branch, "feature/x");
  assert.equal(pkg.changedFiles.length, 1);
  assert.equal(pkg.changedFiles[0]!.path, "auth.ts");
  assert.equal(pkg.logicalChanges.length, 1);
  assert.equal(pkg.logicalChanges[0]!.risk, "medium");
  assert.equal(pkg.tests.length, 1);
  assert.equal(pkg.tests[0]!.status, "passed");
  assert.ok(pkg.risks.length === 0); // passed tests, no dirt, medium risk, small diff
  assert.ok(pkg.agentMetadata.checkpoints >= 1);
  assert.ok(pkg.agentMetadata.events >= 5);

  const onDisk = JSON.parse(await fs.readFile(path.join(root, ".agent-review", "change-package.json"), "utf8"));
  assert.equal(onDisk.schemaVersion, "agent-review/v1");
});

test("build finalizes the session and emits events", async () => {
  const { root, session } = await seededSession();
  await buildChangePackage(root, {});
  const created = await readEventsOfType(root, "change-package.created", session.id);
  const generated = await readEventsOfType(root, "review.generated", session.id);
  const ended = await readEventsOfType(root, "session.ended", session.id);
  assert.equal(created.length, 1);
  assert.equal(generated.length, 1);
  assert.equal(ended.length, 1);
});

test("review.md contains the required sections in order", async () => {
  const { root } = await seededSession();
  const result = await buildChangePackage(root, {});
  const markdown = result.review;

  for (const heading of [
    "# Agent Review",
    "## Task",
    "## Session",
    "## Summary",
    "## Logical Changes",
    "## Test Evidence",
    "## Risks",
    "## Limitations",
    "## Changed Files",
    "## Agent Activity",
  ]) {
    assert.ok(markdown.includes(heading), `missing heading: ${heading}`);
  }
  assert.ok(markdown.includes("add refresh token rotation"));
  assert.ok(markdown.includes("tokens never rotated"));
  assert.ok(markdown.includes("rotate on every use"));
  assert.ok(markdown.includes("**passed**"));
  assert.ok(markdown.includes("`auth.ts`"));
  // No raw reasoning markers, no huge dumps.
  assert.ok(!markdown.includes("chain-of-thought"));
});

test("failed tests become explicit risks", async () => {
  const root = initRepo();
  const session = await startSession(root, { task: "risky" });
  await runTestCommand(root, session.session!, process.execPath + " -e process.exit(1)", "failing");
  const result = await buildChangePackage(root, {});
  assert.ok(result.changePackage.risks.some((risk) => risk.includes("did not pass")));
});

test("dirty start is reported as a risk in the package", async () => {
  const root = initRepo();
  await fs.writeFile(path.join(root, "pre-existing.txt"), "dirt\n");
  const session = await startSession(root, { task: "dirty" });
  await buildChangePackage(root, {});
  void session;
  const pkg = JSON.parse(await fs.readFile(path.join(root, ".agent-review", "change-package.json"), "utf8"));
  assert.ok(pkg.risks.some((risk: string) => risk.includes("dirty at session start")));
});

test("renderReview is stable and self-contained", () => {
  const markdown = renderReview(
    {
      schemaVersion: "agent-review/v1",
      session: { id: "s1", startedAt: "2026-01-01T00:00:00Z", endedAt: null, status: "active" },
      task: "demo",
      branch: "agent/demo",
      commits: [{ hash: "abc123def0", subject: "feat: demo", author: "A", date: "2026-01-01" }],
      changedFiles: [],
      logicalChanges: [],
      tests: [],
      risks: [],
      limitations: ["L"],
      agentMetadata: { toolCalls: 0, commands: 0, checkpoints: 0, tests: 0, events: 3 },
      generatedAt: "2026-01-01T00:00:00Z",
    },
    undefined,
  );
  assert.ok(markdown.includes("agent/demo"));
  assert.ok(markdown.includes("abc123def0".slice(0, 10)));
  assert.ok(markdown.includes("_No test runs were recorded._"));
});
