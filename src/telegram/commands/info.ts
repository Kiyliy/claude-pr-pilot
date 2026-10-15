/**
 * /info command — shows bot and chat info.
 */

import * as tg from "../client";
import * as store from "../../store/db";
import { getRepoForChat } from "./utils";
import type { TGMessage } from "../../types";

export async function cmdInfo(_msg: TGMessage, chatId: string, userId: number, username?: string): Promise<void> {
  const repo = getRepoForChat(chatId);
  const topics = store.getAllTopics(chatId);
  const prList = Object.keys(topics).map((pr) => `#${pr}`).join(", ") || "none";

  let text = `<b>Info</b>\n`;
  text += `Your Telegram ID: <code>${userId}</code>\n`;
  text += `Chat ID: <code>${chatId}</code>\n`;
  text += `Bound repo: <code>${repo || "none"}</code>\n`;
  text += `Loaded PRs: ${prList}`;

  await tg.sendMessage(chatId, text);
}
