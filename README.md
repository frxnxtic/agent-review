# Agent Review

OpenCode plugin that tracks AI agent work on a feature, records verifiable facts
about the session locally, and builds a human-readable review package.

The agent develops as usual; the plugin observes and records:

- a review **session** (task, branches, git state);
- an append-only **event journal** (`events.jsonl`);
- local **checkpoints** with restorable file snapshots;
- structured **intents** (what changed, why, expected behavior, risk);
- **test evidence** (command, exit code, duration, capped redacted output);
- a machine-readable **Change Package** (`change-package.json`, `agent-review/v1`);
- a human-readable **review.md** summary.

Runs on plain Git. No new VCS, no GitHub App, no backend server.

## What it deliberately does NOT do (MVP limits)

- No automatic push, merge, or PR creation; no GitHub comments.
- No destructive git operations — no `reset --hard`, `clean`, force push, branch deletion.
- No chain-of-thought recording — only structured explanations, observed facts,
  command results, test results and statically computed risks.
- Nothing leaves the machine; all data lives in `.agent-review/`.
- The GitHub adapter (`src/github.ts`) is an honest stub that throws — future work.

## Install

Requirements: OpenCode ≥ 1.18, Node ≥ 22.6 (tests only; the plugin itself runs
inside OpenCode's embedded Bun runtime).

```bash
git clone https://github.com/frxnxtic/agent-review.git
cd agent-review
npm install
```

## Connect to OpenCode

Symlink the plugin entry into the project's plugin directory (file symlinks in
`.opencode/plugins/` are loaded like regular plugin files):

```bash
ln -s "$PWD/src/plugin.ts" /path/to/your-project/.opencode/plugins/agent-review.ts
ln -s "$PWD/skills/agent-review" /path/to/your-project/.opencode/skills/agent-review
```

Restart OpenCode — the plugin loads automatically at startup and registers seven
tools: `agent_review_start`, `agent_review_checkpoint`,
`agent_review_record_intent`, `agent_review_run_tests`,
`agent_review_build_package`, `agent_review_status`, `agent_review_rollback`.

The skill (`.opencode/skills/agent-review/SKILL.md`) teaches the agent when and
how to call them.

## Connect to Claude Code

The same tools are exposed by an MCP stdio server (`src/mcp.ts`), and a
`PostToolUse` hook (`src/claude-hook.ts`) replaces the plugin's journaling hooks.
Run `npm install` here first (adds `@modelcontextprotocol/sdk`), then in the host
project:

```bash
mkdir -p .claude/skills
ln -s "$PWD/skills/agent-review" /path/to/your-project/.claude/skills/agent-review
```

`.mcp.json` in the host project:

```json
{ "mcpServers": { "agent-review": { "command": "node", "args": ["/abs/path/agent-review/bin/agent-review-mcp.js"] } } }
```

`.claude/settings.json` hook (journals Edit/Write/Bash while a session is active):

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
  "hooks": [ { "type": "command", "command": "node /abs/path/agent-review/bin/agent-review-claude-hook.js" } ] } ] } }
```

The project root is `AGENT_REVIEW_PROJECT_ROOT`, else `CLAUDE_PROJECT_DIR`, else
the process cwd. In Claude Code the tools are named
`mcp__agent-review__agent_review_*`.

## Usage (typical arc)

1. **Start**: `agent_review_start { task }`.
   On a protected branch (`main`/`master`/`develop`) the tool answers
   `confirmation-required` with a proposed `agent/<task-slug>` branch; after the
   user approves, re-invoke with `confirm: true`. A dirty working tree is
   recorded and warned about — never reset.
2. **Checkpoint**: `agent_review_checkpoint { reason }` — HEAD, status, changed
   files and a restorable snapshot under `.agent-review/snapshots/`.
3. **Record intent**: `agent_review_record_intent { entity, files, changeKind,
   reason, expectedBehavior, risk, alternatives, limitations }`.
4. **Tests**: `agent_review_run_tests { command, reason }` — single command, no
   shell metacharacters, destructive programs rejected, output capped and
   redacted.
5. **Build**: `agent_review_build_package { includeDiff? }` — writes
   `.agent-review/change-package.json` and `.agent-review/review.md`, and
   finalizes the session (pass `keepActive: true` to keep it open).
6. **Status / Rollback**: `agent_review_status` anytime;
   `agent_review_rollback` lists checkpoints, and restoring a chosen one
   requires `confirm: true`, takes a safety checkpoint first, restores only the
   snapshotted files, and never deletes anything.

## Where data lives

```
.agent-review/
├── config.json          # committable configuration
├── change-package.json  # committable review artifact
├── review.md            # committable review summary
├── events.jsonl         # gitignored journal (append-only)
├── session.json         # gitignored current/last session
├── checkpoints/         # gitignored checkpoint metadata
└── snapshots/           # gitignored file snapshots
```

Commit `config.json`, `change-package.json` and `review.md` when you want the
review trail in git; the journal and snapshots stay local. Host projects should
gitignore the runtime files (see this repo's `.gitignore`).

## GitHub Draft PR Reviews

MVP stage 3 adds an opt-in GitHub adapter (`GhCliGitHubAdapter`, `src/github/`)
that turns a built Change Package into a Draft PR with a readable summary and a
small number of inline comments on meaningful diff lines.

- **Disabled by default** — enable in `.agent-review/config.json`:
  `"github": { "enabled": true }`. With it disabled, `status`/`prepare-pr`
  stay available (read-only / local-only); publishing hard-fails.
- **Needs the GitHub CLI** — the adapter shells out to `gh` only (no REST
  client, no tokens in the plugin). Run `gh auth login` first; if gh is missing
  or unauthenticated the tools fail safely with
  «Для публикации PR выполните: gh auth login» and keep all local artifacts.
- **Publishing always requires confirmation** — `agent_review_publish_pr`
  performs nothing unless `confirmed: true` was passed after an explicit user
  approval; the same applies to `agent_review_update_github_review`.
- The plugin creates ordinary branches, commits and **Draft PRs**; it never
  force-pushes, never rewrites history, never merges, never changes the base
  branch, never auto-assigns reviewers or labels, and never duplicates an
  existing open PR for the branch.
- Inline comments attach **only to lines of the current PR diff** (added lines,
  RIGHT side), capped at `maxInlineComments` (default 8), never on generated
  files, lockfiles or formatting-only changes, never more than one per logical
  change. Changes without a mappable diff line become a file-level note in the
  PR body instead — the mapper never guesses.
- Comments carry a hidden HTML marker (`agent-review:session=…;change=…`).
  After a new push, the update workflow replaces **only the plugin's own**
  comments (config `updateMode: "replace-agent-comments"`); human and
  other-bot comments are never touched.
- The PR summary and inline comments are review **CONTEXT, not guarantees of
  correctness**. No source code is sent to any external LLM/API for comment
  generation; all captured output passes the existing redaction before any
  artifact is written, and credentials never land in `events.jsonl`,
  `session.json`, `review.md` or `change-package.json`.
- CLI: `agent-review github status | prepare-pr | publish-pr | update-review`
  (see `bin/agent-review.js`; `--confirm` required for publishing).
- Manual test guide: [docs/manual-github-test.md](docs/manual-github-test.md).

## Tests

```bash
npm run typecheck         # tsc --noEmit
npm test                  # unit + mock-integration tests (node --test)
npm run test:integration  # full local arc + mock-GitHub publish arc
npm run demo              # same arc as a demo project, prints review.md
```
