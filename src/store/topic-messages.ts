import { getDb } from "./connection";
import type { TopicMessage } from "../types";

export function addTopicMessage(
  chatId: string,
  threadId: number,
  role: "user" | "assistant" | "command",
  content: string,
  author?: string,
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO topic_messages (chat_id, thread_id, role, author, content) VALUES (?, ?, ?, ?, ?)"
  ).run(chatId, threadId, role, author ?? null, content);
}

export function getTopicMessages(
  chatId: string,
  threadId: number,
  limit: number = 50,
): TopicMessage[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT role, author, content, created_at FROM topic_messages WHERE chat_id = ? AND thread_id = ? ORDER BY id DESC LIMIT ?"
  ).all(chatId, threadId, limit) as { role: string; author: string | null; content: string; created_at: string }[];
  // Reverse to chronological order
  return rows.reverse().map((r) => ({
    role: r.role,
    author: r.author,
    content: r.content,
    createdAt: r.created_at,
  }));
}
