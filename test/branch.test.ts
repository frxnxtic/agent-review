import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isProtectedBranch, slugifyTask, proposeBranchName, resolveWorkingBranch } from "../src/branch.ts";

function tempRepoOnMain(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-branch-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init");
  return root;
}

test("slugifyTask produces kebab-case slugs", () => {
  assert.equal(slugifyTask("Add refresh token rotation"), "add-refresh-token-rotation");
  assert.equal(slugifyTask("  Fix: the / login bug!!  "), "fix-the-login-bug");
  assert.equal(slugifyTask("ÚČTOVÁNÍ 丹 no-ascii"), "uctovani-no-ascii");
  assert.equal(slugifyTask("multi   spaces---dashes"), "multi-spaces-dashes");
});

test("slugifyTask caps length and trims trailing dashes", () => {
  const slug = slugifyTask("a".repeat(100), 40);
  assert.ok(slug.length <= 40);
  assert.ok(!slug.endsWith("-"));
});

test("protected branch detection", () => {
  assert.ok(isProtectedBranch("main"));
  assert.ok(isProtectedBranch("master"));
  assert.ok(isProtectedBranch("develop"));
  assert.ok(!isProtectedBranch("agent/add-login"));
  assert.ok(!isProtectedBranch("feature/x"));
  assert.ok(!isProtectedBranch(null));
  assert.ok(!isProtectedBranch("mainline"));
  assert.ok(isProtectedBranch("trunk", ["trunk"]));
});

test("proposeBranchName uses the configured prefix", () => {
  assert.equal(proposeBranchName("Add refresh token rotation"), "agent/add-refresh-token-rotation");
  assert.equal(proposeBranchName("Add login", "feature/"), "feature/add-login");
});

test("confirm:true creates the branch from a protected branch when autoCreateBranch is omitted", async () => {
  const root = tempRepoOnMain();
  const decision = await resolveWorkingBranch(root, { task: "Add login", confirm: true });
  assert.deepEqual(decision, { action: "created", branch: "agent/add-login", fromProtected: true });
});

test("autoCreateBranch:false still blocks creation from a protected branch", async () => {
  const root = tempRepoOnMain();
  const decision = await resolveWorkingBranch(root, { task: "Add login", confirm: true, autoCreateBranch: false });
  assert.equal(decision.action, "requires-confirmation");
});
