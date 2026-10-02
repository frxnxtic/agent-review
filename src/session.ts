import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { AgentSession, Checkpoint, SessionStatus } from "./types.ts";
import { REVIEW_FILES, reviewDir, reviewFile } from "./paths.ts";
import { changedFilePaths, currentBranch, gitHead, gitStatusShort, isGitRepo } from "./git.ts";
import { makeEvent, appendEvent } from "./events.ts";
import { resolveWorkingBranch, type BranchDecision } from "./branch.ts";
import { createCheckpoint } from "./checkpoints.ts";

export class AgentReviewError extends Error {
  code:
    | "GIT_UNAVAILABLE"
    | "SESSION_ACTIVE"
    | "NO_ACTIVE_SESSION"
    | "PROTECTED_BRANCH"
    | "BRANCH_EXISTS"
    | "DETACHED_HEAD"
    | "INVALID_INPUT"
    | "NOT_FOUND";

  constructor(code: AgentReviewError["code"], message: string) {
    super(message);
    this.name = "AgentReviewError";
    this.code = code;
  }
}

export async function sessionFileExists(projectRoot: string): Promise<boolean> {
  try {
    await fs.access(reviewFile(projectRoot, "session"));
    return true;
  } catch {
    return false;
  }
}

export async function loadSession(projectRoot: string): Promise<AgentSession | null> {
  try {
    return JSON.parse(await fs.readFile(reviewFile(projectRoot, "session"), "utf8")) as AgentSession;
  } catch {
    return null;
  }
}

export async function saveSession(projectRoot: string, session: AgentSession): Promise<void> {
  await fs.mkdir(reviewDir(projectRoot), { recursive: true });
  await fs.writeFile(reviewFile(projectRoot, "session"), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export async function getActiveSession(projectRoot: string): Promise<AgentSession | null> {
  const session = await loadSession(projectRoot);
  return session && session.status === "active" ? session : null;
}

export interface StartResult {
  session: AgentSession | null;
  checkpoint: Checkpoint | null;
  branchAction: BranchDecision;
  /** When set, the caller must surface this and ask the user before re-invoking with confirm. */
  confirmationRequired?: { proposedBranch: string; currentBranch: string };
  warning?: string;
}

/**
 * Starts a review session. Duplicate sessions are refused — call endSession
 * or build the package first. Protected branches are never left without an
 * explicit confirm flag, and a dirty working tree is recorded, never reset.
 */
export async function startSession(
  projectRoot: string,
  options: { task: string; branch?: string | undefined; autoCreateBranch?: boolean; confirm?: boolean },
): Promise<StartResult> {
  if (!options.task || options.task.trim().length === 0) {
    throw new AgentReviewError("INVALID_INPUT", "task is required");
  }
  if (!(await isGitRepo(projectRoot))) {
    throw new AgentReviewError("GIT_UNAVAILABLE", `not a git repository: ${projectRoot}`);
  }

  const existing = await loadSession(projectRoot);
  if (existing?.status === "active") {
    throw new AgentReviewError(
      "SESSION_ACTIVE",
      `session ${existing.id} is already active — finish it first (agent_review_build_package) or inspect with agent_review_status`,
    );
  }

  const branchBefore = await currentBranch(projectRoot);
  const branchAction = await resolveWorkingBranch(projectRoot, options);
  if (branchAction.action === "not-a-repo") {
    throw new AgentReviewError("GIT_UNAVAILABLE", `not a git repository: ${projectRoot}`);
  }
  if (branchAction.action === "error") {
    throw new AgentReviewError(
      branchAction.code === "BRANCH_EXISTS" ? "BRANCH_EXISTS" : "DETACHED_HEAD",
      branchAction.message,
    );
  }
  if (branchAction.action === "requires-confirmation") {
    return {
      session: null,
      checkpoint: null,
      branchAction,
      confirmationRequired: { proposedBranch: branchAction.proposedBranch, currentBranch: branchAction.currentBranch },
    };
  }

  const now = new Date().toISOString();
  const workingBranch = "branch" in branchAction ? branchAction.branch : branchBefore ?? "unknown";

  const session: AgentSession = {
    id: crypto.randomUUID(),
    projectRoot,
    startedAt: now,
    endedAt: null,
    initialBranch: branchBefore ?? workingBranch,
    workingBranch,
    initialHead: await gitHead(projectRoot),
    dirtyAtStart: await gitStatusShort(projectRoot),
    task: options.task.trim(),
    status: "active",
  };

  await saveSession(projectRoot, session);

  if (branchAction.action === "used-current") {
    await appendEvent(projectRoot, makeEvent("branch.checked", "session", { branch: workingBranch }, session.id));
  } else if (branchAction.action === "created") {
    await appendEvent(
      projectRoot,
      makeEvent(
        "branch.created",
        "session",
        { branch: branchAction.branch, fromProtected: branchAction.fromProtected },
        session.id,
      ),
    );
  } else if (branchAction.action === "switched") {
    await appendEvent(projectRoot, makeEvent("branch.checked", "session", { branch: branchAction.branch, switched: true }, session.id));
  }

  await appendEvent(
    projectRoot,
    makeEvent("session.started", "session", { task: session.task, dirtyAtStart: session.dirtyAtStart.length }, session.id),
  );

  const checkpoint = await createCheckpoint(projectRoot, session, "session start");
  const warning = session.dirtyAtStart.length
    ? `working tree has ${session.dirtyAtStart.length} uncommitted change(s) — recorded in session metadata, nothing was reset`
    : undefined;

  return { session, checkpoint, branchAction, warning };
}

export async function endSession(
  projectRoot: string,
  status: Exclude<SessionStatus, "active"> = "ended",
): Promise<AgentSession | null> {
  const session = await loadSession(projectRoot);
  if (!session || session.status !== "active") return null;
  session.status = status;
  session.endedAt = new Date().toISOString();
  await saveSession(projectRoot, session);
  await appendEvent(
    projectRoot,
    makeEvent("session.ended", "session", { status }, session.id),
  );
  return session;
}
