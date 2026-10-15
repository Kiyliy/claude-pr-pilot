import { log } from "../utils/logger";
import { findActiveStandaloneThread } from "../review/manager";
import { REPOS, isSyncPREnabled, getGroupsByRepo } from "../config";
import * as store from "../store/db";
import * as tg from "../telegram/client";
import { loadPR } from "../telegram/commands";

/** Notify the PR's TG topic that the PR has been merged */
export async function notifyPRMergedToTopic(repo: string, prNumber: number, title: string): Promise<void> {
  for (const [chatId] of getGroupsByRepo(repo)) {
    if (!isSyncPREnabled(chatId)) continue;

    const threadId = store.getTopicThread(chatId, prNumber);
    if (!threadId) continue;

    const text = `✅ PR #${prNumber} 已合并: ${title}`;

    try {
      await tg.sendMessage(chatId, text, { threadId });
    } catch (err: any) {
      log(`[Sync] Failed to notify PR merge to topic: ${err.message}`);
    }
  }
}

/** Notify selfhost groups (syncPR: false) that a new version is available */
export async function notifyVersionUpdate(repo: string, prNumber: number, title: string): Promise<void> {
  for (const [chatId, group] of getGroupsByRepo(repo)) {
    if (group.syncPR !== false) continue; // only notify ops/selfhost groups

    const text = `🆕 <b>New version available</b>\n` +
      `PR #${prNumber} merged: ${title}\n` +
      `Use /update to pull and restart.`;

    try {
      await tg.sendMessage(chatId, text);
    } catch (err: any) {
      log(`[Sync] Failed to notify version update: ${err.message}`);
    }
  }
}

export async function autoLoadPR(repoFullName: string, prNumber: number, prTitle?: string, prBranch?: string): Promise<void> {
  log(`[autoLoadPR] START PR #${prNumber} repo=${repoFullName} title="${prTitle?.slice(0, 60)}" branch=${prBranch}`);
  for (const [chatId] of getGroupsByRepo(repoFullName)) {
    if (!isSyncPREnabled(chatId)) continue; // PR sync disabled for this group

    // Check if already loaded in pr_topics
    const existing = store.getTopicThread(chatId, prNumber);
    log(`[autoLoadPR] PR #${prNumber} chat=${chatId}: pr_topics lookup → threadId=${existing ?? 'null'}`);
    if (existing) {
      const alive = await tg.topicExists(chatId, existing);
      if (alive) {
        log(`[autoLoadPR] PR #${prNumber} already loaded in topic ${existing}, skipping`);
        continue; // Already loaded and topic exists — process remaining groups
      }
      // Stale mapping — clean up and re-load
      log(`[${repoFullName}] PR #${prNumber} stale topic ${existing}, re-loading`);
      await store.removeTopicThread(chatId, prNumber, repoFullName, { keepMessages: true });
    }

    // Check if a standalone topic is already bound to this PR (task finished before webhook)
    const standaloneThreadId = store.findStandaloneTopicByPR(chatId, prNumber);
    log(`[autoLoadPR] PR #${prNumber} chat=${chatId}: standalone_topics PR lookup → threadId=${standaloneThreadId ?? 'null'}`);
    if (standaloneThreadId) {
      const alive = await tg.topicExists(chatId, standaloneThreadId);
      if (alive) {
        store.setTopicThread(chatId, prNumber, standaloneThreadId);
        log(`[${repoFullName}] PR #${prNumber} bound to existing standalone topic ${standaloneThreadId}`);
        continue; // topic registered for this group — process remaining groups
      }
      log(`[autoLoadPR] PR #${prNumber}: standalone topic ${standaloneThreadId} no longer alive`);
    }

    // Check if there's an active standalone task that likely created this PR.
    // Uses branch-based matching (highest priority), then description-based matching.
    const activeThreadId = findActiveStandaloneThread(repoFullName, chatId, prTitle, prBranch);
    log(`[autoLoadPR] PR #${prNumber} chat=${chatId}: findActiveStandaloneThread → threadId=${activeThreadId ?? 'null'}`);
    if (activeThreadId) {
      // Guard: only claim this thread if it's not already bound to another PR.
      // Without this check, a second PR opened while the same standalone task is
      // still running would be incorrectly bound to the same topic, causing messages
      // from two different PRs to be routed to the same Telegram topic (消息串 bug).
      const claimedBy = store.findPRByThread(chatId, activeThreadId);
      log(`[autoLoadPR] PR #${prNumber}: active thread ${activeThreadId} claimedBy=${claimedBy ?? 'null'}`);
      if (!claimedBy || claimedBy === prNumber) {
        store.setTopicThread(chatId, prNumber, activeThreadId);
        store.updateStandaloneTopicPR(chatId, activeThreadId, prNumber);
        const bindReason = claimedBy === prNumber ? "re-binding (idempotent)" : "binding";
        log(`[${repoFullName}] PR #${prNumber} ${bindReason} to active standalone task topic ${activeThreadId}`);
        continue; // topic registered for this group — process remaining groups
      }
      log(`[${repoFullName}] Active standalone thread ${activeThreadId} already claimed by PR #${claimedBy}, skipping bind for PR #${prNumber}`);
    }

    const installationId = REPOS[repoFullName]?.installationId;
    if (!installationId) continue; // no installationId for this group — process remaining groups

    log(`[autoLoadPR] PR #${prNumber} chat=${chatId}: NO existing topic found, creating NEW topic via loadPR ⚠️`);
    await loadPR(chatId, repoFullName, installationId, prNumber);
  }
  log(`[autoLoadPR] END PR #${prNumber}`);
}

/** Look up TG chat/thread for a PR (for routing task output to Telegram) */
export function findTGTopicForPR(repoFullName: string, prNumber: number): { chatId: string; threadId: number } | null {
  for (const [chatId] of getGroupsByRepo(repoFullName)) {
    if (!isSyncPREnabled(chatId)) continue;
    const threadId = store.getTopicThread(chatId, prNumber);
    if (threadId) return { chatId, threadId };
  }
  return null;
}
