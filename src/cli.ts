/**
 * Minimal CLI: agent-review github status | prepare-pr | publish-pr | update-review
 * Same code paths as the plugin tools; nothing is published without --confirm.
 */
import { githubStatus, githubPreparePullRequest, githubPublishPullRequest, githubUpdateReview } from "./github-workflow.ts";

function usage(): string {
  return [
    "usage: agent-review github status [--base <branch>]",
    "       agent-review github prepare-pr [--base <branch>] [--max <n>]",
    "       agent-review github publish-pr [--base <branch>] [--title <t>] [--allow-commit] [--allow-push] [--no-draft] --confirm",
    "       agent-review github update-review [--pr <n>] --confirm",
    "",
    "Nothing is pushed or published without --confirm (explicit user confirmation).",
  ].join("\n");
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

export async function runCli(argv: string[]): Promise<number> {
  const [group, command] = argv;
  if (group !== "github" || !command || has(argv, "--help") || has(argv, "-h")) {
    console.log(usage());
    return group === "github" ? 1 : 2;
  }
  const rest = argv.slice(2);

  try {
    if (command === "status") {
      console.log(JSON.stringify(await githubStatus(process.cwd(), { baseBranch: flag(rest, "--base") }), null, 2));
      return 0;
    }
    if (command === "prepare-pr") {
      console.log(JSON.stringify(await githubPreparePullRequest(process.cwd(), { baseBranch: flag(rest, "--base"), maxInlineComments: flag(rest, "--max") ? Number(flag(rest, "--max")) : undefined }), null, 2));
      return 0;
    }
    if (command === "publish-pr") {
      console.log(JSON.stringify(await githubPublishPullRequest(process.cwd(), {
        baseBranch: flag(rest, "--base"),
        title: flag(rest, "--title"),
        allowCommit: has(rest, "--allow-commit"),
        allowPush: has(rest, "--allow-push"),
        createDraft: !has(rest, "--no-draft"),
        confirmed: has(rest, "--confirm"),
      }), null, 2));
      return 0;
    }
    if (command === "update-review") {
      console.log(JSON.stringify(await githubUpdateReview(process.cwd(), {
        pullRequestNumber: flag(rest, "--pr") ? Number(flag(rest, "--pr")) : undefined,
        confirmed: has(rest, "--confirm"),
      }), null, 2));
      return 0;
    }
    console.log(usage());
    return 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1]?.endsWith("cli.ts")) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
