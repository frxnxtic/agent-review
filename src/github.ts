/**
 * GitHub integration (MVP stage 3) — facade.
 *
 * The concrete implementation is the GhCliGitHubAdapter (src/github/adapter.ts):
 * everything runs through the `gh` CLI; there is no REST/token client.
 * status/prepare are read-only or local-only; publish/update require
 * confirmed:true AND config.github.enabled — otherwise they hard-fail.
 */
export {
  GH_AUTH_MESSAGE,
  GhCliGitHubAdapter,
  type GitHubAdapter,
  type GitHubStatusResult,
  type PrepareInput,
  type PrepareResult,
  type PublishInput,
  type PublishResult,
  type UpdateInput,
  type UpdateResult,
} from "./github/adapter.ts";
export { parseGitHubRemote, type ParsedRemote } from "./github/remote.ts";
export { isGeneratedFile, isLockfile, isFormattingOnlyIntent } from "./github/filters.ts";
export { createMarker, parseMarker, type MarkerData } from "./github/marker.ts";
export {
  GitDiffMapper,
  addedLinesInDiff,
  firstAddedLine,
  type InlineCommentCandidate,
  type UnmappedChange,
  type DiffMapping,
  type PullRequestDiffMapper,
} from "./github/diff-mapper.ts";
export {
  selectInlineComments,
  DEFAULT_MAX_INLINE_COMMENTS,
  type SelectedComment,
  type SelectionResult,
} from "./github/selection.ts";
export {
  generatePrTitle,
  generatePrBody,
  generateInlineCommentBody,
  buildGroupedReviewPayload,
  type GroupedReviewPayload,
} from "./github/pr-content.ts";
