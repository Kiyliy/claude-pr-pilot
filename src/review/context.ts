import { BOT_LOGIN, MENTION_PATTERN } from "../config";
import { log } from "../utils/logger";
import * as ghApi from "../github/api";

function isRelevant(comment: ghApi.PRComment): boolean {
  if (comment.author === BOT_LOGIN) return true;
  if (MENTION_PATTERN.test(comment.body || "")) return true;
  return false;
}

export async function loadIssueContext(
  repoFullName: string,
  issueNumber: number,
  installationId: number,
): Promise<string | null> {
  try {
    const comments = await ghApi.getIssueComments(installationId, repoFullName, issueNumber);
    if (comments.length === 0) return null;

    const parts: string[] = [`## Conversation History (Issue #${issueNumber})`];
    for (const c of comments) {
      const date = new Date(c.createdAt).toISOString().replace("T", " ").slice(0, 19);
      const label = c.author === BOT_LOGIN ? "Your previous answer" : `${c.author}`;
      parts.push(`### ${label} at ${date}`);
      parts.push(c.body);
      parts.push("");
    }

    log(`[${repoFullName}] Issue #${issueNumber} loaded context: ${comments.length} comment(s)`);
    return parts.join("\n");
  } catch (err: any) {
    log(`[${repoFullName}] Issue #${issueNumber} failed to load context: ${err.message}`);
    return null;
  }
}

export async function loadBotContext(
  repoFullName: string,
  prNumber: number,
  installationId: number,
): Promise<string | null> {
  try {
    const comments = await ghApi.getPRComments(installationId, repoFullName, prNumber);
    const relevant = comments.filter(isRelevant);

    if (relevant.length === 0) {
      return null;
    }

    const parts: string[] = ["## Conversation History (your reviews + messages directed at you)"];
    for (const c of relevant) {
      const date = new Date(c.createdAt).toISOString().replace("T", " ").slice(0, 19);
      const label = c.author === BOT_LOGIN ? "Your review" : `${c.author} (to you)`;
      parts.push(`### ${label} at ${date}`);
      parts.push(c.body);
      parts.push("");
    }

    const botCount = relevant.filter((c) => c.author === BOT_LOGIN).length;
    const mentionCount = relevant.length - botCount;
    log(`[${repoFullName}] PR #${prNumber} loaded context: ${botCount} review(s), ${mentionCount} mention(s)`);
    return parts.join("\n");
  } catch (err: any) {
    log(`[${repoFullName}] PR #${prNumber} failed to load bot context: ${err.message}`);
    return null;
  }
}
