import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitChangeAnalyzer, detectLanguage } from "../src/analyzer.ts";

function initRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-review-analyzer-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@e.c"], { cwd: root });
  execFileSync("git", ["config", "user.name", "T"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: root });
  execFileSync("git", ["checkout", "-q", "-b", "feature/x"], { cwd: root });
  return root;
}

test("language detection by extension", () => {
  assert.equal(detectLanguage("src/index.ts"), "typescript");
  assert.equal(detectLanguage("app/models/user.rb"), "ruby");
  assert.equal(detectLanguage("main.rs"), "rust");
  assert.equal(detectLanguage("data.unknown"), "unknown");
});

test("analyzer classifies added/modified/removed files with stats and symbols", async () => {
  const root = initRepo();
  // Committed file that will be modified.
  await fs.writeFile(path.join(root, "existing.ts"), "function keep() {}\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: root });

  await fs.writeFile(path.join(root, "added.ts"), "export class alpha {}\nfunction beta() {}\n");
  await fs.writeFile(path.join(root, "existing.ts"), "function keep() {}\nfunction gamma() {}\n");
  await fs.writeFile(path.join(root, "removed.rb"), "def old; end\n");
  execFileSync("git", ["add", "removed.rb"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "stage removal"], { cwd: root });
  execFileSync("git", ["rm", "-q", "removed.rb"], { cwd: root });

  const changes = await new GitChangeAnalyzer().analyze(root);
  const byPath = new Map(changes.map((change) => [change.path, change]));

  const added = byPath.get("added.ts")!;
  assert.equal(added.kind, "added");
  assert.equal(added.language, "typescript");
  assert.ok(added.insertions >= 2);
  assert.deepEqual([...added.symbols!].sort(), ["alpha", "beta"]);

  const modified = byPath.get("existing.ts")!;
  assert.equal(modified.kind, "modified");
  assert.ok(modified.insertions >= 1);
  assert.ok(modified.symbols!.includes("gamma"));

  const removed = byPath.get("removed.rb")!;
  assert.equal(removed.kind, "removed");
  assert.equal(removed.deletions, 1);
});
