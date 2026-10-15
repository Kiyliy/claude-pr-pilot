import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { log, logger } from "../utils/logger";
import { REPOS } from "../config";
import { notifyTaskComplete } from "../telegram/notifications";

/** Remove a single worktree, falling back to fs.rmSync on failure */
export function removeWorktree(repoDir: string, worktreeDir: string, repoFullName: string): void {
  try {
    execSync(`git worktree remove "${worktreeDir}" --force`, {
      cwd: repoDir,
      stdio: "ignore",
    });
    log(`[${repoFullName}] worktree cleaned up`);
  } catch (e: any) {
    log(`[${repoFullName}] worktree cleanup failed: ${e.message}`);
  }
}

/** Startup cleanup: remove orphaned worktrees from previous runs */
export function cleanupOrphanedWorktrees(): void {
  for (const [repoName, config] of Object.entries(REPOS)) {
    const wtDir = path.join(config.dir, ".worktrees");
    if (!fs.existsSync(wtDir)) continue;

    let entries: string[];
    try {
      entries = fs.readdirSync(wtDir);
    } catch { continue; }

    for (const entry of entries) {
      const fullPath = path.join(wtDir, entry);
      try {
        if (!fs.statSync(fullPath).isDirectory()) continue;
      } catch { continue; }

      // Parse PR number from worktree name: task-<command>-pr-<number>-<timestamp>
      const prMatch = entry.match(/^task-\w+-pr-(\d+)-/);
      const prNumber = prMatch ? Number(prMatch[1]) : null;

      try {
        execSync(`git worktree remove "${fullPath}" --force`, {
          cwd: config.dir,
          stdio: "ignore",
        });
        log(`[${repoName}] Cleaned up orphaned worktree: ${entry}`);
      } catch {
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          log(`[${repoName}] Force-removed orphaned worktree dir: ${entry}`);
        } catch { /* ignore */ }
      }

      // Notify TG topic if we can identify the PR
      if (prNumber) {
        notifyTaskComplete(repoName, prNumber, "task", false, "interrupted by restart").catch((err: any) => {
          logger.warn(`[${repoName}] Failed to notify orphaned worktree cleanup for PR #${prNumber}: ${err?.message ?? String(err)}`);
        });
      }
    }

    // Prune stale worktree refs
    try {
      execSync("git worktree prune", { cwd: config.dir, stdio: "ignore" });
    } catch { /* ignore */ }
  }
}
