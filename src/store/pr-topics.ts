import { getDb } from "./connection";

export function getTopicThread(chatId: string, prNumber: number): number | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT thread_id FROM pr_topics WHERE chat_id = ? AND pr_number = ?"
  ).get(chatId, prNumber) as { thread_id: number } | undefined;
  return row?.thread_id ?? null;
}

export function getAllTopics(chatId: string): Record<string, number> {
  const db = getDb();
  const rows = db.prepare(
    "SELECT pr_number, thread_id FROM pr_topics WHERE chat_id = ?"
  ).all(chatId) as { pr_number: number; thread_id: number }[];
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[String(row.pr_number)] = row.thread_id;
  }
  return result;
}

export function setTopicThread(chatId: string, prNumber: number, threadId: number, baseTitle?: string): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO pr_topics (chat_id, pr_number, thread_id, base_title) VALUES (?, ?, ?, ?)"
  ).run(chatId, prNumber, threadId, baseTitle ?? null);
}

export function getTopicBaseTitle(chatId: string, prNumber: number): string | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT base_title FROM pr_topics WHERE chat_id = ? AND pr_number = ?"
  ).get(chatId, prNumber) as { base_title: string | null } | undefined;
  return row?.base_title ?? null;
}

export function removeTopicThread(
  chatId: string,
  prNumber: number,
  repo?: string,
  opts?: { keepMessages?: boolean },
): void {
  const db = getDb();
  const txn = db.transaction(() => {
    // Look up thread_id before deleting so we can optionally clean topic_messages
    const row = db.prepare(
      "SELECT thread_id FROM pr_topics WHERE chat_id = ? AND pr_number = ?"
    ).get(chatId, prNumber) as { thread_id: number } | undefined;

    db.prepare(
      "DELETE FROM pr_topics WHERE chat_id = ? AND pr_number = ?"
    ).run(chatId, prNumber);
    if (repo) {
      db.prepare(
        "DELETE FROM message_refs WHERE repo = ? AND pr_number = ? AND chat_id = ?"
      ).run(repo, prNumber, chatId);
    } else {
      db.prepare(
        "DELETE FROM message_refs WHERE pr_number = ? AND chat_id = ?"
      ).run(prNumber, chatId);
    }

    // Only delete topic_messages when explicitly requested (e.g. user /close).
    // Stale auto-cleanup paths pass keepMessages: true to preserve history.
    if (row && !opts?.keepMessages) {
      db.prepare(
        "DELETE FROM topic_messages WHERE chat_id = ? AND thread_id = ?"
      ).run(chatId, row.thread_id);
    }
  });
  txn();
}

export function findPRByThread(chatId: string, threadId: number): number | null {
  const db = getDb();
  // Check PR topics first
  const prRow = db.prepare(
    "SELECT pr_number FROM pr_topics WHERE chat_id = ? AND thread_id = ?"
  ).get(chatId, threadId) as { pr_number: number } | undefined;
  if (prRow) return prRow.pr_number;

  // Check standalone topics with bound PR
  const stRow = db.prepare(
    "SELECT pr_number FROM standalone_topics WHERE chat_id = ? AND thread_id = ? AND pr_number IS NOT NULL"
  ).get(chatId, threadId) as { pr_number: number } | undefined;
  if (stRow) return stRow.pr_number;

  return null;
}
