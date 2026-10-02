import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from "../src/checkpoints.ts";
import { startSession } from "../src/session.ts";

function initRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-review-ckpt-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: root });
  execFileSync("git", ["checkout", "-q", "-b", "feature/x"], { cwd: root });
  return root;
}

test("checkpoint metadata captures HEAD, status and changed files", async () => {
  const root = initRepo();
  await fs.writeFile(path.join(root, "a.txt"), "hello\n");
  const session = await startSession(root, { task: "ckpt" });
  await fs.appendFile(path.join(root, "a.txt"), "more\n");
  await fs.mkdir(path.join(root, "nested"), { recursive: true });
  await fs.writeFile(path.join(root, "nested/b.txt"), "new\n");
  const checkpoint = await createCheckpoint(root, session.session!, "after edits");

  assert.equal(checkpoint.reason, "after edits");
  assert.equal(checkpoint.sessionId, session.session!.id);
  assert.ok(checkpoint.gitHead);
  assert.ok(checkpoint.gitStatus.length >= 1);
  assert.deepEqual([...checkpoint.changedFiles].sort(), ["a.txt", "nested/b.txt"]);
  assert.equal(checkpoint.restorable, true);
  assert.ok(checkpoint.snapshotPath);

  const stored = JSON.parse(
    await fs.readFile(path.join(root, ".agent-review", "checkpoints", `${checkpoint.id}.json`), "utf8"),
  );
  assert.equal(stored.id, checkpoint.id);
});

test("snapshot is restorable without destructive git ops", async () => {
  const root = initRepo();
  await fs.writeFile(path.join(root, "a.txt"), "original\n");
  const session = await startSession(root, { task: "rollback" });
  const checkpoint = await createCheckpoint(root, session.session!, "good state");

  // Corrupt the working tree afterwards.
  await fs.writeFile(path.join(root, "a.txt"), "corrupted\n");
  await fs.writeFile(path.join(root, "user-new-file.txt"), "user data\n");

  const before = await listCheckpoints(root);
  const result = await restoreCheckpoint(root, checkpoint.id);

  assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "original\n");
  // Unrelated user files are never touched.
  assert.equal(await fs.readFile(path.join(root, "user-new-file.txt"), "utf8"), "user data\n");
  // A safety checkpoint was added.
  const after = await listCheckpoints(root);
  assert.equal(after.length, before.length + 1);
  assert.match(after.at(-1)!.reason, /pre-rollback safety/);
  assert.ok(result.restored.includes("a.txt"));
});

test("unknown checkpoint id is rejected", async () => {
  const root = initRepo();
  await assert.rejects(() => restoreCheckpoint(root, "does-not-exist"));
});
