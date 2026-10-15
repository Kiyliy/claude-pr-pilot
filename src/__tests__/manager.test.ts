import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

const mockExecSync = vi.fn(() => "");
const mockSpawn = vi.fn(() => {
  const child = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
});
const mockExistsSync = vi.fn(() => false);
const mockReaddirSync = vi.fn(() => [] as string[]);
const mockStatSync = vi.fn(() => ({ isDirectory: () => true }));
const mockRmSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockGetProvider = vi.fn(() => "claude");
const mockCreateWriteStream = vi.fn(() => ({
  write: vi.fn(),
  end: vi.fn(),
}));
const mockCreateReadStream = vi.fn(() => ({
  pipe: vi.fn(),
}));

// Mock all external dependencies
vi.mock("fs", () => ({
  default: {
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    readdirSync: mockReaddirSync,
    statSync: mockStatSync,
    rmSync: mockRmSync,
    readFileSync: vi.fn(() => "{}"),
    writeFileSync: mockWriteFileSync,
    unlinkSync: vi.fn(),
    createWriteStream: mockCreateWriteStream,
    createReadStream: mockCreateReadStream,
  },
}));

vi.mock("child_process", () => ({
  spawn: mockSpawn,
  execSync: mockExecSync,
}));

vi.mock("../utils/logger", () => ({
  log: vi.fn(),
  formatDuration: vi.fn(() => "1s"),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../config", () => ({
  ROOT_DIR: "/app",
  BOT_LOGIN: "mikoto-devs[bot]",
  REPOS: {
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
  },
  getRepoConfig: vi.fn((name: string) => {
    if (name === "owner/repo") return {
      dir: "/tmp/repo",
      commands: {},
      baseBranch: "main",
      installationId: 12345,
      autoFix: false,
    };
    if (name === "owner/autofix-repo") return {
      dir: "/tmp/autofix-repo",
      commands: {},
      baseBranch: "main",
      installationId: 67890,
      allowAutoFix: true,
      maxAutoFixRounds: 3,
    };
    return null;
  }),
  resolveSkillPath: vi.fn(() => "skills/review-pr/SKILL.md"),
  getGroupDir: vi.fn(() => null),
  getProvider: mockGetProvider,
}));

vi.mock("../review/prompt", () => ({
  buildPrompt: vi.fn(() => "test prompt"),
}));

vi.mock("../github/auth", () => ({
  getInstallationToken: vi.fn().mockResolvedValue("mock-token"),
}));

const mockNotifyTaskStart = vi.fn().mockResolvedValue(undefined);
const mockNotifyTaskComplete = vi.fn().mockResolvedValue(undefined);
const mockSendOutputToTG = vi.fn().mockResolvedValue(undefined);
const mockSendPRBodyToTG = vi.fn().mockResolvedValue(undefined);

vi.mock("../telegram/notifications", () => ({
  notifyTaskStart: mockNotifyTaskStart,
  notifyTaskComplete: mockNotifyTaskComplete,
  sendOutputToTG: mockSendOutputToTG,
  sendPRBodyToTG: mockSendPRBodyToTG,
}));

vi.mock("../review/topic-context", () => ({
  loadTaskContext: vi.fn().mockResolvedValue(null),
}));

const mockUpdateStandaloneTopicPR = vi.fn();
const mockUpdateStandaloneTopicIssue = vi.fn();
const mockSetTopicThread = vi.fn();
const mockGetStandaloneTopic = vi.fn(() => null);
const mockGetMessageRefCount = vi.fn(() => 0);
const mockFindPRByThread = vi.fn(() => null);

vi.mock("../store/db", () => ({
  updateStandaloneTopicPR: mockUpdateStandaloneTopicPR,
  updateStandaloneTopicIssue: mockUpdateStandaloneTopicIssue,
  setTopicThread: mockSetTopicThread,
  findPRByThread: mockFindPRByThread,
  // autofix_state functions used by autofix.ts
  getAutofixState: vi.fn(() => null),
  setAutofixRounds: vi.fn(),
  setAutofixHeadSHA: vi.fn(),
  clearAutofixHeadSHA: vi.fn(),
  clearAutofixRoundsAndManual: vi.fn(),
  deleteAutofixState: vi.fn(),
  clearAllAutofixState: vi.fn(),
  getStandaloneTopic: mockGetStandaloneTopic,
  getMessageRefCount: mockGetMessageRefCount,
}));

