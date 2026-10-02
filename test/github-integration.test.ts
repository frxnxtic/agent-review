/**
 * Integration test for the GitHub PR review adapter.
 * Offline: a mock `gh` executable (records invocations, emits canned JSON) and
 * a local fake git repo with a bare "origin". A `git` shim answers
 * `remote get-url origin` with a GitHub URL so remote parsing works while the
 * real push stays local. No network, no real gh.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startSession, loadSession } from "../src/session.ts";
import { recordIntent } from "../src/intent.ts";
import { runTestCommand } from "../src/tests.ts";
import { GhCliGitHubAdapter, GH_AUTH_MESSAGE } from "../src/github/adapter.ts";
import { loadOrCreateConfig } from "../src/config.ts";
import { reviewDir } from "../src/paths.ts";

interface Ctx {
  root: string;
  ghLog: string;
  ghBin: string;
  shimDir: string;
  prevPath: string;
}

function useGitShim(ctx: Ctx): void {
  process.env.PATH = `${ctx.shimDir}:${ctx.prevPath}`;
}

function restorePath(ctx: Ctx): void {
  process.env.PATH = ctx.prevPath;
}

async function makeContext(): Promise<Ctx> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agent-review-gh-int-"));
  const origin = mkdtempSync(path.join(os.tmpdir(), "agent-review-gh-origin-"));
  const work = path.join(tmp, "work");
  await fs.mkdir(work, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["config", "user.email", "agent@example.com"], { cwd: work });
  execFileSync("git", ["config", "user.name", "Agent"], { cwd: work });
  await fs.writeFile(path.join(work, "README.md"), "# demo\n");
  await fs.mkdir(path.join(work, "src"), { recursive: true });
  await fs.writeFile(path.join(work, "src", "auth.ts"), "export const a = 1;\n");
  execFileSync("git", ["add", "."], { cwd: work });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: work });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: work });
  execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: work });
  execFileSync("git", ["checkout", "-q", "-b", "agent/rotate-tokens"], { cwd: work });
  await fs.writeFile(path.join(work, "src", "auth.ts"), "export const a = 1;\n\nexport function rotate(): boolean {\n  return true;\n}\n");
  await fs.writeFile(path.join(work, "package-lock.json"), "{}\n");

  // git shim: GitHub-looking origin URL, everything else passes through.
  const shimDir = path.join(tmp, "shim");
  await fs.mkdir(shimDir, { recursive: true });
  const realGit = execFileSync("which", ["git"]).toString().trim();
  await fs.writeFile(
    path.join(shimDir, "git"),
    `#!/bin/sh\nif [ "$1" = "remote" ] && [ "$2" = "get-url" ] && [ "$3" = "origin" ]; then echo "git@github.com:octo/cat-prj.git"; exit 0; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
    { mode: 0o755 },
  );

  // mock gh executable.
  const ghLog = path.join(tmp, "gh-calls.log");
  const stateFile = path.join(tmp, "gh-state.json");
  await fs.writeFile(stateFile, JSON.stringify({ pr: null }), "utf8");
  const stateRef = JSON.stringify(stateFile);
  const script = [
    "#!/bin/sh",
    `echo "$@" >> ${JSON.stringify(ghLog)}`,
    `headSha=$(git -C ${JSON.stringify(work)} rev-parse HEAD)`,
    'case "$*" in',
    '  *"--version"*) echo "gh version 2.0.0-mock"; exit 0;;',
    '  *"auth status"*) exit 0;;',
    '  *"pr list"*) node -e "const s=require(process.argv[1]);console.log(JSON.stringify(s.pr?[s.pr]:[]))" ${stateRef}; exit 0;;',
    '  *"pr view"*) echo "$headSha"; exit 0;;',
    '  *"pr create"*) node -e "const fs=require(\'fs\');const p=process.argv[1];const s=JSON.parse(fs.readFileSync(p));s.pr={number:12,url:\'https://github.com/octo/cat-prj/pull/12\',isDraft:true};fs.writeFileSync(p,JSON.stringify(s))" ${stateRef}; echo \'{"url":"https://github.com/octo/cat-prj/pull/12"}\'; exit 0;;',
    '  *"pulls/12/reviews"*) echo \'{"id":777,"comments":[{"id":888}]}\'; exit 0;;',
    '  *"/comments"*) echo \'[]\'; exit 0;;',
    "esac",
    "exit 0",
  ].join("\n").replace(/\$\{stateRef\}/g, stateRef);
  const ghBin = path.join(tmp, "mock-gh");
  await fs.writeFile(ghBin, script, { mode: 0o755 });

  await fs.mkdir(path.join(work, ".agent-review"), { recursive: true });
  await fs.writeFile(
    path.join(work, ".agent-review", "config.json"),
    JSON.stringify({ github: { enabled: true, defaultBaseBranch: "main" } }),
    "utf8",
  );

  return { root: work, ghLog, ghBin, shimDir, prevPath: process.env.PATH ?? "" };
}

async function seedArc(root: string): Promise<void> {
  const started = await startSession(root, { task: "Rotate refresh tokens", autoCreateBranch: false, confirm: true });
  assert.ok(started.session);
  const session = (await loadSession(root))!;
  await recordIntent(root, session, {
    entity: "refresh token rotation",
    files: ["src/auth.ts"],
    changeKind: "modified",
    reason: "static refresh tokens allow replay",
    expectedBehavior: "every refresh rotates the token",
    risk: "high",
  });
  await runTestCommand(root, session, process.execPath + " --version", "runtime sanity check");
}

test("integration: status, prepare, guarded publish, publish on a mock GitHub", async () => {
  const ctx = await makeContext();
  useGitShim(ctx);
  try {
    const { root, ghLog, ghBin } = ctx;
    await seedArc(root);

    const config = await loadOrCreateConfig(root);
    assert.equal(config.github.enabled, true);
    const adapter = new GhCliGitHubAdapter(root, config, ghBin);

    // 1. status: available + authenticated, GitHub remote resolved.
    const status = await adapter.status({ baseBranch: "main" });
    assert.equal(status.available, true);
    assert.equal(status.authenticated, true);
    assert.equal(status.repository, "octo/cat-prj");
    assert.equal(status.currentBranch, "agent/rotate-tokens");
    assert.equal(status.baseBranch, "main");
    assert.ok(!status.problems.some((problem) => problem.includes(GH_AUTH_MESSAGE)));

    // 2. prepare: LOCAL ONLY.
    const prepared = await adapter.preparePullRequest({ baseBranch: "main" });
    assert.equal(prepared.status, "prepared");
    assert.ok(prepared.title.includes("Rotate refresh tokens"));
    const inlinePreview = JSON.parse(await fs.readFile(path.join(root, ".agent-review", "github", "inline-comments.preview.json"), "utf8"));
    assert.equal(inlinePreview.schemaVersion, "agent-review-inline-comments/v1");
    assert.ok(inlinePreview.comments.length >= 1);
    assert.equal(inlinePreview.comments[0].side, "RIGHT");
    assert.equal(inlinePreview.comments[0].status, "preview");
    assert.ok(inlinePreview.comments[0].body.includes("<!-- agent-review:session="));
    const body = await fs.readFile(path.join(root, ".agent-review", "github", "pr-body.md"), "utf8");
    assert.ok(body.startsWith("# Agent Review"));
    assert.ok(body.includes("1 logical changes /"));
    assert.ok(body.includes(": passed"));
    assert.ok(!inlinePreview.comments.some((comment: { path: string }) => comment.path.includes("package-lock.json")));

    // 3. publish with confirmed:false — NOTHING external happens.
    const before = await fs.readFile(ghLog, "utf8").catch(() => "");
    const blocked = await adapter.publishPullRequest({ confirmed: false });
    assert.equal(blocked.status, "confirmation-required");
    assert.equal(await fs.readFile(ghLog, "utf8").catch(() => ""), before);

    // 4. publish with confirmed:true + allowPush + allowCommit.
    const published = await adapter.publishPullRequest({ baseBranch: "main", allowCommit: true, allowPush: true, confirmed: true });
    assert.equal(published.status, "published", `expected published, got ${published.status}: ${published.message ?? ""}`);
    assert.equal(published.pullRequestNumber, 12);
    assert.equal(published.pullRequestUrl, "https://github.com/octo/cat-prj/pull/12");
    assert.equal(published.publishedComments, 1);

    const calls = (await fs.readFile(ghLog, "utf8")).split("\n");
    const createCalls = calls.filter((call) => call.includes("pr create"));
    assert.equal(createCalls.length, 1); // exactly one PR creation, never duplicated
    assert.ok(createCalls[0]!.includes("--base main"));
    assert.ok(createCalls[0]!.includes("--head agent/rotate-tokens"));
    assert.ok(createCalls[0]!.includes("--draft"));
    assert.ok(createCalls[0]!.includes("pr-body.md"));
    assert.ok(createCalls[0]!.includes("--title Rotate refresh tokens"));

    // Exactly ONE grouped review payload; line + side RIGHT; commit_id present.
    const reviewCalls = calls.filter((call) => call.includes("/reviews") && call.includes("POST"));
    assert.equal(reviewCalls.length, 1);
    const payload = JSON.parse(await fs.readFile(path.join(root, ".agent-review", "github", "review-payload.json"), "utf8"));
    assert.equal(payload.event, "COMMENT");
    assert.ok(typeof payload.commit_id === "string" && payload.commit_id.length >= 7);
    assert.ok(payload.comments.length >= 1 && payload.comments.length <= 8);
    for (const comment of payload.comments) {
      assert.equal(comment.side, "RIGHT");
      assert.equal(typeof comment.line, "number");
      assert.ok(comment.body.includes("Agent context"));
    }

    const publishedRecord = JSON.parse(await fs.readFile(path.join(root, ".agent-review", "github", "published.json"), "utf8"));
    assert.equal(publishedRecord.pullRequestNumber, 12);
    assert.equal(publishedRecord.reviewId, 777);

    // No token recorded anywhere under .agent-review/.
    async function assertNoSecrets(dir: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await assertNoSecrets(full);
        else {
          const content = await fs.readFile(full, "utf8").catch(() => "");
          assert.ok(!content.includes("ghp_16characters"), `secret found in ${full}`);
        }
      }
    }
    await assertNoSecrets(reviewDir(root));

    // 5. update with confirmed:false → confirmation-required; review count unchanged.
    const updateBlocked = await adapter.updateReview({ pullRequestNumber: 12, confirmed: false });
    assert.equal(updateBlocked.status, "confirmation-required");
    const reviewCount = (await fs.readFile(ghLog, "utf8")).split("\n").filter((call) => call.includes("/reviews") && call.includes("POST")).length;
    assert.equal(reviewCount, 1);
  } finally {
    restorePath(ctx);
  }
});

test("integration: publish stops safely when no PR exists and allowPush=false", async () => {
  const ctx = await makeContext();
  useGitShim(ctx);
  try {
    const { root, ghBin } = ctx;
    await seedArc(root);
    const adapter = new GhCliGitHubAdapter(root, await loadOrCreateConfig(root), ghBin);
    const result = await adapter.publishPullRequest({ baseBranch: "main", confirmed: true });
    assert.equal(result.status, "stopped");
    assert.ok(result.message!.includes("allowPush"));
  } finally {
    restorePath(ctx);
  }
});

test("integration: unauthenticated mock gh → publish fails safely with gh auth login message", async () => {
  const ctx = await makeContext();
  useGitShim(ctx);
  try {
    const { root, ghLog } = ctx;
    const ghBinFailing = path.join(root, "..", "mock-gh-unauth");
    await fs.writeFile(
      ghBinFailing,
      `#!/bin/sh\ncase "$*" in *"auth status"*) exit 1;; esac\nexit 0\n`,
      { mode: 0o755 },
    );
    const adapter = new GhCliGitHubAdapter(root, await loadOrCreateConfig(root), ghBinFailing);
    const status = await adapter.status();
    assert.equal(status.authenticated, false);
    assert.ok(status.problems.some((problem) => problem.includes(GH_AUTH_MESSAGE)));
    const result = await adapter.publishPullRequest({ confirmed: true });
    assert.equal(result.status, "stopped");
    assert.ok(result.message!.includes("gh auth login"));
    const calls = await fs.readFile(ghLog, "utf8").catch(() => "");
    assert.ok(!calls.includes("pr create"));
  } finally {
    restorePath(ctx);
  }
});
