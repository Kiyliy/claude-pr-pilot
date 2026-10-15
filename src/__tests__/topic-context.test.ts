import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/logger", () => ({
  log: vi.fn(),
}));

vi.mock("../store/db", () => ({
  addTopicMessage: vi.fn(),
  getTopicMessages: vi.fn(),
}));

vi.mock("../review/context", () => ({
  loadBotContext: vi.fn(),
}));

vi.mock("../config", () => ({
  BOT_LOGIN: "mikoto-devs[bot]",
  MENTION_PATTERN: /@mikoto(-devs)?/i,
}));

const store = await import("../store/db");
const context = await import("../review/context");
const {
  recordUserMessage,
  recordCommand,
  recordAssistantOutput,
  loadTaskContext,
} = await import("../review/topic-context");

describe("recording functions", () => {
  beforeEach(() => {
    vi.mocked(store.addTopicMessage).mockReset();
  });

  it("recordUserMessage stores user message", () => {
    recordUserMessage("-100", 123, "hello world", "user1");
    expect(store.addTopicMessage).toHaveBeenCalledWith("-100", 123, "user", "hello world", "user1");
  });

  it("recordCommand stores command message", () => {
    recordCommand("-100", 123, "/do fix the bug", "user1");
    expect(store.addTopicMessage).toHaveBeenCalledWith("-100", 123, "command", "/do fix the bug", "user1");
  });

  it("recordAssistantOutput stores assistant output", () => {
    recordAssistantOutput("-100", 123, "Task completed");
    expect(store.addTopicMessage).toHaveBeenCalledWith("-100", 123, "assistant", "Task completed", "claude");
  });

  it("recordAssistantOutput truncates long output", () => {
    const longOutput = "x".repeat(10000);
    recordAssistantOutput("-100", 123, longOutput);
    const stored = vi.mocked(store.addTopicMessage).mock.calls[0][3];
    expect(stored.length).toBe(8000);
  });
});

describe("loadTaskContext", () => {
  beforeEach(() => {
    vi.mocked(context.loadBotContext).mockReset();
    vi.mocked(store.getTopicMessages).mockReset();
  });

  it("loads PR context via loadBotContext when PR-bound with installationId", async () => {
    vi.mocked(context.loadBotContext).mockResolvedValue("## PR Context");

    const result = await loadTaskContext(
      { repoFullName: "owner/repo", prNumber: 1, tgChatId: "-100", tgThreadId: 123 },
      12345
    );
    expect(result).toBe("## PR Context");
    expect(context.loadBotContext).toHaveBeenCalledWith("owner/repo", 1, 12345);
  });

  it("falls back to topic history when PR context is null", async () => {
    vi.mocked(context.loadBotContext).mockResolvedValue(null);
    vi.mocked(store.getTopicMessages).mockReturnValue([
      { role: "user", author: "dev", content: "test message", createdAt: "2024-01-01" },
    ]);

    const result = await loadTaskContext(
      { repoFullName: "owner/repo", prNumber: 1, tgChatId: "-100", tgThreadId: 123 },
      12345
    );
    expect(result).toContain("Conversation History");
    expect(result).toContain("test message");
  });

  it("loads topic history for standalone tasks", async () => {
    vi.mocked(store.getTopicMessages).mockReturnValue([
      { role: "command", author: "user1", content: "/do fix bug", createdAt: "2024-01-01" },
      { role: "assistant", author: "claude", content: "Fixed!", createdAt: "2024-01-01" },
    ]);

    const result = await loadTaskContext(
      { repoFullName: "owner/repo", tgChatId: "-100", tgThreadId: 456 }
    );
    expect(result).toContain("User command");
    expect(result).toContain("/do fix bug");
    expect(result).toContain("Assistant (previous output)");
    expect(result).toContain("Fixed!");
  });

  it("returns null when no context available", async () => {
    const result = await loadTaskContext(
      { repoFullName: "owner/repo" }
    );
    expect(result).toBeNull();
  });

  it("returns null when topic has no messages", async () => {
    vi.mocked(store.getTopicMessages).mockReturnValue([]);

    const result = await loadTaskContext(
      { repoFullName: "owner/repo", tgChatId: "-100", tgThreadId: 789 }
    );
    expect(result).toBeNull();
  });
});
