/**
 * Admin commands: /status and /autofix.
 */

import { resolveSkillPath } from "../../config";
import { getActiveTasks, registerCallbackId, runTask } from "../../review/manager";
import { recordCommand } from "../../review/topic-context";
import * as tg from "../client";
import * as store from "../../store/db";
import { isAllowed } from "../auth";
import { getRepoForChat, resolveHeadBranch } from "./utils";
import type { TGMessage, ActiveTaskInfo } from "../../types";
import type { InlineButton } from "../client";

/** Build a t.me deep-link URL for a Telegram group topic. */
function topicUrl(chatId: string, threadId: number): string {
  // Supergroup chatIds are like -1001234567890; strip the leading '-100' for the URL
  const numericId = chatId.replace(/^-100/, "");
  return `https://t.me/c/${numericId}/${threadId}`;
}

/** Resolve the Telegram thread ID for a task (for the navigation button). */
function resolveThreadId(task: ActiveTaskInfo, chatId: string): number | null {
  // Standalone tasks with TG context store the thread ID directly
  if (task.tgThreadId) return task.tgThreadId;

  // PR tasks: look up from the database
  if (task.key.match(/^[^#]+#\d+:/)) {
    const prMatch = task.key.match(/^[^#]+#(\d+):/);
    if (prMatch) {
      const prNumber = parseInt(prMatch[1], 10);
      return store.getTopicThread(chatId, prNumber);
    }
  }
  return null;
}

export async function cmdStatus(_msg: TGMessage, chatId: string, userId: number, username?: string): Promise<void> {
  if (!isAllowed(chatId, userId, username)) {
    await tg.sendMessage(chatId, "Permission denied.");
    return;
  }

  const repo = getRepoForChat(chatId);
  const allTasks = getActiveTasks();
  const tasks = repo
    ? allTasks.filter((t) => t.key.startsWith(repo))
    : allTasks;

  if (tasks.length === 0) {
    await tg.sendMessage(chatId, "No active tasks.");
    return;
  }

  const lines = tasks.map((t, i) => {
    const desc = t.label ? `\n    📝 ${t.label}` : "";
    return `${i + 1}. <code>${t.key}</code> [${t.command}] (${t.branch}) — ${t.elapsed}${desc}`;
  });
  const buttons: InlineButton[][] = tasks.map((t, i) => {
    const row: InlineButton[] = [];
    const threadId = resolveThreadId(t, chatId);
    if (threadId) {
      row.push({ text: `#${i + 1} 🔗 跳转`, url: topicUrl(chatId, threadId) });
    }
    row.push({
      text: `#${i + 1} ❌ Cancel`,
      callbackData: `cancel_ask:${registerCallbackId(t.key)}`,
    });
    return row;
  });
  await tg.sendInlineKeyboard(chatId, `<b>Active Tasks:</b>\n${lines.join("\n\n")}`, buttons);
}

export async function cmdAutofix(msg: TGMessage, chatId: string, userId: number, username?: string, threadId?: number): Promise<void> {
  if (!isAllowed(chatId, userId, username)) {
    await tg.sendMessage(chatId, "Permission denied.", { threadId });
    return;
  }

  const repo = getRepoForChat(chatId);
  if (!repo) {
    await tg.sendMessage(chatId, "No repo bound to this group.", { threadId });
    return;
  }

  if (!threadId) {
    await tg.sendMessage(chatId, "Use /autofix inside a PR topic.");
    return;
  }

  const prNumber = store.findPRByThread(chatId, threadId);
  if (!prNumber) {
    await tg.sendMessage(chatId, "This topic is not linked to a PR. Use /autofix inside a PR topic.", { threadId });
    return;
  }

  const skillPath = resolveSkillPath(repo, "review");
  if (!skillPath) {
    await tg.sendMessage(chatId, "Review skill not configured.", { threadId });
    return;
  }

  const headBranch = await resolveHeadBranch(repo, prNumber);
  const rejection = runTask({
    repoFullName: repo,
    prNumber,
    headBranch,
    command: "review",
    skillPath,
    tgChatId: chatId,
    tgThreadId: threadId,
    manualAutoFix: true,
  });
  if (rejection) {
    await tg.sendMessage(chatId, rejection.reason, { threadId });
    return;
  }
  await tg.sendMessage(chatId, `🔄 Auto-fix triggered for PR #${prNumber}. Starting review→fix cycle...`, { threadId });
  recordCommand(chatId, threadId, msg.text || "", username || "user");
}
