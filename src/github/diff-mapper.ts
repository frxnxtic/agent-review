/**
 * PullRequestDiffMapper — maps logical changes onto concrete PR-diff lines.
 * Only lines inside ADDED hunks of the RIGHT (head) side qualify. If a logical
 * change cannot be mapped to an exact changed line, the mapper does NOT guess:
 * the change falls back to a file-level section in the PR body + a limitation.
 */
import type { IntentRecord } from "../types.ts";
import { git } from "../git.ts";
import { isGeneratedFile, isLockfile } from "./filters.ts";

export interface InlineCommentCandidate {
  logicalChangeId: string;
  path: string;
  line: number;
  side: "RIGHT";
}

export interface UnmappedChange {
  logicalChangeId: string;
  entity: string;
  path: string;
  reason: string;
}

export interface DiffMapping {
  candidates: InlineCommentCandidate[];
  unmapped: UnmappedChange[];
}

export interface PullRequestDiffMapper {
  map(logicalChanges: IntentRecord[], baseRef: string, headRef: string): Promise<DiffMapping>;
}

export interface DiffMapperOptions {
  skipGeneratedFiles?: boolean | undefined;
  skipLockfiles?: boolean | undefined;
}

/** Parses one unified diff and returns head-side line numbers of added lines. */
export function addedLinesInDiff(diff: string): { path: string | null; lines: number[] } {
  const lines: number[] = [];
  let path: string | null = null;
  let newLine = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(raw);
    if (fileMatch) {
      path = fileMatch[1]!;
      continue;
    }
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]!);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+")) {
      lines.push(newLine);
      newLine++;
    } else if (raw.startsWith("-") || raw.startsWith("\\")) {
      // deleted line or "\ No newline" — head line number does not move
    } else if (raw.startsWith(" ")) {
      newLine++;
    } else if (raw.startsWith("diff ") || raw === "") {
      inHunk = false;
    }
  }
  return { path, lines };
}

export class GitDiffMapper implements PullRequestDiffMapper {
  private readonly projectRoot: string;
  private readonly options: DiffMapperOptions;

  constructor(projectRoot: string, options: DiffMapperOptions = {}) {
    this.projectRoot = projectRoot;
    this.options = options;
  }

  async map(logicalChanges: IntentRecord[], baseRef: string, headRef: string): Promise<DiffMapping> {
    // `git diff <base>` (working tree) is used when headRef is the current HEAD so
    // that uncommitted-but-built packages still map; for an explicit head SHA the
    // three-dot committed range is used. Both stay read-only.
    const range = headRef === "HEAD" ? baseRef : `${baseRef}...${headRef}`;
    const nameOnly = await git(this.projectRoot, ["diff", "--name-only", range]);
    const changedFiles = new Set(
      nameOnly.code === 0
        ? nameOnly.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
        : [],
    );

    const candidates: InlineCommentCandidate[] = [];
    const unmapped: UnmappedChange[] = [];
    const patchCache = new Map<string, number[]>();

    const patchLines = async (path: string): Promise<number[]> => {
      const cached = patchCache.get(path);
      if (cached) return cached;
      const patch = await git(this.projectRoot, ["diff", "--unified=3", range, "--", path], 512 * 1024);
      const parsed = patch.code === 0 ? addedLinesInDiff(patch.stdout) : { lines: [] };
      const sorted = [...parsed.lines].sort((a, b) => a - b);
      patchCache.set(path, sorted);
      return sorted;
    };

    for (const change of logicalChanges) {
      for (const file of change.files) {
        if (!changedFiles.has(file)) continue;
        if (this.options.skipGeneratedFiles !== false && isGeneratedFile(file)) {
          unmapped.push({ logicalChangeId: change.id, entity: change.entity, path: file, reason: "generated file excluded from inline comments" });
          continue;
        }
        if (this.options.skipLockfiles !== false && isLockfile(file)) {
          unmapped.push({ logicalChangeId: change.id, entity: change.entity, path: file, reason: "lockfile excluded from inline comments" });
          continue;
        }
        const lines = await patchLines(file);
        if (lines.length === 0) {
          unmapped.push({ logicalChangeId: change.id, entity: change.entity, path: file, reason: "no added line for this file in the PR diff (deletions and renames are not commented in MVP)" });
          continue;
        }
        candidates.push({ logicalChangeId: change.id, path: file, line: lines[0]!, side: "RIGHT" });
        break; // one file per logical change — never the same change twice
      }
    }
    return { candidates, unmapped };
  }
}

/** Convenience wrapper used by tests: the first added head-side line of a diff text. */
export function firstAddedLine(diff: string): number | null {
  return addedLinesInDiff(diff).lines[0] ?? null;
}
