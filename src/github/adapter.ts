/**
 * GhCliGitHubAdapter — the concrete GitHubAdapter for the MVP.
 * All GitHub access goes through the `gh` CLI (child_process, shell:false);
 * there is no REST client and no token handling anywhere in the plugin.
 * Publishing paths only ever run with confirmed:true, and never without
 * config.github.enabled.
 */
import fs from "node:fs/promises";
import type { AgentReviewConfig } from "../config.ts";
import type { ChangePackage, IntentRecord, InlineCommentState } from "../types.ts";
import { runCommand, git, currentBranch, gitStatusShort, gitHead } from "../git.ts";
import { redactString, redactValue } from "../redact.ts";
import { buildChangePackage } from "../package-builder.ts";
import { reviewFile, githubDir, githubFile } from "../paths.ts";
import { parseGitHubRemote } from "./remote.ts";
import { GitDiffMapper, type DiffMapping } from "./diff-mapper.ts";
import { selectInlineComments, DEFAULT_MAX_INLINE_COMMENTS, type SelectedComment, type SelectionResult } from "./selection.ts";
import { generatePrTitle, generatePrBody, generateInlineCommentBody, buildGroupedReviewPayload, type GroupedReviewPayload } from "./pr-content.ts";
import { parseMarker } from "./marker.ts";

export const GH_AUTH_MESSAGE = "Для публикации PR выполните: gh auth login";

export interface GitHubStatusResult {
  available: boolean;
  authenticated: boolean;
  repository: string | null;
  remote: string | null;
  currentBranch: string | null;
  baseBranch: string;
  existingPullRequest: { number: number; url: string; isDraft: boolean } | null;
  problems: string[];
}

export interface PrepareInput {
  baseBranch?: string | undefined;
  maxInlineComments?: number | undefined;
}

export interface PrepareResult {
  status: "prepared";
  repository: string | null;
  baseBranch: string;
  headBranch: string;
  title: string;
  summary: { logicalChanges: number; filesChanged: number; testsPassed: number; risks: string[] };
  inlineComments: Array<{ id: string; logicalChangeId: string; path: string; line: number; risk: string }>;
  fileLevelCount: number;
  skipped: Array<{ logicalChangeId: string; reason: string }>;
  artifacts: string[];
}

export interface PublishInput {
  baseBranch?: string | undefined;
  title?: string | undefined;
  allowCommit?: boolean | undefined;
  allowPush?: boolean | undefined;
  createDraft?: boolean | undefined;
  publishInlineComments?: boolean | undefined;
  confirmed?: boolean | undefined;
}

export interface PublishResult {
  status: "confirmation-required" | "published" | "stopped" | "error";
  message?: string | undefined;
  pullRequestNumber?: number | undefined;
  pullRequestUrl?: string | undefined;
  publishedComments?: number | undefined;
  skipped?: Array<{ logicalChangeId: string; reason: string }> | undefined;
  warning?: string | undefined;
  preview?: Record<string, unknown> | undefined;
}

export interface UpdateInput {
  pullRequestNumber?: number | undefined;
  confirmed?: boolean | undefined;
}

export interface UpdateResult {
  status: "confirmation-required" | "updated" | "error" | "up-to-date";
  message?: string | undefined;
  headMoved?: boolean | undefined;
  replacedComments?: number | undefined;
  publishedComments?: number | undefined;
  preview?: Record<string, unknown> | undefined;
}

export interface GitHubAdapter {
  status(input?: { baseBranch?: string }): Promise<GitHubStatusResult>;
  preparePullRequest(input?: PrepareInput): Promise<PrepareResult>;
  publishPullRequest(input: PublishInput): Promise<PublishResult>;
  updateReview(input: UpdateInput): Promise<UpdateResult>;
}

interface PublishedRecord {
  repository: string;
  baseBranch: string;
  headBranch: string;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  headCommit: string | null;
  sessionId: string;
  reviewId: number | null;
  publishedCommentIds: number[];
  publishedAt: string;
}

async function gh(projectRoot: string, ghBin: string, args: string[], maxOutputBytes = 512 * 1024) {
  return runCommand(projectRoot, ghBin, args, maxOutputBytes);
}

