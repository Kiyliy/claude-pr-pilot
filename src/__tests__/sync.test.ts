import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/logger", () => ({
  log: vi.fn(),
}));

const mockGroups: Record<string, any> = {
  "-100": {
    repo: "owner/repo",
    name: "Test",
    syncPR: true,
  },
  "-200": {
    repo: "owner/repo",
    name: "Ops",
    syncPR: false,
  },
  "-300": {
    repo: "other/repo",
    name: "Other",
    syncPR: true,
  },
};

vi.mock("../config", () => ({
  TELEGRAM_CONFIG: {
    botToken: "test-token",
    adminUsers: [111],
    groups: mockGroups,
  },
  REPOS: {
    "owner/repo": {
      dir: "/tmp/repo",
      commands: {},
      installationId: 12345,
    },
    "other/repo": {
      dir: "/tmp/other",
      commands: {},
      installationId: 67890,
    },
  },
  BOT_LOGIN: "mikoto-devs[bot]",
  isSyncPREnabled: vi.fn((chatId: string) => chatId !== "-200"),
  getGroupsByRepo: vi.fn((repo: string) =>
    Object.entries(mockGroups).filter(([, g]: [string, any]) => g.repo === repo)
  ),
}));

vi.mock("../telegram/client", () => ({
  sendMessage: vi.fn().mockResolvedValue({ message_id: 7777 }),
  sendLongMessage: vi.fn().mockResolvedValue({ message_id: 7777 }),
  sendInlineKeyboard: vi.fn().mockResolvedValue({ message_id: 7778 }),
  sanitizeHtml: vi.fn((x: string) => x),
  formatCommentForTG: vi.fn(() => "<b>formatted</b>"),
  editForumTopicName: vi.fn().mockResolvedValue(undefined),
  editForumTopicIcon: vi.fn().mockResolvedValue(undefined),
  markdownToTelegramHtml: vi.fn((x: string) => x),
  splitHtmlSafe: vi.fn((x: string) => [x]),
}));

vi.mock("../store/db", () => ({
  getTopicThread: vi.fn(),
  getTopicBaseTitle: vi.fn(),
  getMessageRef: vi.fn(),
  setMessageRef: vi.fn(),
  findPRByThread: vi.fn(),
  addTopicMessage: vi.fn(),
}));

vi.mock("../github/api", () => ({
  postPRComment: vi.fn().mockResolvedValue({ id: 8888 }),
  getPRBody: vi.fn().mockResolvedValue("## PR body content\n\nSome details"),
}));

vi.mock("../telegram/auth", () => ({
  isAllowed: vi.fn(() => true),
}));

vi.mock("../review/topic-context", () => ({
  recordAssistantOutput: vi.fn(),
}));

const tg = await import("../telegram/client");
const store = await import("../store/db");
const ghApi = await import("../github/api");
const tgAuth = await import("../telegram/auth");
const topicContext = await import("../review/topic-context");
const { isCommentVisible, syncGitHubCommentToTG, syncTGMessageToGitHub } = await import("../telegram/sync-github");
const { notifyTaskStart, notifyTaskComplete, sendOutputToTG, sendPRBodyToTG } = await import("../telegram/notifications");

// Convenience typed refs for mocks added in this test file
const mockEditForumTopicName = vi.mocked(tg.editForumTopicName);
const mockEditForumTopicIcon = vi.mocked(tg.editForumTopicIcon);

describe("isCommentVisible", () => {
  it("returns true for our bot", () => {
    expect(isCommentVisible("mikoto-devs[bot]")).toBe(true);
  });

  it("returns false for other bots", () => {
    expect(isCommentVisible("gemini-code-assist[bot]")).toBe(false);
    expect(isCommentVisible("dependabot[bot]")).toBe(false);
  });

  it("returns true for humans", () => {
    expect(isCommentVisible("developer")).toBe(true);
    expect(isCommentVisible("reviewer")).toBe(true);
  });

  it("returns false for github-actions bot", () => {
    expect(isCommentVisible("github-actions[bot]")).toBe(false);
  });

  it("returns true for usernames containing 'bot' but not ending with [bot]", () => {
    expect(isCommentVisible("robotman")).toBe(true);
    expect(isCommentVisible("botfixer")).toBe(true);
  });

  it("returns true for empty string (edge case)", () => {
    // empty string doesn't end with [bot]
    expect(isCommentVisible("")).toBe(true);
  });
});