vi.mock("../telegram/client", () => ({
  sendMessage: vi.fn().mockResolvedValue({}),
  sendInlineKeyboard: vi.fn().mockResolvedValue({}),
  editForumTopicName: vi.fn().mockResolvedValue(undefined),
  editForumTopicIcon: vi.fn().mockResolvedValue(undefined),
}));

const mockGetPR = vi.fn().mockResolvedValue({ number: 1, title: "test PR", author: "user", headBranch: "feat", baseBranch: "main", draft: false });
vi.mock("../github/api", () => ({
  postPRComment: vi.fn().mockResolvedValue({ id: 1 }),
  getPR: mockGetPR,
}));

const mockGenerateTopicTitle = vi.fn().mockResolvedValue("#99 Clean Title");
vi.mock("../xai/client", () => ({
  generateTopicTitle: mockGenerateTopicTitle,
}));

const {
  findActiveStandaloneThread,
  getActiveTasks,
  cancelTask,
  consumeAutoFixRound,
  cleanupOrphanedWorktrees,
  runTask,
  registerCallbackId,
  resolveCallbackId,
  _resetActiveTasks,
} = await import("../review/manager");

describe("findActiveStandaloneThread", () => {
  beforeEach(() => {
    _resetActiveTasks();
    vi.clearAllMocks();
  });

  it("returns null when no active tasks", () => {
    expect(findActiveStandaloneThread("owner/repo", "-100")).toBeNull();
  });

  it("returns null for non-matching repoFullName", () => {
    // Start a standalone task to populate activeTasks
    runTask({
      repoFullName: "owner/repo",
      command: "do",
      tgChatId: "-100",
      tgThreadId: 5555,
      userInput: "test task",
    });
    // Querying a different repo should return null
    expect(findActiveStandaloneThread("other/repo", "-100")).toBeNull();
  });

  it("returns null for non-matching chatId", () => {
    runTask({
      repoFullName: "owner/repo",
      command: "do",
      tgChatId: "-100",
      tgThreadId: 6666,
      userInput: "test",
    });
    expect(findActiveStandaloneThread("owner/repo", "-200")).toBeNull();
  });

  it("returns first candidate when no prTitle/prBranch provided", () => {
    runTask({
      repoFullName: "owner/repo",
      command: "do",
      tgChatId: "-100",
      tgThreadId: 7777,
      userInput: "fix auth bug",
    });
    const result = findActiveStandaloneThread("owner/repo", "-100");
    expect(result).not.toBeNull();
  });

  it("binds to matching task when description overlaps with PR title", () => {
    runTask({
      repoFullName: "owner/repo",
      command: "do",
      tgChatId: "-100",
      tgThreadId: 8888,
      userInput: "fix authentication bug in login flow",
    });
    // Mock the DB to return description for this thread
    mockGetStandaloneTopic.mockImplementation((chatId: string, threadId: number) => {
      if (chatId === "-100" && threadId === 8888) {
        return { repo: "owner/repo", description: "fix authentication bug in login flow" };
      }
      return null;
    });
    const result = findActiveStandaloneThread(
      "owner/repo", "-100",
      "fix: Fix authentication bug in login flow",
      "feat/fix-auth-bug"
    );
    expect(result).toBe(8888);
    mockGetStandaloneTopic.mockReset();
    mockGetStandaloneTopic.mockReturnValue(null);
  });

  it("returns single candidate regardless of description match (CJK-safe fallback)", () => {
    // When only ONE standalone task is active, it must be the task that created the PR.
    // Return it unconditionally so CJK descriptions (which score 0 against English PR
    // titles) don't cause a duplicate topic to be created by autoLoadPR.
    runTask({
      repoFullName: "owner/repo",
      command: "do",
      tgChatId: "-100",
      tgThreadId: 9999,
      userInput: "add feature X to dashboard",
    });
    mockGetStandaloneTopic.mockImplementation((chatId: string, threadId: number) => {
      if (chatId === "-100" && threadId === 9999) {
        return { repo: "owner/repo", description: "add feature X to dashboard" };
      }
      return null;
    });
    // Even with a non-matching description, return the single candidate
    const result = findActiveStandaloneThread(
      "owner/repo", "-100",
      "fix: Fix critical auth bug",
      "hotfix/auth-crash"
    );
    expect(result).toBe(9999);
    mockGetStandaloneTopic.mockReset();
    mockGetStandaloneTopic.mockReturnValue(null);
  });

  it("returns null when multiple candidates exist and none matches PR title (prevents wrong binding)", () => {
    // With two active tasks, neither of which has descriptions matching the PR,
    // we must not bind to avoid routing a human-created PR to the wrong topic.
    runTask({
      repoFullName: "owner/repo",
      command: "do",
      tgChatId: "-100",
      tgThreadId: 9999,
      userInput: "add feature X to dashboard",
    });
    runTask({
      repoFullName: "owner/repo",
      command: "fix",
      tgChatId: "-100",
      tgThreadId: 9998,
      userInput: "improve performance of search module",
    });
    mockGetStandaloneTopic.mockImplementation((chatId: string, threadId: number) => {
      if (chatId === "-100" && threadId === 9999) {
        return { repo: "owner/repo", description: "add feature X to dashboard" };
      }
      if (chatId === "-100" && threadId === 9998) {
        return { repo: "owner/repo", description: "improve performance of search module" };
      }
      return null;
    });
    // Unrelated PR opened manually while both tasks are running — should not match either
    const result = findActiveStandaloneThread(
      "owner/repo", "-100",
      "fix: Fix critical auth bug",
      "hotfix/auth-crash"
    );
    expect(result).toBeNull();
    mockGetStandaloneTopic.mockReset();
    mockGetStandaloneTopic.mockReturnValue(null);
  });

  it("falls back to first match when no stored descriptions exist", () => {
    runTask({
      repoFullName: "owner/repo",
      command: "do",
      tgChatId: "-100",
      tgThreadId: 1111,
    });
    // getStandaloneTopic returns null (no description stored)
    mockGetStandaloneTopic.mockReturnValue(null);
    const result = findActiveStandaloneThread(
      "owner/repo", "-100",
      "fix: Some PR title",
      "feat/some-branch"
    );
    expect(result).not.toBeNull();
  });
});

