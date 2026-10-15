/**
 * Skill-based commands: /review, /fix, /do, /ask, and any custom skill commands.
 * Handles both PR-topic context and standalone mode.
 */

import { log } from "../../utils/logger";
import { resolveSkillPath } from "../../config";
import { runTask } from "../../review/manager";
import { recordCommand } from "../../review/topic-context";
import * as tg from "../client";
import * as store from "../../store/db";
import { isAllowed } from "../auth";
import { getRepoForChat, parseCommand, resolveHeadBranch } from "./utils";
import type { TGMessage } from "../../types";

export async function cmdSkill(msg: TGMessage, chatId: string, userId: number, username?: string, threadId?: number): Promise<void> {
  if (!isAllowed(chatId, userId, username)) {
    await tg.sendMessage(chatId, "Permission denied.", { threadId });
    return;
  }

  const { command, userInput } = parseCommand(msg.text || "");
  const repo = getRepoForChat(chatId);
  if (!repo) return;

  const skillPath = resolveSkillPath(repo, command);
  if (!skillPath) {
    await tg.sendMessage(chatId, `Unknown command: /${command}`, { threadId });
    return;
  }

  // Commands that require user input
  if ((command === "do" || command === "ask" || command === "pm") && !userInput) {
    const hint = command === "ask" ? "question" : command === "pm" ? "feature description" : "instruction";
    await tg.sendMessage(chatId, `Usage: /${command} <${hint}>`, { threadId });
    return;
  }

  // In-topic mode: check if this topic is linked to a PR
  if (threadId) {
    log(`[TG] cmdSkill: /${command} in topic threadId=${threadId}, chatId=${chatId}`);
    const prNumber = store.findPRByThread(chatId, threadId);
    if (prNumber) {
      log(`[TG] cmdSkill: topic threadId=${threadId} linked to PR #${prNumber}, running in-topic`);
      const headBranch = await resolveHeadBranch(repo, prNumber);
      const rejection = runTask({
        repoFullName: repo,
        prNumber,
        headBranch,
        command,
        skillPath,
        userInput: userInput || undefined,
        tgChatId: chatId,
        tgThreadId: threadId,
      });
      if (rejection) {
        await tg.sendMessage(chatId, rejection.reason, { threadId });
        return;
      }
      const extra = userInput ? ` (${userInput.slice(0, 500)}${userInput.length > 500 ? "..." : ""})` : "";
      await tg.sendMessage(chatId, `Task '${command}' triggered for PR #${prNumber}.${extra}`, { threadId });
      recordCommand(chatId, threadId, msg.text || "", username || "user");
      return;
    }

    // Check if this is a standalone topic — reuse it for follow-up commands
    const standaloneTopic = store.getStandaloneTopic(chatId, threadId);
    log(`[TG] cmdSkill: standalone lookup for threadId=${threadId}: ${standaloneTopic ? JSON.stringify(standaloneTopic) : 'null'}`);
    if (standaloneTopic) {
      log(`[TG] cmdSkill: reusing standalone topic threadId=${threadId} for /${command}`);
      const headBranch = standaloneTopic.branch || null;
      const rejection = runTask({
        repoFullName: repo,
        prNumber: standaloneTopic.prNumber,
        issueNumber: standaloneTopic.issueNumber,
        headBranch,
        command,
        skillPath,
        userInput: userInput || undefined,
        tgChatId: chatId,
        tgThreadId: threadId,
      });
      if (rejection) {
        await tg.sendMessage(chatId, rejection.reason, { threadId });
        return;
      }
      const ctx = standaloneTopic.prNumber ? ` (PR #${standaloneTopic.prNumber})` : standaloneTopic.branch ? ` (branch: ${standaloneTopic.branch})` : "";
      await tg.sendMessage(chatId, `Task '${command}' triggered${ctx}.`, { threadId });
      recordCommand(chatId, threadId, msg.text || "", username || "user");
      return;
    }
    // Topic exists but not linked — fall through to standalone mode
  }

  // Standalone mode: review/fix require a target (PR number or description)
  if ((command === "review" || command === "fix") && !userInput) {
    await tg.sendMessage(chatId, `Use /${command} inside a PR topic, or provide a target: /${command} <PR number or description>`, { threadId });
    return;
  }

  // If userInput is a pure PR number, resolve it for proper branch checkout
  let prNumber: number | undefined;
  let headBranch: string | null = null;
  const prNumMatch = userInput?.match(/^#?(\d+)$/);
  if (prNumMatch) {
    prNumber = Number(prNumMatch[1]);
    headBranch = await resolveHeadBranch(repo, prNumber);
  }

  log(`[TG] cmdSkill: no existing topic context, creating new standalone topic for /${command}`);
  const emoji = command === "ask" ? "💬" : command === "do" ? "🔨" : "⚡";
  const topicTitle = `${command}: ${(userInput || "task").slice(0, 100)}`;
  const topic = await tg.createForumTopic(chatId, topicTitle, emoji);
  const targetThreadId = topic.message_thread_id;
  log(`[TG] cmdSkill: created standalone topic threadId=${targetThreadId} for /${command}`);

  // Register standalone topic for follow-up reuse (store description for PR binding verification)
  store.setStandaloneTopic(chatId, targetThreadId, { repo, prNumber, description: userInput || undefined });

  const rejection = runTask({
    repoFullName: repo,
    prNumber,
    headBranch,
    command,
    skillPath,
    userInput: userInput || undefined,
    tgChatId: chatId,
    tgThreadId: targetThreadId,
  });
  if (rejection) {
    await tg.sendMessage(chatId, rejection.reason, { threadId: targetThreadId });
    return;
  }
  const ctx = prNumber ? ` for PR #${prNumber}` : "";
  await tg.sendMessage(chatId, `Task '${command}' started${ctx}.${userInput && !prNumber ? ` Instruction: ${userInput.slice(0, 500)}` : ""}`, {
    threadId: targetThreadId,
  });
  recordCommand(chatId, targetThreadId, msg.text || "", username || "user");
}
