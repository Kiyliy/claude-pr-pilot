import { log } from "../utils/logger";
import * as store from "../store/db";
import { loadBotContext, loadIssueContext } from "./context";

// ============================================================
// Recording — write messages to topic_messages table
// ============================================================

/** Record a user's free-text message in a topic */
export function recordUserMessage(chatId: string, threadId: number, text: string, author: string): void {
  store.addTopicMessage(chatId, threadId, "user", text, author);
}

/** Record a command invocation (e.g. "/do fix the bug") */
export function recordCommand(chatId: string, threadId: number, commandText: string, author: string): void {
  store.addTopicMessage(chatId, threadId, "command", commandText, author);
}

/** Record Claude's output after task completion */
export function recordAssistantOutput(chatId: string, threadId: number, output: string): void {
  // Store a reasonable amount for context — full output can be huge
  const trimmed = output.length > 8000 ? output.slice(-8000) : output;
  store.addTopicMessage(chatId, threadId, "assistant", trimmed, "claude");
}

// ============================================================
// Loading — build context string for prompt injection
// ============================================================

/**
 * Load conversation context for a task.
 *
 * Strategy:
 * - PR-bound tasks with installationId → use GitHub PR comments (loadBotContext)
 * - Issue-bound tasks with installationId → use GitHub Issue comments (loadIssueContext)
 * - Standalone topics (no PR/Issue) → use topic_messages from SQLite
 * - PR-bound tasks WITHOUT installationId → fallback to topic_messages
 *
 * This avoids double injection: each task gets exactly one source of context.
 */
export async function loadTaskContext(
  task: {
    repoFullName: string;
    prNumber?: number;
    issueNumber?: number;
    tgChatId?: string;
    tgThreadId?: number;
  },
  installationId?: number,
): Promise<string | null> {
  // PR-bound: prefer GitHub PR comment history
  if (task.prNumber && installationId) {
    const prContext = await loadBotContext(task.repoFullName, task.prNumber, installationId);
    if (prContext) return prContext;
  }

  // Issue-bound: use GitHub Issue comment history
  if (task.issueNumber && installationId) {
    const issueContext = await loadIssueContext(task.repoFullName, task.issueNumber, installationId);
    if (issueContext) return issueContext;
  }

  // Standalone or PR without GitHub context: use topic_messages
  if (task.tgChatId && task.tgThreadId) {
    return loadTopicHistory(task.tgChatId, task.tgThreadId);
  }

  return null;
}

/** Format topic_messages into a prompt-friendly string */
function loadTopicHistory(chatId: string, threadId: number): string | null {
  const messages = store.getTopicMessages(chatId, threadId);
  if (messages.length === 0) return null;

  const parts: string[] = ["## Conversation History"];
  for (const m of messages) {
    const label =
      m.role === "assistant" ? "Assistant (previous output)" :
      m.role === "command" ? "User command" :
      `User (${m.author || "unknown"})`;
    parts.push(`### ${label}`);
    parts.push(m.content);
    parts.push("");
  }

  log(`[TopicContext] Loaded ${messages.length} message(s) for thread ${threadId}`);
  return parts.join("\n");
}