describe("syncGitHubCommentToTG", () => {
  beforeEach(() => {
    vi.mocked(tg.sendMessage).mockReset().mockResolvedValue({ message_id: 7777 });
    vi.mocked(tg.sendLongMessage).mockReset().mockResolvedValue({ message_id: 7777 });
    vi.mocked(store.getTopicThread).mockReset();
    vi.mocked(store.getMessageRef).mockReset().mockReturnValue(null);
    vi.mocked(store.setMessageRef).mockReset();
  });

  it("syncs a new comment to TG topic", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(1001);

    await syncGitHubCommentToTG("owner/repo", 42, {
      id: 100,
      author: "developer",
      body: "LGTM",
      createdAt: "2024-01-01T00:00:00Z",
    });

    expect(tg.sendLongMessage).toHaveBeenCalled();
    expect(store.setMessageRef).toHaveBeenCalled();
  });

  it("skips TG-sync-marked comments (anti-loop)", async () => {
    await syncGitHubCommentToTG("owner/repo", 42, {
      id: 101,
      author: "developer",
      body: "message <!-- tg-sync -->",
      createdAt: "2024-01-01T00:00:00Z",
    });

    expect(tg.sendLongMessage).not.toHaveBeenCalled();
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("skips other bot comments", async () => {
    await syncGitHubCommentToTG("owner/repo", 42, {
      id: 102,
      author: "dependabot[bot]",
      body: "Bump version",
      createdAt: "2024-01-01T00:00:00Z",
    });

    expect(tg.sendLongMessage).not.toHaveBeenCalled();
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("skips when no TG topic found", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(null);

    await syncGitHubCommentToTG("owner/repo", 42, {
      id: 103,
      author: "developer",
      body: "test",
      createdAt: "2024-01-01T00:00:00Z",
    });

    expect(tg.sendLongMessage).not.toHaveBeenCalled();
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("skips already synced comments", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(1001);
    vi.mocked(store.getMessageRef).mockReturnValue({
      chatId: "-100",
      threadId: 1001,
      messageId: 5555,
    });

    await syncGitHubCommentToTG("owner/repo", 42, {
      id: 104,
      author: "developer",
      body: "test",
      createdAt: "2024-01-01T00:00:00Z",
    });

    expect(tg.sendLongMessage).not.toHaveBeenCalled();
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("skips groups with syncPR disabled", async () => {
    // Only group "-200" has syncPR: false, which is handled by isSyncPREnabled mock
    // "-100" should still work
    vi.mocked(store.getTopicThread).mockReturnValue(1001);

    await syncGitHubCommentToTG("owner/repo", 42, {
      id: 105,
      author: "developer",
      body: "test",
      createdAt: "2024-01-01T00:00:00Z",
    });

    // Should only attempt for "-100" group
    expect(tg.sendLongMessage).toHaveBeenCalledTimes(1);
  });

  it("allows our bot's own comments through", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(1001);

    await syncGitHubCommentToTG("owner/repo", 42, {
      id: 106,
      author: "mikoto-devs[bot]",
      body: "Review completed",
      createdAt: "2024-01-01T00:00:00Z",
    });

    expect(tg.sendLongMessage).toHaveBeenCalled();
  });

  it("does not sync for non-matching repo groups", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(1001);

    await syncGitHubCommentToTG("unknown/repo", 42, {
      id: 107,
      author: "developer",
      body: "test",
      createdAt: "2024-01-01T00:00:00Z",
    });

    expect(tg.sendLongMessage).not.toHaveBeenCalled();
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("handles sendMessage error gracefully", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(1001);
    vi.mocked(tg.sendLongMessage).mockRejectedValueOnce(new Error("TG API error"));

    // Should not throw
    await syncGitHubCommentToTG("owner/repo", 42, {
      id: 108,
      author: "developer",
      body: "test",
      createdAt: "2024-01-01T00:00:00Z",
    });

    expect(store.setMessageRef).not.toHaveBeenCalled();
  });
});

describe("syncTGMessageToGitHub", () => {
  beforeEach(() => {
    vi.mocked(ghApi.postPRComment).mockReset().mockResolvedValue({ id: 8888 });
    vi.mocked(store.findPRByThread).mockReset();
    vi.mocked(store.setMessageRef).mockReset();
    vi.mocked(tgAuth.isAllowed).mockReturnValue(true);
  });

  it("syncs TG message to GitHub PR comment", async () => {
    vi.mocked(store.findPRByThread).mockReturnValue(42);

    await syncTGMessageToGitHub({
      message_id: 555,
      chat: { id: -100 },
      from: { id: 111, first_name: "Dev", username: "dev" },
      text: "Please fix this",
      message_thread_id: 1001,
    });

    expect(ghApi.postPRComment).toHaveBeenCalledWith(
      12345,
      "owner/repo",
      42,
      expect.stringContaining("Please fix this")
    );
    expect(store.setMessageRef).toHaveBeenCalled();
  });

  it("skips unauthorized users", async () => {
    vi.mocked(tgAuth.isAllowed).mockReturnValue(false);

    await syncTGMessageToGitHub({
      message_id: 555,
      chat: { id: -100 },
      from: { id: 999, username: "stranger" },
      text: "test",
      message_thread_id: 1001,
    });

    expect(ghApi.postPRComment).not.toHaveBeenCalled();
  });

  it("skips messages without thread", async () => {
    await syncTGMessageToGitHub({
      message_id: 555,
      chat: { id: -100 },
      from: { id: 111 },
      text: "test",
    });

    expect(ghApi.postPRComment).not.toHaveBeenCalled();
  });

  it("skips when topic not linked to PR", async () => {
    vi.mocked(store.findPRByThread).mockReturnValue(null);

    await syncTGMessageToGitHub({
      message_id: 555,
      chat: { id: -100 },
      from: { id: 111 },
      text: "test",
      message_thread_id: 1001,
    });

    expect(ghApi.postPRComment).not.toHaveBeenCalled();
  });

  it("skips empty messages", async () => {
    vi.mocked(store.findPRByThread).mockReturnValue(42);

    await syncTGMessageToGitHub({
      message_id: 555,
      chat: { id: -100 },
      from: { id: 111 },
      text: "",
      message_thread_id: 1001,
    });

    expect(ghApi.postPRComment).not.toHaveBeenCalled();
  });

  it("skips messages without from field", async () => {
    await syncTGMessageToGitHub({
      message_id: 555,
      chat: { id: -100 },
      text: "test",
      message_thread_id: 1001,
    });

    expect(ghApi.postPRComment).not.toHaveBeenCalled();
  });

  it("includes TG sync marker in posted comment", async () => {
    vi.mocked(store.findPRByThread).mockReturnValue(42);

    await syncTGMessageToGitHub({
      message_id: 555,
      chat: { id: -100 },
      from: { id: 111, first_name: "Dev", username: "dev" },
      text: "Fix the bug",
      message_thread_id: 1001,
    });

    expect(ghApi.postPRComment).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(String),
      expect.any(Number),
      expect.stringContaining("<!-- tg-sync -->")
    );
  });

  it("uses first_name in posted comment", async () => {
    vi.mocked(store.findPRByThread).mockReturnValue(42);

    await syncTGMessageToGitHub({
      message_id: 555,
      chat: { id: -100 },
      from: { id: 111, first_name: "John", username: "johndoe" },
      text: "test msg",
      message_thread_id: 1001,
    });

    expect(ghApi.postPRComment).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(String),
      expect.any(Number),
      expect.stringContaining("John")
    );
  });

  it("falls back to username when first_name is absent", async () => {
    vi.mocked(store.findPRByThread).mockReturnValue(42);

    await syncTGMessageToGitHub({
      message_id: 555,
      chat: { id: -100 },
      from: { id: 111, username: "dev_user" },
      text: "test msg",
      message_thread_id: 1001,
    });

    expect(ghApi.postPRComment).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(String),
      expect.any(Number),
      expect.stringContaining("dev_user")
    );
  });

  it("handles postPRComment error gracefully", async () => {
    vi.mocked(store.findPRByThread).mockReturnValue(42);
    vi.mocked(ghApi.postPRComment).mockRejectedValue(new Error("API error"));

    // Should not throw
    await syncTGMessageToGitHub({
      message_id: 555,
      chat: { id: -100 },
      from: { id: 111, first_name: "Dev" },
      text: "test",
      message_thread_id: 1001,
    });

    expect(store.setMessageRef).not.toHaveBeenCalled();
  });

  it("skips messages without text", async () => {
    vi.mocked(store.findPRByThread).mockReturnValue(42);

    await syncTGMessageToGitHub({
      message_id: 555,
      chat: { id: -100 },
      from: { id: 111 },
      message_thread_id: 1001,
      // no text field
    });

    expect(ghApi.postPRComment).not.toHaveBeenCalled();
  });
});

describe("notifyTaskStart", () => {
  beforeEach(() => {
    vi.mocked(tg.sendMessage).mockReset().mockResolvedValue({});
    mockEditForumTopicName.mockReset().mockResolvedValue(undefined);
    mockEditForumTopicIcon.mockReset().mockResolvedValue(undefined);
    vi.mocked(store.getTopicThread).mockReset();
    vi.mocked(store.getTopicBaseTitle).mockReset().mockReturnValue(null);
  });

  it("sends start notification to TG", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(1001);

    await notifyTaskStart("owner/repo", 42, "review");

    expect(tg.sendMessage).toHaveBeenCalledWith(
      "-100",
      expect.stringContaining("review"),
      expect.objectContaining({ threadId: 1001 })
    );
  });

  it("skips when no topic found", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(null);

    await notifyTaskStart("owner/repo", 42, "review");
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("uses correct emoji for different commands", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(1001);

    await notifyTaskStart("owner/repo", 42, "fix");
    expect(tg.sendMessage).toHaveBeenCalledWith(
      "-100",
      expect.stringContaining("🔨"),
      expect.any(Object)
    );

    vi.mocked(tg.sendMessage).mockClear();
    await notifyTaskStart("owner/repo", 42, "do");
    expect(tg.sendMessage).toHaveBeenCalledWith(
      "-100",
      expect.stringContaining("🔨"),
      expect.any(Object)
    );
  });

  it("renames topic with in-progress emoji when base_title is available", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(1001);
    vi.mocked(store.getTopicBaseTitle).mockReturnValue("#42 Fix login bug");

    await notifyTaskStart("owner/repo", 42, "fix");

    expect(mockEditForumTopicIcon).toHaveBeenCalledWith(
      "-100",
      1001,
      "#42 Fix login bug",
      "🔨"
    );
  });

  it("skips topic rename when base_title is absent", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(1001);
    vi.mocked(store.getTopicBaseTitle).mockReturnValue(null);

    await notifyTaskStart("owner/repo", 42, "review");

    expect(mockEditForumTopicIcon).not.toHaveBeenCalled();
  });

  it("handles sendMessage error gracefully", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(1001);
    vi.mocked(tg.sendMessage).mockRejectedValue(new Error("TG error"));

    // Should not throw
    await notifyTaskStart("owner/repo", 42, "review");
  });
});

