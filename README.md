# Agent Review

**Local, verifiable review trails for AI coding agents.**

When an AI agent builds a feature for you, the diff shows *what* changed but not
*why*, which tests actually ran, or what risks the agent knew about. Agent
Review records that evidence while the agent works and turns it into a review
package you (and your reviewers) can trust:

- a review **session** bound to a task and a git branch;
- an append-only **event journal** of edits and commands;
- restorable **checkpoints** (file snapshots, never `git reset`);
- structured **intents** per logical change: what, why, expected behavior,
  risk, alternatives, limitations;
- **test evidence**: exact command, exit code, duration, capped and redacted output;
- a machine-readable **Change Package** (`change-package.json`, schema `agent-review/v1`)
  and a human-readable **`review.md`**;
- optional: a **GitHub Draft PR** with a summary and a few inline comments placed
  on the exact diff lines they explain.

It runs on plain Git with no backend, no GitHub App and no extra VCS. Everything
stays on your machine until you explicitly confirm a publish.

Works with **[OpenCode](https://opencode.ai)** (native plugin) and
**[Claude Code](https://claude.com/claude-code)** (and any other MCP host) via
an MCP stdio server.

## Example output

An excerpt of a generated `review.md` (from `npm run demo`):

```markdown
## Logical Changes

### 1. refresh token rotation
- What changed: added in `src/token.ts`
- Why: refresh tokens were static; rotation limits replay windows
- Expected behavior: every refresh rotates the token
- Risk: medium

## Test Evidence

### Run 1
- Command: `npm test`
- Result: **passed** (exit code: 0)
- Duration: 412 ms

## Risks
- Branch was created from protected branch "main".
```

## Safety model

Agent Review is built to be safe to hand to an autonomous agent:

- **No destructive git.** It never runs `reset --hard`, `clean`, force-push,
  history rewrites or branch deletion. Rollback restores snapshotted files only,
  after taking a safety checkpoint, and never deletes files.
- **Confirmation gates.** Creating a branch from a protected branch
  (`main`/`master`/`develop`), restoring a checkpoint, and every GitHub publish
  require an explicit `confirm`/`confirmed: true` passed after the user agrees.
  Without it the tools only return a preview.
- **Evidence, not reasoning.** Only observed facts, explicit decisions, command
  results and statically computed risks are recorded. No chain-of-thought.
- **Redaction.** Tokens, keys and credentials are redacted before anything is
  written to the journal or the package; test output is size-capped.
- **No code leaves the machine** for comment generation; GitHub publishing goes
  through your own authenticated `gh` CLI only.
- **Restricted test runner.** `run_tests` takes a single command with no shell
  metacharacters and rejects destructive programs.

## Install

Requirements: Git, Node ≥ 22.6, and for GitHub publishing the
[GitHub CLI](https://cli.github.com) (`gh auth login`).

```bash
git clone https://github.com/frxnxtic/agent-review.git
cd agent-review
npm install
```

### Claude Code (or any MCP host)

1. Register the MCP server in your project's `.mcp.json`:

   ```json
   {
     "mcpServers": {
       "agent-review": {
         "command": "node",
         "args": ["/abs/path/to/agent-review/bin/agent-review-mcp.js"]
       }
     }
   }
   ```

2. Add the journaling hook to `.claude/settings.json`. It records edits and
   shell commands, but only while a review session is active:

   ```json
   {
     "hooks": {
       "PostToolUse": [
         {
           "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
           "hooks": [
             { "type": "command", "command": "node /abs/path/to/agent-review/bin/agent-review-claude-hook.js", "timeout": 10 }
           ]
         }
       ]
     }
   }
   ```

3. Add the skill that teaches the agent the workflow:

   ```bash
   mkdir -p .claude/skills
   ln -s /abs/path/to/agent-review/skills/agent-review .claude/skills/agent-review
   ```

4. Restart Claude Code. The tools appear as `mcp__agent-review__agent_review_*`.

The project root is resolved from `AGENT_REVIEW_PROJECT_ROOT`, then
`CLAUDE_PROJECT_DIR`, then the server's working directory.

### OpenCode

Symlink the plugin and the skill into your project (file symlinks in
`.opencode/plugins/` load like regular plugin files), then restart OpenCode:

```bash
ln -s /abs/path/to/agent-review/src/plugin.ts .opencode/plugins/agent-review.ts
ln -s /abs/path/to/agent-review/skills/agent-review .opencode/skills/agent-review
```

The plugin journals file edits and tool calls through OpenCode's own hooks.

## Tools

| Tool | What it does | Side effects |
|------|--------------|--------------|
| `agent_review_start` | Start a session for a task; propose an `agent/<slug>` branch when on a protected branch | Creates a branch only with `confirm: true` |
| `agent_review_checkpoint` | Record HEAD, status, changed files and a restorable snapshot | Local only |
| `agent_review_record_intent` | Record one logical change: entity, files, kind, reason, expected behavior, risk, alternatives, limitations | Local only |
| `agent_review_run_tests` | Run one explicit test command and store the evidence | Runs the command |
| `agent_review_build_package` | Write `change-package.json` and `review.md`; ends the session unless `keepActive: true` | Local only |
| `agent_review_status` | Show the session state and counts | Read-only |
| `agent_review_rollback` | List checkpoints, or restore one with `confirm: true` | Restores snapshotted files |
| `agent_review_github_status` | Check `gh` availability and auth, remote, branches, existing PR | Read-only |
| `agent_review_prepare_pr` | Build the PR body and inline-comment preview under `.agent-review/github/` | Local only |
| `agent_review_publish_pr` | Commit (opt-in), push, open a Draft PR, post the grouped review | **External**, only with `confirmed: true` |
| `agent_review_update_github_review` | After a new push, replace only Agent Review's own PR comments | **External**, only with `confirmed: true` |

## Typical workflow

1. **Start**: `agent_review_start { task }`. On a protected branch the tool
   proposes a branch name; after the user approves, call again with
   `confirm: true`. A dirty working tree is recorded as a risk, never reset.
2. **Work.** Take checkpoints before risky edits, and call
   `agent_review_record_intent` once per logical change.
3. **Test**: `agent_review_run_tests { command: "npm test", reason }`.
4. **Build**: `agent_review_build_package`, then read `.agent-review/review.md`.
5. **Optional PR**: `agent_review_prepare_pr`, show the preview to the user,
   then `agent_review_publish_pr { confirmed: true, allowPush: true }`.

Tip: if your working tree contains unrelated changes, commit your feature
yourself and publish with `allowCommit: false`. The tool's own commit step
stages everything (`git add -A`).

## GitHub Draft PR reviews

Enable publishing in `.agent-review/config.json` (`"github": { "enabled": true }`).
With it disabled, `status` and `prepare-pr` still work and publishing fails.

- **Draft PRs only** by default. It never merges, never changes the base branch,
  never assigns reviewers or labels, and reuses an existing open PR instead of
  creating a duplicate.
- **Inline comments** attach only to added lines of the current PR diff, at most
  one per logical change, capped by `maxInlineComments` (default 8). They skip
  generated files, lockfiles and formatting-only changes. A change with no
  mappable line becomes a note in the PR body; the mapper never guesses.
- **Updates are surgical.** Each comment carries a hidden marker
  (`agent-review:session=…;change=…`); after a new push, only Agent Review's own
  comments are replaced. Human and other-bot comments are never touched.
- The summary and comments are **review context, not guarantees of correctness**.

Manual end-to-end test guide: [docs/manual-github-test.md](docs/manual-github-test.md).

## CLI

The GitHub workflow is also available from the shell (run from your project
directory):

```bash
node /abs/path/to/agent-review/bin/agent-review.js github status [--base main]
node /abs/path/to/agent-review/bin/agent-review.js github prepare-pr [--base main] [--max 8]
node /abs/path/to/agent-review/bin/agent-review.js github publish-pr [--allow-commit] [--allow-push] [--no-draft] --confirm
node /abs/path/to/agent-review/bin/agent-review.js github update-review [--pr <n>] --confirm
```

Nothing is published without `--confirm`.

## Where data lives

```
.agent-review/
├── config.json          # committable configuration
├── change-package.json  # committable review artifact
├── review.md            # committable review summary
├── github/              # committable PR preview artifacts
├── events.jsonl         # gitignored journal (append-only)
├── session.json         # gitignored current/last session
├── checkpoints/         # gitignored checkpoint metadata
└── snapshots/           # gitignored file snapshots
```

Add the runtime files to your project's `.gitignore`:

```gitignore
/.agent-review/events.jsonl
/.agent-review/session.json
/.agent-review/checkpoints/
/.agent-review/snapshots/
```

## Configuration

`.agent-review/config.json` is created on first use:

| Key | Default | Meaning |
|-----|---------|---------|
| `protectedBranches` | `["main","master","develop"]` | Branches that need confirmation before branching off |
| `branchPrefix` | `"agent/"` | Prefix for proposed branch names |
| `maxCapturedOutputBytes` | `10240` | Cap on stored test output |
| `maxDiffBytesPerFile` | `20480` | Cap on per-file diff embedded in the package |
| `includeDiffInPackageByDefault` | `true` | Embed the diff into `change-package.json` |
| `redactionEnabled` | `true` | Redact secrets before writing anything |
| `github.enabled` | `false` | Allow publishing |
| `github.maxInlineComments` | `8` | Inline comment cap per PR |
| `github.updateMode` | `"replace-agent-comments"` | How updates treat previous comments |

## Limitations

- Snapshots cover only files that were changed at checkpoint time.
- Symbol extraction is regex-based, not AST-based.
- The Change Package reflects the working tree, so uncommitted unrelated changes
  are counted; the dirty state at session start is recorded as a risk.
- Automatic journaling depends on host hooks (OpenCode plugin hooks, Claude Code
  `PostToolUse`); other MCP hosts get the tools without automatic journaling.

## Development

```bash
npm run typecheck         # tsc --noEmit
npm test                  # unit + mock-integration tests (node --test)
npm run test:integration  # full local arc + mock-GitHub publish arc
npm run demo              # runs a demo arc and prints review.md
```

Domain logic lives in `src/*.ts`. The host adapters are `src/plugin.ts`
(OpenCode), `src/mcp.ts` (MCP server) and `src/claude-hook.ts` (Claude Code
hook), all built on the shared handlers in `src/handlers.ts`.

## License

[AGPL-3.0](LICENSE)
