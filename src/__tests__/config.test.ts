import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs and path before importing config
vi.mock("fs", () => ({
  default: {
    readFileSync: vi.fn((filePath: string) => {
      if (filePath.includes("repos.json")) {
        return JSON.stringify({
          "owner/repo": {
            dir: "/tmp/repo",
            commands: { review: "custom/review.md" },
            baseBranch: "main",
            installationId: 12345,
          },
          "owner/other": {
            dir: "/tmp/other",
          },
        });
      }
      if (filePath.includes("telegram.json")) {
        return JSON.stringify({
          botToken: "test-token",
          adminUsers: [111, "admin_user"],
          groups: {
            "-100123": {
              repo: "owner/repo",
              name: "Test Group",
              dir: "/tmp/group-override",
              allowedCommands: ["review", "fix"],
              syncPR: true,
            },
            "-100456": {
              repo: "owner/repo",
              name: "Ops Group",
              syncPR: false,
            },
          },
        });
      }
      throw new Error(`Unexpected file: ${filePath}`);
    }),
    existsSync: vi.fn(() => true),
  },
}));

// Mock logger to suppress output
vi.mock("../utils/logger", () => ({
  log: vi.fn(),
}));

// Import after mocks are set up
const config = await import("../config");

describe("resolveSkillPath", () => {
  it("returns repo-specific override when available", () => {
    expect(config.resolveSkillPath("owner/repo", "review")).toBe("custom/review.md");
  });

  it("falls back to built-in skill when no override", () => {
    expect(config.resolveSkillPath("owner/repo", "ask")).toBe("skills/ask/SKILL.md");
    expect(config.resolveSkillPath("owner/repo", "fix")).toBe("skills/fix/SKILL.md");
  });

  it("returns null for unknown command without builtin", () => {
    expect(config.resolveSkillPath("owner/repo", "nonexistent")).toBeNull();
  });

  it("returns built-in for unconfigured repo", () => {
    expect(config.resolveSkillPath("unknown/repo", "review")).toBe("skills/review-pr/SKILL.md");
  });
});

describe("getRepoConfig", () => {
  it("returns config for known repo", () => {
    const cfg = config.getRepoConfig("owner/repo");
    expect(cfg).not.toBeNull();
    expect(cfg!.dir).toBe("/tmp/repo");
    expect(cfg!.baseBranch).toBe("main");
    expect(cfg!.installationId).toBe(12345);
  });

  it("returns null for unknown repo", () => {
    expect(config.getRepoConfig("unknown/repo")).toBeNull();
  });
});

describe("isCommandAllowed", () => {
  it("returns true for allowed commands", () => {
    expect(config.isCommandAllowed("-100123", "review")).toBe(true);
    expect(config.isCommandAllowed("-100123", "fix")).toBe(true);
  });

  it("returns false for disallowed commands", () => {
    expect(config.isCommandAllowed("-100123", "do")).toBe(false);
    expect(config.isCommandAllowed("-100123", "ask")).toBe(false);
  });

  it("returns true for group without whitelist", () => {
    expect(config.isCommandAllowed("-100456", "do")).toBe(true);
    expect(config.isCommandAllowed("-100456", "anything")).toBe(true);
  });

  it("returns true for unknown group (no config)", () => {
    expect(config.isCommandAllowed("-999", "review")).toBe(true);
  });
});

describe("isSyncPREnabled", () => {
  it("returns true when syncPR is true", () => {
    expect(config.isSyncPREnabled("-100123")).toBe(true);
  });

  it("returns false when syncPR is explicitly false", () => {
    expect(config.isSyncPREnabled("-100456")).toBe(false);
  });

  it("returns true for unknown group (default)", () => {
    expect(config.isSyncPREnabled("-999")).toBe(true);
  });
});

describe("getGroupDir", () => {
  it("returns group-level dir override", () => {
    expect(config.getGroupDir("-100123", "owner/repo")).toBe("/tmp/group-override");
  });

  it("returns repo-level dir when no group override", () => {
    expect(config.getGroupDir("-100456", "owner/repo")).toBe("/tmp/repo");
  });

  it("returns repo-level dir for unknown group", () => {
    expect(config.getGroupDir("-999", "owner/repo")).toBe("/tmp/repo");
  });

  it("returns null for unknown repo and group", () => {
    expect(config.getGroupDir("-999", "unknown/repo")).toBeNull();
  });
});

describe("getGroupsByRepo", () => {
  it("returns groups matching the repo", () => {
    const groups = config.getGroupsByRepo("owner/repo");
    expect(groups).toHaveLength(2);
    const chatIds = groups.map(([id]) => id);
    expect(chatIds).toContain("-100123");
    expect(chatIds).toContain("-100456");
  });

  it("returns empty array for unknown repo", () => {
    expect(config.getGroupsByRepo("unknown/repo")).toEqual([]);
  });

  it("returns entries with correct group data", () => {
    const groups = config.getGroupsByRepo("owner/repo");
    const syncGroup = groups.find(([id]) => id === "-100123");
    expect(syncGroup).toBeDefined();
    expect(syncGroup![1].name).toBe("Test Group");
    expect(syncGroup![1].syncPR).toBe(true);
  });
});

describe("REPOS", () => {
  it("loads repos from mocked repos.json", () => {
    expect(config.REPOS).toHaveProperty("owner/repo");
    expect(config.REPOS).toHaveProperty("owner/other");
  });

  it("ensures commands object exists even when not specified", () => {
    expect(config.REPOS["owner/other"].commands).toEqual({});
  });
});

