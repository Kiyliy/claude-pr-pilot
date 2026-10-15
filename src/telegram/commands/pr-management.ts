/**
 * PR management commands: /load and /close.
 * Handles creating/removing forum topics and syncing PR comments.
 */

import { log } from "../../utils/logger";
import { isSyncPREnabled } from "../../config";
import * as tg from "../client";
import * as store from "../../store/db";
import * as ghApi from "../../github/api";
import { isAllowed } from "../auth";
import { isCommentVisible } from "../sync-github";
import { getRepoForChat, getInstallationId } from "./utils";
import { generateTopicTitle } from "../../xai/client";
import type { TGMessage } from "../../types";

export async function cmdLoad(msg: TGMessage, chatId: string, userId: number, username?: string): Promise<void> {
  if (!isAllowed(chatId, userId, username)) {
    await tg.sendMessage(chatId, "Permission denied.");
    return;
  }

  const repo = getRepoForChat(chatId);
  if (!repo) {
    await tg.sendMessage(chatId, "No repo bound to this group.");
    return;
  }

  const installationId = getInstallationId(repo);
  if (!installationId) {
    await tg.sendMessage(chatId, `Repo <code>${repo}</code> has no installationId configured.`);
    return;
  }

  // Check if a specific PR number was given: /load 471
  const parts = (msg.text || "").trim().split(/\s+/);
  if (parts.length >= 2) {
    const prNumber = parseInt(parts[1], 10);
    if (!isNaN(prNumber)) {
      await loadPR(chatId, repo, installationId, prNumber);
      return;
    }
  }

  // No number → show inline keyboard with open PRs
  let prs: ghApi.PRInfo[];
  try {
    prs = await ghApi.listOpenPRs(installationId, repo);
  } catch (err: any) {
    await tg.sendMessage(chatId, `Failed to fetch PRs: ${err.message}`);
    return;
  }

  if (prs.length === 0) {
    await tg.sendMessage(chatId, "No open PRs found.");
    return;
  }

  // Filter out already loaded PRs, cleaning stale topics first
  const loadedTopics = store.getAllTopics(chatId);
  for (const [prStr, threadId] of Object.entries(loadedTopics)) {
    const alive = await tg.topicExists(chatId, threadId);
    if (!alive) {
      const prNum = Number(prStr);
      log(`[TG] Stale topic ${threadId} for PR #${prNum}, removing`);
      await store.removeTopicThread(chatId, prNum, repo, { keepMessages: true });
      delete loadedTopics[prStr];
    }
  }
  const unloaded = prs.filter((pr) => !loadedTopics[String(pr.number)]);

  if (unloaded.length === 0) {
    await tg.sendMessage(chatId, "All open PRs are already loaded.");
    return;
  }

  const buttons = unloaded.map((pr) => [{
    text: `#${pr.number} ${pr.title.slice(0, 40)}`,
    callbackData: `load:${pr.number}`,
  }]);

  await tg.sendInlineKeyboard(
    chatId,
    `<b>Open PRs for ${repo}:</b>\nSelect a PR to load:`,
    buttons
  );
}

/** In-flight dedup: prevent concurrent loadPR for the same chat+PR */
const loadingPRs = new Set<string>();

export async function loadPR(
  chatId: string,
  repo: string,
  installationId: number,
  prNumber: number
): Promise<void> {
  const lockKey = `${chatId}:${prNumber}`;
  if (loadingPRs.has(lockKey)) {
    log(`[TG] loadPR already in progress for PR #${prNumber} in chat ${chatId}, skipping`);
    return;
  }
  loadingPRs.add(lockKey);
  try {
    await loadPRInner(chatId, repo, installationId, prNumber);
  } finally {
    loadingPRs.delete(lockKey);
  }
}

