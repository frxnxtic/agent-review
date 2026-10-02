import fs from "node:fs/promises";
import path from "node:path";
import type { AgentSession, Checkpoint } from "./types.ts";
import { checkpointFile, checkpointsDir, snapshotDir } from "./paths.ts";
import { changedFilePaths, gitHead, gitStatusShort } from "./git.ts";
import { makeEvent, appendEvent } from "./events.ts";

export async function createCheckpoint(
  projectRoot: string,
  session: Pick<AgentSession, "id"> | null,
  reason: string,
): Promise<Checkpoint> {
  const id = crypto.randomUUID();
  const head = await gitHead(projectRoot);
  const status = await gitStatusShort(projectRoot);
  const files = await changedFilePaths(projectRoot);

  const destDir = snapshotDir(projectRoot, id);
  let restorable = true;
  let snapshotPath: string | null = null;
  try {
    await fs.mkdir(destDir, { recursive: true });
    for (const file of files) {
      const source = path.join(projectRoot, file);
      const target = path.join(destDir, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      try {
        await fs.copyFile(source, target);
      } catch {
        // Deleted file at checkpoint time: nothing to copy; the absence is the snapshot.
      }
    }
    snapshotPath = destDir;
  } catch {
    restorable = false;
  }

  const checkpoint: Checkpoint = {
    id,
    sessionId: session?.id ?? null,
    createdAt: new Date().toISOString(),
    reason,
    gitHead: head,
    gitStatus: status,
    changedFiles: files,
    snapshotPath,
    restorable,
  };

  await fs.mkdir(checkpointsDir(projectRoot), { recursive: true });
  await fs.writeFile(checkpointFile(projectRoot, id), `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  await appendEvent(
    projectRoot,
    makeEvent(
      "checkpoint.created",
      "checkpoint",
      { checkpointId: id, reason, changedFiles: files.length, restorable },
      session?.id ?? null,
    ),
  );
  return checkpoint;
}

export async function listCheckpoints(projectRoot: string): Promise<Checkpoint[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(checkpointsDir(projectRoot));
  } catch {
    return [];
  }
  const checkpoints: Checkpoint[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      checkpoints.push(JSON.parse(await fs.readFile(path.join(checkpointsDir(projectRoot), entry), "utf8")) as Checkpoint);
    } catch {
      // Skip unreadable checkpoint metadata.
    }
  }
  return checkpoints.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface RestoreResult {
  restored: string[];
  safetyCheckpointId: string;
  checkpointId: string;
}

/**
 * Restores ONLY the files captured in the checkpoint snapshot.
 * Never deletes files, never touches git index/HEAD, no destructive reset.
 * A fresh safety checkpoint is taken first so the restore itself is reversible.
 */
export async function restoreCheckpoint(projectRoot: string, checkpointId: string): Promise<RestoreResult> {
  const checkpoints = await listCheckpoints(projectRoot);
  const checkpoint = checkpoints.find((candidate) => candidate.id === checkpointId);
  if (!checkpoint) throw new Error(`checkpoint not found: ${checkpointId}`);
  if (!checkpoint.restorable || !checkpoint.snapshotPath) {
    throw new Error(`checkpoint ${checkpointId} has no restorable snapshot`);
  }

  const safety = await createCheckpoint(projectRoot, null, `pre-rollback safety (restore ${checkpointId})`);

  const snapshotFiles = await listSnapshotFiles(checkpoint.snapshotPath);
  for (const file of snapshotFiles) {
    const source = path.join(checkpoint.snapshotPath, file);
    const target = path.join(projectRoot, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }

  return { restored: snapshotFiles, safetyCheckpointId: safety.id, checkpointId };
}

async function listSnapshotFiles(snapshotPath: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files.push(path.relative(snapshotPath, full));
      }
    }
  };
  await walk(snapshotPath);
  return files.sort();
}
