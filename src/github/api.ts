import { getInstallationToken } from "./auth";
import { log } from "../utils/logger";

async function ghFetch(
  installationId: number,
  endpoint: string,
  opts?: { method?: string; body?: any }
): Promise<any> {
  const token = await getInstallationToken(installationId);
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method: opts?.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${endpoint} (${res.status}): ${text}`);
  }
  return res.json();
}

export interface PRInfo {
  number: number;
  title: string;
  author: string;
  headBranch: string;
  baseBranch: string;
  draft: boolean;
}

export async function listOpenPRs(
  installationId: number,
  repo: string
): Promise<PRInfo[]> {
  const data = await ghFetch(installationId, `/repos/${repo}/pulls?state=open&per_page=30`);
  return data.map((pr: any) => ({
    number: pr.number,
    title: pr.title,
    author: pr.user?.login || "unknown",
    headBranch: pr.head?.ref || "",
    baseBranch: pr.base?.ref || "",
    draft: pr.draft || false,
  }));
}

export interface PRComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export async function getPR(
  installationId: number,
  repo: string,
  prNumber: number
): Promise<PRInfo | null> {
  try {
    const pr = await ghFetch(installationId, `/repos/${repo}/pulls/${prNumber}`);
    return {
      number: pr.number,
      title: pr.title,
      author: pr.user?.login || "unknown",
      headBranch: pr.head?.ref || "",
      baseBranch: pr.base?.ref || "",
      draft: pr.draft || false,
    };
  } catch {
    return null;
  }
}

export async function getPRBody(
  installationId: number,
  repo: string,
  prNumber: number
): Promise<string | null> {
  try {
    const pr = await ghFetch(installationId, `/repos/${repo}/pulls/${prNumber}`);
    return pr.body || null;
  } catch {
    return null;
  }
}

function parseComments(data: any[]): PRComment[] {
  return data.map((c: any) => ({
    id: c.id,
    author: c.user?.login || "unknown",
    body: c.body || "",
    createdAt: c.created_at,
  }));
}

/** Fetch all comments across pages (GitHub returns max 100 per page) */
async function fetchAllComments(
  installationId: number,
  endpoint: string
): Promise<PRComment[]> {
  const all: PRComment[] = [];
  let page = 1;
  while (true) {
    const data = await ghFetch(installationId, `${endpoint}?per_page=100&page=${page}`);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...parseComments(data));
    if (data.length < 100) break;
    page++;
  }
  return all;
}

export async function getPRComments(
  installationId: number,
  repo: string,
  prNumber: number
): Promise<PRComment[]> {
  return fetchAllComments(installationId, `/repos/${repo}/issues/${prNumber}/comments`);
}

export async function getIssueComments(
  installationId: number,
  repo: string,
  issueNumber: number
): Promise<PRComment[]> {
  return fetchAllComments(installationId, `/repos/${repo}/issues/${issueNumber}/comments`);
}

export async function postPRComment(
  installationId: number,
  repo: string,
  prNumber: number,
  body: string
): Promise<{ id: number }> {
  const data = await ghFetch(
    installationId,
    `/repos/${repo}/issues/${prNumber}/comments`,
    { method: "POST", body: { body } }
  );
  return { id: data.id };
}
