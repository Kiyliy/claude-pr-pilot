import { vi } from "vitest";

export const initTelegramClient = vi.fn();
export const getMe = vi.fn().mockResolvedValue({ id: 42, username: "testbot" });
export const getUpdates = vi.fn().mockResolvedValue([]);

export const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
export const sendInlineKeyboard = vi.fn().mockResolvedValue({ message_id: 2 });
export const sendLongMessage = vi.fn().mockResolvedValue({ message_id: 3 });
export const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
export const createForumTopic = vi.fn().mockResolvedValue({ message_thread_id: 100 });
export const deleteForumTopic = vi.fn().mockResolvedValue(undefined);
export const editForumTopicName = vi.fn().mockResolvedValue(undefined);
export const editForumTopicIcon = vi.fn().mockResolvedValue(undefined);
export const topicExists = vi.fn().mockResolvedValue(true);
export const formatCommentForTG = vi.fn((c: { body: string }) => `<b>comment</b>: ${c.body}`);
export const sanitizeHtml = vi.fn((s: string) => s);
export const markdownToTelegramHtml = vi.fn((s: string) => s);