describe("getActiveTasks", () => {
  beforeEach(() => {
    _resetActiveTasks();
    vi.clearAllMocks();
  });

  it("returns empty array when no active tasks", () => {
    expect(getActiveTasks()).toEqual([]);
  });

  it("returns tasks with correct structure", () => {
    runTask({
      repoFullName: "owner/repo",
      prNumber: 200,
      command: "review",
      headBranch: "feat/200",
    });

    const tasks = getActiveTasks();
    const found = tasks.find((t) => t.key.includes("200"));
    expect(found).toBeDefined();
    expect(found!.command).toBe("review");
    expect(found!.branch).toBe("feat/200");
    expect(found!.label).toBe("PR #200");
  });
});

describe("cancelTask", () => {
  it("returns false when task key not found", () => {
    expect(cancelTask("nonexistent-key")).toBe(false);
  });
});

describe("consumeAutoFixRound", () => {
  it("returns { round: 0, manualAutoFix: false } when no round pending", () => {
    expect(consumeAutoFixRound("owner/repo", 42)).toEqual({
      round: 0,
      manualAutoFix: false,
    });
  });

  it("returns default for unknown repo/PR combination", () => {
    const result = consumeAutoFixRound("unknown/repo", 999);
    expect(result).toEqual({ round: 0, manualAutoFix: false });
  });

  it("is idempotent when called multiple times for same PR", () => {
    const r1 = consumeAutoFixRound("owner/repo", 50);
    const r2 = consumeAutoFixRound("owner/repo", 50);
    expect(r1).toEqual(r2);
    expect(r1).toEqual({ round: 0, manualAutoFix: false });
  });
});

