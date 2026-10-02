/**
 * GitHub workflow orchestration used by the plugin tools and the CLI.
 * Chooses between the enabled GhCliGitHubAdapter and the safe not-connected
 * fallback: status/prepare stay allowed (read-only/local), publish/update
 * hard-fail when config.github.enabled is false.
 */
import { loadOrCreateConfig } from "./config.ts";
import {
  GhCliGitHubAdapter,
  GH_AUTH_MESSAGE,
  type GitHubAdapter,
  type GitHubStatusResult,
  type PrepareInput,
  type PrepareResult,
  type PublishInput,
  type PublishResult,
  type UpdateInput,
  type UpdateResult,
} from "./github.ts";

export async function getGitHubAdapter(projectRoot: string, ghBin?: string): Promise<{ adapter: GitHubAdapter; enabled: boolean }> {
  const config = await loadOrCreateConfig(projectRoot);
  return { adapter: new GhCliGitHubAdapter(projectRoot, config, ghBin ?? "gh"), enabled: config.github.enabled };
}

export async function githubStatus(projectRoot: string, input?: { baseBranch?: string }): Promise<GitHubStatusResult> {
  const { adapter, enabled } = await getGitHubAdapter(projectRoot);
  const status = await adapter.status(input);
  if (!enabled) {
    status.problems.push("GitHub integration is disabled in config (.agent-review/config.json → github.enabled); status/prepare stay available, publishing is not.");
  }
  return status;
}

export async function githubPreparePullRequest(projectRoot: string, input?: PrepareInput): Promise<PrepareResult> {
  const { adapter } = await getGitHubAdapter(projectRoot);
  return adapter.preparePullRequest(input);
}

export async function githubPublishPullRequest(projectRoot: string, input: PublishInput): Promise<PublishResult> {
  const { adapter, enabled } = await getGitHubAdapter(projectRoot);
  if (!enabled && input.confirmed === true) {
    throw new Error(`GitHub integration is disabled in config (github.enabled = false). ${GH_AUTH_MESSAGE.replace("Для публикации", "Для публикации также")}`);
  }
  return adapter.publishPullRequest(input);
}

export async function githubUpdateReview(projectRoot: string, input: UpdateInput): Promise<UpdateResult> {
  const { adapter, enabled } = await getGitHubAdapter(projectRoot);
  if (!enabled && input.confirmed === true) {
    throw new Error("GitHub integration is disabled in config (github.enabled = false).");
  }
  return adapter.updateReview(input);
}
