#!/usr/bin/env node
// Tiny wrapper: re-execs node with --experimental-strip-types so the TS CLI
// entry works even when the interpreter is started without the flag.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const result = spawnSync(process.execPath, ["--experimental-strip-types", entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
