/**
 * /provider command — switch AI provider for the current group.
 */

import { getProvider, setProvider } from "../../config";
import { listProviders, isValidProvider, type AIProvider } from "../../providers";
import * as tg from "../client";
import { isAllowed } from "../auth";
import type { TGMessage } from "../../types";

export async function cmdProvider(msg: TGMessage, chatId: string, userId: number, username?: string, threadId?: number): Promise<void> {
  if (!isAllowed(chatId, userId, username)) {
    await tg.sendMessage(chatId, "Permission denied.", { threadId });
    return;
  }

  const parts = (msg.text || "").trim().split(/\s+/);
  const current = getProvider(chatId);

  if (parts.length < 2) {
    const others = listProviders().filter(p => p !== current);
    await tg.sendInlineKeyboard(
      chatId,
      `<b>AI Provider:</b> <code>${current}</code>`,
      [others.map(p => ({ text: `Switch to ${p}`, callbackData: `provider:${p}` }))],
    );
    return;
  }

  const target = parts[1].toLowerCase();
  if (!isValidProvider(target)) {
    const valid = listProviders().join(", ");
    await tg.sendMessage(chatId, `Invalid provider: <code>${target}</code>. Use one of: ${valid}.`, { threadId });
    return;
  }

  setProvider(chatId, target as AIProvider);
  await tg.sendMessage(chatId, `✅ AI provider switched to <code>${target}</code> for this group.`, { threadId });
}
