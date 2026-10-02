import path from "node:path";

export const REVIEW_DIR_NAME = ".agent-review";

export const REVIEW_FILES = {
  config: "config.json",
  events: "events.jsonl",
  session: "session.json",
  changePackage: "change-package.json",
  review: "review.md",
} as const;

export const REVIEW_SUBDIRS = {
  checkpoints: "checkpoints",
  snapshots: "snapshots",
  github: "github",
} as const;

export const GITHUB_FILES = {
  prPreview: "pr-preview.json",
  prBody: "pr-body.md",
  inlinePreview: "inline-comments.preview.json",
  publishPlan: "publish-plan.md",
  reviewPayload: "review-payload.json",
  published: "published.json",
} as const;

export function reviewDir(projectRoot: string): string {
  return path.join(projectRoot, REVIEW_DIR_NAME);
}

export function reviewFile(projectRoot: string, name: keyof typeof REVIEW_FILES): string {
  return path.join(reviewDir(projectRoot), REVIEW_FILES[name]);
}

export function checkpointsDir(projectRoot: string): string {
  return path.join(reviewDir(projectRoot), REVIEW_SUBDIRS.checkpoints);
}

export function snapshotsDir(projectRoot: string): string {
  return path.join(reviewDir(projectRoot), REVIEW_SUBDIRS.snapshots);
}

export function checkpointFile(projectRoot: string, checkpointId: string): string {
  return path.join(checkpointsDir(projectRoot), `${checkpointId}.json`);
}

export function snapshotDir(projectRoot: string, checkpointId: string): string {
  return path.join(snapshotsDir(projectRoot), checkpointId);
}

export function githubDir(projectRoot: string): string {
  return path.join(reviewDir(projectRoot), REVIEW_SUBDIRS.github);
}

export function githubFile(projectRoot: string, name: keyof typeof GITHUB_FILES): string {
  return path.join(githubDir(projectRoot), GITHUB_FILES[name]);
}
