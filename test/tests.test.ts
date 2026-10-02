import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseTestCommand, evidenceStatus, runTestCommand, detectTestCommands } from "../src/tests.ts";
import { startSession } from "../src/session.ts";
import { readEventsOfType } from "../src/events.ts";

test("parseTestCommand splits without a shell", () => {
  const parsed = parseTestCommand("npm test --silent");
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.ok ? parsed.parsed : null, { file: "npm", args: ["test", "--silent"] });
});

test("parseTestCommand rejects shell metacharacters", () => {
  for (const command of ["npm test && rm -rf /", "echo hi | tee file", "cat file > /dev/null", "echo $(whoami)", "echo `id`"]) {
    const parsed = parseTestCommand(command);
    assert.ok(!parsed.ok, `should reject: ${command}`);
  }
});

test("parseTestCommand rejects destructive programs", () => {
  for (const command of ["rm -rf /", "git push origin main", "git reset --hard", "sudo rm x", "curl http://evil.example"]) {
    assert.ok(!parseTestCommand(command).ok, `should reject: ${command}`);
  }
});

test("evidenceStatus maps exit codes", () => {
  assert.equal(evidenceStatus(0), "passed");
  assert.equal(evidenceStatus(1), "failed");
  assert.equal(evidenceStatus(null), "error");
});

test("runTestCommand records full evidence and events", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-review-tests-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@e.c"], { cwd: root });
  execFileSync("git", ["config", "user.name", "T"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: root });
  execFileSync("git", ["checkout", "-q", "-b", "feature/x"], { cwd: root });
  const session = await startSession(root, { task: "tests" });

  const evidence = await runTestCommand(root, session.session!, process.execPath + " --version", "sanity");
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.exitCode, 0);
  assert.ok(evidence.durationMs >= 0);
  assert.ok(evidence.stdoutSummary.includes("v"));
  assert.equal(evidence.workingDirectory, root);

  const completed = await readEventsOfType(root, "test.completed", session.session!.id);
  assert.equal(completed.length, 1);
  assert.equal((completed[0]!.payload as { status: string }).status, "passed");

  const started = await readEventsOfType(root, "test.started", session.session!.id);
  assert.equal(started.length, 1);
});

test("runTestCommand captures failing exit codes", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-review-tests2-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@e.c"], { cwd: root });
  execFileSync("git", ["config", "user.name", "T"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: root });
  execFileSync("git", ["checkout", "-q", "-b", "feature/x"], { cwd: root });
  const session = await startSession(root, { task: "failing" });
  const evidence = await runTestCommand(root, session.session!, process.execPath + " -e process.exit(3)", "expected failure");
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.exitCode, 3);
});

test("detectTestCommands proposes but never runs", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-review-detect-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
  );
  await fs.writeFile(path.join(root, "Gemfile"), 'gem "rspec"\n');
  const proposals = await detectTestCommands(root);
  const commands = proposals.map((proposal) => proposal.command);
  assert.ok(commands.includes("npm run test"));
  assert.ok(commands.some((command) => command.includes("rspec")));
});
