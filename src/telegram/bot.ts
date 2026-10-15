import { log } from "../utils/logger";
import * as tg from "./client";
import { handleCommand, handleCallbackQuery } from "./commands";
import { syncTGMessageToGitHub } from "./sync-github";
import { recordUserMessage } from "../review/topic-context";
import type { TGUpdate } from "../types";

let running = false;
let offset = 0;
let botUserId = 0;

export async function startBot(token: string): Promise<void> {
  tg.initTelegramClient(token);

  const me = await tg.getMe();
  botUserId = me.id;
  log(`Telegram bot started: @${me.username} (id: ${me.id})`);

  running = true;
  pollLoop();
}

export function stopBot(): void {
  running = false;
  log("Telegram bot stopping...");
}

async function pollLoop(): Promise<void> {
  while (running) {
    try {
      const updates = await tg.getUpdates(offset, 30);
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await processUpdate(update);
        } catch (err: any) {
          log(`[TG] Error processing update ${update.update_id}: ${err.message}`);
        }
      }
    } catch (err: any) {
      log(`[TG] Polling error: ${err.message}`);
      // Wait before retrying on error
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function processUpdate(update: TGUpdate): Promise<void> {
  // Callback query (inline keyboard click)
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  // Message
  const msg = update.message;
  if (!msg) return;

  const text: string = msg.text || "";

  // Sync all user messages (including commands) to GitHub PR if in a topic
  if (msg.message_thread_id && text && msg.from?.id && msg.from.id !== botUserId) {
    const chatId = String(msg.chat.id);
    const author = msg.from?.first_name || msg.from?.username || "unknown";
    recordUserMessage(chatId, msg.message_thread_id, text, author);
    await syncTGMessageToGitHub(msg);
  }

  // Bot command
  if (text.startsWith("/")) {
    await handleCommand(msg);
    return;
  }
}
