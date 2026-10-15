/**
 * Telegram Bot API client — network layer.
 * Handles all HTTP calls to the Telegram Bot API.
 */

import { log } from "../utils/logger";
import { splitHtmlSafe, stripAllHtml, formatCommentForTG } from "./formatting";
import type { TGUpdate, TGUser } from "../types";

let BOT_TOKEN = "";
const BASE = () => `https://api.telegram.org/bot${BOT_TOKEN}`;

export function initTelegramClient(token: string): void {
  BOT_TOKEN = token;
}

async function call(method: string, body?: Record<string, any>): Promise<any> {
  const res = await fetch(`${BASE()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!data.ok) {
    log(`TG API ${method} failed: ${JSON.stringify(data)}`);
    throw new Error(`TG API ${method}: ${data.description || "unknown error"}`);
  }
  return data.result;
}

// --- Messages ---

export async function sendMessage(
  chatId: number | string,
  text: string,
  opts?: { threadId?: number; parseMode?: string; replyMarkup?: any }
): Promise<any> {
  const parseMode = opts?.parseMode ?? "HTML";
  const base = {
    chat_id: chatId,
    text,
    message_thread_id: opts?.threadId,
    reply_markup: opts?.replyMarkup,
  };

  // Try with parse_mode first
  if (parseMode) {
    try {
      return await call("sendMessage", { ...base, parse_mode: parseMode });
    } catch (err: any) {
      // If parse error, fallback to plain text
      if (err.message?.includes("can't parse entities")) {
        log(`TG sendMessage parse failed, falling back to plain text`);
        const plain = stripAllHtml(text);
        return call("sendMessage", { ...base, text: plain });
      }
      throw err;
    }
  }

  return call("sendMessage", base);
}

export type InlineButton =
  | { text: string; callbackData: string; url?: never }
  | { text: string; url: string; callbackData?: never };

export async function sendInlineKeyboard(
  chatId: number | string,
  text: string,
  buttons: InlineButton[][],
  opts?: { threadId?: number }
): Promise<any> {
  return sendMessage(chatId, text, {
    threadId: opts?.threadId,
    replyMarkup: {
      inline_keyboard: buttons.map((row) =>
        row.map((btn) =>
          btn.url
            ? { text: btn.text, url: btn.url }
            : { text: btn.text, callback_data: btn.callbackData }
        )
      ),
    },
  });
}

/**
 * Send a long message split into multiple Telegram messages.
 * Returns the first sent message result (for message_id tracking).
 * If the message is split, appends a footer to the last chunk.
 */
export async function sendLongMessage(
  chatId: number | string,
  text: string,
  opts?: { threadId?: number; parseMode?: string; footer?: string }
): Promise<any> {
  const chunks = splitHtmlSafe(text);

  if (chunks.length === 1) {
    return sendMessage(chatId, chunks[0], opts);
  }

  const footer = opts?.footer ?? "\n\n<i>... 完整内容请查看 GitHub PR 评论</i>";
  let firstResult: any;

  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];
    if (i === chunks.length - 1 && footer) {
      chunk += footer;
    }
    const result = await sendMessage(chatId, chunk, opts);
    if (i === 0) firstResult = result;
  }

  return firstResult;
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string
): Promise<void> {
  await call("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

export async function deleteMessage(
  chatId: number | string,
  messageId: number
): Promise<void> {
  await call("deleteMessage", { chat_id: chatId, message_id: messageId });
}

// --- Forum Topics ---

export async function createForumTopic(
  chatId: number | string,
  name: string,
  iconEmoji?: string
): Promise<{ message_thread_id: number; name: string }> {
  let iconId: string | undefined;
  let topicName = name;
  if (iconEmoji) {
    const map = await getTopicIconStickerMap();
    iconId = map.get(iconEmoji);
    // Telegram only supports a limited set of emoji as topic icons.
    // Fall back to prefixing the name with the emoji so the status is always visible.
    if (!iconId) {
      topicName = `${iconEmoji} ${name}`;
    }
  }
  return call("createForumTopic", {
    chat_id: chatId,
    name: topicName,
    ...(iconId ? { icon_custom_emoji_id: iconId } : {}),
  });
}

export async function closeForumTopic(
  chatId: number | string,
  messageThreadId: number
): Promise<void> {
  await call("closeForumTopic", {
    chat_id: chatId,
    message_thread_id: messageThreadId,
  });
}

/** Check if a forum topic still exists (no visible side effects) */
export async function topicExists(
  chatId: number | string,
  messageThreadId: number
): Promise<boolean> {
  try {
    // editForumTopic with no name/icon is a no-op but validates the topic exists
    await call("editForumTopic", {
      chat_id: chatId,
      message_thread_id: messageThreadId,
    });
    return true;
  } catch (err: any) {
    // Only return false for explicit "topic not found" errors.
    // Closed topics, permission issues, network errors, etc. are treated
    // as "probably still exists" to prevent accidental data loss.
    const msg = (err?.message || "").toLowerCase();
    if (
      msg.includes("message thread not found") ||
      msg.includes("thread not found") ||
      msg.includes("topic_id_invalid")
    ) {
      return false;
    }
    // Conservative: assume topic exists on unknown errors
    log(`[TG] topicExists check inconclusive for thread ${messageThreadId}: ${err.message}`);
    return true;
  }
}

/** Rename a forum topic */
export async function editForumTopicName(
  chatId: number | string,
  messageThreadId: number,
  name: string
): Promise<void> {
  await call("editForumTopic", {
    chat_id: chatId,
    message_thread_id: messageThreadId,
    name: name.slice(0, 128),
  });
}

// Lazy cache: emoji character → custom_emoji_id for forum topic icons
let _iconStickerMap: Map<string, string> | null = null;

/** @internal — only for use in tests */
export function _resetIconStickerMapCache(): void {
  _iconStickerMap = null;
}

async function getTopicIconStickerMap(): Promise<Map<string, string>> {
  if (_iconStickerMap !== null) return _iconStickerMap;
  try {
    const stickers: Array<{ emoji?: string; custom_emoji_id?: string }> = await call("getForumTopicIconStickers");
    _iconStickerMap = new Map(
      stickers
        .filter(s => s.emoji && s.custom_emoji_id)
        .map(s => [s.emoji!, s.custom_emoji_id!])
    );
  } catch (err: any) {
    log(`[TG] Failed to fetch forum topic icon stickers: ${err.message}`);
    // Don't cache on failure — allow retry on next call
    return new Map();
  }
  return _iconStickerMap;
}

/**
 * Edit forum topic name and set its icon emoji via icon_custom_emoji_id.
 * iconEmoji is a Unicode emoji that will be matched to the Telegram topic icon sticker set.
 * If no matching sticker is found, falls back to prefixing the topic name with the emoji
 * so the status is always visible to users.
 */
export async function editForumTopicIcon(
  chatId: number | string,
  messageThreadId: number,
  name: string,
  iconEmoji: string
): Promise<void> {
  const map = await getTopicIconStickerMap();
  const iconId = map.get(iconEmoji);
  // If Telegram supports the emoji as an icon, use it; otherwise prefix the name.
  const topicName = iconId ? name : `${iconEmoji} ${name}`;
  await call("editForumTopic", {
    chat_id: chatId,
    message_thread_id: messageThreadId,
    name: topicName.slice(0, 128),
    ...(iconId ? { icon_custom_emoji_id: iconId } : {}),
  });
}

export async function deleteForumTopic(
  chatId: number | string,
  messageThreadId: number
): Promise<void> {
  await call("deleteForumTopic", {
    chat_id: chatId,
    message_thread_id: messageThreadId,
  });
}

// --- Polling ---

export async function getUpdates(
  offset: number,
  timeout: number = 30
): Promise<TGUpdate[]> {
  const data = await call("getUpdates", {
    offset,
    timeout,
    allowed_updates: ["message", "callback_query"],
  });
  return data;
}

export async function getMe(): Promise<TGUser> {
  return call("getMe");
}

// Re-export for convenience
export { formatCommentForTG };
