---
name: agent-review
description: >
  Track your work with the Agent Review workflow: start a review session before
  a feature, record structured intents for logical changes, take checkpoints,
  run tests with evidence, and build the review package at the end.
  Use at the start of every feature task in this repository.
license: AGPL-3.0
compatibility: opencode, claude-code
metadata:
  audience: coding-agents
  workflow: agent-review
---

## What I do

Instruct you to drive the `agent_review_*` tools so that every feature arc leaves
a verifiable, local, human-readable review trail.

Tool names: in OpenCode the tools are registered as `agent_review_<name>`; in
Claude Code they come from the `agent-review` MCP server and appear as
`mcp__agent-review__agent_review_<name>`. The workflow below uses the short
names for both. Edits and shell commands are journaled automatically (OpenCode
plugin hooks / Claude Code `PostToolUse` hook) while a session is active.

## When to use me

At the START of a feature task, and throughout, as follows.

## Workflow

1. **Start** — call `agent_review_start` with the task description.
   - If the tool answers `confirmation-required`, you are on a protected branch
     (`main`/`master`/`develop`). Tell the user the proposed branch name
     (`agent/<task-slug>`) and ask for approval. Only after the user agrees,
     re-invoke with `confirm: true`. Never create the branch unconfirmed.
   - If the tool reports a dirty working tree, warn the user; never reset.
2. **Checkpoint** — call `agent_review_checkpoint` before and after meaningful
   units of work (e.g. before risky edits, after a feature compiles).
3. **Record intents** — for every logical change call
   `agent_review_record_intent`: entity, files, change kind, the reason, the
   expected behavior, the risk level, alternatives and limitations.
   This is structured evidence, NOT reasoning — record only explicit decisions
   and verifiable facts. No chain-of-thought.
4. **Tests** — call `agent_review_run_tests` with a single explicit command
   (e.g. `npm test`, `bundle exec rspec`). Show the command to the user in your
   message. Never pass destructive or network-fetching commands.
5. **Build** — when the feature is done, call `agent_review_build_package`.
   This writes `.agent-review/change-package.json` and `.agent-review/review.md`
   and finalizes the session. Show the user the review summary (risks, test
   results, changed files).
6. **Status** — `agent_review_status` at any point to inspect the session.
7. **Rollback** — `agent_review_rollback` without args lists checkpoints.
   To restore, get explicit user approval first, then call with `checkpointId`
   and `confirm: true`. The plugin never deletes files and never runs
   `git reset` — it restores only the snapshotted files, after taking a safety
   checkpoint.
8. **GitHub Draft PR review (opt-in, MVP stage 3)** — after
   `agent_review_build_package`:
   - Call `agent_review_prepare_pr` (LOCAL ONLY — never pushes, never creates
     PRs). It maps logical changes to PR-diff lines and writes previews under
     `.agent-review/github/`.
   - Show the user: branch, proposed PR title, summary counts, the
     inline-comment list (path:line), risks, limitations. Then ask EXACTLY:
     «Создать commit, push branch, Draft PR и опубликовать N review comments?»
   - Only after an unambiguous confirmation call `agent_review_publish_pr`
     with `allowCommit: true, allowPush: true, confirmed: true`. Never publish
     automatically. If `gh` is missing or unauthenticated, tell the user:
     «Для публикации PR выполните: gh auth login» — and keep the local
     artifacts.
   - After publishing show the PR URL and a short report: PR created or
     reused; how many comments were published; which were skipped and why.
   - After a later commit/push on the same PR, use
     `agent_review_update_github_review` (also `confirmed: true` only). It
     replaces ONLY the plugin's own marker-carrying comments — never touch
     human or other-bot comments.

## Constraints you must respect

- GitHub publishing is opt-in and confirmed: no `confirmed: true`, no external
  action. Draft PRs only; never force-push, never merge, never duplicate a PR.
- When GitHub is disabled in config, status/prepare stay available;
  publishing hard-fails with a clear message.
- All local data stays under `.agent-review/`; secrets are redacted
  automatically, but do not paste secrets into intents.
- The PR summary and inline comments are review CONTEXT, not guarantees of
  correctness.
