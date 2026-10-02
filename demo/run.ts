/**
 * Demo run: the same vertical slice as the integration test, but keeps the
 * artifacts on disk for inspection and prints where they live.
 * Run with: npm run demo
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startSession } from "../src/session.ts";
import { createCheckpoint } from "../src/checkpoints.ts";
import { recordIntent } from "../src/intent.ts";
import { runTestCommand } from "../src/tests.ts";
import { buildChangePackage } from "../src/package-builder.ts";

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-review-demo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "agent@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Agent"], { cwd: root });
  await fs.writeFile(path.join(root, "README.md"), "# demo project\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: root });

  const blocked = await startSession(root, { task: "Add refresh token rotation" });
  console.log("protected branch handling:", blocked.confirmationRequired);

  const started = await startSession(root, { task: "Add refresh token rotation", autoCreateBranch: true, confirm: true });
  const session = started.session!;
  console.log("session:", session.id, "branch:", session.workingBranch);

  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "token.ts"), "export function rotate(): boolean {\n  return true;\n}\n");
  await createCheckpoint(root, session, "token rotation implemented");
  await recordIntent(root, session, {
    entity: "refresh token rotation",
    files: ["src/token.ts"],
    changeKind: "added",
    reason: "refresh tokens were static; rotation limits replay windows",
    expectedBehavior: "every refresh rotates the token",
    risk: "medium",
  });
  await runTestCommand(root, session, process.execPath + " --version", "sanity");

  const built = await buildChangePackage(root, { includeDiff: true });
  console.log("\nDemo project:", root);
  console.log("Change package:", built.changePackagePath);
  console.log("Review:", built.reviewPath);
  console.log("\n--- review.md ---\n");
  console.log(built.review);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
