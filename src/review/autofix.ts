import { execSync } from "child_process";
import { log } from "../utils/logger";
import { getRepoConfig, BOT_LOGIN, resolveSkillPath } from "../config";
import * as ghApi from "../github/api";
import * as db from "../store/db";
import type { TaskRequest } from "../types";

const DEFAULT_MAX_AUTO_FIX_ROUNDS = 10;

/**
 * Persistent state tracking auto-fix rounds (backed by SQLite autofix_state table).
 * Set when a fix task is triggered (review→fix); consumed by handlePullRequest
 * when the fix pushes a commit and the `synchronize` event fires.
 * This lets the synchronize-triggered review inherit the correct round number.
 *
 * Key format: "owner/repo#prNumber"
 */

/** @internal — only for use in tests */
export function _resetAutoFixState(): void {
  db.clearAllAutofixState();
}

/** Record HEAD SHA before a fix starts (for no-commit detection in auto-fix) */
export function recordAutoFixHeadSHA(repoFullName: string, prNumber: number, sha: string): void {
  db.setAutofixHeadSHA(`${repoFullName}#${prNumber}`, sha);
}

/**
 * Clean up all auto-fix state for a PR.
 * Called when a fix task fails (non-zero exit or process error) to prevent
 * state entries from leaking — no synchronize event will fire in these cases.
 */
export function cleanupAutoFixState(repoFullName: string, prNumber: number): void {
  db.deleteAutofixState(`${repoFullName}#${prNumber}`);
}

/**
 * Consume (read and delete) the auto-fix round for a PR.
 * Called by handlePullRequest on `synchronize` events to propagate round info.
 * Returns { round: 0, manualAutoFix: false } if no auto-fix round is pending.
 */
export function consumeAutoFixRound(repoFullName: string, prNumber: number): { round: number; manualAutoFix: boolean } {
  const key = `${repoFullName}#${prNumber}`;
  const state = db.getAutofixState(key);
  if (state && state.rounds > 0) {
    const { rounds, isManual } = state;
    db.clearAutofixRoundsAndManual(key);
    return { round: rounds, manualAutoFix: isManual };
  }
  return { round: 0, manualAutoFix: false };
}

/**
 * After a review completes, check if auto-fix should be triggered.
 * After a fix completes (from auto-fix), trigger a re-review.
 * Cycle: review(round N) → fix(round N) → review(round N+1) → ...
 *
 * Triggers are done by posting a PR comment with autofix metadata,
 * which the webhook handler picks up — making the flow visible in the PR timeline.
 */
