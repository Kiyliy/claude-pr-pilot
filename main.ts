import "dotenv/config";
import { createServer } from "./src/server";
import { PORT, REPOS, TELEGRAM_CONFIG } from "./src/config";
import { log } from "./src/utils/logger";
import { formatDuration } from "./src/utils/logger";
import { startBot, stopBot } from "./src/telegram/bot";
import { cleanupOrphanedWorktrees, killAllChildProcesses } from "./src/review/manager";
import { readAndDeleteUpdateMarker } from "./src/review/update-marker";
import { VERSION, VERSION_DATE } from "./src/version";
import * as tg from "./src/telegram/client";

// Clean up any worktrees left behind by a previous crash/restart
cleanupOrphanedWorktrees();

const server = createServer();

server.listen(PORT, () => {
  log(`Auto-reviewer webhook server listening on port ${PORT}`);
  log(`Configured repos: ${Object.keys(REPOS).join(", ")}`);
  log(`Health check: http://localhost:${PORT}/health`);
});

// Start Telegram bot if configured
if (TELEGRAM_CONFIG) {
  startBot(TELEGRAM_CONFIG.botToken)
    .then(() => {
      // Check if this startup follows a successful /update restart
      const marker = readAndDeleteUpdateMarker();
      if (marker) {
        const elapsed = formatDuration(Date.now() - marker.startedAt);
        const text = `✅ <b>更新成功！</b> Bot 已重启\n版本: v${VERSION} · ${VERSION_DATE}\n耗时: ${elapsed}`;
        log(`[update] Sending post-update notification to chat ${marker.chatId} thread ${marker.threadId}`);
        tg.sendMessage(marker.chatId, text, { threadId: marker.threadId }).catch((err: any) => {
          log(`[update] Failed to send post-update notification: ${err.message}`);
        });
      }
    })
    .catch((err: any) => {
      log(`Telegram bot failed to start: ${err.message}`);
    });
}

// Graceful shutdown
function shutdown(signal: string) {
  log(`Received ${signal}, shutting down...`);
  killAllChildProcesses();
  stopBot();
  server.close(() => {
    log("HTTP server closed");
    cleanupOrphanedWorktrees();
    log("Shutdown complete");
    process.exit(0);
  });
  // Force exit after 10s if graceful shutdown hangs
  setTimeout(() => {
    log("Forced exit after timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
