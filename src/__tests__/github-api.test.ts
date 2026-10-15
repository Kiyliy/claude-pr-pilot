import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock auth module
vi.mock("../github/auth", () => ({
  getInstallationToken: vi.fn().mockResolvedValue("mock-token"),
}));

vi.mock("../utils/logger", () => ({
  log: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { listOpenPRs, getPR, getPRComments, getIssueComments, postPRComment } = await import("../github/api");

describe("GitHub API", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("listOpenPRs", () => {
    it("returns parsed PR list", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          {
            number: 1,
            title: "Test PR",
            user: { login: "author" },
            head: { ref: "feat/test" },
            base: { ref: "main" },
            draft: false,
          },
          {
            number: 2,
            title: "Draft PR",
            user: null,
            head: { ref: "feat/draft" },
            base: { ref: "main" },
            draft: true,
          },
        ],
      });

      const prs = await listOpenPRs(12345, "owner/repo");
      expect(prs).toHaveLength(2);
      expect(prs[0]).toEqual({
        number: 1,
        title: "Test PR",
        author: "author",
        headBranch: "feat/test",
        baseBranch: "main",
        draft: false,
      });
      expect(prs[1].author).toBe("unknown");
      expect(prs[1].draft).toBe(true);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/repos/owner/repo/pulls"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer mock-token",
          }),
        })
      );
    });

    it("returns empty array when no PRs", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [],
      });

      const prs = await listOpenPRs(12345, "owner/repo");
      expect(prs).toHaveLength(0);
    });

    it("throws on API error", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      await expect(listOpenPRs(12345, "owner/repo")).rejects.toThrow("GitHub API");
    });

    it("handles missing head/base refs gracefully", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          {
            number: 3,
            title: "Weird PR",
            user: { login: "dev" },
            head: null,
            base: null,
            draft: undefined,
          },
        ],
      });

      const prs = await listOpenPRs(12345, "owner/repo");
      expect(prs[0].headBranch).toBe("");
      expect(prs[0].baseBranch).toBe("");
      expect(prs[0].draft).toBe(false);
    });
  });

  describe("getPR", () => {
    it("returns parsed PR info", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          number: 42,
          title: "Some PR",
          user: { login: "dev" },
          head: { ref: "feature" },
          base: { ref: "main" },
          draft: false,
        }),
      });

      const pr = await getPR(12345, "owner/repo", 42);
      expect(pr).not.toBeNull();
      expect(pr!.number).toBe(42);
      expect(pr!.author).toBe("dev");
      expect(pr!.headBranch).toBe("feature");
    });

    it("returns null on error", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "Not Found",
      });

      const pr = await getPR(12345, "owner/repo", 999);
      expect(pr).toBeNull();
    });

    it("returns null on network error", async () => {
      mockFetch.mockRejectedValue(new Error("network error"));

      const pr = await getPR(12345, "owner/repo", 999);
      expect(pr).toBeNull();
    });

    it("uses correct endpoint for specific PR", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          number: 10,
          title: "PR",
          user: { login: "dev" },
          head: { ref: "b" },
          base: { ref: "main" },
          draft: false,
        }),
      });

      await getPR(12345, "owner/repo", 10);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/repos/owner/repo/pulls/10"),
        expect.any(Object)
      );
    });
  });

  describe("getPRComments", () => {
    it("returns parsed comments", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          {
            id: 1,
            user: { login: "reviewer" },
            body: "LGTM",
            created_at: "2024-01-01T00:00:00Z",
          },
          {
            id: 2,
            user: null,
            body: "",
            created_at: "2024-01-02T00:00:00Z",
          },
        ],
      });

      const comments = await getPRComments(12345, "owner/repo", 1);
      expect(comments).toHaveLength(2);
      expect(comments[0]).toEqual({
        id: 1,
        author: "reviewer",
        body: "LGTM",
        createdAt: "2024-01-01T00:00:00Z",
      });
      expect(comments[1].author).toBe("unknown");
      expect(comments[1].body).toBe("");
    });

    it("returns empty array for PR with no comments", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [],
      });

      const comments = await getPRComments(12345, "owner/repo", 1);
      expect(comments).toHaveLength(0);
    });

    it("uses issues endpoint (not pulls) for comments", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [],
      });

      await getPRComments(12345, "owner/repo", 42);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/repos/owner/repo/issues/42/comments"),
        expect.any(Object)
      );
    });

    it("paginates through all pages when response has 100 items", async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        user: { login: `user${i}` },
        body: `comment ${i}`,
        created_at: "2024-01-01T00:00:00Z",
      }));
      const page2 = [{ id: 101, user: { login: "last" }, body: "last comment", created_at: "2024-01-02T00:00:00Z" }];

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => page1 })
        .mockResolvedValueOnce({ ok: true, json: async () => page2 });

      const comments = await getPRComments(12345, "owner/repo", 1);
      expect(comments).toHaveLength(101);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(1,
        expect.stringContaining("page=1"),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenNthCalledWith(2,
        expect.stringContaining("page=2"),
        expect.any(Object)
      );
    });
  });

  describe("getIssueComments", () => {
    it("returns parsed issue comments", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          {
            id: 10,
            user: { login: "commenter" },
            body: "Issue comment body",
            created_at: "2024-06-01T00:00:00Z",
          },
        ],
      });

      const comments = await getIssueComments(12345, "owner/repo", 5);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toEqual({
        id: 10,
        author: "commenter",
        body: "Issue comment body",
        createdAt: "2024-06-01T00:00:00Z",
      });
    });

    it("uses correct endpoint for issue comments", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [],
      });

      await getIssueComments(12345, "owner/repo", 7);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/repos/owner/repo/issues/7/comments"),
        expect.any(Object)
      );
    });

    it("throws on API error", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "Not Found",
      });

      await expect(getIssueComments(12345, "owner/repo", 999)).rejects.toThrow("GitHub API");
    });
  });

  describe("postPRComment", () => {
    it("posts a comment and returns id", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ id: 999 }),
      });

      const result = await postPRComment(12345, "owner/repo", 1, "test comment");
      expect(result).toEqual({ id: 999 });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/repos/owner/repo/issues/1/comments"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ body: "test comment" }),
        })
      );
    });

    it("throws on API error", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => "Forbidden",
      });

      await expect(postPRComment(12345, "owner/repo", 1, "test")).rejects.toThrow("GitHub API");
    });

    it("sends Content-Type header for POST", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ id: 1 }),
      });

      await postPRComment(12345, "owner/repo", 1, "msg");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        })
      );
    });

    it("includes error details in thrown message", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => "Validation Failed: body is too short",
      });

      await expect(postPRComment(12345, "owner/repo", 1, "")).rejects.toThrow("422");
      await expect(postPRComment(12345, "owner/repo", 1, "")).rejects.toThrow("Validation Failed");
    });
  });
});