async function ghJson<T>(projectRoot: string, ghBin: string, args: string[]): Promise<{ ok: boolean; data: T | null; stderr: string }> {
  try {
    const result = await gh(projectRoot, ghBin, args);
    if (result.code !== 0) return { ok: false, data: null, stderr: result.stderr };
    try {
      return { ok: true, data: JSON.parse(result.stdout) as T, stderr: result.stderr };
    } catch {
      return { ok: false, data: null, stderr: `unparseable gh output: ${redactString(result.stdout.slice(0, 200))}` };
    }
  } catch (error) {
    return { ok: false, data: null, stderr: error instanceof Error ? error.message : String(error) };
  }
}

export class GhCliGitHubAdapter implements GitHubAdapter {
  private readonly projectRoot: string;
  private readonly config: AgentReviewConfig;
  private readonly ghBin: string;

  constructor(projectRoot: string, config: AgentReviewConfig, ghBin = "gh") {
    this.projectRoot = projectRoot;
    this.config = config;
    this.ghBin = ghBin;
  }

  /** Read-only. Never throws; missing/unauthenticated gh degrades to problems[]. */
  async status(input?: { baseBranch?: string }): Promise<GitHubStatusResult> {
    const problems: string[] = [];
    let available = true;
    let authenticated = false;

    try {
      const version = await gh(this.projectRoot, this.ghBin, ["--version"]);
      if (version.code !== 0) {
        available = false;
        problems.push("GitHub CLI (`gh`) is not working on PATH.");
      }
    } catch {
      available = false;
      problems.push("GitHub CLI (`gh`) is not installed on PATH.");
    }

    if (available) {
      try {
        const auth = await gh(this.projectRoot, this.ghBin, ["auth", "status"]);
        authenticated = auth.code === 0;
        if (!authenticated) problems.push(GH_AUTH_MESSAGE);
      } catch {
        available = false;
        problems.push("GitHub CLI (`gh`) could not be executed.");
      }
    }
    if (!available) problems.push(GH_AUTH_MESSAGE);

    let remote: string | null = null;
    let repository: string | null = null;
    try {
      const url = await git(this.projectRoot, ["remote", "get-url", "origin"]);
      remote = url.code === 0 ? url.stdout.trim() : null;
    } catch {
      remote = null;
    }
    if (!remote) {
      problems.push("No `origin` git remote is configured.");
    } else {
      const parsed = parseGitHubRemote(remote);
      if (!parsed) problems.push(`Remote \`origin\` is not a GitHub URL (redacted: ${redactString(remote).slice(0, 40)}).`);
      else repository = parsed.slug;
    }

    const branchName: string | null = await currentBranch(this.projectRoot);
    const baseBranch = input?.baseBranch ?? this.config.github.defaultBaseBranch;

    let existingPullRequest: GitHubStatusResult["existingPullRequest"] = null;
    if (available && authenticated && repository && branchName) {
      const prs = await ghJson<Array<{ number: number; url: string; isDraft: boolean }>>(
        this.projectRoot,
        this.ghBin,
        ["pr", "list", "--head", branchName, "--state", "open", "--json", "number,url,isDraft,headRefName,baseRefName"],
      );
      if (prs.ok && Array.isArray(prs.data) && prs.data.length > 0) {
        const pr = prs.data[0]!;
        existingPullRequest = { number: pr.number, url: pr.url, isDraft: Boolean(pr.isDraft) };
      }
    }

    return {
      available,
      authenticated,
      repository,
      remote: remote ? redactString(remote) : null,
      currentBranch: branchName,
      baseBranch,
      existingPullRequest,
      problems,
    };
  }

