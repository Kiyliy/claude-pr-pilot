import { log } from "../utils/logger";
import { TELEGRAM_CONFIG, REPOS, BOT_LOGIN, isSyncPREnabled, getGroupsByRepo } from "../config";
import * as tg from "./client";
import * as store from "../store/db";
import * as ghApi from "../github/api";
import { isAllowed } from "./auth";
import type { TGMessage } from "../types";

const TG_SYNC_MARKER = "<!-- tg-sync -->";

/** In-flight dedup: prevent duplicate webhook deliveries from sending twice */
const inFlight = new Set<number>();

/** Skip comments from other bots (e.g. gemini-code-assist[bot]), keep humans + mikoto */
export function isCommentVisible(author: string): boolean {
  if (author === BOT_LOGIN) return true;       // our own bot
  if (author.endsWith("[bot]")) return false;   // other bots
  return true;                                  // humans
}

/**
 * GitHub → Telegram: push a new PR comment to the corresponding TG topic.
 * Called from webhook handler when a new issue_comment is created.
 */
export async function syncGitHubCommentToTG(
  repo: string,
  prNumber: number,
  comment: { id: number; author: string; body: string; createdAt: string }
): Promise<void> {
  if (!TELEGRAM_CONFIG) return;

  // Anti-loop: skip comments created by TG sync
  if (comment.body.includes(TG_SYNC_MARKER)) {
    log(`[Sync] Skipping tg-sync marked comment ${comment.id}`);
    return;
  }

  // Skip other bots (gemini-code-assist[bot], etc.)
  if (!isCommentVisible(comment.author)) return;

  // Dedup: skip if this comment is already being processed
  if (inFlight.has(comment.id)) return;
  inFlight.add(comment.id);

  try {
    // Find which TG group has this repo
    for (const [chatId] of getGroupsByRepo(repo)) {
      if (!isSyncPREnabled(chatId)) continue; // PR sync disabled for this group

      const threadId = store.getTopicThread(chatId, prNumber);
      if (!threadId) continue; // PR not loaded in this group

      // Check if we already synced this comment
      const existing = store.getMessageRef(repo, prNumber, comment.id);
      if (existing) continue;

      const formatted = tg.formatCommentForTG(comment);

      try {
        const sent = await tg.sendLongMessage(chatId, formatted, { threadId });
        await store.setMessageRef(repo, prNumber, comment.id, {
          chatId,
          threadId,
          messageId: sent.message_id,
        });
        log(`[Sync] GH→TG: comment ${comment.id} → chat ${chatId} thread ${threadId}`);
      } catch (err: any) {
        log(`[Sync] GH→TG failed for comment ${comment.id}: ${err.message}`);
        tg.sendMessage(chatId, `⚠️ GitHub 评论同步失败，请查看 GitHub 原文 (comment #${comment.id})`, { threadId }).catch(() => {});
      }
    }
  } finally {
    inFlight.delete(comment.id);
  }
}

/**
 * Telegram → GitHub: post a TG topic message as a PR comment.
 * Called from the polling loop for non-command messages in PR topics.
 */
export async function syncTGMessageToGitHub(msg: TGMessage): Promise<void> {
  if (!TELEGRAM_CONFIG) return;

  const chatId = String(msg.chat.id);
  const userId = msg.from?.id;
  const username = msg.from?.username;
  if (!userId || !isAllowed(chatId, userId, username)) return; // Only whitelisted users can sync to GitHub
  if (!isSyncPREnabled(chatId)) return; // PR sync disabled for this group

  const threadId = msg.message_thread_id;
  if (!threadId) return; // Not in a topic

  const group = TELEGRAM_CONFIG.groups[chatId];
  if (!group) return;

  const repo = group.repo;
  const prNumber = store.findPRByThread(chatId, threadId);
  if (!prNumber) return; // Topic not linked to a PR

  const installationId = REPOS[repo]?.installationId;
  if (!installationId) return;

  const author = msg.from?.first_name || msg.from?.username || "Unknown";
  const text = msg.text || "";
  if (!text) return;

  const body = `**${author}** (via Telegram):\n\n${text}\n\n${TG_SYNC_MARKER}`;

  try {
    const { id: commentId } = await ghApi.postPRComment(installationId, repo, prNumber, body);
    await store.setMessageRef(repo, prNumber, commentId, {
      chatId,
      threadId,
      messageId: msg.message_id,
    });
    log(`[Sync] TG→GH: msg ${msg.message_id} → comment ${commentId} on ${repo}#${prNumber}`);
  } catch (err: any) {
    log(`[Sync] TG→GH failed: ${err.message}`);
    tg.sendMessage(chatId, `⚠️ 消息同步到 GitHub 失败，请在 GitHub 上手动评论 (PR #${prNumber})`, { threadId }).catch(() => {});
  }
}

