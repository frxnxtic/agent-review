#!/usr/bin/env node
// Re-execs node with --experimental-strip-types for the TS entry src/claude-hook.ts.
// --no-warnings keeps the strip-types notice off stderr; stdio is passed through.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "claude-hook.ts");
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
