import fs from "node:fs/promises";
import path from "node:path";
import type { ChangeKind, LogicalChange } from "./types.ts";
import { changedFilePaths, diffNameOnly, gitStatusShort } from "./git.ts";
import { REVIEW_DIR_NAME } from "./paths.ts";

/**
 * Extensible seam for future AST-based analysis (Tree-sitter etc.).
 * The MVP implementation is Git-only.
 */
export interface ChangeAnalyzer {
  analyze(projectRoot: string, base?: string): Promise<LogicalChange[]>;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".rb": "ruby",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".sh": "shell",
  ".sql": "sql",
  ".css": "css",
  ".html": "html",
};

export function detectLanguage(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return LANGUAGE_BY_EXTENSION[extension] ?? "unknown";
}

function statusToKind(status: string): ChangeKind {
  if (status.startsWith("??") || status.startsWith("A")) return "added";
  if (status.startsWith("D")) return "removed";
  return "modified";
}

/** Cheap symbol hints for supported languages. Regex-only, no AST. */
const SYMBOL_PATTERNS: Array<{ language: string; pattern: RegExp }> = [
  { language: "typescript", pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm },
  { language: "typescript", pattern: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/gm },
  { language: "typescript", pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/gm },
  { language: "javascript", pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm },
  { language: "javascript", pattern: /^\s*(?:export\s+)?class\s+([A-Za-z0-9_$]+)/gm },
  { language: "ruby", pattern: /^\s*(?:def\s+([a-zA-Z0-9_?!=]+)|(?:class|module)\s+([A-Z][A-Za-z0-9_]*))/gm },
  { language: "python", pattern: /^\s*(?:def\s+([a-zA-Z0-9_]+)|class\s+([A-Za-z0-9_]+))/gm },
  { language: "rust", pattern: /^\s*(?:fn\s+([a-z_A-Z0-9]+)|(?:struct|enum|trait)\s+([A-Z][A-Za-z0-9_]*))/gm },
  { language: "go", pattern: /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z0-9_]+)/gm },
];

async function extractSymbols(filePath: string, language: string): Promise<string[]> {
  const supported = SYMBOL_PATTERNS.filter((entry) => entry.language === language);
  if (supported.length === 0) return [];
  let content: string;
  try {
    content = await fs.readFile(path.resolve(filePath), "utf8");
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const { pattern } of supported) {
    for (const match of content.matchAll(pattern)) {
      const name = match[1] ?? match[2];
      if (name) names.add(name);
    }
  }
  return [...names].slice(0, 10);
}

export class GitChangeAnalyzer implements ChangeAnalyzer {
  async analyze(projectRoot: string, base?: string): Promise<LogicalChange[]> {
    const statusLines = await gitStatusShort(projectRoot);
    const workingKindByPath = new Map<string, ChangeKind>();
    for (const line of statusLines) {
      const kind = statusToKind(line);
      const rest = line.slice(3).trim();
      if (!rest || rest.startsWith(REVIEW_DIR_NAME + "/") || rest === REVIEW_DIR_NAME) continue;
      const rename = /^(.+) -> (.+)$/.exec(rest);
      workingKindByPath.set(rename ? rename[2]!.trim() : rest, kind);
    }

    const committedPaths = base ? await diffNameOnly(projectRoot, base) : [];
    const allPaths = [...new Set([...workingKindByPath.keys(), ...committedPaths])];

    const numstat = await numstatByPath(projectRoot, base);

    const changes: LogicalChange[] = [];
    for (const filePath of allPaths) {
      const kind = workingKindByPath.get(filePath) ?? "modified";
      const language = detectLanguage(filePath);
      const stats = numstat.get(filePath) ?? { insertions: 0, deletions: 0 };
      const change: LogicalChange = {
        path: filePath,
        kind,
        language,
        insertions: stats.insertions,
        deletions: stats.deletions,
      };
      // Untracked files never appear in numstat — approximate insertions by line count.
      if (kind === "added" && stats.insertions === 0 && stats.deletions === 0) {
        change.insertions = await countLines(path.join(projectRoot, filePath));
      }
      if (kind !== "removed") {
        const symbols = await extractSymbols(path.join(projectRoot, filePath), language);
        if (symbols.length > 0) change.symbols = symbols;
      }
      changes.push(change);
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }
}

async function countLines(filePath: string): Promise<number> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  } catch {
    return 0;
  }
}

async function numstatByPath(
  projectRoot: string,
  base: string = "HEAD",
): Promise<Map<string, { insertions: number; deletions: number }>> {
  const { runCommand } = await import("./git.ts");
  const result = await runCommand(projectRoot, "git", ["diff", "--numstat", base]);
  const map = new Map<string, { insertions: number; deletions: number }>();
  if (result.code !== 0) return map;
  for (const line of result.stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [insertions, deletions, filePath] = parts as [string, string, string];
    const rename = /^(.+) => (.+)$/.exec(filePath);
    const target = (rename ? rename[2]! : filePath).trim();
    map.set(target, {
      insertions: insertions === "-" ? 0 : Number.parseInt(insertions ?? "0", 10) || 0,
      deletions: deletions === "-" ? 0 : Number.parseInt(deletions ?? "0", 10) || 0,
    });
  }
  return map;
}

export const defaultAnalyzer: ChangeAnalyzer = new GitChangeAnalyzer();