describe("cleanupOrphanedWorktrees", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when .worktrees dir does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    cleanupOrphanedWorktrees();
    expect(mockReaddirSync).not.toHaveBeenCalled();
  });

  it("cleans up orphaned worktrees using git worktree remove", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["task-review-pr-42-1234567890"] as any);
    mockStatSync.mockReturnValue({ isDirectory: () => true });

    cleanupOrphanedWorktrees();

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git worktree remove"),
      expect.any(Object)
    );
  });

  it("falls back to rmSync when git worktree remove fails", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["task-fix-pr-10-9999999"] as any);
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("git worktree remove")) throw new Error("git error");
      if (cmd.includes("git worktree prune")) return "";
      return "";
    });

    cleanupOrphanedWorktrees();

    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining("task-fix-pr-10-9999999"),
      { recursive: true, force: true }
    );
  });

  it("notifies TG for worktrees with identifiable PR numbers", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["task-review-pr-42-1234567890"] as any);
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockExecSync.mockReturnValue("");

    cleanupOrphanedWorktrees();

    expect(mockNotifyTaskComplete).toHaveBeenCalledWith(
      expect.any(String),
      42,
      "task",
      false,
      "interrupted by restart"
    );
  });

  it("skips non-directory entries", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["somefile.txt"] as any);
    mockStatSync.mockReturnValue({ isDirectory: () => false });

    cleanupOrphanedWorktrees();

    expect(mockExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining("git worktree remove"),
      expect.any(Object)
    );
  });

  it("handles readdirSync errors gracefully", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockImplementation(() => { throw new Error("EACCES"); });

    // Should not throw
    expect(() => cleanupOrphanedWorktrees()).not.toThrow();
  });

  it("handles statSync errors gracefully", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["task-review-pr-1-000"] as any);
    mockStatSync.mockImplementation(() => { throw new Error("ENOENT"); });

    expect(() => cleanupOrphanedWorktrees()).not.toThrow();
  });

  it("prunes stale worktree refs after cleanup", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([] as any);

    cleanupOrphanedWorktrees();

    expect(mockExecSync).toHaveBeenCalledWith(
      "git worktree prune",
      expect.any(Object)
    );
  });
});

