/**
 * /system command — shows system status and Claude API usage.
 * Contains Claude API key / OAuth usage check helpers.
 */

import { spawn } from "child_process";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { log } from "../../utils/logger";
import { getActiveTasks } from "../../review/manager";
import * as tg from "../client";
import { isAllowed } from "../auth";
import type { TGMessage } from "../../types";

/** Read Claude OAuth access token from env var or ~/.claude/.credentials.json */
function getClaudeOAuthToken(): string | null {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken) return envToken;

  const credPath = `${process.env.HOME ?? homedir()}/.claude/.credentials.json`;
  try {
    const data = JSON.parse(readFileSync(credPath, "utf-8"));
    if (data.claudeAiOauth?.accessToken) return data.claudeAiOauth.accessToken;
    if (data.accessToken) return data.accessToken;
  } catch {
    // file not found or parse error
  }
  return null;
}

/** Check Claude Max/Pro subscription usage via OAuth usage API. */
async function checkClaudeOAuthUsage(): Promise<string | null> {
  const token = getClaudeOAuthToken();
  if (!token) return null;

  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`OAuth usage API 返回 ${res.status}`);
  }

  const data = (await res.json()) as Record<string, { utilization?: number; resets_at?: string }>;

  const fmt = (key: string): string => {
    const section = data[key];
    if (!section) return "N/A";
    const u = Math.round(section.utilization ?? 0);
    const resetsAt = section.resets_at;
    if (!resetsAt) return `${u}%`;
    const dt = new Date(resetsAt);
    const mins = Math.max(0, Math.floor((dt.getTime() - Date.now()) / 60000));
    if (mins < 1) return `${u}%（剩 < 1分钟）`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${u}%（剩 ${h}h${String(m).padStart(2, "0")}m）`;
  };

  return `<b>5小时用量:</b> ${fmt("five_hour")}\n<b>7天用量:</b> ${fmt("seven_day")}`;
}

/** Check Claude CLI availability for Max/Pro subscription users. */
async function checkClaudeCLIStatus(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p", "--dangerously-skip-permissions"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (data: Buffer) => stdoutChunks.push(data));
    child.stderr.on("data", (data: Buffer) => stderrChunks.push(data));

    child.stdin.write("Reply with only the single word: OK");
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill();
      resolve(`<b>检查超时</b>（CLI 响应较慢，状态未知）`);
    }, 10000);

    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
      const combined = stdout + "\n" + stderr;
      const combinedLower = combined.toLowerCase();

      if (combinedLower.includes("you've hit your limit") || combinedLower.includes("hit your limit")) {
        const resetMatch = combined.match(/resets?\s+[^\n\r]+/i);
        const resetInfo = resetMatch ? `，${resetMatch[0].trim().replace(/</g, "&lt;").replace(/>/g, "&gt;")}` : "";
        resolve(`<b>已达用量限制</b>${resetInfo}`);
      } else if (combinedLower.includes("rate limit") || combinedLower.includes("too many requests")) {
        resolve(`<b>请求频率受限</b>，请稍后重试`);
      } else if (code === 0) {
        resolve(`<b>可用</b>（未达限制）`);
      } else {
        const errInfo = (stderr || stdout).slice(0, 300).replace(/</g, "&lt;").replace(/>/g, "&gt;");
        resolve(`<b>异常</b>（退出码 ${code}）${errInfo ? `\n<code>${errInfo}</code>` : ""}`);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`<b>CLI 不可用:</b> ${err.message.replace(/</g, "&lt;").replace(/>/g, "&gt;")}`);
    });
  });
}

function readClaudeOAuthToken(): string | null {
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    const raw = readFileSync(credPath, "utf-8");
    const creds = JSON.parse(raw);
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (oauth.expiresAt && Date.now() > oauth.expiresAt) {
      log("Claude OAuth token expired");
      return null;
    }
    return oauth.accessToken;
  } catch {
    return null;
  }
}

function renderBar(ratio: number): string {
  const total = 10;
  const filled = Math.round(ratio * total);
  return "█".repeat(filled) + "░".repeat(total - filled);
}

function formatResetTime(epochSec: number): string {
  const resetDate = new Date(epochSec * 1000);
  const now = new Date();
  const diffMs = resetDate.getTime() - now.getTime();
  if (diffMs <= 0) return "now";
  const diffMin = Math.floor(diffMs / 60000);
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  if (h > 0) return `${h}h${m}m 后`;
  return `${m}m 后`;
}

export async function cmdSystem(_msg: TGMessage, chatId: string, userId: number, username?: string): Promise<void> {
  if (!isAllowed(chatId, userId, username)) {
    await tg.sendMessage(chatId, "Permission denied.");
    return;
  }

  const lines: string[] = [];
  lines.push(`<b>System Status</b>\n`);

  // Uptime
  const uptimeSec = process.uptime();
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = Math.floor(uptimeSec % 60);
  lines.push(`<b>Uptime:</b> ${h}h ${m}m ${s}s`);

  // Active tasks
  const tasks = getActiveTasks();
  lines.push(`<b>Active tasks:</b> ${tasks.length}`);
  if (tasks.length > 0) {
    for (const t of tasks) {
      lines.push(`  • <code>${t.command}</code> (${t.branch}) — ${t.elapsed}${t.label ? ` [${t.label}]` : ""}`);
    }
  }

  // Memory
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1024 / 1024).toFixed(1);
  const heapUsed = (mem.heapUsed / 1024 / 1024).toFixed(1);
  const heapTotal = (mem.heapTotal / 1024 / 1024).toFixed(1);
  lines.push(`<b>Memory:</b> RSS ${rss}MB | Heap ${heapUsed}/${heapTotal}MB`);

  // Node version
  lines.push(`<b>Node:</b> ${process.version}`);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const oauthToken = readClaudeOAuthToken();

  if (apiKey) {
    lines.push(`\n<b>Claude API Rate Limits</b> (API Key)\n`);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      const rlRequestsLimit = res.headers.get("anthropic-ratelimit-requests-limit");
      const rlRequestsRemaining = res.headers.get("anthropic-ratelimit-requests-remaining");
      const rlRequestsReset = res.headers.get("anthropic-ratelimit-requests-reset");
      const rlTokensLimit = res.headers.get("anthropic-ratelimit-tokens-limit");
      const rlTokensRemaining = res.headers.get("anthropic-ratelimit-tokens-remaining");
      const rlTokensReset = res.headers.get("anthropic-ratelimit-tokens-reset");
      const rlInputRemaining = res.headers.get("anthropic-ratelimit-input-tokens-remaining");
      const rlInputLimit = res.headers.get("anthropic-ratelimit-input-tokens-limit");
      const rlOutputRemaining = res.headers.get("anthropic-ratelimit-output-tokens-remaining");
      const rlOutputLimit = res.headers.get("anthropic-ratelimit-output-tokens-limit");

      if (rlRequestsLimit) {
        lines.push(`<b>Requests:</b> ${rlRequestsRemaining}/${rlRequestsLimit} remaining`);
        if (rlRequestsReset) lines.push(`  Reset: ${rlRequestsReset}`);
      }
      if (rlTokensLimit) {
        lines.push(`<b>Tokens:</b> ${rlTokensRemaining}/${rlTokensLimit} remaining`);
        if (rlTokensReset) lines.push(`  Reset: ${rlTokensReset}`);
      }
      if (rlInputLimit) {
        lines.push(`<b>Input tokens:</b> ${rlInputRemaining}/${rlInputLimit} remaining`);
      }
      if (rlOutputLimit) {
        lines.push(`<b>Output tokens:</b> ${rlOutputRemaining}/${rlOutputLimit} remaining`);
      }

      if (!rlRequestsLimit && !rlTokensLimit) {
        lines.push(`API response: ${res.status} (no rate limit headers found)`);
      }
    } catch (err: any) {
      lines.push(`<b>API check failed:</b> ${err.message}`);
    }
  } else if (oauthToken) {
    lines.push(`\n<b>Claude 用量 (Max Plan)</b>\n`);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${oauthToken}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      const status = res.headers.get("anthropic-ratelimit-unified-status");
      const fiveHStatus = res.headers.get("anthropic-ratelimit-unified-5h-status");
      const fiveHUtil = res.headers.get("anthropic-ratelimit-unified-5h-utilization");
      const fiveHReset = res.headers.get("anthropic-ratelimit-unified-5h-reset");
      const sevenDStatus = res.headers.get("anthropic-ratelimit-unified-7d-status");
      const sevenDUtil = res.headers.get("anthropic-ratelimit-unified-7d-utilization");
      const sevenDReset = res.headers.get("anthropic-ratelimit-unified-7d-reset");
      const sevenDSonnetStatus = res.headers.get("anthropic-ratelimit-unified-7d_sonnet-status");
      const sevenDSonnetUtil = res.headers.get("anthropic-ratelimit-unified-7d_sonnet-utilization");
      const sevenDSonnetReset = res.headers.get("anthropic-ratelimit-unified-7d_sonnet-reset");
      const representativeClaim = res.headers.get("anthropic-ratelimit-unified-representative-claim");
      const fallback = res.headers.get("anthropic-ratelimit-unified-fallback");

      if (status) {
        const statusEmoji = status === "allowed" ? "🟢" : status === "allowed_warning" ? "🟡" : "🔴";
        lines.push(`<b>状态:</b> ${statusEmoji} ${status}`);
      }
      if (fiveHUtil) {
        const pct = (parseFloat(fiveHUtil) * 100).toFixed(1);
        const bar = renderBar(parseFloat(fiveHUtil));
        const resetStr = fiveHReset ? formatResetTime(parseInt(fiveHReset, 10)) : "";
        lines.push(`<b>5h 窗口:</b> ${bar} ${pct}% (${fiveHStatus ?? ""})`);
        if (resetStr) lines.push(`  重置: ${resetStr}`);
      }
      if (sevenDUtil) {
        const pct = (parseFloat(sevenDUtil) * 100).toFixed(1);
        const bar = renderBar(parseFloat(sevenDUtil));
        const resetStr = sevenDReset ? formatResetTime(parseInt(sevenDReset, 10)) : "";
        lines.push(`<b>7d 窗口:</b> ${bar} ${pct}% (${sevenDStatus ?? ""})`);
        if (resetStr) lines.push(`  重置: ${resetStr}`);
      }
      if (sevenDSonnetUtil) {
        const pct = (parseFloat(sevenDSonnetUtil) * 100).toFixed(1);
        const bar = renderBar(parseFloat(sevenDSonnetUtil));
        const resetStr = sevenDSonnetReset ? formatResetTime(parseInt(sevenDSonnetReset, 10)) : "";
        lines.push(`<b>7d Sonnet:</b> ${bar} ${pct}% (${sevenDSonnetStatus ?? ""})`);
        if (resetStr) lines.push(`  重置: ${resetStr}`);
      }
      if (representativeClaim) lines.push(`<b>瓶颈:</b> ${representativeClaim}`);
      if (fallback) lines.push(`<b>降级可用:</b> ${fallback}`);
      if (!status && !fiveHUtil && !sevenDUtil) {
        lines.push(`API response: ${res.status} (无统一限速头)`);
      }
    } catch (err: any) {
      lines.push(`<b>API check failed:</b> ${err.message}`);
    }
  } else {
    lines.push(`\n<b>Claude 订阅用量</b> (Max/Pro)\n`);
    try {
      const oauthStatus = await checkClaudeOAuthUsage();
      if (oauthStatus !== null) {
        lines.push(oauthStatus);
      } else {
        const cliStatus = await checkClaudeCLIStatus();
        lines.push(cliStatus);
      }
    } catch (err: any) {
      lines.push(`<b>用量查询失败:</b> ${err.message.replace(/</g, "&lt;").replace(/>/g, "&gt;")}`);
    }
    lines.push(`\n<i>如需查看 API Key 用量详情，请设置 ANTHROPIC_API_KEY。</i>`);
  }

  await tg.sendMessage(chatId, lines.join("\n"));
}
