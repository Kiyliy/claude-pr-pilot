import { log } from "../utils/logger";
import { isSyncPREnabled, getGroupsByRepo } from "../config";
import * as tg from "./client";
import * as store from "../store/db";
import * as ghApi from "../github/api";
import { recordAssistantOutput } from "../review/topic-context";
import type { TaskRequest } from "../types";

/** Map a running command to its in-progress status emoji */
function taskRunningEmoji(command: string): string {
  if (command === "review") return "🔍";
  if (command === "fix") return "🔨";
  if (command === "do") return "🔨";
  if (command === "ask") return "❓";
  return "⚡️";
}

/**
 * Notify TG topic when a task starts.
 * Called from review/manager.ts when a task is triggered.
 */
export async function notifyTaskStart(
  repo: string,
  prNumber: number,
  command: string
): Promise<void> {
  for (const [chatId] of getGroupsByRepo(repo)) {
    if (!isSyncPREnabled(chatId)) continue;

    const threadId = store.getTopicThread(chatId, prNumber);
    if (!threadId) continue;

    const emoji = taskRunningEmoji(command);
    const text = `${emoji} Task '${command}' started for PR #${prNumber}`;

    try {
      await tg.sendMessage(chatId, text, { threadId });
    } catch (err: any) {
      log(`[Sync] Failed to notify task start: ${err.message}`);
    }

    // Update topic icon and name to reflect in-progress status
    const baseTitle = store.getTopicBaseTitle(chatId, prNumber);
    if (baseTitle) {
      tg.editForumTopicIcon(chatId, threadId, baseTitle, emoji).catch(() => {});
    }
  }
}

/**
 * Notify TG topic when a task completes.
 * Called from review/manager.ts on child process close.
 */
export async function notifyTaskComplete(
  repo: string,
  prNumber: number,
  command: string,
  success: boolean,
  elapsed: string
): Promise<void> {
  for (const [chatId] of getGroupsByRepo(repo)) {
    if (!isSyncPREnabled(chatId)) continue;

    const threadId = store.getTopicThread(chatId, prNumber);
    if (!threadId) continue;

    const msgEmoji = success ? "\u2705" : "\u274c";
    const status = success ? "completed" : "failed";
    const text = `${msgEmoji} Task '${command}' ${status} for PR #${prNumber} (took ${elapsed})`;

    try {
      await tg.sendMessage(chatId, text, { threadId });
    } catch (err: any) {
      log(`[Sync] Failed to notify task completion: ${err.message}`);
    }

    // Update topic icon: 👀 for success (pending user review), ❌ for failure
    const topicEmoji = success ? "👀" : "\u274c";
    const baseTitle = store.getTopicBaseTitle(chatId, prNumber);
    if (baseTitle) {
      tg.editForumTopicIcon(chatId, threadId, baseTitle, topicEmoji).catch(() => {});
    }

    // Send "mark as read" button for successful tasks
    if (success) {
      tg.sendInlineKeyboard(
        chatId,
        "👀 待查看",
        [[{ text: "✅ 标记已读", callbackData: `mark_read:${chatId}:${threadId}` }]],
        { threadId },
      ).catch(() => {});
    }
  }
}

/**
 * Send PR body content to TG topic for standalone /do tasks that created a PR.
 * Replaces raw stdout output with the structured PR body from GitHub.
 * Always records rawOutput in topic history for context injection.
 */
export async function sendPRBodyToTG(
  task: TaskRequest,
  prNumber: number,
  installationId: number | undefined,
  rawOutput: string,
  elapsed: string,
): Promise<void> {
  if (!task.tgChatId || !task.tgThreadId) return;

  // Always record Claude output in topic history for context injection
  if (rawOutput) {
    recordAssistantOutput(task.tgChatId, task.tgThreadId, rawOutput);
  }

  // Send success header with PR link
  const prUrl = `https://github.com/${task.repoFullName}/pull/${prNumber}`;
  const header = `✅ Task '${task.command}' completed (${elapsed})\n\n<a href="${prUrl}">PR #${prNumber}</a>`;
  await tg.sendMessage(task.tgChatId, header, { threadId: task.tgThreadId });

  if (!installationId) return;

  // getPRBody handles errors internally and returns null on failure
  const prBody = await ghApi.getPRBody(installationId, task.repoFullName, prNumber);
  if (!prBody) return;

  const html = tg.markdownToTelegramHtml(prBody);
  const chunks = tg.splitHtmlSafe(html);
  for (const chunk of chunks) {
    await tg.sendMessage(task.tgChatId, chunk, { threadId: task.tgThreadId });
  }
}

/** Send captured Claude output back to the TG topic */
export async function sendOutputToTG(
  task: TaskRequest,
  stdoutChunks: Buffer[],
  success: boolean,
  elapsed: string,
): Promise<void> {
  if (!task.tgChatId || !task.tgThreadId) return;

  const raw = Buffer.concat(stdoutChunks).toString("utf-8").trim();

  // Record Claude output in topic history for context injection
  if (raw) {
    recordAssistantOutput(task.tgChatId, task.tgThreadId, raw);
  }

  if (!raw) {
    await tg.sendMessage(task.tgChatId, `Task '${task.command}' finished (${elapsed}) but produced no output.`, {
      threadId: task.tgThreadId,
    });
    return;
  }

  const emoji = success ? "✅" : "❌";
  const status = success ? "completed" : "failed";
  const header = `${emoji} Task '${task.command}' ${status} (${elapsed})`;

  // Telegram message limit is ~4096 chars; send in chunks if needed
  const MAX_CHUNK = 3800;
  // Take the last portion if output is very long (most relevant info is at the end)
  const output = raw.length > MAX_CHUNK * 3
    ? "... (truncated) ...\n\n" + raw.slice(-MAX_CHUNK * 3)
    : raw;

  const chunks: string[] = [];
  for (let i = 0; i < output.length; i += MAX_CHUNK) {
    chunks.push(output.slice(i, i + MAX_CHUNK));
  }

  await tg.sendMessage(task.tgChatId, header, { threadId: task.tgThreadId });
  for (const chunk of chunks) {
    await tg.sendMessage(task.tgChatId, `<pre>${tg.sanitizeHtml(chunk)}</pre>`, {
      threadId: task.tgThreadId,
    });
  }
}
