import assert from "node:assert/strict";
import { test } from "node:test";
import { isProtectedBranch, slugifyTask, proposeBranchName } from "../src/branch.ts";

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
