import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { log, logger, formatDuration } from "../utils/logger";
import { getRepoConfig, getGroupDir, getProvider, type AIProvider } from "../config";
import { buildPrompt } from "./prompt";
import { notifyTaskComplete } from "../telegram/notifications";
import * as tg from "../telegram/client";
import { removeWorktree } from "./worktree";
import { spawnTaskProcess, cancelChildProcess, _resetChildProcesses } from "./process";
import { recordAutoFixHeadSHA, _resetAutoFixState } from "./autofix";
import { getStandaloneTopic } from "../store/db";
import { writeUpdateMarker } from "./update-marker";
import type { TaskRequest, ActiveTask, ActiveTaskInfo, TaskRejection } from "../types";

// Re-export for backward compatibility — existing importers (main.ts, handler.ts, etc.)
// do not need to update their import paths.
export { cleanupOrphanedWorktrees } from "./worktree";
export { killAllChildProcesses } from "./process";
export { consumeAutoFixRound, cleanupAutoFixState } from "./autofix";

const activeTasks = new Map<string, ActiveTask>();

// --- Callback ID mapping (Telegram callback_data has a 64-byte limit) ---
// Process-level random prefix ensures old buttons from a previous process
// cannot accidentally resolve to a new task after restart.
const processToken = Math.random().toString(36).slice(2, 6);
let callbackIdSeq = 0;
const callbackIdToKey = new Map<string, string>(); // shortId → fullKey
const keyToCallbackId = new Map<string, string>(); // fullKey → shortId (dedup)

/** Register a task key and return a short callback ID safe for Telegram buttons. */
export function registerCallbackId(fullKey: string): string {
  const existing = keyToCallbackId.get(fullKey);
  if (existing) return existing;
  const shortId = `${processToken}_${++callbackIdSeq}`;
  callbackIdToKey.set(shortId, fullKey);
  keyToCallbackId.set(fullKey, shortId);
  return shortId;
}

/** Resolve a short callback ID back to the full task key. Returns null if not found. */
export function resolveCallbackId(shortId: string): string | null {
  return callbackIdToKey.get(shortId) ?? null;
}

/** Remove callback ID mappings for a given task key (cleanup on task completion). */
function removeCallbackId(fullKey: string): void {
  const shortId = keyToCallbackId.get(fullKey);
  if (shortId) {
    callbackIdToKey.delete(shortId);
    keyToCallbackId.delete(fullKey);
  }
}

/** @internal — only for use in tests */
export function _resetActiveTasks(): void {
  activeTasks.clear();
  callbackIdSeq = 0;
  callbackIdToKey.clear();
  keyToCallbackId.clear();
  _resetChildProcesses();
  _resetAutoFixState();
}

/** Commands that run directly in the target dir (no worktree isolation) */
const NO_WORKTREE_COMMANDS = new Set(["update"]);

/**
 * Common programming action verbs and conventional-commit prefixes that appear in both
 * task descriptions and PR titles. Filtering them from the description side prevents
 * spurious matches when descriptions are short
 * (e.g. "fix bug" → score 0.5 against "fix: Update payment flow").
 */
const DESCRIPTION_STOPWORDS = new Set([
  // Action verbs
  "fix", "add", "update", "create", "change", "remove", "delete",
  "refactor", "improve", "build", "use", "get", "set", "make", "move", "bump",
  // Conventional commit type prefixes
  "feat", "feature", "chore", "ci", "style", "revert", "merge",
]);

/**
 * Compute a word-overlap score between a stored task description and a PR's title/branch.
 * Returns a value in [0, 1]: ratio of description words that appear in the PR target strings.
 * Returns 0 if description has fewer than 2 meaningful words (too short to match reliably).
 *
 * CJK tokenization: each CJK character is treated as an individual token. This is
 * character-level splitting, not semantic segmentation — sufficient for keyword overlap
 * but does not handle compound words or multi-character semantic units.
 */
function computeDescriptionMatchScore(description: string, prTitle: string, prBranch: string): number {
  const normalize = (s: string): string[] =>
    s.toLowerCase()
      .replace(/[/:_\-]/g, " ")
      // Insert spaces around each CJK character so they tokenize individually.
      .replace(/([\u4e00-\u9fa5])/g, " $1 ")
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9\u4e00-\u9fa5]/g, ""))
      // Keep multi-char ASCII tokens and single CJK characters.
      .filter((w) => w.length > 1 || /[\u4e00-\u9fa5]/.test(w));

  // Exclude common action verbs from the description side to prevent false positives
  // on short descriptions (e.g. "fix bug" should not match every "fix: …" PR title).
  const descWords = normalize(description).filter((w) => !DESCRIPTION_STOPWORDS.has(w));
  if (descWords.length < 2) return 0;

  const targetWords = new Set([...normalize(prTitle), ...normalize(prBranch)]);
  let matches = 0;
  for (const word of descWords) {
    if (targetWords.has(word)) matches++;
  }
  return matches / descWords.length;
}

