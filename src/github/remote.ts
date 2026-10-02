/**
 * GitHub remote URL parsing — SSH and HTTPS forms, owner/repo extraction.
 */

export interface ParsedRemote {
  owner: string;
  repo: string;
  /** repository as "owner/repo" */
  slug: string;
}

/** Parses a git remote URL into a GitHub owner/repo slug, or null if not GitHub. */
export function parseGitHubRemote(url: string): ParsedRemote | null {
  if (!url) return null;
  const trimmed = url.trim();
  // SSH: git@github.com:owner/repo.git (optionally ssh:// prefix)
  const ssh = /^(?:ssh:\/\/)?git@([^/:]+)[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (ssh) {
    const host = ssh[1]!.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return null;
    return { owner: ssh[2]!, repo: ssh[3]!, slug: `${ssh[2]}/${ssh[3]}` };
  }
  // HTTPS / git / http: https://github.com/owner/repo(.git)
  const https = /^(https?|git|git\+ssh):\/\/(?:[^/@]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (https) {
    const host = https[2]!.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return null;
    return { owner: https[3]!, repo: https[4]!, slug: `${https[3]}/${https[4]}` };
  }
  return null;
}
