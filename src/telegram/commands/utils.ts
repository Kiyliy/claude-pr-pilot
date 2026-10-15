/**
 * Shared utilities for command handlers.
 */

import { TELEGRAM_CONFIG, REPOS } from "../../config";
import * as ghApi from "../../github/api";

export function getRepoForChat(chatId: string): string | null {
  return TELEGRAM_CONFIG?.groups[chatId]?.repo ?? null;
}

export function getInstallationId(repo: string): number | null {
  return REPOS[repo]?.installationId ?? null;
}

/** Parse "/command extra text" → { command, userInput } */
export function parseCommand(text: string): { command: string; userInput: string } {
  const trimmed = text.trim();
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { command: trimmed.slice(1).replace(/@\S+/, ""), userInput: "" };
  }
  const command = trimmed.slice(1, spaceIdx).replace(/@\S+/, "");
  const userInput = trimmed.slice(spaceIdx + 1).trim();
  return { command, userInput };
}

/** Resolve head branch for a PR */
export async function resolveHeadBranch(repo: string, prNumber: number): Promise<string | null> {
  const installationId = getInstallationId(repo);
  if (!installationId) return null;
  const pr = await ghApi.getPR(installationId, repo, prNumber);
  return pr?.headBranch ?? null;
}