/**
 * Detect the current git branch inside a worktree directory.
 * Returns null on any error (dir missing, detached HEAD, etc.).
 */
// TODO: consider migrating to async execFilePromise to avoid blocking the event loop
// in webhook async callback chains (acceptable at current scale, but worth revisiting).
function detectWorktreeBranch(worktreeDir: string): string | null {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: worktreeDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // "HEAD" means detached — Claude hasn't created a branch yet
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Find the thread ID of an active standalone task (no PR number yet) for a given repo+chat.
 * Used by autoLoadPR to detect that a /do task is running and reuse its topic
 * instead of creating a duplicate.
 *
 * Matching strategy (in priority order):
 * 1. **Branch match**: if prBranch is provided and a candidate's worktree is on that exact
 *    branch, return it immediately — this is a definitive match.
 * 2. **Single candidate**: returned unconditionally (no ambiguity).
 * 3. **Description match**: score each candidate's stored description against prTitle/prBranch.
 * 4. **Fallback**: if no descriptions stored, return the first candidate.
 */
export function findActiveStandaloneThread(
  repoFullName: string,
  chatId: string,
  prTitle?: string,
  prBranch?: string,
): number | null {
  const prefix = `${repoFullName}#tg-${chatId}-`;
  const candidates: { threadId: number; task: ActiveTask }[] = [];

  for (const [key, task] of activeTasks) {
    if (key.startsWith(prefix) && !task.prNumber) {
      const afterPrefix = key.slice(prefix.length); // "<threadId>:<command>"
      const colonIdx = afterPrefix.indexOf(":");
      if (colonIdx > 0) {
        const threadId = Number(afterPrefix.slice(0, colonIdx));
        if (!isNaN(threadId)) candidates.push({ threadId, task });
      }
    }
  }

  log(`[findActiveStandaloneThread] repo=${repoFullName} chat=${chatId} prTitle="${prTitle?.slice(0, 40)}" prBranch=${prBranch} candidates=${candidates.length}`);
  if (candidates.length === 0) {
    log(`[findActiveStandaloneThread] no candidates found`);
    return null;
  }
  for (const { threadId, task } of candidates) {
    log(`[findActiveStandaloneThread] candidate: threadId=${threadId} command=${task.command} worktreeDir=${task.worktreeDir ?? 'null'} label=${task.label ?? 'null'}`);
  }

  // Priority 1: Branch-based precise matching.
  // When the webhook provides prBranch (head.ref), check each candidate's worktree
  // to see if Claude has created/checked out that exact branch. This is definitive.
  if (prBranch) {
    for (const { threadId, task } of candidates) {
      if (task.worktreeDir) {
        const branch = detectWorktreeBranch(task.worktreeDir);
        log(`[findActiveStandaloneThread] branch check: threadId=${threadId} worktreeBranch=${branch ?? 'null'} prBranch=${prBranch}`);
        if (branch === prBranch) {
          log(`[findActiveStandaloneThread] Branch match: thread ${threadId} on branch ${branch}`);
          return threadId;
        }
      }
    }
  }

  if (!prTitle && !prBranch) {
    log(`[findActiveStandaloneThread] no prTitle/prBranch, returning first candidate threadId=${candidates[0].threadId}`);
    return candidates[0].threadId;
  }

  // Single candidate: return immediately, no scoring needed.
  // The guard in autoLoadPR (findPRByThread) still prevents double-binding.
  if (candidates.length === 1) {
    log(`[findActiveStandaloneThread] single candidate, returning threadId=${candidates[0].threadId}`);
    return candidates[0].threadId;
  }

  // Description-based matching: score each candidate against the PR info
  const MATCH_THRESHOLD = 0.35;
  let bestThreadId: number | null = null;
  let bestScore = 0;
  let hasAnyDescription = false;

  for (const { threadId } of candidates) {
    const info = getStandaloneTopic(chatId, threadId);
    const description = info?.description;
    if (description) {
      hasAnyDescription = true;
      const score = computeDescriptionMatchScore(description, prTitle || "", prBranch || "");
      log(`[findActiveStandaloneThread] description score: threadId=${threadId} desc="${description.slice(0, 40)}" score=${score.toFixed(3)}`);
      if (score > bestScore) {
        bestScore = score;
        bestThreadId = threadId;
      }
    }
  }

  if (hasAnyDescription) {
    // At least one task has a stored description: only bind if there's a confident match.
    const result = bestScore >= MATCH_THRESHOLD ? bestThreadId : null;
    log(`[findActiveStandaloneThread] description match result: bestScore=${bestScore.toFixed(3)} threshold=${MATCH_THRESHOLD} → ${result ?? 'null'}`);
    return result;
  }
  // No descriptions stored (old tasks or tasks without userInput): fall back to first match
  log(`[findActiveStandaloneThread] no descriptions, falling back to first candidate threadId=${candidates[0].threadId}`);
  return candidates[0].threadId;
}

export function getActiveTasks(): ActiveTaskInfo[] {
  const now = Date.now();
  const tasks: ActiveTaskInfo[] = [];
  for (const [key, info] of activeTasks) {
    tasks.push({
      key,
      command: info.command,
      branch: info.headBranch || "unknown",
      elapsed: formatDuration(now - info.startedAt),
      label: info.label,
      tgChatId: info.tgChatId,
      tgThreadId: info.tgThreadId,
    });
  }
  return tasks;
}

/** Cancel a running task by key. Returns true if found and killed. */
export function cancelTask(key: string): boolean {
  return cancelChildProcess(key);
}

// --- Task execution ---

function taskKey(task: TaskRequest): string {
  if (task.prNumber) return `${task.repoFullName}#${task.prNumber}:${task.command}`;
  if (task.issueNumber) return `${task.repoFullName}#issue-${task.issueNumber}:${task.command}`;
  // Dedup standalone tasks by TG thread to prevent concurrent runs in the same topic
  if (task.tgChatId && task.tgThreadId) return `${task.repoFullName}#tg-${task.tgChatId}-${task.tgThreadId}:${task.command}`;
  return `${task.repoFullName}#${task.command}-${Date.now()}`;
}

export function runTask(task: TaskRequest): TaskRejection | null {
  const key = taskKey(task);

  // Guard: reject /update if there are active tasks (update would kill them via pm2 restart)
  if (task.command === "update" && activeTasks.size > 0) {
    const running = getActiveTasks();
    const summary = running.map((t) => `• ${t.command}${t.label ? ` (${t.label})` : ""} - ${t.elapsed}`).join("\n");
    const reason = `Cannot update: ${running.length} task(s) still running. Please wait for them to finish.\n${summary}`;
    log(`[${task.repoFullName}] Update rejected: ${running.length} active tasks`);
    return { reason };
  }

  // Guard: reject new tasks if an update is in progress (process is about to restart)
  if (task.command !== "update") {
    for (const [, info] of activeTasks) {
      if (info.command === "update") {
        const elapsed = formatDuration(Date.now() - info.startedAt);
        const reason = `An update is in progress (${elapsed}). Please wait for it to finish before starting new tasks.`;
        log(`[${task.repoFullName}] Task '${task.command}' rejected: update in progress`);
        return { reason };
      }
    }
  }

  // Dedup: prevent concurrent tasks with the same key (PR-bound or same TG thread)
  if (activeTasks.has(key)) {
    const existing = activeTasks.get(key)!;
    const elapsed = formatDuration(Date.now() - existing.startedAt);
    const target = task.prNumber ? `PR #${task.prNumber}` : task.issueNumber ? `Issue #${task.issueNumber}` : `This topic`;
    const reason = `${target} already has a '${existing.command}' task running (${elapsed}). Please wait for it to finish.`;
    log(`[${task.repoFullName}] ${reason}`);
    return { reason };
  }

  const repoConfig = getRepoConfig(task.repoFullName);
  if (!repoConfig) return { reason: `Repo ${task.repoFullName} not configured.` };

  // Override dir with group-level dir if available
  const effectiveDir = task.tgChatId
    ? getGroupDir(task.tgChatId, task.repoFullName) || repoConfig.dir
    : repoConfig.dir;
  const config = { ...repoConfig, dir: effectiveDir };

  const startedAt = Date.now();
  const label = task.prNumber
    ? `PR #${task.prNumber}`
    : task.userInput
      ? task.userInput.slice(0, 80) + (task.userInput.length > 80 ? "..." : "")
      : undefined;
  const activeTask: ActiveTask = {
    startedAt,
    prNumber: task.prNumber,
    headBranch: task.headBranch || config.baseBranch || null,
    command: task.command,
    label,
    tgChatId: task.tgChatId,
    tgThreadId: task.tgThreadId,
  };
  activeTasks.set(key, activeTask);
  log(
    `[${task.repoFullName}] Starting task '${task.command}'${task.prNumber ? ` for PR #${task.prNumber}` : ""} (branch: ${task.headBranch || "N/A"})`
  );

  const skipWorktree = NO_WORKTREE_COMMANDS.has(task.command);
  let worktreeDir: string;

  if (skipWorktree) {
    // Run directly in the target directory (e.g. production dir for /update)
    worktreeDir = config.dir;
    log(`[${task.repoFullName}] task '${task.command}' running directly in ${config.dir} (no worktree)`);
  } else {
    // Create a worktree for isolation (PR tasks use head branch, others use baseBranch/HEAD)
    const worktreeName = task.prNumber
      ? `task-${task.command}-pr-${task.prNumber}-${Date.now()}`
      : `task-${task.command}-${Date.now()}`;
    worktreeDir = path.join(config.dir, ".worktrees", worktreeName);

    try {
      execSync("git fetch origin", { cwd: config.dir, stdio: "ignore" });

      // Record HEAD SHA before fix starts (for no-commit detection in auto-fix)
      if (task.command === "fix" && (task.autoFixRound ?? 0) > 0 && task.headBranch && task.prNumber) {
        try {
          const sha = execSync(`git rev-parse origin/${task.headBranch}`, {
            cwd: config.dir, encoding: "utf-8",
          }).trim();
          recordAutoFixHeadSHA(task.repoFullName, task.prNumber, sha);
        } catch { /* ignore — commit detection will be skipped */ }
      }

      fs.mkdirSync(path.join(config.dir, ".worktrees"), { recursive: true });
      const ref = task.headBranch
        ? `origin/${task.headBranch}`
        : config.baseBranch
          ? `origin/${config.baseBranch}`
          : "HEAD";
      execSync(`git worktree add "${worktreeDir}" "${ref}" --detach`, {
        cwd: config.dir,
        stdio: "ignore",
      });
      log(`[${task.repoFullName}] worktree created at ${worktreeDir}`);
    } catch (err: any) {
      activeTasks.delete(key);
      removeCallbackId(key);
      log(`[${task.repoFullName}] failed to create worktree: ${err.message}`);
      return { reason: `Failed to create worktree: ${err.message}` };
    }
  }
  // Update worktreeDir in activeTask so findActiveStandaloneThread can detect branches
  activeTask.worktreeDir = worktreeDir;

  // Write restart marker for /update tasks so the new process can notify the requester
  // after pm2 restarts (the current process will be killed before the close event fires)
  if (task.command === "update" && task.tgChatId && task.tgThreadId) {
    writeUpdateMarker({
      chatId: task.tgChatId,
      threadId: task.tgThreadId,
      startedAt,
      repoFullName: task.repoFullName,
    });
  }

  let prompt = buildPrompt(task);
  const provider = getProvider(task.tgChatId);

  const onTaskDone = (doneKey: string) => {
    activeTasks.delete(doneKey);
    removeCallbackId(doneKey);
  };

  spawnTaskProcess(task, config, worktreeDir, prompt, startedAt, key, skipWorktree, onTaskDone, provider)
    .catch((err: any) => {
      activeTasks.delete(key);
      removeCallbackId(key);
      if (!skipWorktree) removeWorktree(config.dir, worktreeDir, task.repoFullName);
      log(`[${task.repoFullName}] task '${task.command}' spawnTaskProcess failed: ${err?.message ?? String(err)}`);
      if (task.prNumber) {
        notifyTaskComplete(task.repoFullName, task.prNumber, task.command, false, formatDuration(Date.now() - startedAt)).catch((notifyErr: any) => {
          logger.warn(`[${task.repoFullName}] Failed to notify task failure for PR #${task.prNumber}: ${notifyErr?.message ?? String(notifyErr)}`);
        });
      }
      if (task.tgChatId && task.tgThreadId) {
        tg.sendMessage(task.tgChatId, `⚠️ 任务 '${task.command}' 启动失败: ${err?.message ?? String(err)}`, { threadId: task.tgThreadId }).catch((sendErr: any) => {
          logger.warn(`[${task.repoFullName}] Failed to send spawn error to TG: ${sendErr?.message ?? String(sendErr)}`);
        });
      }
    });

  return null;
}
