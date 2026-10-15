import { vi } from "vitest";

export const MOCK_REPOS = {
  "owner/repo": {
    dir: "/tmp/repo",
    commands: {},
    baseBranch: "main",
    installationId: 12345,
    autoFix: false,
  },
  "owner/autofix-repo": {
    dir: "/tmp/autofix-repo",
    commands: {},
    baseBranch: "main",
    installationId: 67890,
    allowAutoFix: true,
    maxAutoFixRounds: 3,
  },
};

export const MOCK_TELEGRAM_CONFIG = {
  botToken: "mock-token",
  adminUsers: [1],
  groups: {
    "-100": {
      repo: "owner/repo",
      name: "Test Group",
    },
  },
};

export const ROOT_DIR = "/app";
export const BOT_LOGIN = "mikoto-devs[bot]";
export const REPOS = MOCK_REPOS;
export const TELEGRAM_CONFIG = MOCK_TELEGRAM_CONFIG;

export const getRepoConfig = vi.fn((name: string) => {
  return MOCK_REPOS[name as keyof typeof MOCK_REPOS] ?? null;
});

export const resolveSkillPath = vi.fn(() => "skills/review-pr/SKILL.md");
export const getGroupDir = vi.fn(() => null);
export const getProvider = vi.fn(() => "claude" as const);
export const setProvider = vi.fn();
export const isCommandAllowed = vi.fn(() => true);
export const isSyncPREnabled = vi.fn(() => true);
export const getGroupsByRepo = vi.fn(() => []);
