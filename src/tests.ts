import type { AgentSession, TestEvidence } from "./types.ts";
import { runCommand } from "./git.ts";
import { makeEvent, appendEvent } from "./events.ts";
import { loadOrCreateConfig } from "./config.ts";
import { redactAndTruncate } from "./redact.ts";
import fs from "node:fs/promises";
import path from "node:path";

/** Shell metacharacters — commands containing these are rejected outright. */
const METACHARACTERS = /[;&|`$><\\\n"']/;
const FORBIDDEN: RegExp[] = [
  /\brm\b/, /\brmdir\b/, /\bdd\b/, /mkfs/, /\bshred\b/,
  /\bgit\s+push\b/, /\bgit\s+reset\b/, /\bgit\s+clean\b/, /\bgit\s+rebase\b/,
  /\bsudo\b/, /\bshutdown\b/, /\breboot\b/,
  /\bcurl\b/, /\bwget\b/, /\bnpm\s+publish\b/,
  /\bdocker\s+(?:system\s+prune|rm)\b/,
];

export interface ParsedCommand {
  file: string;
  args: string[];
}

export type ParseCommandResult =
  | { ok: true; parsed: ParsedCommand }
  | { ok: false; error: string };

/** Parses a test command without a shell. Rejects metacharacters and destructive programs. */
export function parseTestCommand(command: string): ParseCommandResult {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, error: "command is empty" };
  if (METACHARACTERS.test(trimmed)) {
    return { ok: false, error: "shell metacharacters are not allowed — pass a single program with plain arguments" };
  }
  const parts = trimmed.split(/\s+/);
  const file = parts[0]!;
  const args = parts.slice(1);
  const whole = trimmed.toLowerCase();
  for (const pattern of FORBIDDEN) {
    if (pattern.test(whole)) {
      return { ok: false, error: `potentially destructive command rejected by policy: /${pattern.source}/` };
    }
  }
  return { ok: true, parsed: { file, args } };
}

export function evidenceStatus(exitCode: number | null): TestEvidence["status"] {
  if (exitCode === null) return "error";
  return exitCode === 0 ? "passed" : "failed";
}

/** Runs one explicitly provided test command and records full evidence. */
export async function runTestCommand(
  projectRoot: string,
  session: Pick<AgentSession, "id"> | null,
  command: string,
  reason: string,
): Promise<TestEvidence> {
  const parsed = parseTestCommand(command);
  if (!parsed.ok) throw new Error(parsed.error);

  const config = await loadOrCreateConfig(projectRoot);
  const startedAt = new Date().toISOString();
  await appendEvent(
    projectRoot,
    makeEvent("test.started", "tests", { command, reason }, session?.id ?? null),
  );

  const startedMs = Date.now();
  let result;
  try {
    result = await runCommand(projectRoot, parsed.parsed.file, parsed.parsed.args, config.maxCapturedOutputBytes);
  } catch (error) {
    const evidence: TestEvidence = {
      command,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      exitCode: null,
      status: "error",
      stdoutSummary: "",
      stderrSummary: error instanceof Error ? error.message : String(error),
      workingDirectory: projectRoot,
    };
    await appendEvent(projectRoot, makeEvent("test.completed", "tests", { ...evidence }, session?.id ?? null));
    return evidence;
  }
  const durationMs = Date.now() - startedMs;

  const stdout = redactAndTruncate(result.stdout, config.maxCapturedOutputBytes);
  const stderr = redactAndTruncate(result.stderr, config.maxCapturedOutputBytes);
  const evidence: TestEvidence = {
    command,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs,
    exitCode: result.code,
    status: evidenceStatus(result.code),
    stdoutSummary: stdout.text,
    stderrSummary: stderr.text,
    workingDirectory: projectRoot,
  };
  await appendEvent(
    projectRoot,
    makeEvent(
      "test.completed",
      "tests",
      { ...evidence, commandTruncated: stdout.truncated || stderr.truncated },
      session?.id ?? null,
    ),
  );
  return evidence;
}

export interface TestCommandProposal {
  command: string;
  source: string;
}

/**
 * Detects candidate test commands from project manifests.
 * Proposals only — nothing is ever auto-run.
 */
export async function detectTestCommands(projectRoot: string): Promise<TestCommandProposal[]> {
  const proposals: TestCommandProposal[] = [];

  try {
    const pkg = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
      if (/^(?:test|test:\w+|check|lint)$/.test(name)) {
        proposals.push({ command: `npm run ${name}`, source: "package.json scripts" });
      }
      void script;
    }
  } catch {
    // No package.json.
  }

  try {
    const makefile = await fs.readFile(path.join(projectRoot, "Makefile"), "utf8");
    if (/^test\s*:/m.test(makefile)) proposals.push({ command: "make test", source: "Makefile" });
  } catch {
    // No Makefile.
  }

  try {
    await fs.access(path.join(projectRoot, "Cargo.toml"));
    proposals.push({ command: "cargo test", source: "Cargo.toml" });
  } catch {
    // No Cargo.toml.
  }

  try {
    const pyproject = await fs.readFile(path.join(projectRoot, "pyproject.toml"), "utf8");
    if (/pytest/.test(pyproject)) proposals.push({ command: "pytest", source: "pyproject.toml" });
  } catch {
    // No pyproject.toml.
  }

  try {
    const gemfile = await fs.readFile(path.join(projectRoot, "Gemfile"), "utf8");
    if (/rspec/.test(gemfile)) proposals.push({ command: "bundle exec rspec", source: "Gemfile (rspec)" });
    if (/\brake\b/.test(gemfile) || /rails/.test(gemfile)) {
      proposals.push({ command: "bundle exec rake", source: "Gemfile (rake)" });
    }
  } catch {
    // No Gemfile.
  }

  return proposals;
}
