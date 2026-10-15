/**
 * /start and /help command — shows available commands for this group.
 */

import { isCommandAllowed } from "../../config";
import { listProviders } from "../../providers";
import * as tg from "../client";
import { VERSION, VERSION_DATE } from "../../version";
import { getRepoForChat } from "./utils";
import type { TGMessage } from "../../types";

export async function cmdStart(_msg: TGMessage, chatId: string): Promise<void> {
  const repo = getRepoForChat(chatId);
  const allowed = (cmd: string) => isCommandAllowed(chatId, cmd);

  let text = `<b>Mikoto — AI Code Review Bot</b>\n\n`;

  // PR Commands
  const prCmds: string[] = [];
  if (allowed("review")) prCmds.push(`  /review — Review the PR against requirements`);
  if (allowed("fix")) prCmds.push(`  /fix <description> — Fix a bug in the PR`);
  if (allowed("do")) prCmds.push(`  /do <instruction> — Execute a dev task on the PR`);
  if (allowed("ask")) prCmds.push(`  /ask <question> — Ask a question about the code`);
  if (allowed("autofix")) prCmds.push(`  /autofix — Trigger review→fix cycle (works even when auto-fix is off)`);
  if (prCmds.length > 0) {
    text += `<b>PR Commands</b> (use inside a PR topic):\n${prCmds.join("\n")}\n\n`;
  }

  // Standalone Commands
  const standaloneCmds: string[] = [];
  if (allowed("ask")) standaloneCmds.push(`  /ask <question> — Q&amp;A about the repo (read-only)`);
  if (allowed("do")) standaloneCmds.push(`  /do <instruction> — Run a dev task (creates a new PR)`);
  if (allowed("pm")) standaloneCmds.push(`  /pm <requirement> — Plan a feature: break it into Issues &amp; auto-dispatch`);
  if (allowed("fix")) standaloneCmds.push(`  /fix <description> — Fix a bug (creates a new PR)`);
  if (allowed("review")) standaloneCmds.push(`  /review <PR#> — Review a specific PR by number`);
  if (standaloneCmds.length > 0) {
    text += `<b>Standalone Commands</b> (use anywhere):\n${standaloneCmds.join("\n")}\n\n`;
  }

  // Management Commands
  const mgmtCmds: string[] = [];
  if (allowed("load")) mgmtCmds.push(`  /load — Load an open PR into a topic`);
  if (allowed("close")) mgmtCmds.push(`  /close — Unload a PR topic`);
  if (allowed("status")) mgmtCmds.push(`  /status — Show running tasks`);
  if (allowed("system")) mgmtCmds.push(`  /system — Check system status &amp; Claude API usage`);
  if (allowed("provider")) mgmtCmds.push(`  /provider [${listProviders().join("|")}] — Switch AI provider`);
  mgmtCmds.push(`  /info — Show bot &amp; chat info`);
  text += `<b>Management Commands</b>:\n${mgmtCmds.join("\n")}\n`;

  if (repo) {
    text += `\nBound repo: <code>${repo}</code>`;
  }
  text += `\n\n<b>版本</b>: v${VERSION} · ${VERSION_DATE} (UTC+8)`;
  await tg.sendMessage(chatId, text);
}
