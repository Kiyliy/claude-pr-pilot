import { log } from "../utils/logger";
import { runTask, consumeAutoFixRound, cleanupAutoFixState } from "../review/manager";
import { syncGitHubCommentToTG } from "../telegram/sync-github";
import { TELEGRAM_CONFIG, MENTION_PATTERN, BOT_LOGIN, resolveSkillPath } from "../config";
import * as ghApi from "../github/api";
import * as tg from "../telegram/client";
import { autoLoadPR, notifyPRMergedToTopic, notifyVersionUpdate, findTGTopicForPR } from "./pr-service";
import { cleanupAutoverifyState } from "../review/autoverify";
import type { RepoConfig, HandlerResult, WebhookPayload } from "../types";

export function handleIssueComment(
  payload: WebhookPayload,
  repoFullName: string,
  _repoConfig: RepoConfig
): HandlerResult {
  const action = payload.action;
  const commentBody = payload.comment?.body || "";
  const isPR = !!payload.issue?.pull_request;
  const prNumber = payload.issue?.number;

  const commentAuthor = payload.comment?.user?.login || "";
  const isTrigger = MENTION_PATTERN.test(commentBody);
  log(
    `[${repoFullName}] issue_comment on ${isPR ? "PR" : "issue"} #${prNumber}, trigger=${isTrigger}, body="${commentBody.slice(0, 100)}"`
  );

  if (!prNumber) {
    return { status: 200, message: "OK - no issue number" };
  }

  // Sync any new PR comment to Telegram (before trigger check to avoid early return skip)
  if (action === "created" && isPR) {
    syncGitHubCommentToTG(repoFullName, prNumber, {
      id: payload.comment?.id ?? 0,
      author: commentAuthor || "unknown",
      body: commentBody,
      createdAt: payload.comment?.created_at || new Date().toISOString(),
    }).catch((err: any) => {
      log(`[${repoFullName}] PR #${prNumber} TG sync failed: ${err.message}`);
    });
  }

  // Bot's own comments: check for auto-fix trigger, skip everything else
  if (commentAuthor === BOT_LOGIN) {
    // Recognize auto-fix trigger comments posted by maybeAutoFix()
    const autoFixMatch = commentBody.match(/<!-- autofix:command=(\w+),round=(\d+)(?:,manual=(true))? -->/);
    if (autoFixMatch && action === "created" && isPR && prNumber) {
      const [, command, roundStr, manualStr] = autoFixMatch;
      const round = parseInt(roundStr, 10);
      const manualAutoFix = manualStr === "true";
      log(`[${repoFullName}] PR #${prNumber} auto-fix webhook: /${command} round ${round}${manualAutoFix ? " (manual)" : ""}`);

      const skillPath = resolveSkillPath(repoFullName, command);
      const tgTopic = findTGTopicForPR(repoFullName, prNumber);
      fetchHeadBranch(repoFullName, prNumber, _repoConfig).then((headBranch) => {
        runTask({
          repoFullName,
          prNumber,
          headBranch,
          command,
          skillPath: skillPath || undefined,
          userInput: command === "fix"
            ? "Fix all issues found in the latest CLAUDE REVIEW comment on this PR."
            : undefined,
          tgChatId: tgTopic?.chatId,
          tgThreadId: tgTopic?.threadId,
          autoFixRound: round,
          manualAutoFix,
        });
      }).catch((err: any) => {
        log(`[${repoFullName}] PR #${prNumber} auto-fix /${command} failed: ${err.message}`);
        if (tgTopic) {
          tg.sendMessage(tgTopic.chatId, `⚠️ Auto-fix /${command} 触发失败: ${err.message}`, { threadId: tgTopic.threadId }).catch(() => {});
        }
      });
      return { status: 200, message: `OK - auto-fix /${command} round ${round} triggered` };
    }
    // Recognize autoverify trigger comments posted by triggerVerify() in autofix.ts
    const autoVerifyMatch = commentBody.match(/<!-- autoverify:command=(\w+),round=(\d+) -->/);
    if (autoVerifyMatch && action === "created" && isPR && prNumber) {
      const [, command, roundStr] = autoVerifyMatch;
      const verifyRound = parseInt(roundStr, 10);
      log(`[${repoFullName}] PR #${prNumber} autoverify webhook: /${command} round ${verifyRound}`);

      const skillPath = resolveSkillPath(repoFullName, command);
      const tgTopic = findTGTopicForPR(repoFullName, prNumber);
      fetchHeadBranch(repoFullName, prNumber, _repoConfig).then((headBranch) => {
        runTask({
          repoFullName,
          prNumber,
          headBranch,
          command,
          skillPath: skillPath || undefined,
          tgChatId: tgTopic?.chatId,
          tgThreadId: tgTopic?.threadId,
          verifyRound,
        });
      }).catch((err: any) => {
        log(`[${repoFullName}] PR #${prNumber} autoverify /${command} failed: ${err.message}`);
        if (tgTopic) {
          tg.sendMessage(tgTopic.chatId, `⚠️ Auto-verify /${command} 触发失败: ${err.message}`, { threadId: tgTopic.threadId }).catch(() => {});
        }
      });
      return { status: 200, message: `OK - autoverify /${command} round ${verifyRound} triggered` };
    }
    // Allow @mikoto /command triggers from the bot on Issues (not PRs).
    // PM auto-dispatch posts @mikoto /do on sub-Issues using the bot identity;
    // we must let these fall through to the regular trigger path.
    if (!isPR && isTrigger && action === "created") {
      // Fall through to trigger handling below
    } else {
      return { status: 200, message: "OK - bot's own comment, skipping trigger" };
    }
  }

  if (action === "created" && isTrigger) {
    // Parse command and optional user input: @mikoto /fix please fix the bug
    const cmdMatch = commentBody.match(/@mikoto(?:-devs)?\s+\/(\w+)(?:\s+([\s\S]*))?/i);
    const triggerCommand = cmdMatch?.[1]?.toLowerCase();
    const userInput = cmdMatch?.[2]?.trim() || undefined;

    if (isPR) {
      // --- PR-bound trigger path ---
      if (triggerCommand === "autofix") {
        log(`[${repoFullName}] PR #${prNumber} manual /autofix requested via comment`);
        const skillPath = resolveSkillPath(repoFullName, "review");
        const tgTopic = findTGTopicForPR(repoFullName, prNumber);
        fetchHeadBranch(repoFullName, prNumber, _repoConfig).then((headBranch) => {
          runTask({
            repoFullName,
            prNumber,
            headBranch,
            command: "review",
            skillPath: skillPath || undefined,
            tgChatId: tgTopic?.chatId,
            tgThreadId: tgTopic?.threadId,
            manualAutoFix: true,
          });
        }).catch((err: any) => {
          log(`[${repoFullName}] PR #${prNumber} manual /autofix failed: ${err.message}`);
          if (tgTopic) {
            tg.sendMessage(tgTopic.chatId, `⚠️ /autofix 触发失败: ${err.message}`, { threadId: tgTopic.threadId }).catch(() => {});
          }
        });
        return { status: 200, message: "OK - manual /autofix triggered" };
      }

      // Resolve command: use parsed command if it has a known skill, otherwise default to "review"
      const command = triggerCommand && resolveSkillPath(repoFullName, triggerCommand)
        ? triggerCommand
        : "review";
      const skillPath = resolveSkillPath(repoFullName, command);

      log(`[${repoFullName}] PR #${prNumber} manual /${command} requested via comment`);

      const tgTopic = findTGTopicForPR(repoFullName, prNumber);
      fetchHeadBranch(repoFullName, prNumber, _repoConfig).then((headBranch) => {
        runTask({
          repoFullName,
          prNumber,
          headBranch,
          command,
          skillPath: skillPath || undefined,
          userInput,
          tgChatId: tgTopic?.chatId,
          tgThreadId: tgTopic?.threadId,
        });
      }).catch((err: any) => {
        log(`[${repoFullName}] PR #${prNumber} manual /${command} failed: ${err.message}`);
        if (tgTopic) {
          tg.sendMessage(tgTopic.chatId, `⚠️ /${command} 触发失败: ${err.message}`, { threadId: tgTopic.threadId }).catch(() => {});
        }
      });
      return { status: 200, message: `OK - manual /${command} triggered` };
    } else {
      // --- Issue trigger path (PM auto-dispatch / standalone Issue commands) ---
      if (!triggerCommand) {
        return { status: 200, message: "OK - comment noted" };
      }

      if (triggerCommand === "autofix") {
        log(`[${repoFullName}] Issue #${prNumber}: /autofix not supported on Issues, skipping`);
        return { status: 200, message: "OK - /autofix not supported on Issues" };
      }

      const skillPath = resolveSkillPath(repoFullName, triggerCommand);
      if (!skillPath) {
        log(`[${repoFullName}] Issue #${prNumber}: unknown command '/${triggerCommand}', skipping`);
        return { status: 200, message: `OK - unknown command '/${triggerCommand}' on issue` };
      }
      const command = triggerCommand!;
      const issueNumber = prNumber;
      log(`[${repoFullName}] Issue #${issueNumber} manual /${command} requested via comment`);

      const rejection = runTask({
        repoFullName,
        issueNumber,
        headBranch: null,
        command,
        skillPath,
        userInput,
      });
      if (rejection) {
        log(`[${repoFullName}] Issue #${issueNumber} /${command} rejected: ${rejection.reason}`);
      }
      return { status: 200, message: `OK - manual /${command} triggered on issue` };
    }
  }

  return { status: 200, message: "OK - comment noted" };
}