describe("notifyTaskComplete", () => {
  beforeEach(() => {
    vi.mocked(tg.sendMessage).mockReset().mockResolvedValue({});
    vi.mocked(tg.sendInlineKeyboard).mockReset().mockResolvedValue({ message_id: 7778 });
    mockEditForumTopicName.mockReset().mockResolvedValue(undefined);
    mockEditForumTopicIcon.mockReset().mockResolvedValue(undefined);
    vi.mocked(store.getTopicThread).mockReset();
    vi.mocked(store.getTopicBaseTitle).mockReset().mockReturnValue(null);
  });

  it("sends success notification", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(1001);

    await notifyTaskComplete("owner/repo", 42, "review", true, "1m30s");

    expect(tg.sendMessage).toHaveBeenCalledWith(
      "-100",
      expect.stringContaining("completed"),
      expect.any(Object)
    );
  });

  it("sends failure notification", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(1001);

    await notifyTaskComplete("owner/repo", 42, "fix", false, "5s");

    expect(tg.sendMessage).toHaveBeenCalledWith(
      "-100",
      expect.stringContaining("failed"),
      expect.any(Object)
    );
  });

  it("includes elapsed time", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(1001);

    await notifyTaskComplete("owner/repo", 42, "review", true, "2m15s");

    expect(tg.sendMessage).toHaveBeenCalledWith(
      "-100",
      expect.stringContaining("2m15s"),
      expect.any(Object)
    );
  });

  it("skips when no topic found", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(null);

    await notifyTaskComplete("owner/repo", 42, "review", true, "1s");
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("renames topic with 👀 on success when base_title is available", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(1001);
    vi.mocked(store.getTopicBaseTitle).mockReturnValue("#42 Fix login bug");

    await notifyTaskComplete("owner/repo", 42, "review", true, "1m");

    expect(mockEditForumTopicIcon).toHaveBeenCalledWith(
      "-100",
      1001,
      "#42 Fix login bug",
      "👀"
    );
  });

  it("sends mark-as-read button on success", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(1001);
    vi.mocked(store.getTopicBaseTitle).mockReturnValue("#42 Fix login bug");

    await notifyTaskComplete("owner/repo", 42, "review", true, "1m");

    expect(tg.sendInlineKeyboard).toHaveBeenCalledWith(
      "-100",
      "👀 待查看",
      [[{ text: "✅ 标记已读", callbackData: "mark_read:-100:1001" }]],
      { threadId: 1001 },
    );
  });

  it("does not send mark-as-read button on failure", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(1001);
    vi.mocked(store.getTopicBaseTitle).mockReturnValue("#42 Fix login bug");

    await notifyTaskComplete("owner/repo", 42, "fix", false, "5s");

    expect(tg.sendInlineKeyboard).not.toHaveBeenCalled();
  });

  it("renames topic with ❌ on failure when base_title is available", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(1001);
    vi.mocked(store.getTopicBaseTitle).mockReturnValue("#42 Fix login bug");

    await notifyTaskComplete("owner/repo", 42, "fix", false, "5s");

    expect(mockEditForumTopicIcon).toHaveBeenCalledWith(
      "-100",
      1001,
      "#42 Fix login bug",
      "❌"
    );
  });

  it("skips topic rename when base_title is absent", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(1001);
    vi.mocked(store.getTopicBaseTitle).mockReturnValue(null);

    await notifyTaskComplete("owner/repo", 42, "review", true, "1s");

    expect(mockEditForumTopicIcon).not.toHaveBeenCalled();
  });

  it("handles sendMessage error gracefully", async () => {
    vi.mocked(store.getTopicThread).mockReturnValue(1001);
    vi.mocked(tg.sendMessage).mockRejectedValue(new Error("TG error"));

    // Should not throw
    await notifyTaskComplete("owner/repo", 42, "review", true, "1s");
  });
});

