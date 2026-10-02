/**
 * Generated-file and lockfile filtering, and formatting-only/rename detection.
 * Never comment on noise: these gates run before any inline comment is selected.
 */

const GENERATED_PATTERNS: RegExp[] = [
  /\.min\.(js|css|mjs|cjs)$/i,
  /(?:^|\/)dist\//,
  /(?:^|\/)coverage\//,
  /(?:^|\/)build\//,
  /(?:^|\/)out\//,
  /\.snap$/,
  /\.map$/,
  /(?:^|\/)vendor\//,
  /(?:^|\/)node_modules\//,
  /-pkg\.el$/,
  /(?:^|\/)compiled\//,
];

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Gemfile.lock",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "composer.lock",
  "go.sum",
  "mix.lock",
  "Podfile.lock",
]);

export function isGeneratedFile(path: string): boolean {
  return GENERATED_PATTERNS.some((pattern) => pattern.test(path));
}

export function isLockfile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return LOCKFILE_NAMES.has(base);
}

/** Heuristic: an intent that only renames/formats/lints carries no semantic review value. */
export function isFormattingOnlyIntent(intent: { reason: string; entity: string; changeKind: string }): boolean {
  const text = `${intent.entity} ${intent.reason}`.toLowerCase();
  const noise = /\b(re-?format|formatting|whitespace|rename|renamed|re-?indent|lint autofix|typo|cosmetic|code style|prettier|clang-format|sort imports)\b/;
  return noise.test(text);
}
