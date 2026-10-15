import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config", () => ({
  BOT_LOGIN: "mikoto-devs[bot]",
  MENTION_PATTERN: /@mikoto(-devs)?/i,
}));

vi.mock("../utils/logger", () => ({
  log: vi.fn(),
}));

vi.mock("../github/api", () => ({
  getPRComments: vi.fn(),
}));

const ghApi = await import("../github/api");
const { loadBotContext } = await import("../review/context");

describe("loadBotContext", () => {
  beforeEach(() => {
    vi.mocked(ghApi.getPRComments).mockReset();
  });

  it("returns null when no relevant comments", async () => {
    vi.mocked(ghApi.getPRComments).mockResolvedValue([
      { id: 1, author: "random-user", body: "Nice PR!", createdAt: "2024-01-01T00:00:00Z" },
    ]);

    const result = await loadBotContext("owner/repo", 1, 12345);
    expect(result).toBeNull();
  });

  it("includes bot comments", async () => {
    vi.mocked(ghApi.getPRComments).mockResolvedValue([
      {
        id: 1,
        author: "mikoto-devs[bot]",
        body: "## Review\nLGTM",
        createdAt: "2024-01-01T10:00:00Z",
      },
    ]);

    const result = await loadBotContext("owner/repo", 1, 12345);
    expect(result).not.toBeNull();
    expect(result).toContain("Your review");
    expect(result).toContain("## Review\nLGTM");
  });

  it("includes mention comments", async () => {
    vi.mocked(ghApi.getPRComments).mockResolvedValue([
      {
        id: 2,
        author: "developer",
        body: "@mikoto-devs please review this",
        createdAt: "2024-01-01T11:00:00Z",
      },
    ]);

    const result = await loadBotContext("owner/repo", 1, 12345);
    expect(result).not.toBeNull();
    expect(result).toContain("developer (to you)");
  });

  it("includes both bot and mention comments in order", async () => {
    vi.mocked(ghApi.getPRComments).mockResolvedValue([
      {
        id: 1,
        author: "mikoto-devs[bot]",
        body: "First review",
        createdAt: "2024-01-01T10:00:00Z",
      },
      {
        id: 2,
        author: "dev",
        body: "@mikoto fix this",
        createdAt: "2024-01-01T11:00:00Z",
      },
      {
        id: 3,
        author: "other",
        body: "Random comment",
        createdAt: "2024-01-01T12:00:00Z",
      },
    ]);

    const result = await loadBotContext("owner/repo", 1, 12345);
    expect(result).not.toBeNull();
    expect(result).toContain("First review");
    expect(result).toContain("@mikoto fix this");
    expect(result).not.toContain("Random comment");
    expect(result).toContain("Conversation History");
  });

  it("returns null on API error", async () => {
    vi.mocked(ghApi.getPRComments).mockRejectedValue(new Error("API fail"));

    const result = await loadBotContext("owner/repo", 1, 12345);
    expect(result).toBeNull();
  });
});