describe("sendOutputToTG", () => {
  beforeEach(() => {
    vi.mocked(tg.sendMessage).mockReset().mockResolvedValue({});
    vi.mocked(topicContext.recordAssistantOutput).mockReset();
  });

  it("sends output to TG when available", async () => {
    const chunks = [Buffer.from("Task output here")];

    await sendOutputToTG(
      { repoFullName: "owner/repo", command: "do", tgChatId: "-100", tgThreadId: 1001 },
      chunks,
      true,
      "30s"
    );

    expect(tg.sendMessage).toHaveBeenCalledTimes(2); // header + content
  });

  it("sends 'no output' message when empty", async () => {
    await sendOutputToTG(
      { repoFullName: "owner/repo", command: "do", tgChatId: "-100", tgThreadId: 1001 },
      [],
      true,
      "10s"
    );

    expect(tg.sendMessage).toHaveBeenCalledWith(
      "-100",
      expect.stringContaining("no output"),
      expect.any(Object)
    );
  });

  it("does nothing when no TG routing info", async () => {
    await sendOutputToTG(
      { repoFullName: "owner/repo", command: "review" },
      [Buffer.from("output")],
      true,
      "5s"
    );

    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("chunks long output", async () => {
    const longOutput = "x".repeat(8000);
    const chunks = [Buffer.from(longOutput)];

    await sendOutputToTG(
      { repoFullName: "owner/repo", command: "do", tgChatId: "-100", tgThreadId: 1001 },
      chunks,
      true,
      "1m"
    );

    // header + multiple content chunks
    expect(tg.sendMessage).toHaveBeenCalledTimes(4); // header + ceil(8000/3800) = 3 chunks
  });

  it("records assistant output in topic history", async () => {
    const chunks = [Buffer.from("Claude output")];

    await sendOutputToTG(
      { repoFullName: "owner/repo", command: "do", tgChatId: "-100", tgThreadId: 1001 },
      chunks,
      true,
      "30s"
    );

    expect(topicContext.recordAssistantOutput).toHaveBeenCalledWith("-100", 1001, "Claude output");
  });

  it("does not record empty output", async () => {
    await sendOutputToTG(
      { repoFullName: "owner/repo", command: "do", tgChatId: "-100", tgThreadId: 1001 },
      [],
      true,
      "10s"
    );

    expect(topicContext.recordAssistantOutput).not.toHaveBeenCalled();
  });

  it("truncates very long output (> MAX_CHUNK * 3)", async () => {
    const veryLongOutput = "y".repeat(3800 * 4); // exceeds 3 * MAX_CHUNK
    const chunks = [Buffer.from(veryLongOutput)];

    await sendOutputToTG(
      { repoFullName: "owner/repo", command: "do", tgChatId: "-100", tgThreadId: 1001 },
      chunks,
      true,
      "5m"
    );

    const calls = vi.mocked(tg.sendMessage).mock.calls;
    // header + content chunks
    expect(calls.length).toBeGreaterThan(1);
    // At least one content message must contain the truncation marker
    const allContent = calls.map((c) => String(c[1])).join("");
    expect(allContent).toContain("truncated");
  });

  it("shows success emoji for successful tasks", async () => {
    const chunks = [Buffer.from("output")];

    await sendOutputToTG(
      { repoFullName: "owner/repo", command: "do", tgChatId: "-100", tgThreadId: 1001 },
      chunks,
      true,
      "30s"
    );

    // First call is the header
    expect(tg.sendMessage).toHaveBeenCalledWith(
      "-100",
      expect.stringContaining("✅"),
      expect.any(Object)
    );
  });

  it("shows failure emoji for failed tasks", async () => {
    const chunks = [Buffer.from("error output")];

    await sendOutputToTG(
      { repoFullName: "owner/repo", command: "do", tgChatId: "-100", tgThreadId: 1001 },
      chunks,
      false,
      "30s"
    );

    expect(tg.sendMessage).toHaveBeenCalledWith(
      "-100",
      expect.stringContaining("❌"),
      expect.any(Object)
    );
  });

  it("does nothing when tgChatId is set but tgThreadId is missing", async () => {
    await sendOutputToTG(
      { repoFullName: "owner/repo", command: "do", tgChatId: "-100" },
      [Buffer.from("output")],
      true,
      "5s"
    );

    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("concatenates multiple stdout chunks", async () => {
    const chunks = [Buffer.from("part1"), Buffer.from(" part2"), Buffer.from(" part3")];

    await sendOutputToTG(
      { repoFullName: "owner/repo", command: "do", tgChatId: "-100", tgThreadId: 1001 },
      chunks,
      true,
      "30s"
    );

    expect(topicContext.recordAssistantOutput).toHaveBeenCalledWith("-100", 1001, "part1 part2 part3");
  });
});

describe("sendPRBodyToTG", () => {
  beforeEach(() => {
    vi.mocked(tg.sendMessage).mockReset().mockResolvedValue({ message_id: 7777 });
    vi.mocked(ghApi.getPRBody).mockReset().mockResolvedValue("## PR body\n\nDetails here");
    vi.mocked(tg.markdownToTelegramHtml).mockReset().mockImplementation((x: string) => x);
    vi.mocked(tg.splitHtmlSafe).mockReset().mockImplementation((x: string) => [x]);
    vi.mocked(topicContext.recordAssistantOutput).mockReset();
  });

  it("sends PR link header and fetched PR body to TG", async () => {
    await sendPRBodyToTG(
      { repoFullName: "owner/repo", command: "do", tgChatId: "-100", tgThreadId: 1001 },
      42,
      12345,
      "Claude output",
      "30s"
    );

    // Header message with PR link
    expect(tg.sendMessage).toHaveBeenCalledWith(
      "-100",
      expect.stringContaining("PR #42"),
      expect.objectContaining({ threadId: 1001 })
    );
    // PR body message
    expect(tg.sendMessage).toHaveBeenCalledWith(
      "-100",
      expect.stringContaining("PR body"),
      expect.objectContaining({ threadId: 1001 })
    );
    expect(ghApi.getPRBody).toHaveBeenCalledWith(12345, "owner/repo", 42);
  });

  it("records raw output in topic history", async () => {
    await sendPRBodyToTG(
      { repoFullName: "owner/repo", command: "do", tgChatId: "-100", tgThreadId: 1001 },
      42,
      12345,
      "Claude stdout output",
      "30s"
    );

    expect(topicContext.recordAssistantOutput).toHaveBeenCalledWith("-100", 1001, "Claude stdout output");
  });

  it("does not record empty raw output", async () => {
    await sendPRBodyToTG(
      { repoFullName: "owner/repo", command: "do", tgChatId: "-100", tgThreadId: 1001 },
      42,
      12345,
      "",
      "30s"
    );

    expect(topicContext.recordAssistantOutput).not.toHaveBeenCalled();
  });

  it("sends only header when no installationId", async () => {
    await sendPRBodyToTG(
      { repoFullName: "owner/repo", command: "do", tgChatId: "-100", tgThreadId: 1001 },
      42,
      undefined,
      "output",
      "30s"
    );

    expect(tg.sendMessage).toHaveBeenCalledTimes(1); // only header
    expect(ghApi.getPRBody).not.toHaveBeenCalled();
  });

  it("sends only header when PR body is null", async () => {
    vi.mocked(ghApi.getPRBody).mockResolvedValue(null);

    await sendPRBodyToTG(
      { repoFullName: "owner/repo", command: "do", tgChatId: "-100", tgThreadId: 1001 },
      42,
      12345,
      "output",
      "30s"
    );

    expect(tg.sendMessage).toHaveBeenCalledTimes(1); // only header
  });

  it("handles PR body fetch error gracefully", async () => {
    vi.mocked(ghApi.getPRBody).mockResolvedValue(null);

    // Should not throw
    await sendPRBodyToTG(
      { repoFullName: "owner/repo", command: "do", tgChatId: "-100", tgThreadId: 1001 },
      42,
      12345,
      "output",
      "30s"
    );

    expect(tg.sendMessage).toHaveBeenCalledTimes(1); // only header
  });

  it("does nothing when no TG routing info", async () => {
    await sendPRBodyToTG(
      { repoFullName: "owner/repo", command: "do" },
      42,
      12345,
      "output",
      "30s"
    );

    expect(tg.sendMessage).not.toHaveBeenCalled();
    expect(ghApi.getPRBody).not.toHaveBeenCalled();
  });

  it("includes PR URL in header", async () => {
    await sendPRBodyToTG(
      { repoFullName: "owner/repo", command: "do", tgChatId: "-100", tgThreadId: 1001 },
      42,
      12345,
      "output",
      "1m30s"
    );

    expect(tg.sendMessage).toHaveBeenCalledWith(
      "-100",
      expect.stringContaining("https://github.com/owner/repo/pull/42"),
      expect.any(Object)
    );
  });

  it("includes elapsed time in header", async () => {
    await sendPRBodyToTG(
      { repoFullName: "owner/repo", command: "do", tgChatId: "-100", tgThreadId: 1001 },
      42,
      12345,
      "output",
      "2m15s"
    );

    expect(tg.sendMessage).toHaveBeenCalledWith(
      "-100",
      expect.stringContaining("2m15s"),
      expect.any(Object)
    );
  });

  it("sends multiple chunks when splitHtmlSafe returns multiple", async () => {
    vi.mocked(tg.splitHtmlSafe).mockReturnValue(["chunk1", "chunk2", "chunk3"]);

    await sendPRBodyToTG(
      { repoFullName: "owner/repo", command: "do", tgChatId: "-100", tgThreadId: 1001 },
      42,
      12345,
      "output",
      "1m"
    );

    // header + 3 body chunks
    expect(tg.sendMessage).toHaveBeenCalledTimes(4);
  });
});
