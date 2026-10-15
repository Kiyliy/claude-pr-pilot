import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/logger", () => ({ log: vi.fn() }));

const mockGetRepoConfig = vi.fn();
const mockGetAutoverifyState = vi.fn();
const mockSetAutoverifyRounds = vi.fn();
const mockDeleteAutoverifyState = vi.fn();
const mockClearAllAutoverifyState = vi.fn();
const mockGetPRComments = vi.fn();
const mockPostPRComment = vi.fn();

vi.mock("../config", () => ({
  getRepoConfig: mockGetRepoConfig,
  BOT_LOGIN: "mikoto-devs[bot]",
}));

vi.mock("../store/db", () => ({
  getAutoverifyState: mockGetAutoverifyState,
  setAutoverifyRounds: mockSetAutoverifyRounds,
  deleteAutoverifyState: mockDeleteAutoverifyState,
  clearAllAutoverifyState: mockClearAllAutoverifyState,
}));

vi.mock("../github/api", () => ({
  getPRComments: mockGetPRComments,
  postPRComment: mockPostPRComment,
}));

const { maybeAutoVerify } = await import("../review/autoverify");

describe("maybeAutoVerify", () => {
  const task = {
    repoFullName: "owner/repo",
    prNumber: 42,
    headBranch: "feat/test",
    command: "verify" as const,
    verifyRound: 0,
  };

  const baseConfig = {
    dir: "/tmp",
    commands: {},
    installationId: 12345,
    autoVerify: true,
    maxAutoVerifyRounds: 3,
    autoMerge: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRepoConfig.mockReturnValue(baseConfig);
    mockGetPRComments.mockResolvedValue([]);
    mockPostPRComment.mockResolvedValue(undefined);
  });

  it("does nothing when prNumber is missing", async () => {
    await maybeAutoVerify({ ...task, prNumber: undefined }, "VERIFY_STATUS: passed");
    expect(mockPostPRComment).not.toHaveBeenCalled();
    expect(mockDeleteAutoverifyState).not.toHaveBeenCalled();
  });

  it("does nothing when repo config not found", async () => {
    mockGetRepoConfig.mockReturnValue(null);
    await maybeAutoVerify(task, "VERIFY_STATUS: passed");
    expect(mockPostPRComment).not.toHaveBeenCalled();
  });

  it("deletes state and does NOT post status when verify passes at round=0", async () => {
    await maybeAutoVerify(task, "VERIFY_STATUS: passed");
    expect(mockDeleteAutoverifyState).toHaveBeenCalledWith("owner/repo#42");
    expect(mockPostPRComment).not.toHaveBeenCalled();
  });

  it("posts cycle complete when verify passes at round>0", async () => {
    await maybeAutoVerify({ ...task, verifyRound: 2 }, "VERIFY_STATUS: passed");
    expect(mockDeleteAutoverifyState).toHaveBeenCalledWith("owner/repo#42");
    expect(mockPostPRComment).toHaveBeenCalledWith(
      12345, "owner/repo", 42, expect.stringContaining("Product verification passed")
    );
  });

  it("increments verifyRound and triggers fix on failure (round=0)", async () => {
    await maybeAutoVerify(task, "VERIFY_STATUS: needs_changes");
    expect(mockSetAutoverifyRounds).toHaveBeenCalledWith("owner/repo#42", 1);
    expect(mockPostPRComment).toHaveBeenCalledWith(
      12345, "owner/repo", 42,
      expect.stringContaining("autofix:command=fix,round=1")
    );
  });

  it("stops and warns when nextRound exceeds maxAutoVerifyRounds", async () => {
    // verifyRound=3, maxRounds=3 → nextRound=4 > 3 → stop
    await maybeAutoVerify({ ...task, verifyRound: 3 }, "VERIFY_STATUS: needs_changes");
    expect(mockSetAutoverifyRounds).not.toHaveBeenCalled();
    expect(mockDeleteAutoverifyState).toHaveBeenCalledWith("owner/repo#42");
    expect(mockPostPRComment).toHaveBeenCalledWith(
      12345, "owner/repo", 42, expect.stringContaining("max rounds")
    );
  });

  it("reads verify result from last bot comment (preferred over stdout)", async () => {
    mockGetPRComments.mockResolvedValue([
      { author: "mikoto-devs[bot]", body: "## 🧪 PRODUCT VERIFY\n\nVERIFY_STATUS: passed" },
    ]);
    // stdout says needs_changes but bot comment says passed → passed wins
    await maybeAutoVerify({ ...task, verifyRound: 1 }, "VERIFY_STATUS: needs_changes");
    expect(mockDeleteAutoverifyState).toHaveBeenCalledWith("owner/repo#42");
    expect(mockSetAutoverifyRounds).not.toHaveBeenCalled();
  });

  it("reads verify result from bot comment Verdict pattern (no VERIFY_STATUS marker)", async () => {
    mockGetPRComments.mockResolvedValue([
      { author: "mikoto-devs[bot]", body: "## 🧪 PRODUCT VERIFY\n\n**Verdict:** ✅ Passed\n\n### Requirements\nAll good." },
    ]);
    // Comment has "Verdict: ✅ Passed" but no VERIFY_STATUS marker — should still detect as passed
    await maybeAutoVerify({ ...task, verifyRound: 1 }, "VERIFY_STATUS: needs_changes");
    expect(mockDeleteAutoverifyState).toHaveBeenCalledWith("owner/repo#42");
    expect(mockSetAutoverifyRounds).not.toHaveBeenCalled();
  });

  it("respects explicit ❌ verdict in bot comment even when stdout says passed", async () => {
    mockGetPRComments.mockResolvedValue([
      { author: "mikoto-devs[bot]", body: "## 🧪 PRODUCT VERIFY\n\n**Verdict:** ❌ Needs Changes" },
    ]);
    // Comment has explicit ❌ → fail, stdout is ignored
    await maybeAutoVerify(task, "VERIFY_STATUS: passed");
    expect(mockSetAutoverifyRounds).toHaveBeenCalledWith("owner/repo#42", 1);
    expect(mockDeleteAutoverifyState).not.toHaveBeenCalled();
  });

  it("falls back to stdout when bot comment has no recognizable verdict", async () => {
    mockGetPRComments.mockResolvedValue([
      { author: "mikoto-devs[bot]", body: "## 🧪 PRODUCT VERIFY\n\nSome analysis without a verdict marker." },
    ]);
    // No pass/fail markers in comment → fall back to stdout
    await maybeAutoVerify(task, "VERIFY_STATUS: passed");
    expect(mockDeleteAutoverifyState).toHaveBeenCalledWith("owner/repo#42");
  });

  it("falls back to stdout when no bot comment exists", async () => {
    mockGetPRComments.mockResolvedValue([
      { author: "some-human", body: "lgtm" },
    ]);
    await maybeAutoVerify(task, "VERIFY_STATUS: passed");
    // No bot comment → fallback to stdout "passed"
    expect(mockDeleteAutoverifyState).toHaveBeenCalledWith("owner/repo#42");
  });

  it("falls back to stdout when getPRComments throws", async () => {
    mockGetPRComments.mockRejectedValue(new Error("API error"));
    await maybeAutoVerify(task, "VERIFY_STATUS: passed");
    expect(mockDeleteAutoverifyState).toHaveBeenCalledWith("owner/repo#42");
  });

  it("falls back to stdout when no installationId", async () => {
    mockGetRepoConfig.mockReturnValue({ ...baseConfig, installationId: undefined });
    await maybeAutoVerify(task, "VERIFY_STATUS: passed");
    expect(mockDeleteAutoverifyState).toHaveBeenCalledWith("owner/repo#42");
    expect(mockGetPRComments).not.toHaveBeenCalled();
  });
});