async function loadPRInner(
  chatId: string,
  repo: string,
  installationId: number,
  prNumber: number
): Promise<void> {
  log(`[loadPRInner] START PR #${prNumber} chat=${chatId} repo=${repo}`);
  // Check if already loaded — but verify topic still exists
  const existing = store.getTopicThread(chatId, prNumber);
  log(`[loadPRInner] PR #${prNumber}: existing pr_topics threadId=${existing ?? 'null'}`);
  if (existing) {
    const alive = await tg.topicExists(chatId, existing);
    if (alive) {
      log(`[loadPRInner] PR #${prNumber}: topic ${existing} already exists and alive, skipping creation`);
      await tg.sendMessage(chatId, `PR #${prNumber} is already loaded.`, { threadId: existing });
      return;
    }
    // Topic was deleted externally — clean up stale mapping and re-load
    log(`[TG] Topic ${existing} for PR #${prNumber} no longer exists, re-loading`);
    await store.removeTopicThread(chatId, prNumber, repo, { keepMessages: true });
  }

  // Fetch PR info for title; use xAI to generate a clean topic name
  const prInfo = await ghApi.getPR(installationId, repo, prNumber);
  const title = prInfo
    ? await generateTopicTitle(prNumber, prInfo.title)
    : `PR #${prNumber}`;

  // Create forum topic
  let topic: { message_thread_id: number };
  try {
    topic = await tg.createForumTopic(chatId, title.slice(0, 128));
  } catch (err: any) {
    await tg.sendMessage(chatId, `Failed to create topic: ${err.message}`);
    return;
  }

  await store.setTopicThread(chatId, prNumber, topic.message_thread_id, title.slice(0, 128));
  log(`[loadPRInner] ⚠️ CREATED NEW topic threadId=${topic.message_thread_id} for ${repo}#${prNumber} in chat ${chatId} (title: "${title.slice(0, 60)}")`);
  log(`[TG] Created topic ${topic.message_thread_id} for ${repo}#${prNumber} in chat ${chatId}`);

  // Send PR description/body as the opening message in the topic
  try {
    const prBody = await ghApi.getPRBody(installationId, repo, prNumber);
    if (prBody) {
      const html = tg.markdownToTelegramHtml(prBody);
      const chunks = tg.splitHtmlSafe(html);
      for (const chunk of chunks) {
        await tg.sendMessage(chatId, chunk, { threadId: topic.message_thread_id });
      }
    }
  } catch (err: any) {
    log(`[TG] Failed to send PR description for ${repo}#${prNumber}: ${err.message}`);
  }

  // Sync existing comments into the topic
  try {
    const allComments = await ghApi.getPRComments(installationId, repo, prNumber);
    const comments = allComments.filter((c) => isCommentVisible(c.author));
    for (const c of comments) {
      const formatted = tg.formatCommentForTG(c);
      const sent = await tg.sendLongMessage(chatId, formatted, {
        threadId: topic.message_thread_id,
      });
      await store.setMessageRef(repo, prNumber, c.id, {
        chatId,
        threadId: topic.message_thread_id,
        messageId: sent.message_id,
      });
    }
    if (comments.length > 0) {
      log(`[TG] Synced ${comments.length} existing comments for ${repo}#${prNumber}`);
    }
  } catch (err: any) {
    log(`[TG] Failed to sync existing comments: ${err.message}`);
  }

  await tg.sendMessage(chatId, `Loaded PR #${prNumber}. Use /review in the topic to trigger a review.`, {
    threadId: topic.message_thread_id,
  });
}

export async function cmdClose(_msg: TGMessage, chatId: string, userId: number, username?: string, threadId?: number): Promise<void> {
  if (!isAllowed(chatId, userId, username)) {
    await tg.sendMessage(chatId, "Permission denied.", { threadId });
    return;
  }

  if (!threadId) {
    await tg.sendMessage(chatId, "Use /close inside a PR topic.");
    return;
  }

  const prNumber = store.findPRByThread(chatId, threadId);
  if (!prNumber) {
    await tg.sendMessage(chatId, "This topic is not linked to a PR.", { threadId });
    return;
  }

  try {
    await tg.deleteForumTopic(chatId, threadId);
  } catch (err: any) {
    log(`[TG] Failed to delete topic: ${err.message}`);
  }

  const repo = getRepoForChat(chatId);
  await store.removeTopicThread(chatId, prNumber, repo || undefined);
  log(`[TG] Deleted topic for PR #${prNumber} in chat ${chatId}`);
}
