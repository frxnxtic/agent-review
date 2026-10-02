import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startSession, endSession, loadSession, AgentReviewError } from "../src/session.ts";
import { readEvents } from "../src/events.ts";
import { listCheckpoints } from "../src/checkpoints.ts";

function initRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-review-session-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: root });
  return root;
}

test("session creation on a feature branch uses the current branch", async () => {
  const root = initRepo();
  execFileSync("git", ["checkout", "-q", "-b", "feature/x"], { cwd: root });
  const result = await startSession(root, { task: "add login" });
  assert.equal(result.session?.workingBranch, "feature/x");
  assert.equal(result.session?.status, "active");
  assert.ok(result.checkpoint?.id);

  const loaded = await loadSession(root);
  assert.equal(loaded?.id, result.session?.id);
  const events = await readEvents(root);
  assert.ok(events.some((event) => event.type === "session.started"));
  assert.ok(events.some((event) => event.type === "checkpoint.created"));
});

test("protected branch requires confirmation before session creation", async () => {
  const root = initRepo();
  const result = await startSession(root, { task: "add login" });
  assert.equal(result.session, null);
  assert.equal(result.confirmationRequired?.currentBranch, "main");
  assert.match(result.confirmationRequired!.proposedBranch, /^agent\/add-login/);
  assert.equal(await loadSession(root), null);
});

test("confirmed start creates the feature branch off the protected branch", async () => {
  const root = initRepo();
  const result = await startSession(root, { task: "add login", autoCreateBranch: true, confirm: true });
  assert.equal(result.session?.workingBranch, "agent/add-login");
  assert.equal(result.session?.initialBranch, "main");
  const branch = execFileSync("git", ["branch", "--show-current"], { cwd: root }).toString().trim();
  assert.equal(branch, "agent/add-login");
});

test("duplicate active session is refused", async () => {
  const root = initRepo();
  execFileSync("git", ["checkout", "-q", "-b", "feature/x"], { cwd: root });
  await startSession(root, { task: "one" });
  await assert.rejects(
    () => startSession(root, { task: "two" }),
    (error: unknown) => error instanceof AgentReviewError && error.code === "SESSION_ACTIVE",
  );
});

test("dirty working tree is recorded, never reset", async () => {
  const root = initRepo();
  execFileSync("git", ["checkout", "-q", "-b", "feature/x"], { cwd: root });
  await fs.writeFile(path.join(root, "dirty.txt"), "uncommitted\n");
  const result = await startSession(root, { task: "keep dirt" });
  assert.equal(result.session?.dirtyAtStart.length, 1);
  assert.match(result.warning ?? "", /uncommitted/);
  assert.equal(await fs.readFile(path.join(root, "dirty.txt"), "utf8"), "uncommitted\n");
  assert.ok(await fs.access(path.join(root, "dirty.txt")).then(() => true, () => false));
});

test("endSession finalizes and appends session.ended", async () => {
  const root = initRepo();
  execFileSync("git", ["checkout", "-q", "-b", "feature/x"], { cwd: root });
  await startSession(root, { task: "finish me" });
  const ended = await endSession(root);
  assert.equal(ended?.status, "ended");
  assert.ok(ended?.endedAt);
  const events = await readEvents(root);
  assert.ok(events.some((event) => event.type === "session.ended"));
  // After ending, a new session can start (no duplicate error).
  const again = await startSession(root, { task: "again" });
  assert.equal(again.session?.status, "active");
});

test("missing git repo raises GIT_UNAVAILABLE", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-review-nogit-"));
  await assert.rejects(
    () => startSession(root, { task: "nope" }),
    (error: unknown) => error instanceof AgentReviewError && error.code === "GIT_UNAVAILABLE",
  );
});

test("checkpoints from a session are listed and scoped", async () => {
  const root = initRepo();
  execFileSync("git", ["checkout", "-q", "-b", "feature/x"], { cwd: root });
  const result = await startSession(root, { task: "ckpt" });
  const checkpoints = await listCheckpoints(root);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]!.sessionId, result.session?.id);
  assert.equal(checkpoints[0]!.reason, "session start");
});
