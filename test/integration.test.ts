/**
 * Integration test: full vertical slice on a temporary git repository.
 * Creates repo → initial commit → feature branch → file change → checkpoint →
 * intent → harmless test command → Change Package → asserts review.md + JSON.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startSession } from "../src/session.ts";
import { createCheckpoint, restoreCheckpoint } from "../src/checkpoints.ts";
import { recordIntent } from "../src/intent.ts";
import { runTestCommand } from "../src/tests.ts";
import { buildChangePackage } from "../src/package-builder.ts";
import { readEvents } from "../src/events.ts";
import { isGitRepo } from "../src/git.ts";
import type { ObservedEventType } from "../src/types.ts";

test("integration: full agent review arc on a temporary repository", async () => {
  // 1. Temporary repository with an initial commit (on protected main).
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-review-integration-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "agent@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Agent"], { cwd: root });
  await fs.writeFile(path.join(root, "README.md"), "# demo\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: root });
  assert.ok(await isGitRepo(root));

  // 2. Start on protected branch → confirmation required.
  const blocked = await startSession(root, { task: "Add refresh token rotation" });
  assert.equal(blocked.confirmationRequired?.proposedBranch, "agent/add-refresh-token-rotation");

  // 3. Confirmed start creates the feature branch.
  const started = await startSession(root, { task: "Add refresh token rotation", autoCreateBranch: true, confirm: true });
  const session = started.session!;
  assert.equal(session.workingBranch, "agent/add-refresh-token-rotation");
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: root }).toString().trim(), "agent/add-refresh-token-rotation");

  // 4. Change a file.
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "token.ts"), "export function rotate(): boolean {\n  return true;\n}\n", "utf8");

  // 5. Checkpoint.
  const checkpoint = await createCheckpoint(root, session, "token rotation implemented");
  assert.equal(checkpoint.restorable, true);
  assert.ok(checkpoint.changedFiles.includes(path.join("src", "token.ts")));

  // 6. Intent.
  const intent = await recordIntent(root, session, {
    entity: "refresh token rotation",
    files: [path.join("src", "token.ts")],
    changeKind: "added",
    reason: "refresh tokens were static; rotation limits replay windows",
    expectedBehavior: "every refresh rotates the token and invalidates the previous one",
    risk: "medium",
    alternatives: ["long-lived tokens with device binding"],
    limitations: ["revocation list deferred"],
  });
  assert.ok(intent.id);

  // 7. Harmless test command.
  const evidence = await runTestCommand(root, session, process.execPath + " --version", "runtime sanity check");
  assert.equal(evidence.status, "passed");

  // 8. Build the Change Package (also writes review.md and finalizes).
  const built = await buildChangePackage(root, { includeDiff: true });

  // 9. Assertions on artifacts.
  const pkg = JSON.parse(await fs.readFile(path.join(root, ".agent-review", "change-package.json"), "utf8"));
  assert.equal(pkg.schemaVersion, "agent-review/v1");
  assert.equal(pkg.branch, "agent/add-refresh-token-rotation");
  assert.equal(pkg.logicalChanges.length, 1);
  assert.equal(pkg.tests.length, 1);
  assert.equal(pkg.tests[0].status, "passed");
  assert.ok(pkg.agentMetadata.toolCalls >= 0);
  assert.ok(pkg.agentMetadata.checkpoints >= 2); // session start + explicit

  const review = await fs.readFile(path.join(root, ".agent-review", "review.md"), "utf8");
  assert.ok(review.startsWith("# Agent Review"));
  assert.ok(review.includes("Add refresh token rotation"));
  assert.ok(review.includes("refresh tokens were static"));
  assert.ok(review.includes("**passed**"));
  assert.ok(review.includes("`src/token.ts`"));

  // Journal contains the full event vocabulary used by the arc.
  const types = new Set((await readEvents(root)).map((event) => event.type));
  const expectedTypes: ObservedEventType[] = ["session.started", "branch.created", "checkpoint.created", "intent.recorded", "test.completed", "change-package.created", "review.generated", "session.ended"];
  for (const expected of expectedTypes) {
    assert.ok(types.has(expected), `missing event type: ${expected}`);
  }

  // 10. Rollback path: restores the checkpointed file, never destructive.
  await fs.writeFile(path.join(root, "src", "token.ts"), "corrupted\n");
  const restored = await restoreCheckpoint(root, checkpoint.id);
  assert.ok(restored.restored.includes(path.join("src", "token.ts")));
  assert.equal(await fs.readFile(path.join(root, "src", "token.ts"), "utf8"), "export function rotate(): boolean {\n  return true;\n}\n");
});
