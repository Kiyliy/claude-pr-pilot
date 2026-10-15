import { getDb } from "./connection";
import type { StandaloneTopicInfo } from "../types";

export function getStandaloneTopic(chatId: string, threadId: number): StandaloneTopicInfo | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT repo, branch, pr_number, issue_number, description FROM standalone_topics WHERE chat_id = ? AND thread_id = ?"
  ).get(chatId, threadId) as { repo: string; branch: string | null; pr_number: number | null; issue_number: number | null; description: string | null } | undefined;
  if (!row) return null;
  return {
    repo: row.repo,
    branch: row.branch ?? undefined,
    prNumber: row.pr_number ?? undefined,
    issueNumber: row.issue_number ?? undefined,
    description: row.description ?? undefined,
  };
}

export function setStandaloneTopic(chatId: string, threadId: number, info: StandaloneTopicInfo): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO standalone_topics (chat_id, thread_id, repo, branch, pr_number, issue_number, description) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(chatId, threadId, info.repo, info.branch ?? null, info.prNumber ?? null, info.issueNumber ?? null, info.description ?? null);
}

export function updateStandaloneTopicPR(chatId: string, threadId: number, prNumber: number, branch?: string): void {
  const db = getDb();
  if (branch) {
    db.prepare(
      "UPDATE standalone_topics SET pr_number = ?, branch = ? WHERE chat_id = ? AND thread_id = ?"
    ).run(prNumber, branch, chatId, threadId);
  } else {
    db.prepare(
      "UPDATE standalone_topics SET pr_number = ? WHERE chat_id = ? AND thread_id = ?"
    ).run(prNumber, chatId, threadId);
  }
}

export function updateStandaloneTopicIssue(chatId: string, threadId: number, issueNumber: number): void {
  const db = getDb();
  db.prepare(
    "UPDATE standalone_topics SET issue_number = ? WHERE chat_id = ? AND thread_id = ?"
  ).run(issueNumber, chatId, threadId);
}

export function findStandaloneTopicByPR(chatId: string, prNumber: number): number | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT thread_id FROM standalone_topics WHERE chat_id = ? AND pr_number = ?"
  ).get(chatId, prNumber) as { thread_id: number } | undefined;
  return row?.thread_id ?? null;
}
