import fs from "fs";
import path from "path";
import { log } from "./utils/logger";
import type { RepoConfig, RepoMap, TelegramConfig, TelegramGroup } from "./types";
import { isValidProvider, type AIProvider } from "./providers";

export const ROOT_DIR = path.join(__dirname, "..");
export const BOT_LOGIN = "mikoto-devs[bot]";
export const MENTION_PATTERN = /@mikoto(-devs)?/i;

export const PORT = parseInt(process.env.PORT || "9876", 10);
export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

/** Validate repos.json structure at startup — fail-fast on missing required fields */
export function validateRepoMap(raw: Record<string, any>): void {
  const errors: string[] = [];
  for (const [key, cfg] of Object.entries(raw)) {
    if (!/^[^/]+\/[^/]+$/.test(key)) {
      errors.push(`repos.json: invalid repo key "${key}" (expected "owner/repo" format)`);
    }
    if (typeof cfg !== "object" || cfg === null) {
      errors.push(`repos.json: "${key}" must be an object`);
      continue;
    }
    if (typeof cfg.dir !== "string" || !cfg.dir) {
      errors.push(`repos.json: "${key}" is missing required field "dir" (string)`);
    }
    if (cfg.installationId !== undefined && typeof cfg.installationId !== "number") {
      errors.push(`repos.json: "${key}.installationId" must be a number`);
    }
    if (cfg.baseBranch !== undefined && typeof cfg.baseBranch !== "string") {
      errors.push(`repos.json: "${key}.baseBranch" must be a string`);
    }
    if (cfg.taskTimeoutMs !== undefined && (typeof cfg.taskTimeoutMs !== "number" || cfg.taskTimeoutMs < 0)) {
      errors.push(`repos.json: "${key}.taskTimeoutMs" must be a non-negative number`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Config validation failed:\n  ${errors.join("\n  ")}`);
  }
}

/** Validate telegram.json structure — fail-fast on missing required fields */
export function validateTelegramConfig(config: any, repoMap: RepoMap): void {
  const errors: string[] = [];

  if (typeof config.botToken !== "string" || !config.botToken) {
    errors.push(`telegram.json: missing required field "botToken" (non-empty string)`);
  }
  if (!Array.isArray(config.adminUsers)) {
    errors.push(`telegram.json: missing required field "adminUsers" (array)`);
  }
  if (typeof config.groups !== "object" || config.groups === null) {
    errors.push(`telegram.json: missing required field "groups" (object)`);
  } else {
    for (const [chatId, group] of Object.entries(config.groups) as [string, any][]) {
      if (typeof group !== "object" || group === null) {
        errors.push(`telegram.json: group "${chatId}" must be an object`);
        continue;
      }
      if (typeof group.repo !== "string" || !group.repo) {
        errors.push(`telegram.json: group "${chatId}" is missing required field "repo" (string)`);
      } else if (!repoMap[group.repo]) {
        errors.push(`telegram.json: group "${chatId}" references unknown repo "${group.repo}" (not in repos.json)`);
      }
      if (typeof group.name !== "string" || !group.name) {
        errors.push(`telegram.json: group "${chatId}" is missing required field "name" (string)`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Config validation failed:\n  ${errors.join("\n  ")}`);
  }
}

export const REPOS: RepoMap = (() => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "repos.json"), "utf-8"));
  for (const [, cfg] of Object.entries(raw) as [string, any][]) {
    if (!cfg.commands) cfg.commands = {};
  }
  validateRepoMap(raw);
  return raw;
})();

export const BUILTIN_SKILLS: Record<string, string> = {
  ask: "skills/ask/SKILL.md",
  do: "skills/do/SKILL.md",
  pm: "skills/pm/SKILL.md",
  review: "skills/review-pr/SKILL.md",
  fix: "skills/fix/SKILL.md",
  update: "skills/ops/update/SKILL.md",
  verify: "skills/verify/SKILL.md",
};

/** Resolve skill path: repo-specific override > built-in fallback */
export function resolveSkillPath(repo: string, command: string): string | null {
  return REPOS[repo]?.commands?.[command] || BUILTIN_SKILLS[command] || null;
}

export function getRepoConfig(fullName: string): RepoConfig | null {
  const config = REPOS[fullName];
  if (!config) {
    log(`Repo ${fullName} not configured, skipping`);
    return null;
  }
  return config;
}

export const TELEGRAM_CONFIG: TelegramConfig | null = loadTelegramConfig();

/** Resolve working directory for a group: group-level dir override > repo-level dir */
export function getGroupDir(chatId: string, repo: string): string | null {
  const group = TELEGRAM_CONFIG?.groups[chatId];
  if (group?.dir) return group.dir;
  return REPOS[repo]?.dir ?? null;
}

/** Check if a command is allowed for a given chat (group-level filter) */
export function isCommandAllowed(chatId: string, command: string): boolean {
  const group = TELEGRAM_CONFIG?.groups[chatId];
  if (!group) return true; // no group config = allow all
  if (!group.allowedCommands) return true; // no whitelist = allow all
  return group.allowedCommands.includes(command);
}

/** Get all groups configured for a given repo */
export function getGroupsByRepo(repo: string): Array<[string, TelegramGroup]> {
  if (!TELEGRAM_CONFIG) return [];
  return Object.entries(TELEGRAM_CONFIG.groups).filter(([, group]) => group.repo === repo);
}

/** Check if PR syncing is enabled for a given chat */
export function isSyncPREnabled(chatId: string): boolean {
  const group = TELEGRAM_CONFIG?.groups[chatId];
  if (!group) return true; // no group config = default enabled
  return group.syncPR !== false; // default true unless explicitly false
}

// --- AI Provider management (per-group, in-memory, runtime-switchable) ---

export type { AIProvider };

function resolveDefaultProvider(rawProvider: string | undefined): AIProvider {
  if (!rawProvider) return "claude";
  if (isValidProvider(rawProvider)) return rawProvider;

  log(`Invalid AI_PROVIDER '${rawProvider}', fallback to 'claude'`);
  return "claude";
}

const DEFAULT_PROVIDER: AIProvider = resolveDefaultProvider(process.env.AI_PROVIDER);

/** Per-group provider overrides. Groups not in this map use DEFAULT_PROVIDER. */
const groupProviderOverrides = new Map<string, AIProvider>();

/** Get the active AI provider for a given chat group (or global default). */
export function getProvider(chatId?: string): AIProvider {
  if (chatId) {
    const override = groupProviderOverrides.get(chatId);
    if (override) return override;
  }
  return DEFAULT_PROVIDER;
}

/** Set the AI provider for a specific chat group. */
export function setProvider(chatId: string, provider: AIProvider): void {
  groupProviderOverrides.set(chatId, provider);
}

function loadTelegramConfig(): TelegramConfig | null {
  const tgPath = path.join(ROOT_DIR, "telegram.json");
  if (!fs.existsSync(tgPath)) {
    log("telegram.json not found, Telegram bot disabled");
    return null;
  }
  const config: TelegramConfig = JSON.parse(fs.readFileSync(tgPath, "utf-8"));
  if (!config.botToken) {
    log("telegram.json has no botToken, Telegram bot disabled");
    return null;
  }
  validateTelegramConfig(config, REPOS);
  log(`Telegram config loaded: ${Object.keys(config.groups).length} group(s)`);
  return config;
}