export async function maybeAutoFix(task: TaskRequest, output: string): Promise<void> {
  const config = getRepoConfig(task.repoFullName);
  if (!config) return;
  if (!config.autoFix && !task.manualAutoFix) return;
  if (!task.prNumber) return;

  const round = task.autoFixRound || 0;
  const maxRounds = config.maxAutoFixRounds ?? DEFAULT_MAX_AUTO_FIX_ROUNDS;

  if (task.command === "review") {
    // Determine review verdict and merge status from the latest bot PR comment.
    // The review skill always posts a PR comment with the verdict (🔴/🟡/🟢) and any
    // merge failure indicators. This is more reliable than parsing stdout markers.
    //
    // needsFix: primary signal is the bot comment; falls back to stdout if comment fetch
    //   fails or no bot comment exists (robustness for edge cases).
    // mergeFailed: comment-only — no stdout fallback (as requested).
    let needsFix = false;
    let mergeFailed = false;

    if (config.installationId) {
      try {
        const comments = await ghApi.getPRComments(config.installationId, task.repoFullName, task.prNumber);
        const botComments = comments.filter(c => c.author === BOT_LOGIN);
        const lastBotComment = botComments[botComments.length - 1];
        if (lastBotComment) {
          needsFix = /🔴|🟡/.test(lastBotComment.body) || /Needs\s+(Minor\s+)?Changes/i.test(lastBotComment.body);
          mergeFailed = /自动合并失败/.test(lastBotComment.body);
          log(`[${task.repoFullName}] PR #${task.prNumber} review status from bot comment: needsFix=${needsFix}, mergeFailed=${mergeFailed}`);
        } else {
          log(`[${task.repoFullName}] PR #${task.prNumber} no bot comment found, falling back to stdout for review verdict`);
          const statusLine = output.match(/^REVIEW_STATUS:\s*(\S+)/m);
          needsFix = statusLine
            ? statusLine[1] === "needs_changes"
            : /🔴|🟡/.test(output) || /Needs\s+(Minor\s+)?Changes/i.test(output);
        }
      } catch (err: any) {
        log(`[${task.repoFullName}] PR #${task.prNumber} failed to fetch PR comments: ${err.message}, falling back to stdout for review verdict`);
        const statusLine = output.match(/^REVIEW_STATUS:\s*(\S+)/m);
        needsFix = statusLine
          ? statusLine[1] === "needs_changes"
          : /🔴|🟡/.test(output) || /Needs\s+(Minor\s+)?Changes/i.test(output);
      }
    } else {
      // No installationId — fall back to stdout
      const statusLine = output.match(/^REVIEW_STATUS:\s*(\S+)/m);
      needsFix = statusLine
        ? statusLine[1] === "needs_changes"
        : /🔴|🟡/.test(output) || /Needs\s+(Minor\s+)?Changes/i.test(output);
    }

    if (!needsFix && !mergeFailed) {
      // Auto-verify: if configured, trigger verify instead of stopping
      if (config.autoVerify) {
        const prKey = `${task.repoFullName}#${task.prNumber}`;
        const verifyState = db.getAutoverifyState(prKey);
        const verifyRound = verifyState?.verifyRounds ?? 0;
        log(`[${task.repoFullName}] PR #${task.prNumber} review passed 🟢, triggering product verify (round ${verifyRound})`);
        triggerVerify(task, round, verifyRound);
        return;
      }
      if (round > 0) {
        log(`[${task.repoFullName}] PR #${task.prNumber} auto-fix round ${round}: review passed 🟢, stopping cycle`);
        postAutoFixStatus(
          config.installationId, task,
          `✅ **Auto-fix cycle completed** after ${round} round(s). Review passed.`,
        );
      }
      return;
    }

    if (round >= maxRounds) {
      log(`[${task.repoFullName}] PR #${task.prNumber} auto-fix reached max rounds (${maxRounds}), stopping`);
      postAutoFixStatus(
        config.installationId, task,
        `⚠️ **Auto-fix reached max rounds** (${maxRounds}). Please review and fix remaining issues manually.`,
      );
      return;
    }

    // Determine if this is a conflict-only fix (review passed but merge failed)
    const isConflictOnly = !needsFix && mergeFailed;

    // Trigger fix by posting a PR comment (webhook will pick it up)
    const nextRound = round + 1;
    const isManual = !!task.manualAutoFix;

    if (isConflictOnly) {
      log(`[${task.repoFullName}] PR #${task.prNumber} auto-fix round ${nextRound}: merge failed due to conflicts, posting /fix comment${isManual ? " (manual)" : ""}`);
    } else {
      log(`[${task.repoFullName}] PR #${task.prNumber} auto-fix round ${nextRound}: review found issues, posting /fix comment${isManual ? " (manual)" : ""}`);
    }

    // Remember the round (and manual flag) so that when fix pushes a commit
    // and `synchronize` fires, the re-review inherits the correct state.
    db.setAutofixRounds(`${task.repoFullName}#${task.prNumber}`, nextRound, isManual);

    const manualMeta = isManual ? ",manual=true" : "";
    const fixInstruction = isConflictOnly
      ? `Rebase this branch onto the base branch to resolve merge conflicts. Do NOT modify any code logic — only resolve the conflicts so the PR can be merged cleanly.`
      : `Fix all issues found in the latest CLAUDE REVIEW comment on this PR.`;

    const triggerReason = isConflictOnly
      ? `Merge failed (conflicts detected)`
      : `Review found issues`;

    const body =
      `🔄 **Auto-fix round ${nextRound}/${maxRounds}**: ${triggerReason}, triggering fix...\n\n` +
      `> @${BOT_LOGIN} /fix ${fixInstruction}\n\n` +
      `<!-- autofix:command=fix,round=${nextRound}${manualMeta} -->`;


    postAutoFixComment(config.installationId, task, body, "fix", nextRound);

  } else if (task.command === "fix" && round > 0) {
    // Fix is complete. The commit push triggers a `synchronize` event which
    // already starts a re-review (via handlePullRequest). No need to post
    // a separate /review comment — that would cause a duplicate review.
    // The round number is propagated via autofix_state (set when the
    // fix was triggered) and consumed by handlePullRequest via consumeAutoFixRound().
    // NOTE: Do NOT delete autofix rounds here — let consumeAutoFixRound() handle
    // cleanup exclusively, to avoid losing round context if synchronize is delayed.

    // Check if fix produced any new commits by comparing HEAD SHA before/after
    const stateKey = `${task.repoFullName}#${task.prNumber}`;
    const state = db.getAutofixState(stateKey);
    const beforeSHA = state?.headSha ?? null;
    db.clearAutofixHeadSHA(stateKey);

    if (beforeSHA && task.headBranch) {
      try {
        execSync("git fetch origin", { cwd: config.dir, stdio: "ignore" });
        const afterSHA = execSync(`git rev-parse origin/${task.headBranch}`, {
          cwd: config.dir, encoding: "utf-8",
        }).trim();
        if (afterSHA === beforeSHA) {
          log(`[${task.repoFullName}] PR #${task.prNumber} auto-fix round ${round}: no changes were pushed`);
          db.deleteAutofixState(stateKey); // no synchronize will fire, clean up
          postAutoFixStatus(
            config.installationId, task,
            `ℹ️ **Auto-fix round ${round}**: No changes were made. Please review and fix manually.`,
          );
          return;
        }
      } catch { /* proceed with normal flow on error */ }
    }

    log(`[${task.repoFullName}] PR #${task.prNumber} auto-fix round ${round}: fix done, re-review will be triggered by synchronize event`);

    postAutoFixStatus(
      config.installationId, task,
      `🔄 **Auto-fix round ${round}/${maxRounds}**: Fix complete, re-review will be triggered automatically.`,
    );
  }
}

