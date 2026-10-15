import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all external dependencies
vi.mock("../utils/logger", () => ({
  log: vi.fn(),
  formatDuration: vi.fn(() => "1s"),
}));

vi.mock("../review/manager", () => ({
  runTask: vi.fn(),
  findActiveStandaloneThread: vi.fn(),
  consumeAutoFixRound: vi.fn(() => ({ round: 0, manualAutoFix: false })),
  cleanupAutoFixState: vi.fn(),
}));

vi.mock("../telegram/sync-github", () => ({
  syncGitHubCommentToTG: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config", () => ({
  TELEGRAM_CONFIG: null,
  REPOS: {
    "owner/repo": {
      dir: "/tmp/repo",
      commands: {},
      baseBranch: "main",
      installationId: 12345,
    },
  },
  MENTION_PATTERN: /@mikoto(-devs)?/i,
  BOT_LOGIN: "mikoto-devs[bot]",
  resolveSkillPath: vi.fn((repo: string, cmd: string) => {
    const map: Record<string, string> = {
      review: "skills/review-pr/SKILL.md",
      fix: "skills/fix/SKILL.md",
      do: "skills/do/SKILL.md",
      ask: "skills/ask/SKILL.md",
      verify: "skills/verify/SKILL.md",
    };
    return map[cmd] || null;
  }),
  isSyncPREnabled: vi.fn(() => true),
  getGroupsByRepo: vi.fn(() => []),
}));

vi.mock("../github/api", () => ({
  getPR: vi.fn().mockResolvedValue({ headBranch: "feat/test" }),
  postPRComment: vi.fn(),
}));

vi.mock("../store/db", () => ({
  getTopicThread: vi.fn(),
  deleteAutoverifyState: vi.fn(),
}));

vi.mock("../telegram/client", () => ({
  sendMessage: vi.fn(),
}));

vi.mock("../telegram/commands", () => ({
  loadPR: vi.fn(),
}));

const manager = await import("../review/manager");
const sync = await import("../telegram/sync-github");
const { handlePullRequest, handleIssueComment } = await import("../webhook/handler");

