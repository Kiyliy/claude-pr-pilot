/**
 * Command router — dispatches incoming Telegram messages to the appropriate handler.
 * Re-exports public API: handleCommand, handleCallbackQuery, loadPR.
 */

import { isCommandAllowed, isSyncPREnabled, resolveSkillPath } from "../../config";
import * as tg from "../client";
import { cmdStart } from "./help";
import { cmdInfo } from "./info";
import { cmdLoad, cmdClose } from "./pr-management";
import { cmdSkill } from "./skills";
import { cmdProvider } from "./provider";
import { cmdStatus, cmdAutofix } from "./admin";
import { cmdSystem } from "./system";
import { parseCommand, getRepoForChat } from "./utils";
import type { TGMessage } from "../../types";

export { handleCallbackQuery } from "./callbacks";
export { loadPR } from "./pr-management";

export async function handleCommand(msg: TGMessage): Promise<void> {
  const text = msg.text || "";
  const chatId = String(msg.chat.id);
  if (!msg.from) return;
  const userId = msg.from.id;
  const username = msg.from.username;
  const threadId = msg.message_thread_id;

  if (text.startsWith("/start") || text.startsWith("/help")) return cmdStart(msg, chatId);
  if (text.startsWith("/info")) return cmdInfo(msg, chatId, userId, username);

  if (text.startsWith("/load")) {
    if (!isCommandAllowed(chatId, "load") || !isSyncPREnabled(chatId)) {
      await tg.sendMessage(chatId, `Command <code>/load</code> is not available in this group.`, { threadId });
      return;
    }
    return cmdLoad(msg, chatId, userId, username);
  }

  if (text.startsWith("/close")) {
    if (!isCommandAllowed(chatId, "close") || !isSyncPREnabled(chatId)) {
      await tg.sendMessage(chatId, `Command <code>/close</code> is not available in this group.`, { threadId });
      return;
    }
    return cmdClose(msg, chatId, userId, username, threadId);
  }

  if (text.startsWith("/status")) {
    if (!isCommandAllowed(chatId, "status")) {
      await tg.sendMessage(chatId, `Command <code>/status</code> is not available in this group.`, { threadId });
      return;
    }
    return cmdStatus(msg, chatId, userId, username);
  }

  if (text.startsWith("/system")) {
    if (!isCommandAllowed(chatId, "system")) {
      await tg.sendMessage(chatId, `Command <code>/system</code> is not available in this group.`, { threadId });
      return;
    }
    return cmdSystem(msg, chatId, userId, username);
  }

  if (text.startsWith("/provider")) {
    if (!isCommandAllowed(chatId, "provider")) {
      await tg.sendMessage(chatId, `Command <code>/provider</code> is not available in this group.`, { threadId });
      return;
    }
    return cmdProvider(msg, chatId, userId, username, threadId);
  }

  if (text.startsWith("/autofix")) {
    if (!isCommandAllowed(chatId, "autofix")) {
      await tg.sendMessage(chatId, `Command <code>/autofix</code> is not available in this group.`, { threadId });
      return;
    }
    return cmdAutofix(msg, chatId, userId, username, threadId);
  }

  // All skill commands: /review, /fix, /do, /ask, or any command in repos.json
  const { command } = parseCommand(text);
  const repo = getRepoForChat(chatId);
  if (repo && resolveSkillPath(repo, command)) {
    if (!isCommandAllowed(chatId, command)) {
      await tg.sendMessage(chatId, `Command <code>/${command}</code> is not available in this group.`, { threadId });
      return;
    }
    return cmdSkill(msg, chatId, userId, username, threadId);
  }

  // Unknown command — provide feedback
  await tg.sendMessage(chatId, `Unknown command: <code>/${command}</code>. Use /help to see available commands.`, { threadId });
}