/**
 * Post an auto-fix trigger comment on the PR.
 * Falls back to direct runTask() if comment posting fails.
 */
function postAutoFixComment(
  installationId: number | undefined,
  task: TaskRequest,
  body: string,
  command: string,
  round: number,
): void {
  if (!installationId || !task.prNumber) {
    log(`[${task.repoFullName}] PR #${task.prNumber} no installationId, falling back to direct ${command}`);
    fallbackDirectTrigger(task, command, round);
    return;
  }

  ghApi.postPRComment(installationId, task.repoFullName, task.prNumber, body)
    .then(() => {
      log(`[${task.repoFullName}] PR #${task.prNumber} auto-fix: posted /${command} comment (round ${round})`);
    })
    .catch((err: any) => {
      log(`[${task.repoFullName}] PR #${task.prNumber} auto-fix: failed to post comment: ${err.message}, falling back to direct trigger`);
      fallbackDirectTrigger(task, command, round);
    });
}

/**
 * Post a status-only comment (no trigger) for cycle completion / max rounds.
 * Telegram notification is handled by the GitHub comment sync webhook.
 */
function postAutoFixStatus(
  installationId: number | undefined,
  task: TaskRequest,
  ghMessage: string,
): void {
  if (installationId && task.prNumber) {
    ghApi.postPRComment(installationId, task.repoFullName, task.prNumber, ghMessage).catch((err: any) => {
      log(`[${task.repoFullName}] PR #${task.prNumber} auto-fix status comment failed: ${err.message}`);
    });
  }
}

/** Fallback: trigger task directly when PR comment posting fails */
function fallbackDirectTrigger(task: TaskRequest, command: string, round: number): void {
  setTimeout(async () => {
    // Lazy import to avoid circular dependency with manager.ts
    const { runTask } = await import("./manager");
    const skillPath = resolveSkillPath(task.repoFullName, command);
    runTask({
      repoFullName: task.repoFullName,
      prNumber: task.prNumber,
      headBranch: task.headBranch,
      command,
      skillPath: skillPath || undefined,
      userInput: command === "fix"
        ? "Fix all issues found in the latest CLAUDE REVIEW comment on this PR."
        : undefined,
      tgChatId: task.tgChatId,
      tgThreadId: task.tgThreadId,
      autoFixRound: round,
      manualAutoFix: task.manualAutoFix,
    });
  }, 3000);
}

/**
 * Trigger a product verify task by posting a PR comment with an autoverify marker.
 * Called by maybeAutoFix when review passes and autoVerify is configured.
 */
function triggerVerify(task: TaskRequest, autoFixRound: number, verifyRound: number): void {
  const config = getRepoConfig(task.repoFullName);
  if (!config?.installationId || !task.prNumber) {
    log(`[${task.repoFullName}] PR #${task.prNumber} no installationId, cannot trigger verify`);
    return;
  }

  const roundInfo = autoFixRound > 0 ? ` (after auto-fix round ${autoFixRound})` : "";
  const body =
    `🔍 **Review passed** — triggering product verification${roundInfo}...\n\n` +
    `<!-- autoverify:command=verify,round=${verifyRound} -->`;

  ghApi.postPRComment(config.installationId, task.repoFullName, task.prNumber, body)
    .then(() => {
      log(`[${task.repoFullName}] PR #${task.prNumber} posted verify trigger comment (verifyRound=${verifyRound})`);
    })
    .catch((err: any) => {
      log(`[${task.repoFullName}] PR #${task.prNumber} failed to post verify trigger: ${err.message}`);
    });
}