describe("handlePullRequest", () => {
  const repoConfig = {
    dir: "/tmp/repo",
    commands: {},
    baseBranch: "main",
    installationId: 12345,
  };

  beforeEach(() => {
    vi.mocked(manager.runTask).mockReset();
    vi.mocked(manager.consumeAutoFixRound).mockReset().mockReturnValue({ round: 0, manualAutoFix: false });
  });

  it("returns early when no PR number", () => {
    const result = handlePullRequest(
      { action: "opened", pull_request: {} as any },
      "owner/repo",
      repoConfig
    );
    expect(result.status).toBe(200);
    expect(result.message).toContain("no PR number");
    expect(manager.runTask).not.toHaveBeenCalled();
  });

  it("skips draft PRs", () => {
    const result = handlePullRequest(
      {
        action: "opened",
        pull_request: { number: 1, draft: true, head: { ref: "feat" }, base: { ref: "main" } },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.status).toBe(200);
    expect(result.message).toContain("draft PR skipped");
    expect(manager.runTask).not.toHaveBeenCalled();
  });

  it("skips non-target base branch", () => {
    const result = handlePullRequest(
      {
        action: "opened",
        pull_request: { number: 1, draft: false, head: { ref: "feat" }, base: { ref: "develop" } },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.status).toBe(200);
    expect(result.message).toContain("non-target branch");
    expect(manager.runTask).not.toHaveBeenCalled();
  });

  it("triggers review on opened event", () => {
    const result = handlePullRequest(
      {
        action: "opened",
        pull_request: {
          number: 42,
          draft: false,
          head: { ref: "feat/test" },
          base: { ref: "main" },
          title: "Test PR",
          user: { login: "author" },
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.status).toBe(200);
    expect(result.message).toContain("review triggered");
  });

  it("triggers review on synchronize event", () => {
    const result = handlePullRequest(
      {
        action: "synchronize",
        pull_request: {
          number: 42,
          draft: false,
          head: { ref: "feat/test" },
          base: { ref: "main" },
          title: "Test PR",
          user: { login: "author" },
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.status).toBe(200);
    expect(result.message).toContain("review triggered");
    expect(manager.consumeAutoFixRound).toHaveBeenCalledWith("owner/repo", 42);
  });

  it("ignores other events", () => {
    const result = handlePullRequest(
      {
        action: "closed",
        pull_request: {
          number: 42,
          draft: false,
          head: { ref: "feat" },
          base: { ref: "main" },
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.status).toBe(200);
    expect(result.message).toContain("event ignored");
  });

  it("cleans up autofix state when PR is closed", () => {
    handlePullRequest(
      {
        action: "closed",
        pull_request: {
          number: 55,
          draft: false,
          head: { ref: "feat" },
          base: { ref: "main" },
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(manager.cleanupAutoFixState).toHaveBeenCalledWith("owner/repo", 55);
  });

  it("skips baseBranch check when not configured", () => {
    const configNoBranch = { ...repoConfig, baseBranch: undefined };
    const result = handlePullRequest(
      {
        action: "opened",
        pull_request: {
          number: 1,
          draft: false,
          head: { ref: "feat" },
          base: { ref: "develop" },
          title: "PR",
          user: { login: "dev" },
        },
      },
      "owner/repo",
      configNoBranch
    );
    expect(result.message).toContain("review triggered");
  });

  it("does not consume auto-fix round on opened event", () => {
    handlePullRequest(
      {
        action: "opened",
        pull_request: {
          number: 50,
          draft: false,
          head: { ref: "feat" },
          base: { ref: "main" },
          title: "New PR",
          user: { login: "dev" },
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(manager.consumeAutoFixRound).not.toHaveBeenCalled();
  });

  it("passes auto-fix round info on synchronize", () => {
    vi.mocked(manager.consumeAutoFixRound).mockReturnValue({ round: 2, manualAutoFix: true });

    const result = handlePullRequest(
      {
        action: "synchronize",
        pull_request: {
          number: 55,
          draft: false,
          head: { ref: "feat/55" },
          base: { ref: "main" },
          title: "Auto-fix PR",
          user: { login: "dev" },
        },
      },
      "owner/repo",
      repoConfig
    );

    expect(result.message).toContain("review triggered");
    expect(manager.runTask).toHaveBeenCalledWith(
      expect.objectContaining({
        autoFixRound: 2,
        manualAutoFix: true,
      })
    );
  });

  it("calls runTask with correct parameters on synchronize", () => {
    handlePullRequest(
      {
        action: "synchronize",
        pull_request: {
          number: 60,
          draft: false,
          head: { ref: "feat/60" },
          base: { ref: "main" },
          title: "Sync PR",
          user: { login: "dev" },
        },
      },
      "owner/repo",
      repoConfig
    );

    expect(manager.runTask).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: "owner/repo",
        prNumber: 60,
        headBranch: "feat/60",
        command: "review",
      })
    );
  });

  it("ignores labeled/unlabeled events", () => {
    const result = handlePullRequest(
      {
        action: "labeled",
        pull_request: {
          number: 70,
          draft: false,
          head: { ref: "feat" },
          base: { ref: "main" },
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.message).toContain("event ignored");
    expect(manager.runTask).not.toHaveBeenCalled();
  });
});

describe("handleIssueComment", () => {
  const repoConfig = {
    dir: "/tmp/repo",
    commands: {},
    baseBranch: "main",
    installationId: 12345,
  };

  beforeEach(() => {
    vi.mocked(manager.runTask).mockReset();
    vi.mocked(sync.syncGitHubCommentToTG).mockReset().mockResolvedValue(undefined);
  });

  it("returns early when no issue number", () => {
    const result = handleIssueComment(
      { action: "created", comment: { id: 1, body: "@mikoto review", user: { login: "dev" }, created_at: "" } },
      "owner/repo",
      repoConfig
    );
    expect(result.message).toContain("no issue number");
  });

  it("triggers manual review on mention in PR comment", () => {
    const result = handleIssueComment(
      {
        action: "created",
        issue: { number: 42, pull_request: {} },
        comment: {
          id: 1,
          body: "@mikoto-devs please review",
          user: { login: "developer" },
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.message).toContain("manual /review triggered");
  });

  it("triggers /fix command (not review) on @mikoto /fix", () => {
    const result = handleIssueComment(
      {
        action: "created",
        issue: { number: 42, pull_request: {} },
        comment: {
          id: 1,
          body: "@mikoto /fix please fix the bug",
          user: { login: "developer" },
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.message).toContain("manual /fix triggered");
  });

  it("triggers /do command on @mikoto /do", () => {
    const result = handleIssueComment(
      {
        action: "created",
        issue: { number: 42, pull_request: {} },
        comment: {
          id: 1,
          body: "@mikoto /do refactor this function",
          user: { login: "developer" },
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.message).toContain("manual /do triggered");
  });

  it("triggers /ask command on @mikoto /ask", () => {
    const result = handleIssueComment(
      {
        action: "created",
        issue: { number: 42, pull_request: {} },
        comment: {
          id: 1,
          body: "@mikoto /ask what does this function do?",
          user: { login: "developer" },
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.message).toContain("manual /ask triggered");
  });

  it("falls back to review for unknown commands", () => {
    const result = handleIssueComment(
      {
        action: "created",
        issue: { number: 42, pull_request: {} },
        comment: {
          id: 1,
          body: "@mikoto /nonexistent do something",
          user: { login: "developer" },
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.message).toContain("manual /review triggered");
  });

  it("ignores comments without mention", () => {
    const result = handleIssueComment(
      {
        action: "created",
        issue: { number: 42, pull_request: {} },
        comment: {
          id: 1,
          body: "Just a regular comment",
          user: { login: "developer" },
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.message).toContain("comment noted");
  });

  it("skips bot's own comments (no trigger)", () => {
    const result = handleIssueComment(
      {
        action: "created",
        issue: { number: 42, pull_request: {} },
        comment: {
          id: 1,
          body: "@mikoto-devs some comment from bot",
          user: { login: "mikoto-devs[bot]" },
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.message).toContain("bot's own comment");
  });

  it("handles auto-fix trigger from bot comment", () => {
    const result = handleIssueComment(
      {
        action: "created",
        issue: { number: 42, pull_request: {} },
        comment: {
          id: 1,
          body: "Auto-fix <!-- autofix:command=fix,round=1 -->",
          user: { login: "mikoto-devs[bot]" },
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.message).toContain("auto-fix");
  });

  it("syncs new PR comments to Telegram", () => {
    handleIssueComment(
      {
        action: "created",
        issue: { number: 42, pull_request: {} },
        comment: {
          id: 99,
          body: "test comment",
          user: { login: "developer" },
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(sync.syncGitHubCommentToTG).toHaveBeenCalledWith("owner/repo", 42, expect.objectContaining({
      id: 99,
      author: "developer",
    }));
  });

  it("ignores non-PR issue comments for trigger", () => {
    const result = handleIssueComment(
      {
        action: "created",
        issue: { number: 42 },
        comment: {
          id: 1,
          body: "@mikoto review",
          user: { login: "dev" },
          created_at: "",
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.message).toContain("comment noted");
  });

  it("handles auto-fix trigger with manual flag", () => {
    const result = handleIssueComment(
      {
        action: "created",
        issue: { number: 42, pull_request: {} },
        comment: {
          id: 2,
          body: "Auto-fix <!-- autofix:command=fix,round=2,manual=true -->",
          user: { login: "mikoto-devs[bot]" },
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.message).toContain("auto-fix");
    expect(result.message).toContain("round 2");
  });

  it("handles /autofix command trigger", () => {
    const result = handleIssueComment(
      {
        action: "created",
        issue: { number: 42, pull_request: {} },
        comment: {
          id: 3,
          body: "@mikoto /autofix",
          user: { login: "developer" },
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.message).toContain("manual /autofix triggered");
  });

  it("does not trigger on 'edited' action", () => {
    const result = handleIssueComment(
      {
        action: "edited",
        issue: { number: 42, pull_request: {} },
        comment: {
          id: 4,
          body: "@mikoto please review",
          user: { login: "developer" },
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.message).toContain("comment noted");
    expect(manager.runTask).not.toHaveBeenCalled();
  });

  it("does not sync non-created comments to Telegram", () => {
    handleIssueComment(
      {
        action: "deleted",
        issue: { number: 42, pull_request: {} },
        comment: {
          id: 5,
          body: "deleted comment",
          user: { login: "dev" },
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(sync.syncGitHubCommentToTG).not.toHaveBeenCalled();
  });

  it("handles missing comment user gracefully", () => {
    const result = handleIssueComment(
      {
        action: "created",
        issue: { number: 42, pull_request: {} },
        comment: {
          id: 6,
          body: "@mikoto review please",
          user: undefined as any,
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );
    // Should not crash, and since author is empty string it won't match BOT_LOGIN
    expect(result.status).toBe(200);
  });

  it("handles empty comment body", () => {
    const result = handleIssueComment(
      {
        action: "created",
        issue: { number: 42, pull_request: {} },
        comment: {
          id: 7,
          body: "",
          user: { login: "dev" },
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.message).toContain("comment noted");
  });

  it("bot auto-fix comment on non-PR issue is ignored", () => {
    const result = handleIssueComment(
      {
        action: "created",
        issue: { number: 42 }, // no pull_request
        comment: {
          id: 8,
          body: "Auto-fix <!-- autofix:command=fix,round=1 -->",
          user: { login: "mikoto-devs[bot]" },
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );
    // Bot comment on non-PR should skip
    expect(result.message).toContain("bot's own comment");
  });

  it("syncs non-trigger PR comments from regular users to TG", () => {
    handleIssueComment(
      {
        action: "created",
        issue: { number: 10, pull_request: {} },
        comment: {
          id: 200,
          body: "Looks good, but let me check one more thing",
          user: { login: "reviewer" },
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );

    // Should sync but not trigger review
    expect(sync.syncGitHubCommentToTG).toHaveBeenCalled();
    expect(manager.runTask).not.toHaveBeenCalled();
  });

  it("handles @mikoto-devs mention variant", () => {
    const result = handleIssueComment(
      {
        action: "created",
        issue: { number: 42, pull_request: {} },
        comment: {
          id: 9,
          body: "@mikoto-devs /review this please",
          user: { login: "developer" },
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.message).toContain("manual /review triggered");
  });

  it("triggers /do on a plain Issue comment (PM auto-dispatch)", () => {
    const result = handleIssueComment(
      {
        action: "created",
        issue: { number: 77 }, // no pull_request → plain Issue
        comment: {
          id: 10,
          body: "@mikoto /do implement user login",
          user: { login: "pm-bot" },
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.message).toContain("triggered on issue");
    expect(manager.runTask).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "do",
        issueNumber: 77,
        headBranch: null,
      })
    );
  });

  it("ignores unknown /command on a plain Issue comment", () => {
    const result = handleIssueComment(
      {
        action: "created",
        issue: { number: 78 },
        comment: {
          id: 11,
          body: "@mikoto /unknowncmd do something",
          user: { login: "dev" },
          created_at: "2024-01-01T00:00:00Z",
        },
      },
      "owner/repo",
      repoConfig
    );
    expect(result.message).toContain("unknown command");
    expect(manager.runTask).not.toHaveBeenCalled();
  });

  describe("autoverify trigger comments (bot on PR)", () => {
    it("triggers /verify when bot posts autoverify marker on a PR", () => {
      const result = handleIssueComment(
        {
          action: "created",
          issue: { number: 42, pull_request: {} },
          comment: {
            id: 99,
            body: "🔍 Review passed...\n\n<!-- autoverify:command=verify,round=0 -->",
            user: { login: "mikoto-devs[bot]" },
            created_at: "2024-01-01T00:00:00Z",
          },
        },
        "owner/repo",
        repoConfig
      );
      expect(result.message).toContain("autoverify");
      expect(result.message).toContain("verify");
    });

    it("triggers /verify with correct verifyRound=2 from marker", () => {
      const result = handleIssueComment(
        {
          action: "created",
          issue: { number: 42, pull_request: {} },
          comment: {
            id: 100,
            body: "...\n\n<!-- autoverify:command=verify,round=2 -->",
            user: { login: "mikoto-devs[bot]" },
            created_at: "2024-01-01T00:00:00Z",
          },
        },
        "owner/repo",
        repoConfig
      );
      expect(result.message).toContain("2");
    });
  });
});
