/**
 * Inline keyboard callback query handler.
 * Handles: cancel:, provider:, load:, mark_read: actions.
 */

import { isCommandAllowed, isSyncPREnabled, setProvider } from "../../config";
import { cancelTask, resolveCallbackId } from "../../review/manager";
import { isValidProvider, type AIProvider } from "../../providers";
import * as tg from "../client";
import { isAllowed } from "../auth";
import { loadPR } from "./pr-management";
import { getRepoForChat, getInstallationId } from "./utils";
import * as store from "../../store/db";
import type { TGCallbackQuery } from "../../types";

export async function handleCallbackQuery(cbq: TGCallbackQuery): Promise<void> {
  const data = cbq.data || "";
  const chatId = String(cbq.message?.chat?.id);
  const userId = cbq.from.id;
  const username = cbq.from.username;

  if (!isAllowed(chatId, userId, username)) {
    await tg.answerCallbackQuery(cbq.id, "Permission denied.");
    return;
  }

  if (data.startsWith("cancel_ask:")) {
    const cbId = data.slice(11);
    const taskKey = resolveCallbackId(cbId);
    if (!taskKey) {
      await tg.answerCallbackQuery(cbq.id, "Task not found (may have already finished).");
      return;
    }
    await tg.answerCallbackQuery(cbq.id);
    await tg.sendInlineKeyboard(
      chatId,
      `⚠️ 确认要取消任务 <code>${taskKey}</code> 吗？`,
      [
        [
          { text: "✅ 确认取消", callbackData: `cancel_confirm:${cbId}` },
          { text: "❌ 保留运行", callbackData: `cancel_dismiss:${cbId}` },
        ],
      ]
    );
    return;
  }

  if (data.startsWith("cancel_confirm:")) {
    const cbId = data.slice(15);
    const taskKey = resolveCallbackId(cbId);
    if (!taskKey) {
      await tg.answerCallbackQuery(cbq.id, "Task not found (may have already finished).");
      return;
    }
    const killed = cancelTask(taskKey);
    if (killed) {
      await tg.answerCallbackQuery(cbq.id, `Task cancelled.`);
      await tg.sendMessage(chatId, `🛑 Task <code>${taskKey}</code> has been cancelled.`);
    } else {
      await tg.answerCallbackQuery(cbq.id, `Task not found (may have already finished).`);
    }
    return;
  }

  if (data.startsWith("cancel_dismiss:")) {
    await tg.answerCallbackQuery(cbq.id, "已取消操作。");
    return;
  }

  if (data.startsWith("provider:")) {
    if (!isCommandAllowed(chatId, "provider")) {
      await tg.answerCallbackQuery(cbq.id, "This action is not available.");
      return;
    }

    const raw = data.slice(9);
    if (!isValidProvider(raw)) {
      await tg.answerCallbackQuery(cbq.id, "Invalid provider.");
      return;
    }
    const target = raw as AIProvider;
    setProvider(chatId, target);
    await tg.answerCallbackQuery(cbq.id, `Switched to ${target}`);
    await tg.sendMessage(chatId, `✅ AI provider switched to <code>${target}</code> for this group.`);
    return;
  }

  if (data.startsWith("load:")) {
    if (!isCommandAllowed(chatId, "load") || !isSyncPREnabled(chatId)) {
      await tg.answerCallbackQuery(cbq.id, "This action is not available.");
      return;
    }

    const prNumber = parseInt(data.slice(5), 10);
    const repo = getRepoForChat(chatId);
    const installationId = repo ? getInstallationId(repo) : null;

    if (!repo || !installationId) {
      await tg.answerCallbackQuery(cbq.id, "No repo configured.");
      return;
    }

    await tg.answerCallbackQuery(cbq.id, `Loading PR #${prNumber}...`);
    await loadPR(chatId, repo, installationId, prNumber);
    return;
  }

  // mark_read:<chatId>:<threadId> — user marks a topic as "read" (icon 👀 → ✅)
  if (data.startsWith("mark_read:")) {
    const parts = data.slice(10).split(":");
    const targetChatId = parts[0];
    const targetThreadId = Number(parts[1]);

    if (!targetChatId || !targetThreadId) {
      await tg.answerCallbackQuery(cbq.id, "Invalid data.");
      return;
    }

    try {
      // Look up the base title from DB so we can preserve the topic name
      const prNumber = store.findPRByThread(targetChatId, targetThreadId);
      const baseTitle = prNumber
        ? store.getTopicBaseTitle(targetChatId, prNumber)
        : null;

      // Pass empty string when no title found — Telegram keeps current name for empty/omitted name
      await tg.editForumTopicIcon(targetChatId, targetThreadId, baseTitle || "", "✅");
      await tg.answerCallbackQuery(cbq.id, "✅ 已标记为已读");
    } catch {
      await tg.answerCallbackQuery(cbq.id, "Failed to update topic icon.");
    }
    return;
  }

  await tg.answerCallbackQuery(cbq.id);
}
