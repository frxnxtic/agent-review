/**
 * Core domain types for Agent Review.
 * Only structured, verifiable facts live here — never model reasoning.
 */

export type SessionStatus = "active" | "ended" | "error";

export interface AgentSession {
  id: string;
  projectRoot: string;
  startedAt: string;
  endedAt: string | null;
  initialBranch: string;
  workingBranch: string;
  initialHead: string | null;
  /** git status --short lines captured at session start (dirty tree evidence). */
  dirtyAtStart: string[];
  task: string;
  status: SessionStatus;
}

export const OBSERVED_EVENT_TYPES = [
  "session.started",
  "session.ended",
  "branch.checked",
  "branch.created",
  "tool.started",
  "tool.completed",
  "command.started",
  "command.completed",
  "file.changed",
  "checkpoint.created",
  "test.started",
  "test.completed",
  "intent.recorded",
  "change-package.created",
  "review.generated",
] as const;

export type ObservedEventType = (typeof OBSERVED_EVENT_TYPES)[number];

export interface ObservedEvent {
  id: string;
  sessionId: string | null;
  timestamp: string;
  type: ObservedEventType;
  source: string;
  payload: Record<string, unknown>;
}

export interface Checkpoint {
  id: string;
  sessionId: string | null;
  createdAt: string;
  reason: string;
  gitHead: string | null;
  gitStatus: string[];
  changedFiles: string[];
  snapshotPath: string | null;
  restorable: boolean;
}

export type ChangeKind = "added" | "modified" | "removed" | "refactored";
export type RiskLevel = "low" | "medium" | "high";

export interface IntentRecord {
  id: string;
  sessionId: string | null;
  recordedAt: string;
  entity: string;
  files: string[];
  changeKind: ChangeKind;
  reason: string;
  expectedBehavior: string;
  risk: RiskLevel;
  relatedTask?: string;
  alternatives: string[];
  limitations: string[];
  evidence?: string;
}

export interface TestEvidence {
  command: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  status: "passed" | "failed" | "error";
  stdoutSummary: string;
  stderrSummary: string;
  workingDirectory: string;
  relatedChanges?: string[];
}

export interface CommitInfo {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

export interface LogicalChange {
  path: string;
  kind: ChangeKind;
  language: string;
  insertions: number;
  deletions: number;
  /** Cheap heuristic symbols (functions/classes) for supported languages. */
  symbols?: string[];
}

export interface ChangePackage {
  schemaVersion: "agent-review/v1";
  session: {
    id: string;
    startedAt: string;
    endedAt: string | null;
    status: SessionStatus;
  };
  task: string;
  branch: string;
  commits: CommitInfo[];
  changedFiles: LogicalChange[];
  logicalChanges: IntentRecord[];
  tests: TestEvidence[];
  risks: string[];
  limitations: string[];
  agentMetadata: {
    toolCalls: number;
    commands: number;
    checkpoints: number;
    tests: number;
    events: number;
  };
  generatedAt: string;
  /** GitHub Draft PR review state (MVP stage 3). */
  github?: ChangePackageGithub;
}

export type InlineCommentStatus = "preview" | "published" | "outdated" | "skipped";
export type ChangePackageGithubStatus = "not_published" | "preview_ready" | "published" | "outdated";

export interface InlineCommentState {
  logicalChangeId: string;
  path: string;
  line: number | null;
  side: "RIGHT";
  githubCommentId?: number | undefined;
  githubReviewId?: number | undefined;
  status: InlineCommentStatus;
  skipReason?: string | undefined;
}

export interface ChangePackageGithub {
  repository: string | null;
  baseBranch: string;
  headBranch: string;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  headCommit: string | null;
  status: ChangePackageGithubStatus;
  inlineComments: InlineCommentState[];
}
