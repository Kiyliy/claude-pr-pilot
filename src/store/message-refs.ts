import { getDb } from "./connection";
import type { TelegramMessageRef } from "../types";

export function getMessageRef(repo: string, prNumber: number, commentId: number): TelegramMessageRef | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT chat_id, thread_id, message_id FROM message_refs WHERE repo = ? AND pr_number = ? AND comment_id = ?"
  ).get(repo, prNumber, commentId) as { chat_id: string; thread_id: number; message_id: number } | undefined;
  if (!row) return null;
  return { chatId: row.chat_id, threadId: row.thread_id, messageId: row.message_id };
}

export function setMessageRef(
  repo: string, prNumber: number, commentId: number, ref: TelegramMessageRef
): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO message_refs (repo, pr_number, comment_id, chat_id, thread_id, message_id) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(repo, prNumber, commentId, ref.chatId, ref.threadId, ref.messageId);
}

/** Return the number of GitHub comments synced to TG for a given PR */
export function getMessageRefCount(repo: string, prNumber: number): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM message_refs WHERE repo = ? AND pr_number = ?"
  ).get(repo, prNumber) as { count: number };
  return row.count;
}