export function handlePullRequest(
  payload: WebhookPayload,
  repoFullName: string,
  repoConfig: RepoConfig
): HandlerResult {
  const action = payload.action;
  const prNumber = payload.pull_request?.number;
  const baseBranch = payload.pull_request?.base?.ref;
  const isDraft = payload.pull_request?.draft;

  if (!prNumber) {
    return { status: 200, message: "OK - no PR number" };
  }

  if (isDraft) {
    log(`[${repoFullName}] PR #${prNumber} is draft, skipping review`);
    return { status: 200, message: "OK - draft PR skipped" };
  }

  if (repoConfig.baseBranch && baseBranch !== repoConfig.baseBranch) {
    log(
      `[${repoFullName}] PR #${prNumber} targets ${baseBranch}, not ${repoConfig.baseBranch}. Skipping.`
    );
    return { status: 200, message: "OK - non-target branch skipped" };
  }

  const headBranch = payload.pull_request?.head?.ref;
  const prTitle = payload.pull_request?.title || "";
  const prAuthor = payload.pull_request?.user?.login || "unknown";

  if (action === "opened" || action === "synchronize") {
    log(`[${repoFullName}] PR #${prNumber} ${action} → triggering review`);
    log(
      `[${repoFullName}] PR #${prNumber} title: "${prTitle}", author: ${prAuthor}, ${headBranch} → ${baseBranch}`
    );

    const skillPath = resolveSkillPath(repoFullName, "review");

    // On synchronize, check if this push was from an auto-fix task.
    // If so, inherit the round number (and manual flag) so maxRounds limits are respected.
    const autoFixInfo = action === "synchronize"
      ? consumeAutoFixRound(repoFullName, prNumber)
      : { round: 0, manualAutoFix: false };
    const autoFixRound = autoFixInfo.round;

    // Auto-load PR topic in TG before starting review (so notifications work)
    if (action === "opened" && TELEGRAM_CONFIG) {
      (async () => {
        try {
          await autoLoadPR(repoFullName, prNumber, prTitle, headBranch);
        } catch (err: any) {
          log(`[${repoFullName}] PR #${prNumber} auto-load failed: ${err.message}`);
        }
        // Look up TG topic after auto-load so review output is routed to Telegram.
        const tgTopic = findTGTopicForPR(repoFullName, prNumber);
        runTask({
          repoFullName,
          prNumber,
          headBranch,
          command: "review",
          skillPath: skillPath || undefined,
          autoFixRound,
          manualAutoFix: autoFixInfo.manualAutoFix || undefined,
          tgChatId: tgTopic?.chatId,
          tgThreadId: tgTopic?.threadId,
        });
      })().catch((err: any) => {
        log(`[${repoFullName}] PR #${prNumber} auto-load+review failed: ${err.message}`);
      });
    } else {
      // Look up TG topic so task output (sendOutputToTG) is routed to Telegram.
      // This is especially important for synchronize events from auto-fix pushes.
      const tgTopic = findTGTopicForPR(repoFullName, prNumber);
      runTask({
        repoFullName,
        prNumber,
        headBranch,
        command: "review",
        skillPath: skillPath || undefined,
        autoFixRound,
        manualAutoFix: autoFixInfo.manualAutoFix || undefined,
        tgChatId: tgTopic?.chatId,
        tgThreadId: tgTopic?.threadId,
      });
    }
    return { status: 200, message: "OK - review triggered" };
  }

  // PR closed (merged or not): clean up any pending auto-fix state to prevent Map leaks.
  // Normally consumed by synchronize events, but if the PR is closed before that happens
  // (e.g. closed without merging, or fix succeeded but synchronize was missed), we must
  // clean up here to avoid stale entries accumulating over time.
  if (action === "closed") {
    cleanupAutoFixState(repoFullName, prNumber);
    cleanupAutoverifyState(repoFullName, prNumber);
  }

  // PR merged: notify topic + selfhost groups
  if (action === "closed" && payload.pull_request?.merged && TELEGRAM_CONFIG) {
    notifyPRMergedToTopic(repoFullName, prNumber, prTitle).catch((err: any) => {
      log(`[${repoFullName}] PR #${prNumber} merge topic notification failed: ${err.message}`);
    });
    notifyVersionUpdate(repoFullName, prNumber, prTitle).catch((err: any) => {
      log(`[${repoFullName}] PR #${prNumber} version update notification failed: ${err.message}`);
    });
  }

  return { status: 200, message: "OK - event ignored" };
}

async function fetchHeadBranch(
  repoFullName: string,
  prNumber: number,
  repoConfig: RepoConfig,
): Promise<string | null> {
  if (!repoConfig.installationId) return null;
  try {
    const pr = await ghApi.getPR(repoConfig.installationId, repoFullName, prNumber);
    return pr?.headBranch ?? null;
  } catch (err: any) {
    log(`[${repoFullName}] PR #${prNumber} failed to fetch head branch: ${err.message}`);
    return null;
  }
}