  /** LOCAL ONLY: rebuilds the package, maps diffs, writes preview artifacts. Never pushes. */
  async preparePullRequest(input?: PrepareInput): Promise<PrepareResult> {
    const baseBranch = input?.baseBranch ?? this.config.github.defaultBaseBranch;
    const max = input?.maxInlineComments ?? this.config.github.maxInlineComments ?? DEFAULT_MAX_INLINE_COMMENTS;

    const built = await buildChangePackage(this.projectRoot, { keepActive: true });
    const pkg = built.changePackage;
    const headBranch = pkg.branch;
    const selection = await this.mapAndSelect(pkg, pkg.logicalChanges, baseBranch, "HEAD");
    const { selected, fileLevel, skipped } = selection;

    const sessionId = pkg.session.id;
    const commentBodies = selected.map((comment) => ({
      ...comment,
      body: generateInlineCommentBody(comment, sessionId, pkg.tests[0]?.command),
    }));

    const title = generatePrTitle(pkg);
    const body = generatePrBody(pkg, selected, fileLevel);

    await fs.mkdir(githubDir(this.projectRoot), { recursive: true });

    const inlinePreview = {
      schemaVersion: "agent-review-inline-comments/v1",
      branch: headBranch,
      baseBranch,
      comments: commentBodies.map((comment) => ({
        id: comment.id,
        logicalChangeId: comment.logicalChangeId,
        path: comment.path,
        line: comment.line,
        side: "RIGHT",
        body: comment.body,
        risk: comment.risk,
        evidenceRefs: pkg.tests.filter((test) => test.status === "passed").map((_, index) => `test_${String(index + 1).padStart(3, "0")}`),
        status: "preview",
      })),
    };
    const preview = {
      schemaVersion: "agent-review-pr-preview/v1",
      repository: null,
      baseBranch,
      headBranch,
      title,
      draft: this.config.github.createDraftPullRequest,
      summary: {
        logicalChanges: pkg.logicalChanges.length,
        filesChanged: pkg.changedFiles.length,
        testsPassed: pkg.tests.filter((test) => test.status === "passed").length,
        risks: pkg.risks,
      },
      inlineComments: inlinePreview.comments,
      fileLevelNotes: fileLevel.map((intent) => ({ logicalChangeId: intent.id, entity: intent.entity })),
      skipped,
    };

    const artifacts = [
      githubFile(this.projectRoot, "prPreview"),
      githubFile(this.projectRoot, "prBody"),
      githubFile(this.projectRoot, "inlinePreview"),
      githubFile(this.projectRoot, "publishPlan"),
    ];
    await fs.writeFile(githubFile(this.projectRoot, "prPreview"), `${JSON.stringify(redactValue(preview), null, 2)}\n`, "utf8");
    await fs.writeFile(githubFile(this.projectRoot, "prBody"), body, "utf8");
    await fs.writeFile(githubFile(this.projectRoot, "inlinePreview"), `${JSON.stringify(redactValue(inlinePreview), null, 2)}\n`, "utf8");
    await fs.writeFile(
      githubFile(this.projectRoot, "publishPlan"),
      renderPublishPlan(preview.title, baseBranch, headBranch, inlinePreview.comments, skipped),
      "utf8",
    );

    await this.writePackageGithubState(pkg, {
      repository: null,
      baseBranch,
      headBranch,
      pullRequestNumber: null,
      pullRequestUrl: null,
      headCommit: await gitHead(this.projectRoot),
      status: "preview_ready",
      inlineComments: this.commentStates(selected, skipped, fileLevel),
    });

    return {
      status: "prepared",
      repository: null,
      baseBranch,
      headBranch,
      title,
      summary: preview.summary,
      inlineComments: inlinePreview.comments.map((comment) => ({ id: comment.id, logicalChangeId: comment.logicalChangeId, path: comment.path, line: comment.line, risk: comment.risk })),
      fileLevelCount: fileLevel.length,
      skipped,
      artifacts,
    };
  }

