import fs from "fs";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import { log, logger, formatDuration } from "../utils/logger";
import { ROOT_DIR, BOT_LOGIN, REPOS } from "../config";
import { getProviderDef, type AIProvider } from "../providers";
import { getInstallationToken } from "../github/auth";
import { notifyTaskStart, notifyTaskComplete, sendOutputToTG, sendPRBodyToTG } from "../telegram/notifications";
import { loadTaskContext } from "./topic-context";
import { updateStandaloneTopicPR, updateStandaloneTopicIssue, setTopicThread, findPRByThread } from "../store/db";
import * as tg from "../telegram/client";
import * as ghApi from "../github/api";
import { removeWorktree } from "./worktree";
import { maybeAutoFix, cleanupAutoFixState } from "./autofix";
import { maybeAutoVerify, cleanupAutoverifyState } from "./autoverify";
import { deleteUpdateMarker } from "./update-marker";
import { generateTopicTitle } from "../xai/client";
import type { TaskRequest } from "../types";

const childProcesses = new Map<string, ChildProcess>();

/** @internal — only for use in tests */
export function _resetChildProcesses(): void {
  childProcesses.clear();
}

/** Kill all running child processes. Called during graceful shutdown. */
export function killAllChildProcesses(): void {
  for (const [key, child] of childProcesses) {
    log(`Killing child process: ${key}`);
    try {
      child.kill("SIGTERM");
    } catch { /* ignore */ }
  }
}

/** Kill a specific child process by key. Returns true if found and killed. */
export function cancelChildProcess(key: string): boolean {
  const child = childProcesses.get(key);
  if (!child) return false;
  try {
    child.kill("SIGTERM");
  } catch { /* ignore */ }
  return true;
}

