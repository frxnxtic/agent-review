# Manual GitHub test guide

End-to-end manual verification of the GitHub Draft PR Review adapter.
Everything before step 8 stays local; nothing is published without your
explicit confirmation.

1. **Private test repo** — create a private throwaway repository on GitHub
   (e.g. `<you>/agent-review-manual-test`) and clone it locally.
2. **Authenticate gh** — run `gh auth login` and follow the prompts. Verify
   with `gh auth status` and `gh --version`.
3. **Origin setup** — ensure `git remote get-url origin` resolves to the test
   repo (SSH `git@github.com:you/agent-review-manual-test.git` or HTTPS).
4. **Small feature via OpenCode** — in the repo, start a review session
   (`agent_review_start`), record one or two intents
   (`agent_review_record_intent` — one medium/high risk so an inline comment
   is selected), run a test (`agent_review_run_tests`), then build the package
   (`agent_review_build_package`).
5. **prepare-pr** — call `agent_review_prepare_pr` (or
   `agent-review github prepare-pr --base main`). Inspect
   `.agent-review/github/`: `pr-preview.json`, `pr-body.md`,
   `inline-comments.preview.json`, `publish-plan.md`. Check: bounded comment
   count (≤ 8), no lockfile/generated-file targets, redacted output.
6. **Inspect the preview with the user** — branch, proposed PR title, summary
   counts, inline-comment list (path:line), risks, limitations. The agent must
   ask exactly: «Создать commit, push branch, Draft PR и опубликовать N review
   comments?»
7. **Confirm** — only after your explicit yes, the agent calls
   `agent_review_publish_pr` with `allowCommit: true, allowPush: true,
   confirmed: true`. Without `confirmed: true` the tool must perform nothing
   (verify once: run it unconfirmed and check `gh pr list` stays empty).
8. **Draft PR appears** — a Draft PR opens on the test repo with the generated
   body (Summary / What changed / Evidence / Risks / Review guidance).
9. **Review + inline comments visible** — exactly ONE grouped review with the
   `Agent context` comments, each anchored to a real changed line; check
   `.agent-review/github/published.json` and `change-package.json → github`.
10. **Second commit/push** — make another change, commit and push, then run
    `agent_review_update_github_review` (confirm again). The updated grouped
    review replaces only the agent's own comments — no duplicates, human
    comments untouched.
11. **Cleanup** — close/delete the Draft PR and the private test repo.

Failure drills worth repeating once: `gh` removed from PATH, `gh auth logout`,
and a repo without a GitHub `origin` — all three must degrade to a clear
problem message (including «Для публикации PR выполните: gh auth login») with
all local artifacts intact.