describe("runTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetActiveTasks();
  });

  it("returns rejection for unconfigured repo", () => {
    const result = runTask({
      repoFullName: "unknown/repo",
      command: "review",
    });
    expect(result).not.toBeNull();
    expect(result!.reason).toContain("not configured");
  });

  it("returns null (success) for valid task", () => {
    const result = runTask({
      repoFullName: "owner/repo",
      prNumber: 42,
      command: "review",
      headBranch: "feat/test",
    });
    // runTask returns null on success (task started)
    expect(result).toBeNull();
  });

  it("prevents duplicate tasks with same key", () => {
    // First task should succeed
    const result1 = runTask({
      repoFullName: "owner/repo",
      prNumber: 99,
      command: "review",
      headBranch: "feat/test",
    });
    expect(result1).toBeNull();

    // Second task with same key should be rejected
    const result2 = runTask({
      repoFullName: "owner/repo",
      prNumber: 99,
      command: "review",
      headBranch: "feat/test",
    });
    expect(result2).not.toBeNull();
    expect(result2!.reason).toContain("already has");
  });

  it("allows different commands on same PR", () => {
    const r1 = runTask({
      repoFullName: "owner/repo",
      prNumber: 77,
      command: "review",
      headBranch: "feat",
    });
    const r2 = runTask({
      repoFullName: "owner/repo",
      prNumber: 77,
      command: "fix",
      headBranch: "feat",
    });
    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });

  it("registers active task and reports it", () => {
    runTask({
      repoFullName: "owner/repo",
      prNumber: 88,
      command: "review",
      headBranch: "feat/88",
    });

    const tasks = getActiveTasks();
    const found = tasks.find((t) => t.key.includes("88"));
    expect(found).toBeDefined();
    expect(found!.command).toBe("review");
  });

  it("returns rejection when worktree creation fails", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("git worktree add")) throw new Error("worktree creation failed");
      return "";
    });

    const result = runTask({
      repoFullName: "owner/repo",
      prNumber: 300,
      command: "review",
      headBranch: "feat/300",
    });

    expect(result).not.toBeNull();
    expect(result!.reason).toContain("Failed to create worktree");
  });

  it("creates worktree with head branch ref when available", () => {
    mockExecSync.mockReturnValue("");

    runTask({
      repoFullName: "owner/repo",
      prNumber: 301,
      command: "review",
      headBranch: "feat/branch-name",
    });

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("origin/feat/branch-name"),
      expect.any(Object)
    );
  });

  it("skips worktree for 'update' command", () => {
    const result = runTask({
      repoFullName: "owner/repo",
      command: "update",
    });

    expect(result).toBeNull();
    // Should not call git worktree add for update command
    const worktreeAddCalls = mockExecSync.mock.calls.filter(
      (call: any[]) => String(call[0]).includes("git worktree add")
    );
    expect(worktreeAddCalls).toHaveLength(0);
  });

  it("truncates long userInput in label", () => {
    const longInput = "a".repeat(100);
    runTask({
      repoFullName: "owner/repo",
      command: "do",
      tgChatId: "-100",
      tgThreadId: 9999,
      userInput: longInput,
    });

    const tasks = getActiveTasks();
    const found = tasks.find((t) => t.label?.includes("..."));
    expect(found).toBeDefined();
    expect(found!.label!.length).toBeLessThanOrEqual(83); // 80 + "..."
  });

  it("generates timestamp-based key for standalone tasks without TG info", () => {
    vi.useFakeTimers();
    try {
      const r1 = runTask({
        repoFullName: "owner/repo",
        command: "do",
      });
      expect(r1).toBeNull();

      // Advance fake clock by 1ms to ensure different Date.now() values
      vi.advanceTimersByTime(1);

      const r2 = runTask({
        repoFullName: "owner/repo",
        command: "do",
      });
      // Both should succeed since they get unique timestamp-based keys
      expect(r2).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("deduplicates standalone tasks by TG thread", () => {
    const r1 = runTask({
      repoFullName: "owner/repo",
      command: "do",
      tgChatId: "-100",
      tgThreadId: 7777,
    });
    const r2 = runTask({
      repoFullName: "owner/repo",
      command: "do",
      tgChatId: "-100",
      tgThreadId: 7777,
    });
    expect(r1).toBeNull();
    expect(r2).not.toBeNull();
    expect(r2!.reason).toContain("already has");
  });

  it("uses baseBranch as ref when headBranch is not set", () => {
    mockExecSync.mockReturnValue("");

    runTask({
      repoFullName: "owner/repo",
      prNumber: 302,
      command: "review",
      // no headBranch
    });

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("origin/main"),
      expect.any(Object)
    );
  });

  it("uses group dir override when tgChatId is set", async () => {
    const config = await import("../config");
    vi.mocked(config.getGroupDir).mockReturnValueOnce("/custom/group/dir");

    const result = runTask({
      repoFullName: "owner/repo",
      prNumber: 303,
      command: "review",
      headBranch: "feat/303",
      tgChatId: "-100",
    });

    expect(result).toBeNull();
    expect(config.getGroupDir).toHaveBeenCalledWith("-100", "owner/repo");
  });

  it("uses codex CLI when provider is codex", async () => {
    const config = await import("../config");
    vi.mocked(config.getProvider).mockReturnValueOnce("codex");

    const result = runTask({
      repoFullName: "owner/repo",
      prNumber: 304,
      command: "review",
      headBranch: "feat/304",
      tgChatId: "-100",
    });

    expect(result).toBeNull();

    // Flush microtasks so spawnTaskProcess's async awaits (getInstallationToken,
    // loadTaskContext) complete before we inspect mockSpawn.mock.calls
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const spawnCalls = mockSpawn.mock.calls as Array<[string, string[], { env: Record<string, string | undefined> }]>;
    const codexCall = spawnCalls.find(([bin]) => bin === "codex");
    expect(codexCall).toBeDefined();
    const [, args, options] = codexCall!;
    expect(args).toEqual(["exec", "--dangerously-bypass-approvals-and-sandbox", "-"]);

    expect(options.env.CLAUDECODE).toBeUndefined();
    expect(options.env.IS_SANDBOX).toBeUndefined();
  });

  it("rejects update when other tasks are active", () => {
    // Start a review task
    const r1 = runTask({
      repoFullName: "owner/repo",
      prNumber: 200,
      command: "review",
      headBranch: "feat/test",
    });
    expect(r1).toBeNull();

    // Try to update — should be rejected
    const r2 = runTask({
      repoFullName: "owner/repo",
      command: "update",
      tgChatId: "-100",
      tgThreadId: 1,
    });
    expect(r2).not.toBeNull();
    expect(r2!.reason).toContain("Cannot update");
    expect(r2!.reason).toContain("still running");
  });

  it("rejects new tasks when update is in progress", () => {
    // Start an update task
    const r1 = runTask({
      repoFullName: "owner/repo",
      command: "update",
      tgChatId: "-100",
      tgThreadId: 2,
    });
    expect(r1).toBeNull();

    // Try to start a review — should be rejected
    const r2 = runTask({
      repoFullName: "owner/repo",
      prNumber: 201,
      command: "review",
      headBranch: "feat/test",
    });
    expect(r2).not.toBeNull();
    expect(r2!.reason).toContain("update is in progress");
  });

  // Helper: flush async microtasks so spawnTaskProcess awaits complete
  async function flushMicrotasks(count = 5) {
    for (let i = 0; i < count; i++) await Promise.resolve();
  }

  it("skips sendOutputToTG for successful PR-bound review tasks (prevents 消息串)", async () => {
    runTask({
      repoFullName: "owner/repo",
      prNumber: 400,
      command: "review",
      headBranch: "feat/400",
      tgChatId: "-100",
      tgThreadId: 4000,
    });

    // Wait for spawnTaskProcess async init to complete and spawn to be called
    await flushMicrotasks();

    const child = mockSpawn.mock.results.at(-1)?.value;
    expect(child).toBeDefined();

    // Simulate review skill Step 7: stdout marker output after posting PR comment
    child.stdout.emit("data", Buffer.from("REVIEW_STATUS: approved\n"));

    // Simulate successful close
    child.emit("close", 0);
    await flushMicrotasks();

    // sendOutputToTG must NOT be called: review result synced via GitHub comment
    expect(mockSendOutputToTG).not.toHaveBeenCalled();
    // notifyTaskComplete should still be called (it's the task completion notice)
    expect(mockNotifyTaskComplete).toHaveBeenCalledWith("owner/repo", 400, "review", true, expect.any(String));
  });

  it("sends output via sendOutputToTG when PR-bound review fails", async () => {
    runTask({
      repoFullName: "owner/repo",
      prNumber: 401,
      command: "review",
      headBranch: "feat/401",
      tgChatId: "-100",
      tgThreadId: 4001,
    });

    await flushMicrotasks();

    const child = mockSpawn.mock.results.at(-1)?.value;
    child.emit("close", 1); // non-zero exit
    await flushMicrotasks();

    // Failed review: Claude likely didn't post a comment, so output must be sent directly
    expect(mockSendOutputToTG).toHaveBeenCalled();
    // sendOutputToTG already sent a completion header — notifyTaskComplete must be skipped
    expect(mockNotifyTaskComplete).not.toHaveBeenCalled();
  });

  it("sends output via sendOutputToTG for successful PR-bound review when no comment was synced", async () => {
    // Simulate: Claude did not post a PR comment (e.g. PR already merged/closed),
    // so no REVIEW_STATUS marker appears in stdout. Output must be sent directly to TG.

    runTask({
      repoFullName: "owner/repo",
      prNumber: 403,
      command: "review",
      headBranch: "feat/403",
      tgChatId: "-100",
      tgThreadId: 4003,
    });

    await flushMicrotasks();

    const child = mockSpawn.mock.results.at(-1)?.value;
    expect(child).toBeDefined();

    child.emit("close", 0);
    await flushMicrotasks();

    // No new comment was synced → output must be sent directly to TG for user feedback
    expect(mockSendOutputToTG).toHaveBeenCalled();
    // sendOutputToTG already sent a completion header — notifyTaskComplete must be skipped
    expect(mockNotifyTaskComplete).not.toHaveBeenCalled();
  });

  it("skips sendOutputToTG for successful PR-bound fix tasks (prevents 消息串)", async () => {
    // fix SKILL.md instructs Claude to post a PR comment after fixing. That comment is
    // synced to TG via syncGitHubCommentToTG (GitHub webhook → TG). Sending raw stdout
    // here would produce a duplicate message in the same TG topic.
    runTask({
      repoFullName: "owner/repo",
      prNumber: 402,
      command: "fix",
      headBranch: "feat/402",
      tgChatId: "-100",
      tgThreadId: 4002,
    });

    await flushMicrotasks();

    const child = mockSpawn.mock.results.at(-1)?.value;
    // Simulate fix skill Output section: stdout marker output after posting PR comment
    child.stdout.emit("data", Buffer.from("FIX_COMMENT_POSTED\n"));
    child.emit("close", 0);
    await flushMicrotasks();

    expect(mockSendOutputToTG).not.toHaveBeenCalled();
  });

  it("skips synchronous handleTopicRename when xAI IIFE is launched (race condition fix)", async () => {
    // When handlePRBinding finds a PR and launches the xAI IIFE,
    // handleTopicRename must NOT fire — otherwise it overwrites the xAI title.
    mockFindPRByThread.mockReturnValue(99);

    runTask({
      repoFullName: "owner/repo",
      command: "do",
      tgChatId: "-100",
      tgThreadId: 5000,
      userInput: "fix the auth bug",
    });

    await flushMicrotasks();

    const child = mockSpawn.mock.results.at(-1)?.value;
    expect(child).toBeDefined();

    // Simulate successful close
    child.emit("close", 0);
    await flushMicrotasks();

    const tgClient = await import("../telegram/client");
    const editCalls = vi.mocked(tgClient.editForumTopicIcon).mock.calls;

    // The "running" emoji call at task start is expected (line 148 in process.ts).
    // But the synchronous handleTopicRename call (which would use the raw fallback
    // title like "#99 fix the auth bug") must NOT appear — only the xAI IIFE
    // should rename the topic after it resolves.
    const syncRenameCalls = editCalls.filter(
      ([, , name]) => typeof name === "string" && name.startsWith("#99 fix the auth bug")
    );
    expect(syncRenameCalls).toHaveLength(0);

    mockFindPRByThread.mockReturnValue(null);
  });

  it("calls handleTopicRename normally when no PR is found (xAI not launched)", async () => {
    mockFindPRByThread.mockReturnValue(null);

    runTask({
      repoFullName: "owner/repo",
      command: "do",
      tgChatId: "-100",
      tgThreadId: 5001,
      userInput: "add feature",
    });

    await flushMicrotasks();

    const child = mockSpawn.mock.results.at(-1)?.value;
    child.emit("close", 0);
    await flushMicrotasks();

    const tgClient = await import("../telegram/client");
    const editCalls = vi.mocked(tgClient.editForumTopicIcon).mock.calls;

    // handleTopicRename should have been called with the base topic title
    const renameCalls = editCalls.filter(
      ([, , name]) => typeof name === "string" && name.includes("add feature")
    );
    expect(renameCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("sends output via sendOutputToTG for standalone review tasks (no prNumber)", async () => {
    runTask({
      repoFullName: "owner/repo",
      command: "review",
      tgChatId: "-100",
      tgThreadId: 4003,
    });

    await flushMicrotasks();

    const child = mockSpawn.mock.results.at(-1)?.value;
    child.emit("close", 0);
    await flushMicrotasks();

    // Standalone tasks (no prNumber) always use sendOutputToTG as primary channel
    expect(mockSendOutputToTG).toHaveBeenCalled();
  });
});

describe("registerCallbackId / resolveCallbackId", () => {
  beforeEach(() => {
    _resetActiveTasks(); // also clears callback mappings
  });

  it("returns a short ID containing a process-level prefix", () => {
    const id = registerCallbackId("owner/repo#42:review");
    // Format: "<processToken>_<seq>" — must contain an underscore separator
    expect(id).toMatch(/^[a-z0-9]+_\d+$/);
  });

  it("resolves a registered short ID back to the full key", () => {
    const id = registerCallbackId("owner/repo#42:review");
    expect(resolveCallbackId(id)).toBe("owner/repo#42:review");
  });

  it("returns null for an unregistered short ID", () => {
    expect(resolveCallbackId("nonexistent_99")).toBeNull();
  });

  it("is idempotent — same fullKey returns the same shortId", () => {
    const id1 = registerCallbackId("owner/repo#10:fix");
    const id2 = registerCallbackId("owner/repo#10:fix");
    expect(id1).toBe(id2);
  });

  it("assigns distinct IDs to different keys", () => {
    const id1 = registerCallbackId("owner/repo#1:review");
    const id2 = registerCallbackId("owner/repo#2:review");
    expect(id1).not.toBe(id2);
  });

  it("increments the sequence number for successive registrations", () => {
    const id1 = registerCallbackId("owner/repo#A:review");
    const id2 = registerCallbackId("owner/repo#B:review");
    const seq1 = Number(id1.split("_")[1]);
    const seq2 = Number(id2.split("_")[1]);
    expect(seq2).toBe(seq1 + 1);
  });

  it("clears all mappings on _resetActiveTasks", () => {
    const id = registerCallbackId("owner/repo#99:fix");
    _resetActiveTasks();
    expect(resolveCallbackId(id)).toBeNull();
  });
});