describe("BUILTIN_SKILLS", () => {
  it("contains expected skills", () => {
    expect(config.BUILTIN_SKILLS).toHaveProperty("ask");
    expect(config.BUILTIN_SKILLS).toHaveProperty("do");
    expect(config.BUILTIN_SKILLS).toHaveProperty("review");
    expect(config.BUILTIN_SKILLS).toHaveProperty("fix");
    expect(config.BUILTIN_SKILLS).toHaveProperty("update");
  });

  it("resolves 'verify' as a built-in skill", () => {
    expect(config.resolveSkillPath("owner/repo", "verify")).toBe("skills/verify/SKILL.md");
  });
});

describe("constants", () => {
  it("has expected BOT_LOGIN", () => {
    expect(config.BOT_LOGIN).toBe("mikoto-devs[bot]");
  });

  it("has expected MENTION_PATTERN", () => {
    expect(config.MENTION_PATTERN.test("@mikoto")).toBe(true);
    expect(config.MENTION_PATTERN.test("@mikoto-devs")).toBe(true);
    expect(config.MENTION_PATTERN.test("@MIKOTO")).toBe(true);
    expect(config.MENTION_PATTERN.test("@someone")).toBe(false);
  });
});

describe("validateRepoMap", () => {
  it("passes for valid config", () => {
    expect(() =>
      config.validateRepoMap({
        "owner/repo": { dir: "/tmp/repo", commands: {} },
        "org/project": { dir: "/tmp/project", commands: {}, installationId: 123, baseBranch: "main" },
      })
    ).not.toThrow();
  });

  it("throws on missing dir", () => {
    expect(() =>
      config.validateRepoMap({ "owner/repo": { commands: {} } })
    ).toThrow(/missing required field "dir"/);
  });

  it("throws on empty dir", () => {
    expect(() =>
      config.validateRepoMap({ "owner/repo": { dir: "", commands: {} } })
    ).toThrow(/missing required field "dir"/);
  });

  it("throws on invalid repo key format", () => {
    expect(() =>
      config.validateRepoMap({ "no-slash": { dir: "/tmp/x", commands: {} } })
    ).toThrow(/invalid repo key "no-slash"/);
  });

  it("throws on non-object repo value", () => {
    expect(() =>
      config.validateRepoMap({ "owner/repo": "invalid" as any })
    ).toThrow(/"owner\/repo" must be an object/);
  });

  it("throws on wrong installationId type", () => {
    expect(() =>
      config.validateRepoMap({ "owner/repo": { dir: "/tmp/x", commands: {}, installationId: "123" } })
    ).toThrow(/owner\/repo\.installationId" must be a number/);
  });

  it("throws on wrong baseBranch type", () => {
    expect(() =>
      config.validateRepoMap({ "owner/repo": { dir: "/tmp/x", commands: {}, baseBranch: 42 } })
    ).toThrow(/owner\/repo\.baseBranch" must be a string/);
  });

  it("collects multiple errors", () => {
    expect(() =>
      config.validateRepoMap({
        "bad-key": { dir: "", commands: {} },
        "owner/repo": { commands: {} },
      })
    ).toThrow(/invalid repo key.*\n.*missing required field "dir".*\n.*missing required field "dir"/s);
  });
});

describe("validateTelegramConfig", () => {
  const validRepoMap = {
    "owner/repo": { dir: "/tmp/repo", commands: {} },
  };

  it("passes for valid config", () => {
    expect(() =>
      config.validateTelegramConfig(
        {
          botToken: "tok",
          adminUsers: [111],
          groups: { "-100": { repo: "owner/repo", name: "G1" } },
        },
        validRepoMap
      )
    ).not.toThrow();
  });

  it("throws on missing botToken", () => {
    expect(() =>
      config.validateTelegramConfig(
        { adminUsers: [], groups: {} },
        validRepoMap
      )
    ).toThrow(/missing required field "botToken"/);
  });

  it("throws on missing adminUsers", () => {
    expect(() =>
      config.validateTelegramConfig(
        { botToken: "tok", groups: {} },
        validRepoMap
      )
    ).toThrow(/missing required field "adminUsers"/);
  });

  it("throws on missing groups", () => {
    expect(() =>
      config.validateTelegramConfig(
        { botToken: "tok", adminUsers: [] },
        validRepoMap
      )
    ).toThrow(/missing required field "groups"/);
  });

  it("throws on group missing repo", () => {
    expect(() =>
      config.validateTelegramConfig(
        { botToken: "tok", adminUsers: [], groups: { "-100": { name: "G1" } } },
        validRepoMap
      )
    ).toThrow(/group "-100" is missing required field "repo"/);
  });

  it("throws on group missing name", () => {
    expect(() =>
      config.validateTelegramConfig(
        { botToken: "tok", adminUsers: [], groups: { "-100": { repo: "owner/repo" } } },
        validRepoMap
      )
    ).toThrow(/group "-100" is missing required field "name"/);
  });

  it("throws on group referencing unknown repo", () => {
    expect(() =>
      config.validateTelegramConfig(
        { botToken: "tok", adminUsers: [], groups: { "-100": { repo: "no/such", name: "G1" } } },
        validRepoMap
      )
    ).toThrow(/references unknown repo "no\/such"/);
  });

  it("throws on non-object group value", () => {
    expect(() =>
      config.validateTelegramConfig(
        { botToken: "tok", adminUsers: [], groups: { "-100": "bad" } },
        validRepoMap
      )
    ).toThrow(/group "-100" must be an object/);
  });

  it("collects multiple errors", () => {
    expect(() =>
      config.validateTelegramConfig(
        {
          botToken: "tok",
          adminUsers: [],
          groups: {
            "-100": { name: "G1" },
            "-200": { repo: "owner/repo" },
          },
        },
        validRepoMap
      )
    ).toThrow(/missing required field "repo".*\n.*missing required field "name"/s);
  });
});
