/**
 * Telegram client — barrel re-export for backwards compatibility.
 * Consumers can continue importing from this file unchanged.
 *
 * Implementation is split into:
 *   - ./api.ts        Telegram Bot API network calls
 *   - ./formatting.ts HTML/Markdown formatting utilities
 */

export type { InlineButton } from "./api";

export {
  initTelegramClient,
  sendMessage,
  sendInlineKeyboard,
  sendLongMessage,
  answerCallbackQuery,
  deleteMessage,
  createForumTopic,
  closeForumTopic,
  topicExists,
  editForumTopicName,
  editForumTopicIcon,
  deleteForumTopic,
  getUpdates,
  getMe,
  formatCommentForTG,
  _resetIconStickerMapCache,
} from "./api";

export {
  sanitizeHtml,
  markdownToTelegramHtml,
  splitHtmlSafe,
  stripAllHtml,
} from "./formatting";
