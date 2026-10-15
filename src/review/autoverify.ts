import { log } from "../utils/logger";
import { getRepoConfig, BOT_LOGIN } from "../config";
import * as ghApi from "../github/api";
import * as db from "../store/db";
import type { TaskRequest } from "../types";

const DEFAULT_MAX_AUTO_VERIFY_ROUNDS = 3;

/** @internal — only for use in tests */
export function _resetAutoverifyState(): void {
  db.clearAllAutoverifyState();
}

/**
 * Clean up all auto-verify state for a PR.
 * Called when a verify task fails (non-zero exit) to prevent stale state.
 */
export function cleanupAutoverifyState(repoFullName: string, prNumber: number): void {
  db.deleteAutoverifyState(`${repoFullName}#${prNumber}`);
}

/**
 * After a verify task completes, determine next action:
 * - passed → delete state, optionally post "passed" status comment
 * - needs_changes → increment round, trigger fix cycle (if under maxRounds)
 */
export async function maybeAutoVerify(task: TaskRequest, output: string): Promise<void> {
  const config = getRepoConfig(task.repoFullName);
  if (!config) return;
  if (!task.prNumber) return;

  const prKey = `${task.repoFullName}#${task.prNumber}`;
  const round = task.verifyRound ?? 0;
  const maxRounds = config.maxAutoVerifyRounds ?? DEFAULT_MAX_AUTO_VERIFY_ROUNDS;

  // Determine verify result: prefer last bot comment, fall back to stdout
  let passed = false;
  if (config.installationId) {
    try {
      const comments = await ghApi.getPRComments(config.installationId, task.repoFullName, task.prNumber);
      const botComments = comments.filter((c) => c.author === BOT_LOGIN);
      const lastBotComment = botComments[botComments.length - 1];
      if (lastBotComment) {
        const body = lastBotComment.body;
        const hasPass = /VERIFY_STATUS:\s*passed/i.test(body) || /Verdict:.*?✅\s*Passed/i.test(body);
        const hasFail = /VERIFY_STATUS:\s*needs_changes/i.test(body) || /Verdict:.*?❌/i.test(body);
        if (hasPass) {
          passed = true;
          log(`[${task.repoFullName}] PR #${task.prNumber} verify status from bot comment: passed=true`);
        } else if (hasFail) {
          passed = false;
          log(`[${task.repoFullName}] PR #${task.prNumber} verify status from bot comment: passed=false`);
        } else {
          // Comment has no recognizable verdict — fall back to stdout
          // (SKILL.md outputs VERIFY_STATUS to stdout, not always in the comment body)
          log(`[${task.repoFullName}] PR #${task.prNumber} bot comment has no recognizable verdict, falling back to stdout`);
          passed = /^VERIFY_STATUS:\s*passed/m.test(output);
        }
      } else {
        log(`[${task.repoFullName}] PR #${task.prNumber} no bot comment, falling back to stdout`);
        passed = /^VERIFY_STATUS:\s*passed/m.test(output);
      }
    } catch (err: any) {
      log(`[${task.repoFullName}] PR #${task.prNumber} failed to fetch PR comments: ${err.message}, falling back to stdout`);
      passed = /^VERIFY_STATUS:\s*passed/m.test(output);
    }
  } else {
    passed = /^VERIFY_STATUS:\s*passed/m.test(output);
  }

  if (passed) {
    db.deleteAutoverifyState(prKey);
    if (round > 0) {
      log(`[${task.repoFullName}] PR #${task.prNumber} product verify passed after ${round} round(s)`);
      postAutoverifyStatus(
        config.installationId, task,
        `✅ **Product verification passed** after ${round} round(s).`,
      );
    } else {
      log(`[${task.repoFullName}] PR #${task.prNumber} product verify passed`);
    }
    return;
  }

  // Verify failed
  const nextRound = round + 1;
  if (nextRound > maxRounds) {
    log(`[${task.repoFullName}] PR #${task.prNumber} product verify reached max rounds (${maxRounds}), stopping`);
    db.deleteAutoverifyState(prKey);
    postAutoverifyStatus(
      config.installationId, task,
      `⚠️ **Product verification reached max rounds** (${maxRounds}). Please review and address the issues manually.`,
    );
    return;
  }

  log(`[${task.repoFullName}] PR #${task.prNumber} product verify round ${nextRound}: failed, triggering fix`);
  db.setAutoverifyRounds(prKey, nextRound);

  // Trigger fix via PR comment (reuses the autofix webhook mechanism)
  const body =
    `🔄 **Product verify round ${nextRound}/${maxRounds}**: Verification failed, triggering fix...\n\n` +
    `> @${BOT_LOGIN} /fix Fix all issues found in the latest PRODUCT VERIFY comment on this PR.\n\n` +
    // round=1 is intentional: autofix rounds and verify rounds are independent counters.
    // The verify round is tracked in autoverify_state, not autofix_state.
    `<!-- autofix:command=fix,round=1 -->`;

  postAutoverifyComment(config.installationId, task, body, nextRound);
}

function postAutoverifyComment(
  installationId: number | undefined,
  task: TaskRequest,
  body: string,
  round: number,
): void {
  if (!installationId || !task.prNumber) {
    log(`[${task.repoFullName}] PR #${task.prNumber} no installationId, cannot post verify comment`);
    return;
  }
  ghApi.postPRComment(installationId, task.repoFullName, task.prNumber, body)
    .then(() => {
      log(`[${task.repoFullName}] PR #${task.prNumber} posted verify-triggered fix comment (round ${round})`);
    })
    .catch((err: any) => {
      log(`[${task.repoFullName}] PR #${task.prNumber} failed to post verify comment: ${err.message}`);
    });
}

function postAutoverifyStatus(
  installationId: number | undefined,
  task: TaskRequest,
  message: string,
): void {
  if (installationId && task.prNumber) {
    ghApi.postPRComment(installationId, task.repoFullName, task.prNumber, message).catch((err: any) => {
      log(`[${task.repoFullName}] PR #${task.prNumber} autoverify status comment failed: ${err.message}`);
    });
  }
}
