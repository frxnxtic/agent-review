import type { AgentSession } from "./types.ts";
import { getActiveSession, loadSession } from "./session.ts";
import { countEvents, readEventsOfType } from "./events.ts";
import { listCheckpoints } from "./checkpoints.ts";
import { changedFilePaths, currentBranch } from "./git.ts";

export interface SessionStatusReport {
  active: boolean;
  session: AgentSession | null;
  branch: string | null;
  events: number;
  checkpoints: number;
  intents: number;
  tests: number;
  changedFiles: string[];
  changePackageExists: boolean;
}

import fs from "node:fs/promises";
import { reviewFile } from "./paths.ts";

export async function getSessionStatus(projectRoot: string): Promise<SessionStatusReport> {
  const session = await getActiveSession(projectRoot);
  const anySession = await loadSession(projectRoot);
  const sessionId = session?.id;
  let changePackageExists = false;
  try {
    await fs.access(reviewFile(projectRoot, "changePackage"));
    changePackageExists = true;
  } catch {
    changePackageExists = false;
  }

  return {
    active: session !== null,
    session: anySession,
    branch: await currentBranch(projectRoot),
    events: await countEvents(projectRoot),
    checkpoints: (await listCheckpoints(projectRoot)).length,
    intents: await readEventsOfType(projectRoot, "intent.recorded", sessionId).then((events) => events.length),
    tests: await readEventsOfType(projectRoot, "test.completed", sessionId).then((events) => events.length),
    changedFiles: await changedFilePaths(projectRoot),
    changePackageExists,
  };
}