export async function spawnTaskProcess(
  task: TaskRequest,
  config: { dir: string; baseBranch?: string; installationId?: number; taskTimeoutMs?: number },
  worktreeDir: string,
  prompt: string,
  startedAt: number,
  key: string,
  skipWorktree: boolean,
  onTaskDone: (key: string) => void,
  provider: AIProvider = "claude",
): Promise<void> {
  // Delay for standalone task cleanup: keep the worktree and activeTasks entry alive
  // so the webhook's findActiveStandaloneThread can still detect the branch.
  const STANDALONE_CLEANUP_DELAY_MS = 3 * 60 * 1000; // 3 minutes

  function cleanup() {
    if (!skipWorktree) removeWorktree(config.dir, worktreeDir, task.repoFullName);
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: process.env.HOME || "/root",
    // Use bot identity for git commits
    GIT_AUTHOR_NAME: BOT_LOGIN,
    GIT_AUTHOR_EMAIL: `${BOT_LOGIN}@users.noreply.github.com`,
    GIT_COMMITTER_NAME: BOT_LOGIN,
    GIT_COMMITTER_EMAIL: `${BOT_LOGIN}@users.noreply.github.com`,
  };

  // Apply provider-specific env vars — always explicit to avoid inheriting parent process values
  const providerDef = getProviderDef(provider);
  if (providerDef.env) {
    Object.assign(env, providerDef.env);
  }
  for (const key of providerDef.clearEnv ?? []) {
    delete env[key];
  }

  // Get bot token for GitHub App identity
  // Note: installation tokens expire after 1 hour. Claude's gh api calls
  // will fail if the task exceeds this window. See README "Security notes".
  if (config.installationId) {
    try {
      const token = await getInstallationToken(config.installationId);
      env.GH_TOKEN = token;
      log(`[${task.repoFullName}] using GitHub App bot identity`);
    } catch (err: any) {
      onTaskDone(key);
      cleanup();
      log(`[${task.repoFullName}] failed to get bot token, aborting: ${err.message}`);
      if (task.tgChatId && task.tgThreadId) {
        tg.sendMessage(task.tgChatId, `⚠️ GitHub 认证失败，任务 '${task.command}' 无法启动: ${err.message}`, { threadId: task.tgThreadId }).catch(() => {});
      }
      return;
    }
  }

  // Load conversation context (PR comments or topic history — never both)
  const context = await loadTaskContext(task, config.installationId);
  if (context) {
    prompt += `\n\n${context}`;
  }

  // Per-task log file
  const [owner, repo] = task.repoFullName.split("/");
  const logDir = path.join(ROOT_DIR, "logs", owner, repo);
  fs.mkdirSync(logDir, { recursive: true });
  const logName = task.prNumber ? `pr-${task.prNumber}.log` : `${task.command}-${Date.now()}.log`;
  const logPath = path.join(logDir, logName);
  const taskLog = fs.createWriteStream(logPath, { flags: "a" });

  const label = task.prNumber ? `PR #${task.prNumber}` : task.command;

  function taskWrite(msg: string) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    taskLog.write(line);
    log(`[${task.repoFullName}] ${label} ${msg}`);
  }

  taskWrite(`--- Task '${task.command}' started (provider: ${provider}, branch: ${task.headBranch || "N/A"}) ---`);
  taskWrite(`Work dir: ${worktreeDir}`);
  if (task.userInput) {
    taskWrite(`User input: ${task.userInput}`);
  }

  if (task.prNumber) {
    notifyTaskStart(task.repoFullName, task.prNumber, task.command).catch((err: any) => {
      logger.warn(`[${task.repoFullName}] Failed to notify task start for PR #${task.prNumber}: ${err?.message ?? String(err)}`);
    });
  }

  // For standalone topics: track the base title and update emoji to "in-progress"
  // topicBaseTitle is updated at task close via DB lookup (PR number binding via webhook)
  let topicBaseTitle = task.tgChatId && task.tgThreadId && !task.prNumber
    ? `${task.command}: ${(task.userInput || "task").slice(0, 100)}`
    : "";
  const runningEmoji = task.command === "review" ? "🔍"
    : task.command === "fix" ? "🔨"
    : task.command === "do" ? "🔨"
    : task.command === "ask" ? "❓"
    : task.command === "verify" ? "🧪"
    : "⚡️";
  if (task.tgChatId && task.tgThreadId && !task.prNumber) {
    tg.editForumTopicIcon(task.tgChatId, task.tgThreadId, topicBaseTitle, runningEmoji).catch(() => {});
  }

  // Write prompt to a temp file and pipe via stdin to avoid ARG_MAX limits
  // For no-worktree commands, use a temp dir to avoid polluting the target dir
  const promptDir = skipWorktree
    ? path.join(ROOT_DIR, "logs", ...task.repoFullName.split("/"))
    : worktreeDir;
  const promptFile = path.join(promptDir, `.claude-prompt-${Date.now()}.txt`);
  fs.writeFileSync(promptFile, prompt, "utf-8");
  const promptStream = fs.createReadStream(promptFile);

  // Spawn the AI CLI process using provider configuration
  const { bin, args } = providerDef;

  const child = spawn(
    bin,
    args,
    {
      cwd: worktreeDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  promptStream.pipe(child.stdin);
  childProcesses.set(key, child);

  // Task timeout: auto-kill after configured duration (default 24h)
  const DEFAULT_TIMEOUT_MS = 86400000; // 24 hours
  const timeoutMs = config.taskTimeoutMs !== undefined ? config.taskTimeoutMs : DEFAULT_TIMEOUT_MS;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      taskWrite(`--- Task '${task.command}' timed out after ${formatDuration(timeoutMs)}, sending SIGTERM ---`);
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      if (task.tgChatId && task.tgThreadId) {
        tg.sendMessage(
          task.tgChatId,
          `⏰ 任务 '${task.command}' 已运行超过 ${formatDuration(timeoutMs)}，已自动终止。`,
          { threadId: task.tgThreadId }
        ).catch(() => {});
      }
    }, timeoutMs);
  }

  // Capture stdout for TG output routing (non-PR tasks or any task with tgChatId)
  const stdoutChunks: Buffer[] = [];
  // Track PR number created by standalone task (set by handlePRBinding, read by handleOutputRouting)
  let standaloneCreatedPR: number | null = null;

  child.stdout.on("data", (data: Buffer) => {
    taskLog.write(data);
    stdoutChunks.push(data);
  });

  child.stderr.on("data", (data: Buffer) => {
    taskLog.write(data);
  });

  // --- Close callback helpers ---

  /** Bind a newly created PR to the standalone TG topic (looked up from DB at task close).
   *  Returns true if the xAI title-generation IIFE was launched (caller should skip synchronous rename). */
  function handlePRBinding(baseTitleRef: { value: string }, code: number | null): boolean {
    if (!task.tgChatId || !task.tgThreadId || task.prNumber) return false;
    log(`[handlePRBinding] task=${task.command} threadId=${task.tgThreadId} chatId=${task.tgChatId}`);
    let createdPR = findPRByThread(task.tgChatId, task.tgThreadId);
    log(`[handlePRBinding] findPRByThread(${task.tgChatId}, ${task.tgThreadId}) → ${createdPR ?? 'null'}`);
    if (!createdPR) {
      // Fallback: webhook may not have arrived yet; parse CREATED_PR from stdout.
      // SKILL.md requires Claude to output "CREATED_PR=#<number>" after creating a PR,
      // so this covers the race where the process exits before the webhook updates the DB.
      const rawFallback = Buffer.concat(stdoutChunks).toString("utf-8");
      const m = rawFallback.match(/CREATED_PR=#(\d+)/);
      if (m) {
        createdPR = Number(m[1]);
        log(`[handlePRBinding] stdout fallback found CREATED_PR=#${createdPR}`);
      }
    }
    if (!createdPR) {
      log(`[handlePRBinding] no PR found for threadId=${task.tgThreadId}, skipping binding`);
      return false;
    }
    standaloneCreatedPR = createdPR;
    log(`[${task.repoFullName}] Standalone task created PR #${createdPR}, binding to topic threadId=${task.tgThreadId}`);
    try {
      updateStandaloneTopicPR(task.tgChatId, task.tgThreadId, createdPR);
      // Use fallback title to complete synchronous bindings
      const newBaseTitle = `#${createdPR} ${(task.userInput || task.command).slice(0, 110)}`;
      // Also register in pr_topics so the topic is found by PR-based lookups
      setTopicThread(task.tgChatId, createdPR, task.tgThreadId, newBaseTitle);
      // Update tracked base title so the completion rename uses the PR-based title.
      baseTitleRef.value = newBaseTitle;

      // 2. Fire-and-forget: use xAI to generate a clean title from the actual PR title.
      // Does not block sendOutputToTG / notifyTaskComplete.
      // After resolving, overwrites the topic name with the xAI title + completion emoji.
      const capturedThreadId = task.tgThreadId;
      const capturedChatId = task.tgChatId;
      const capturedCode = code;
      logger.info("[xAI] starting topic title generation", { repo: task.repoFullName, prNumber: createdPR });
      ;(async () => {
        try {
          const installationId = REPOS[task.repoFullName]?.installationId;
          if (!installationId) {
            logger.warn("[xAI] no installationId configured, skipping title update", { repo: task.repoFullName, prNumber: createdPR });
            return;
          }
          const prInfo = await ghApi.getPR(installationId, task.repoFullName, createdPR);
          if (!prInfo?.title) {
            logger.warn("[xAI] could not fetch PR info, skipping title update", { repo: task.repoFullName, prNumber: createdPR });
            return;
          }
          const xaiTitle = await generateTopicTitle(createdPR, prInfo.title);
          setTopicThread(capturedChatId, createdPR, capturedThreadId, xaiTitle);
          // Use 👀 for success (pending user review), ❌ for failure
          const doneEmoji = capturedCode === 0 ? "👀" : "❌";
          tg.editForumTopicIcon(capturedChatId, capturedThreadId,
            xaiTitle, doneEmoji).catch((err: any) => {
              logger.warn("[xAI] failed to rename topic after xAI", { repo: task.repoFullName, prNumber: createdPR, error: err?.message ?? String(err) });
            });
        } catch (err: any) {
          logger.error("[xAI] title update failed", { repo: task.repoFullName, prNumber: createdPR, error: err?.message ?? String(err) });
        }
      })();
      return true;
    } catch (err: any) {
      logger.warn("[xAI] standalone topic update failed", { repo: task.repoFullName, prNumber: createdPR, error: err?.message ?? String(err) });
      return false;
    }
  }

  /** Bind a newly created Issue to the standalone TG topic (parsed from stdout). */
  function handleIssueBinding(raw: string): void {
    if (!task.tgChatId || !task.tgThreadId || task.issueNumber) return;
    const issueMatch = raw.match(/CREATED_ISSUE=#(\d+)/);
    if (!issueMatch) return;
    const createdIssue = Number(issueMatch[1]);
    log(`[${task.repoFullName}] Standalone task created Issue #${createdIssue}, binding to topic`);
    try {
      updateStandaloneTopicIssue(task.tgChatId, task.tgThreadId, createdIssue);
    } catch { /* ignore */ }
  }

  /** Update the standalone TG topic icon to reflect task completion status. */
  function handleTopicRename(baseTitle: string, code: number | null): void {
    if (!task.tgChatId || !task.tgThreadId || !baseTitle) return;
    // Use 👀 for success (pending user review), ❌ for failure
    const doneEmoji = code === 0 ? "👀" : "❌";
    log(`[handleTopicRename] threadId=${task.tgThreadId} title="${baseTitle.slice(0, 60)}" emoji=${doneEmoji}`);
    tg.editForumTopicIcon(task.tgChatId, task.tgThreadId, baseTitle, doneEmoji).catch(() => {});
  }

  /**
   * Route task stdout to the TG topic.
   *
   * For successful PR-bound review/fix tasks that already posted a GitHub PR comment,
   * skip direct stdout output — the comment will arrive via webhook and posting
   * stdout too would cause duplicate/interleaved messages in the topic.
   *
   * Detection uses synchronous stdout markers to avoid the webhook timing race
   * (webhooks arrive 500ms–3s after Claude exits, so a DB count read at close time
   * would always return 0 and incorrectly trigger stdout + later duplicate the webhook):
   * - review skill Step 7 prints "REVIEW_STATUS: <status>" after posting
   * - fix skill Output section prints "FIX_COMMENT_POSTED" after posting
   *
   * Returns true if sendOutputToTG was called (i.e. a completion header was already
   * sent to task.tgChatId/tgThreadId), so the caller can skip notifyTaskComplete
   * and avoid sending a redundant second "task completed" message to the same topic.
   */
  function handleOutputRouting(raw: string, code: number | null, elapsed: string): boolean {
    if (!task.tgChatId || !task.tgThreadId) return false;
    log(`[handleOutputRouting] task=${task.command} threadId=${task.tgThreadId} standaloneCreatedPR=${standaloneCreatedPR} code=${code} rawLen=${raw.length}`);
    if (standaloneCreatedPR !== null && code === 0) {
      // Send PR body instead of raw stdout for standalone tasks that created a PR
      sendPRBodyToTG(task, standaloneCreatedPR, config.installationId, raw, elapsed).catch((err: any) => {
        log(`[${task.repoFullName}] Failed to send PR body to TG: ${err?.message ?? String(err)}`);
      });
      return true;
    }
    const postedPRComment = task.command === "review"
      ? /^REVIEW_STATUS:\s*\S+/m.test(raw)
      : task.command === "fix"
        ? /^FIX_COMMENT_POSTED$/m.test(raw)
        : task.command === "verify"
          ? /^VERIFY_STATUS:\s*\S+/m.test(raw)
          : false;
    const skipDirectOutput = task.prNumber
      && (task.command === "review" || task.command === "fix" || task.command === "verify")
      && code === 0
      && postedPRComment;
    if (!skipDirectOutput) {
      sendOutputToTG(task, stdoutChunks, code === 0, elapsed).catch((err: any) => {
        log(`[${task.repoFullName}] Failed to send output to TG: ${err?.message ?? String(err)}`);
      });
      return true;
    }
    return false;
  }

  /** Trigger or clean up post-task automation (autofix / autoverify) based on task outcome. */
  function handlePostTaskAutomation(raw: string, code: number | null): void {
    if (!task.prNumber) return;
    if (code === 0) {
      if (task.command === "verify") {
        maybeAutoVerify(task, raw);
      } else {
        // Auto-fix: after review finds issues, auto-trigger fix → re-review cycle
        maybeAutoFix(task, raw);
      }
    } else if (task.command === "fix" && (task.autoFixRound ?? 0) > 0) {
      // Fix task failed — clean up autofix state since no synchronize event will fire
      cleanupAutoFixState(task.repoFullName, task.prNumber);
    } else if (task.command === "verify") {
      // Verify process failed (non-zero exit) — clean up state
      cleanupAutoverifyState(task.repoFullName, task.prNumber);
    }
  }

  child.on("close", (code: number | null) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const elapsed = formatDuration(Date.now() - startedAt);
    childProcesses.delete(key);

    // For standalone tasks (no PR number): delay worktree removal and activeTasks
    // cleanup by 3 minutes so the webhook's findActiveStandaloneThread can still
    // detect the worktree branch if the webhook arrives after the task exits.
    // PR-bound tasks clean up immediately — they don't need branch-based matching.
    const isStandalone = !task.prNumber && !skipWorktree;
    if (isStandalone) {
      setTimeout(() => {
        onTaskDone(key);
        cleanup();
      }, STANDALONE_CLEANUP_DELAY_MS);
    } else {
      onTaskDone(key);
      cleanup();
    }
    // Clean up prompt file for no-worktree commands (worktree removal handles it otherwise)
    if (skipWorktree) try { fs.unlinkSync(promptFile); } catch { /* ignore */ }

    if (code === 0) {
      taskWrite(`--- Task '${task.command}' completed successfully (took ${elapsed}) ---`);
    } else {
      taskWrite(`--- Task '${task.command}' FAILED (exit code ${code}, took ${elapsed}) ---`);
    }

    taskLog.end();

    const raw = Buffer.concat(stdoutChunks).toString("utf-8");
    const baseTitleRef = { value: topicBaseTitle };

    const xaiLaunched = handlePRBinding(baseTitleRef, code);
    handleIssueBinding(raw);
    // Skip synchronous rename when xAI IIFE was launched — xAI will handle the final rename
    // to avoid a race where the sync rename overwrites the xAI-generated title.
    if (!xaiLaunched) {
      handleTopicRename(baseTitleRef.value, code);
    }
    const sentDirectOutput = handleOutputRouting(raw, code, elapsed);

    // Skip notifyTaskComplete when sendOutputToTG already sent a completion header
    // to task.tgChatId/tgThreadId (which for webhook-triggered tasks is the same
    // topic notifyTaskComplete would target), avoiding duplicate "task completed" messages.
    if (task.prNumber && !sentDirectOutput) {
      notifyTaskComplete(task.repoFullName, task.prNumber, task.command, code === 0, elapsed).catch((err: any) => {
        logger.warn(`[${task.repoFullName}] Failed to notify task complete for PR #${task.prNumber}: ${err?.message ?? String(err)}`);
      });
    }

    // Send "mark as read" button for successful tasks so users can mark topics as reviewed
    // Skip when notifyTaskComplete was called — it already sends the button via notifications.ts
    const notifyHandledButton = task.prNumber && !sentDirectOutput;
    if (code === 0 && task.tgChatId && task.tgThreadId && !notifyHandledButton) {
      tg.sendInlineKeyboard(
        task.tgChatId,
        "👀 待查看",
        [[{ text: "✅ 标记已读", callbackData: `mark_read:${task.tgChatId}:${task.tgThreadId}` }]],
        { threadId: task.tgThreadId },
      ).catch(() => {});
    }

    // If the update task's close event fires, pm2 restart did not kill this process —
    // the task either failed before restart or completed without restarting.
    // Delete the marker so the next startup doesn't send a false positive notification.
    if (task.command === "update") {
      deleteUpdateMarker();
    }

    handlePostTaskAutomation(raw, code);
  });

  child.on("error", (err: Error) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const elapsed = formatDuration(Date.now() - startedAt);
    onTaskDone(key);
    childProcesses.delete(key);
    cleanup();
    taskWrite(`--- Task '${task.command}' process error after ${elapsed}: ${err.message} ---`);
    taskLog.end();

    if (task.tgChatId && task.tgThreadId) {
      tg.sendMessage(task.tgChatId, `❌ Task '${task.command}' failed to start: ${err.message}`, {
        threadId: task.tgThreadId,
      }).catch((sendErr: any) => {
        logger.warn(`[${task.repoFullName}] Failed to send error to TG: ${sendErr?.message ?? String(sendErr)}`);
      });
    }

    if (task.prNumber) {
      notifyTaskComplete(task.repoFullName, task.prNumber, task.command, false, elapsed).catch((notifyErr: any) => {
        logger.warn(`[${task.repoFullName}] Failed to notify task error for PR #${task.prNumber}: ${notifyErr?.message ?? String(notifyErr)}`);
      });
    }

    // Clean up autofix state on error for fix tasks
    if (task.prNumber && task.command === "fix" && (task.autoFixRound ?? 0) > 0) {
      cleanupAutoFixState(task.repoFullName, task.prNumber);
    }
    // Clean up autoverify state on error for verify tasks
    if (task.prNumber && task.command === "verify") {
      cleanupAutoverifyState(task.repoFullName, task.prNumber);
    }
  });
}