  /** External actions. With confirmed !== true it performs NOTHING. */
  async publishPullRequest(input: PublishInput): Promise<PublishResult> {
    if (input.confirmed !== true) {
      return {
        status: "confirmation-required",
        message:
          "Publishing creates a commit (optional), pushes the branch and opens/comments on a GitHub PR. " +
          "Show the preview (.agent-review/github/) to the user and re-invoke only after an explicit confirmation (confirmed: true).",
        preview: (await this.readPreview()) ?? undefined,
      };
    }
    if (!this.config.github.enabled) {
      throw new Error("GitHub integration is disabled in config (github.enabled = false) — enable it in .agent-review/config.json first.");
    }

    const baseBranch = input.baseBranch ?? this.config.github.defaultBaseBranch;
    const status = await this.status({ baseBranch });
    if (!status.available || !status.authenticated) {
      return { status: "stopped", message: GH_AUTH_MESSAGE, warning: status.problems.join(" ") };
    }
    if (!status.repository || !status.currentBranch) {
      return { status: "stopped", message: "No GitHub `origin` remote or current branch — cannot publish.", warning: status.problems.join(" ") };
    }
    const repository = status.repository;
    const headBranch = status.currentBranch;

    // Reuse the existing open PR — never duplicate.
    let pr = status.existingPullRequest;

    const built = await buildChangePackage(this.projectRoot, { keepActive: true });
    const pkg = built.changePackage;
    const title = input.title ?? generatePrTitle(pkg);

    let warning: string | undefined;
    if (!pr) {
      if (input.allowCommit === true) {
        const dirty = (await gitStatusShort(this.projectRoot)).filter((line) => !line.includes(".agent-review"));
        if (dirty.length > 0) {
          await git(this.projectRoot, ["add", "-A"]);
          await git(this.projectRoot, ["reset", "-q", "--", ".agent-review"]);
          const staged = await git(this.projectRoot, ["diff", "--cached", "--name-only"]);
          if (staged.stdout.trim().length > 0) {
            const commit = await git(this.projectRoot, ["commit", "-m", title]);
            if (commit.code !== 0) return { status: "stopped", message: `git commit failed: ${redactString(commit.stderr.slice(0, 300))}` };
          }
        }
      } else if ((await gitStatusShort(this.projectRoot)).some((line) => !line.includes(".agent-review"))) {
        warning = "Working tree has uncommitted changes; allowCommit is false — nothing was committed.";
      }
      if (!status.existingPullRequest && input.allowPush !== true) {
        return {
          status: "stopped",
          message: `Branch "${headBranch}" is not on the remote and allowPush is false. Either push it yourself (git push -u origin ${headBranch}) or re-invoke with allowPush: true.`,
        };
      }
      if (input.allowPush === true) {
        const push = await git(this.projectRoot, ["push", "-u", "origin", headBranch]);
        if (push.code !== 0) return { status: "stopped", message: `git push failed: ${redactString(push.stderr.slice(0, 300))}` };
      }
      if (input.createDraft ?? this.config.github.createDraftPullRequest) {
        const created = await gh(this.projectRoot, this.ghBin, [
          "pr", "create",
          "--base", baseBranch,
          "--head", headBranch,
          "--title", title,
          "--body-file", reviewFileRelative(this.projectRoot, "github/pr-body.md"),
          "--draft",
        ]);
        if (created.code !== 0) return { status: "stopped", message: `gh pr create failed: ${redactString(created.stderr.slice(0, 300))}` };
        const trimmed = created.stdout.trim();
        let url = "";
        let number = 0;
        try {
          const parsed = JSON.parse(trimmed) as { url?: string };
          url = parsed.url ?? "";
        } catch {
          url = /https:\/\/github\.com\/[^\s"']+/.exec(trimmed)?.[0] ?? "";
        }
        const numberMatch = /\/pull\/(\d+)/.exec(url);
        number = numberMatch ? Number(numberMatch[1]) : 0;
        pr = {
          number,
          url,
          isDraft: true,
        };
      }
    }
    if (!pr || !pr.number) {
      return { status: "stopped", message: "No pull request to attach the review to (createDraft=false and no existing PR)." };
    }

    // Publish the summary as the review body — via editing nothing; the body was set at creation.
    // For an existing PR, update the body only if publishSummary is on.
    if (status.existingPullRequest && this.config.github.publishSummary) {
      await gh(this.projectRoot, this.ghBin, [
        "pr", "edit", String(pr.number),
        "--body-file", reviewFileRelative(this.projectRoot, "github/pr-body.md"),
      ]);
    }

    let reviewId: number | null = null;
    let publishedCommentIds: number[] = [];
    let publishedComments = 0;

    // Re-run the mapping against the ACTUAL PR head SHA right before publishing.
    const head = await ghJson<{ headRefOid: string }>(this.projectRoot, this.ghBin, ["pr", "view", String(pr.number), "--json", "headRefOid", "--jq", ".headRefOid"]);
    const headSha = head.ok && head.data ? head.data.headRefOid : (await gitHead(this.projectRoot)) ?? "HEAD";
    const selection = await this.mapAndSelect(pkg, pkg.logicalChanges, baseBranch, headSha);

    if (this.config.github.publishInlineComments && (input.publishInlineComments ?? true) && selection.selected.length > 0) {
      const sessionId = pkg.session.id;
      const comments = selection.selected.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: "RIGHT" as const,
        body: generateInlineCommentBody(comment, sessionId, pkg.tests[0]?.command),
      }));
      const payload = buildGroupedReviewPayload(headSha, comments);
      const payloadPath = githubFile(this.projectRoot, "reviewPayload");
      await fs.writeFile(payloadPath, JSON.stringify(payload, null, 2), "utf8");
      const response = await ghJson<{ id: number; comments?: Array<{ id: number }> }>(
        this.projectRoot,
        this.ghBin,
        ["api", `repos/${repository}/pulls/${pr.number}/reviews`, "--method", "POST", "--input", payloadPath],
      );
      if (!response.ok) {
        return { status: "stopped", message: `gh api review publish failed: ${redactString(response.stderr.slice(0, 300))}`, pullRequestNumber: pr.number, pullRequestUrl: pr.url };
      }
      reviewId = response.data?.id ?? null;
      publishedCommentIds = response.data?.comments?.map((comment) => comment.id) ?? [];
      publishedComments = comments.length;
    }

    const record: PublishedRecord = {
      repository,
      baseBranch,
      headBranch,
      pullRequestNumber: pr.number,
      pullRequestUrl: pr.url,
      headCommit: headSha,
      sessionId: pkg.session.id,
      reviewId,
      publishedCommentIds,
      publishedAt: new Date().toISOString(),
    };
    await fs.writeFile(githubFile(this.projectRoot, "published"), `${JSON.stringify(record, null, 2)}\n`, "utf8");

    await this.writePackageGithubState(pkg, {
      repository,
      baseBranch,
      headBranch,
      pullRequestNumber: pr.number,
      pullRequestUrl: pr.url,
      headCommit: headSha,
      status: "published",
      inlineComments: this.commentStates(selection.selected, selection.skipped, selection.fileLevel).map((state) => ({
        ...state,
        status: state.status === "preview" ? "published" : state.status,
        githubCommentId: undefined,
        githubReviewId: reviewId ?? undefined,
      })),
    });

    return {
      status: "published",
      pullRequestNumber: pr.number,
      pullRequestUrl: pr.url,
      publishedComments,
      skipped: selection.skipped,
      warning,
      message: pr.url ? `PR: ${pr.url}` : undefined,
    };
  }

  /** Update an existing PR's agent review after a new push. Never touches non-agent comments. */
  async updateReview(input: UpdateInput): Promise<UpdateResult> {
    if (input.confirmed !== true) {
      const preview = await this.buildUpdatePreview(input.pullRequestNumber);
      return {
        status: "confirmation-required",
        message: "Updating the review will replace this session's own published comments and post a new grouped review. Confirm with confirmed: true.",
        preview,
      };
    }
    if (!this.config.github.enabled) {
      throw new Error("GitHub integration is disabled in config (github.enabled = false) — enable it in .agent-review/config.json first.");
    }

    const status = await this.status();
    if (!status.available || !status.authenticated || !status.repository) {
      return { status: "error", message: GH_AUTH_MESSAGE };
    }
    const repository = status.repository;
    const prNumber = await this.resolvePrNumber(input.pullRequestNumber);
    if (!prNumber) return { status: "error", message: "No published PR found (.agent-review/github/published.json is missing) and no pullRequestNumber given." };

    const head = await ghJson<{ headRefOid: string }>(this.projectRoot, this.ghBin, ["pr", "view", String(prNumber), "--json", "headRefOid", "--jq", ".headRefOid"]);
    const headSha = head.ok && head.data ? head.data.headRefOid : null;
    const previous = await this.readPublished();
    const headMoved = Boolean(previous?.headCommit && headSha && previous.headCommit !== headSha);

    const built = await buildChangePackage(this.projectRoot, { keepActive: true });
    const pkg = built.changePackage;
    const selection = await this.mapAndSelect(pkg, pkg.logicalChanges, status.baseBranch, "HEAD");

    // Identify ONLY the plugin's own comments via the hidden marker.
    const existing = await ghJson<Array<{ id: number; body: string }>>(
      this.projectRoot,
      this.ghBin,
      ["api", `repos/${repository}/pulls/${prNumber}/comments`],
    );
    const own = (existing.data ?? []).filter((comment) => {
      const marker = parseMarker(comment.body);
      return marker !== null && marker.sessionId === pkg.session.id;
    });

    let replaced = 0;
    if (this.config.github.updateMode === "replace-agent-comments") {      for (const comment of own) {
        await gh(this.projectRoot, this.ghBin, ["api", `repos/${repository}/pulls/comments/${comment.id}`, "-X", "DELETE"]);
        replaced++;
      }
    }

    let published = 0;
    let reviewId: number | null = null;
    const publishedCommentIds: number[] = [];
    if (selection.selected.length > 0 && headSha) {
      const sessionId = pkg.session.id;
      const comments = selection.selected.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: "RIGHT" as const,
        body: generateInlineCommentBody(comment, sessionId, pkg.tests[0]?.command),
      }));
      const payload = buildGroupedReviewPayload(headSha, comments);
      const payloadPath = githubFile(this.projectRoot, "reviewPayload");
      await fs.writeFile(payloadPath, JSON.stringify(payload, null, 2), "utf8");
      const response = await ghJson<{ id: number; comments?: Array<{ id: number }> }>(
        this.projectRoot,
        this.ghBin,
        ["api", `repos/${repository}/pulls/${prNumber}/reviews`, "--method", "POST", "--input", payloadPath],
      );
      if (!response.ok) return { status: "error", message: `gh api review publish failed: ${redactString(response.stderr.slice(0, 300))}` };
      reviewId = response.data?.id ?? null;
      publishedCommentIds.push(...(response.data?.comments?.map((comment) => comment.id) ?? []));
      published = comments.length;
    }

    const record: PublishedRecord = {
      repository,
      baseBranch: status.baseBranch,
      headBranch: status.currentBranch ?? "unknown",
      pullRequestNumber: prNumber,
      pullRequestUrl: previous?.pullRequestUrl ?? null,
      headCommit: headSha,
      sessionId: pkg.session.id,
      reviewId,
      publishedCommentIds,
      publishedAt: new Date().toISOString(),
    };
    await fs.writeFile(githubFile(this.projectRoot, "published"), `${JSON.stringify(record, null, 2)}\n`, "utf8");

    await this.writePackageGithubState(pkg, {
      repository,
      baseBranch: status.baseBranch,
      headBranch: status.currentBranch ?? "unknown",
      pullRequestNumber: prNumber,
      pullRequestUrl: previous?.pullRequestUrl ?? null,
      headCommit: headSha,
      status: "published",
      inlineComments: this.commentStates(selection.selected, selection.skipped, selection.fileLevel).map((state) => ({
        ...state,
        status: state.status === "preview" ? "published" : state.status,
        githubReviewId: reviewId ?? undefined,
      })),
    });

    return {
      status: "updated",
      headMoved,
      replacedComments: replaced,
      publishedComments: published,
      message: `Updated review on PR #${prNumber} (head ${headSha?.slice(0, 10) ?? "?"}); ${replaced} own comment(s) replaced, ${published} published.`,
    };
  }

  // ---------- internals ----------

  private async mapAndSelect(
    pkg: ChangePackage,
    intents: IntentRecord[],
    baseBranch: string,
    headRef: string,
  ): Promise<SelectionResult & { mapping: DiffMapping }> {
    const mapper = new GitDiffMapper(this.projectRoot, {
      skipGeneratedFiles: this.config.github.skipGeneratedFiles,
      skipLockfiles: this.config.github.skipLockfiles,
    });
    const mapping: DiffMapping = await mapper.map(intents, baseBranch, headRef);
    const selection = selectInlineComments(intents, mapping.candidates, mapping.unmapped, this.config.github.maxInlineComments ?? DEFAULT_MAX_INLINE_COMMENTS);
    return { ...selection, mapping };
  }

  private commentStates(
    selected: SelectedComment[],
    skipped: Array<{ logicalChangeId: string; reason: string }>,
    fileLevel: IntentRecord[],
  ): InlineCommentState[] {
    const states: InlineCommentState[] = selected.map((comment) => ({
      logicalChangeId: comment.logicalChangeId,
      path: comment.path,
      line: comment.line,
      side: "RIGHT" as const,
      status: "preview" as const,
    }));
    for (const skip of skipped) {
      states.push({ logicalChangeId: skip.logicalChangeId, path: "", line: null, side: "RIGHT", status: "skipped", skipReason: skip.reason });
    }
    for (const intent of fileLevel) {
      states.push({ logicalChangeId: intent.id, path: intent.files[0] ?? "", line: null, side: "RIGHT", status: "skipped", skipReason: "file-level summary in the PR body (no exact diff line)" });
    }
    return states;
  }

  private async writePackageGithubState(pkg: ChangePackage, github: NonNullable<ChangePackage["github"]>): Promise<void> {
    pkg.github = github;
    await fs.writeFile(reviewFile(this.projectRoot, "changePackage"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  }

  private async readPublished(): Promise<PublishedRecord | null> {
    try {
      return JSON.parse(await fs.readFile(githubFile(this.projectRoot, "published"), "utf8")) as PublishedRecord;
    } catch {
      return null;
    }
  }

  private async resolvePrNumber(explicit?: number): Promise<number | null> {
    if (explicit) return explicit;
    const record = await this.readPublished();
    return record?.pullRequestNumber ?? null;
  }

  private async readPreview(): Promise<Record<string, unknown> | null> {
    try {
      return JSON.parse(await fs.readFile(githubFile(this.projectRoot, "prPreview"), "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async buildUpdatePreview(prNumber?: number): Promise<Record<string, unknown>> {
    const built = await buildChangePackage(this.projectRoot, { keepActive: true });
    const status = await this.status();
    const selection = await this.mapAndSelect(built.changePackage, built.changePackage.logicalChanges, status.baseBranch, "HEAD");
    const previous = await this.readPublished();
    return {
      pullRequestNumber: prNumber ?? previous?.pullRequestNumber ?? null,
      baseBranch: status.baseBranch,
      headBranch: built.changePackage.branch,
      wouldPublish: selection.selected.length,
      wouldReplace: this.config.github.updateMode,
      skipped: selection.skipped,
    };
  }
}

/** `.agent-review/github/<name>` relative path for gh --body-file/--input args. */
function reviewFileRelative(projectRoot: string, rel: string): string {
  // gh resolves --input/--body-file relative to CWD; we always run with cwd = projectRoot.
  void projectRoot;
  return `.agent-review/github/${rel.split("/").pop()}`;
}

function renderPublishPlan(
  title: string,
  baseBranch: string,
  headBranch: string,
  comments: Array<{ path: string; line: number }>,
  skipped: Array<{ logicalChangeId: string; reason: string }>,
): string {
  const lines = [
    "# Publish plan",
    "",
    `- Draft PR: \`${headBranch}\` → \`${baseBranch}\``,
    `- Title: ${title}`,
    `- Inline comments: ${comments.length}`,
    ...comments.map((comment) => `  - \`${comment.path}\`:${comment.line}`),
    `- Skipped: ${skipped.length}`,
    ...skipped.map((skip) => `  - ${skip.reason}`),
    "",
    "Nothing has been pushed or published. Publishing requires explicit user confirmation.",
    "",
  ];
  return lines.join("\n");
}
