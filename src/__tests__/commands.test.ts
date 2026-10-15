import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TGMessage, TGCallbackQuery } from "../types";

// --- Shared mock instances ---
const mockRunTask = vi.fn(() => null);
const mockCancelTask = vi.fn(() => true);
const mockGetActiveTasks = vi.fn(() => []);
const mockRegisterCallbackId = vi.fn((key: string) => `cb_${key}`);
const mockResolveCallbackId = vi.fn((id: string) => id.startsWith("cb_") ? id.slice(3) : null);
const mockRecordCommand = vi.fn();
const mockIsAllowed = vi.fn(() => true);
const mockFindPRByThread = vi.fn(() => null as number | null);
const mockGetTopicThread = vi.fn(() => null as number | null);
const mockSetTopicThread = vi.fn().mockResolvedValue(undefined);
const mockRemoveTopicThread = vi.fn().mockResolvedValue(undefined);
const mockGetAllTopics = vi.fn(() => ({} as Record<string, number>));
const mockGetStandaloneTopic = vi.fn(() => null);
const mockSetStandaloneTopic = vi.fn();
const mockGetTopicBaseTitle = vi.fn(() => null as string | null);
const mockSetMessageRef = vi.fn().mockResolvedValue(undefined);
const mockListOpenPRs = vi.fn().mockResolvedValue([]);
const mockGetPR = vi.fn().mockResolvedValue(null);
const mockGetPRComments = vi.fn().mockResolvedValue([]);
const mockIsCommentVisible = vi.fn(() => true);

// --- Module mocks ---
vi.mock("../utils/logger", async () => await import("./helpers/mock-logger"));

vi.mock("../config", async () => {
  const helpers = await import("./helpers/mock-config");
  return {
    ROOT_DIR: helpers.ROOT_DIR,
    BOT_LOGIN: helpers.BOT_LOGIN,
    REPOS: helpers.REPOS,
    TELEGRAM_CONFIG: helpers.TELEGRAM_CONFIG,
    getRepoConfig: helpers.getRepoConfig,
    resolveSkillPath: helpers.resolveSkillPath,
    getGroupDir: helpers.getGroupDir,
    getProvider: helpers.getProvider,
    setProvider: helpers.setProvider,
    isCommandAllowed: helpers.isCommandAllowed,
    isSyncPREnabled: helpers.isSyncPREnabled,
    getGroupsByRepo: helpers.getGroupsByRepo,
  };
});

vi.mock("../telegram/client", async () => await import("./helpers/mock-telegram"));

vi.mock("../review/manager", () => ({
  getActiveTasks: mockGetActiveTasks,
  runTask: mockRunTask,
  cancelTask: mockCancelTask,
  registerCallbackId: mockRegisterCallbackId,
  resolveCallbackId: mockResolveCallbackId,
}));

vi.mock("../review/topic-context", () => ({
  recordCommand: mockRecordCommand,
  loadTaskContext: vi.fn().mockResolvedValue(null),
}));

vi.mock("../telegram/auth", () => ({
  isAllowed: mockIsAllowed,
}));

vi.mock("../store/db", () => ({
  findPRByThread: mockFindPRByThread,
  getTopicThread: mockGetTopicThread,
  getTopicBaseTitle: mockGetTopicBaseTitle,
  setTopicThread: mockSetTopicThread,
  removeTopicThread: mockRemoveTopicThread,
  getAllTopics: mockGetAllTopics,
  getStandaloneTopic: mockGetStandaloneTopic,
  setStandaloneTopic: mockSetStandaloneTopic,
  setMessageRef: mockSetMessageRef,
}));

vi.mock("../github/api", () => ({
  listOpenPRs: mockListOpenPRs,
  getPR: mockGetPR,
  getPRComments: mockGetPRComments,
  postPRComment: vi.fn().mockResolvedValue({ id: 1 }),
}));

vi.mock("../telegram/sync-github", () => ({
  isCommentVisible: mockIsCommentVisible,
  syncTGMessageToGitHub: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../telegram/notifications", () => ({
  notifyTaskStart: vi.fn().mockResolvedValue(undefined),
  notifyTaskComplete: vi.fn().mockResolvedValue(undefined),
  sendOutputToTG: vi.fn().mockResolvedValue(undefined),
}));

const { handleCommand, handleCallbackQuery } = await import("../telegram/commands");

// restoreMocks:true only restores vi.spyOn() spies, not standalone vi.fn() instances.
// Call vi.clearAllMocks() explicitly to clear call history, then re-set implementations.
async function setupDefaultMocks() {
  vi.clearAllMocks();
  const tg = await import("../telegram/client");
  const config = await import("../config");

  // telegram/client defaults
  vi.mocked(tg.sendMessage).mockResolvedValue({ message_id: 1 } as any);
  vi.mocked(tg.sendInlineKeyboard).mockResolvedValue({ message_id: 2 } as any);
  vi.mocked(tg.sendLongMessage).mockResolvedValue({ message_id: 3 } as any);
  vi.mocked(tg.answerCallbackQuery).mockResolvedValue(undefined);
  vi.mocked(tg.createForumTopic).mockResolvedValue({ message_thread_id: 100 } as any);
  vi.mocked(tg.deleteForumTopic).mockResolvedValue(undefined);
  vi.mocked(tg.topicExists).mockResolvedValue(true);
  vi.mocked(tg.formatCommentForTG).mockReturnValue("<b>comment</b>");

  // config defaults
  vi.mocked(config.isCommandAllowed).mockReturnValue(true);
  vi.mocked(config.isSyncPREnabled).mockReturnValue(true);
  vi.mocked(config.resolveSkillPath).mockReturnValue("skills/review-pr/SKILL.md");
  vi.mocked(config.getProvider).mockReturnValue("claude");
  vi.mocked(config.getGroupDir).mockReturnValue(null);

  // standalone mocks
  mockIsAllowed.mockReturnValue(true);
  mockIsCommentVisible.mockReturnValue(true);
  mockRunTask.mockReturnValue(null);
  mockCancelTask.mockReturnValue(true);
  mockGetActiveTasks.mockReturnValue([]);
  mockFindPRByThread.mockReturnValue(null);
  mockGetTopicThread.mockReturnValue(null);
  mockSetTopicThread.mockResolvedValue(undefined);
  mockRemoveTopicThread.mockResolvedValue(undefined);
  mockGetAllTopics.mockReturnValue({});
  mockGetStandaloneTopic.mockReturnValue(null);
  mockListOpenPRs.mockResolvedValue([]);
  mockGetPR.mockResolvedValue(null);
  mockGetPRComments.mockResolvedValue([]);
}

// --- Test helpers ---
const CHAT_ID = "-100";
const REPO = "owner/repo";

function makeMsg(text: string, opts: Partial<TGMessage> = {}): TGMessage {
  return {
    message_id: 1,
    chat: { id: Number(CHAT_ID) },
    from: { id: 1, username: "alice" },
    text,
    ...opts,
  };
}

function makeCbq(data: string, opts: Partial<TGCallbackQuery> = {}): TGCallbackQuery {
  return {
    id: "cbq1",
    from: { id: 1, username: "alice" },
    data,
    message: { message_id: 1, chat: { id: Number(CHAT_ID) } },
    ...opts,
  };
}

// --- handleCommand ---

describe("handleCommand", () => {
  beforeEach(async () => {
    await setupDefaultMocks();
  });

  it("returns early when message has no 'from' field", async () => {
    const tg = await import("../telegram/client");
    const msg: TGMessage = { message_id: 1, chat: { id: -100 }, text: "/help" };
    await handleCommand(msg);
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("handles /start without error", async () => {
    const tg = await import("../telegram/client");
    await handleCommand(makeMsg("/start"));
    expect(tg.sendMessage).toHaveBeenCalled();
  });

  it("handles /help same as /start", async () => {
    const tg = await import("../telegram/client");
    await handleCommand(makeMsg("/help"));
    expect(tg.sendMessage).toHaveBeenCalled();
  });

  it("handles /info", async () => {
    const tg = await import("../telegram/client");
    mockGetAllTopics.mockReturnValueOnce({ "42": 55 });
    await handleCommand(makeMsg("/info"));
    const call = vi.mocked(tg.sendMessage).mock.calls[0];
    expect(call[1]).toContain("Info");
  });

  it("handles /status — no active tasks", async () => {
    const tg = await import("../telegram/client");
    mockGetActiveTasks.mockReturnValueOnce([]);
    await handleCommand(makeMsg("/status"));
    expect(tg.sendMessage).toHaveBeenCalledWith(CHAT_ID, "No active tasks.");
  });

  it("handles /status — shows active tasks as inline keyboard", async () => {
    const tg = await import("../telegram/client");
    mockGetActiveTasks.mockReturnValueOnce([
      { key: "owner/repo#42:review", command: "review", branch: "feat/42", elapsed: "5s" },
    ]);
    await handleCommand(makeMsg("/status"));
    expect(tg.sendInlineKeyboard).toHaveBeenCalled();
  });

  it("handles /status permission denied", async () => {
    const tg = await import("../telegram/client");
    mockIsAllowed.mockReturnValueOnce(false);
    await handleCommand(makeMsg("/status"));
    expect(tg.sendMessage).toHaveBeenCalledWith(CHAT_ID, "Permission denied.");
  });

  it("sends 'not available' when /load is not allowed", async () => {
    const config = await import("../config");
    const tg = await import("../telegram/client");
    vi.mocked(config.isCommandAllowed).mockReturnValueOnce(false);
    await handleCommand(makeMsg("/load"));
    expect(tg.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining("not available"),
      expect.any(Object)
    );
  });

  it("sends 'not available' when /close is not allowed", async () => {
    const config = await import("../config");
    const tg = await import("../telegram/client");
    vi.mocked(config.isCommandAllowed).mockReturnValueOnce(false);
    await handleCommand(makeMsg("/close"));
    expect(tg.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining("not available"),
      expect.any(Object)
    );
  });

  it("sends 'not available' when /status is not allowed", async () => {
    const config = await import("../config");
    const tg = await import("../telegram/client");
    vi.mocked(config.isCommandAllowed).mockReturnValueOnce(false);
    await handleCommand(makeMsg("/status"));
    expect(tg.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining("not available"),
      expect.any(Object)
    );
  });

  it("handles /provider — shows current provider and switch button", async () => {
    const tg = await import("../telegram/client");
    const config = await import("../config");
    vi.mocked(config.getProvider).mockReturnValue("claude");
    await handleCommand(makeMsg("/provider"));
    expect(tg.sendInlineKeyboard).toHaveBeenCalled();
    const call = vi.mocked(tg.sendInlineKeyboard).mock.calls[0];
    expect(call[1]).toContain("claude");
  });

  it("handles /provider claude — switches to claude", async () => {
    const tg = await import("../telegram/client");
    const config = await import("../config");
    await handleCommand(makeMsg("/provider claude"));
    expect(config.setProvider).toHaveBeenCalledWith(CHAT_ID, "claude");
    expect(tg.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining("claude"),
      expect.any(Object)
    );
  });

  it("handles /provider with invalid value", async () => {
    const tg = await import("../telegram/client");
    await handleCommand(makeMsg("/provider gpt4"));
    expect(tg.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining("Invalid provider"),
      expect.any(Object)
    );
  });

  it("rejects skill command when not allowed", async () => {
    const config = await import("../config");
    const tg = await import("../telegram/client");
    vi.mocked(config.isCommandAllowed).mockReturnValueOnce(false);
    vi.mocked(config.resolveSkillPath).mockReturnValueOnce("skills/review-pr/SKILL.md");
    await handleCommand(makeMsg("/review"));
    expect(tg.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining("not available"),
      expect.any(Object)
    );
  });

  it("handles unknown command with feedback message", async () => {
    const tg = await import("../telegram/client");
    const config = await import("../config");
    vi.mocked(config.resolveSkillPath).mockReturnValueOnce(null);
    await handleCommand(makeMsg("/unknowncmd"));
    expect(tg.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining("Unknown command"),
      expect.any(Object)
    );
  });

  it("triggers skill task in PR topic context", async () => {
    const tg = await import("../telegram/client");
    const config = await import("../config");

    mockFindPRByThread.mockReturnValueOnce(42);
    vi.mocked(config.resolveSkillPath).mockReturnValueOnce("skills/review-pr/SKILL.md");
    mockGetPR.mockResolvedValueOnce({ headBranch: "feat/42" });

    await handleCommand(makeMsg("/review", { message_thread_id: 55 }));

    expect(mockRunTask).toHaveBeenCalledWith(
      expect.objectContaining({ repoFullName: REPO, prNumber: 42, command: "review" })
    );
    expect(tg.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining("review"),
      expect.any(Object)
    );
  });

  it("sends rejection message when runTask returns a reason", async () => {
    const tg = await import("../telegram/client");
    const config = await import("../config");

    mockFindPRByThread.mockReturnValueOnce(42);
    vi.mocked(config.resolveSkillPath).mockReturnValueOnce("skills/review-pr/SKILL.md");
    mockGetPR.mockResolvedValueOnce(null);
    mockRunTask.mockReturnValueOnce({ reason: "already running" });

    await handleCommand(makeMsg("/review", { message_thread_id: 55 }));

    expect(tg.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      "already running",
      expect.any(Object)
    );
  });

  it("requires userInput for /do command", async () => {
    const tg = await import("../telegram/client");
    const config = await import("../config");

    vi.mocked(config.resolveSkillPath).mockReturnValueOnce("skills/do/SKILL.md");
    mockFindPRByThread.mockReturnValueOnce(null);
    mockGetStandaloneTopic.mockReturnValueOnce(null);

    await handleCommand(makeMsg("/do", { message_thread_id: 55 }));

    expect(tg.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining("Usage: /do"),
      expect.any(Object)
    );
    expect(mockRunTask).not.toHaveBeenCalled();
  });

  it("requires userInput for standalone /review", async () => {
    const tg = await import("../telegram/client");
    const config = await import("../config");

    vi.mocked(config.resolveSkillPath).mockReturnValueOnce("skills/review-pr/SKILL.md");
    // No threadId → standalone context
    await handleCommand(makeMsg("/review"));

    expect(tg.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining("Use /review inside a PR topic"),
      expect.any(Object)
    );
  });

  it("handles /autofix inside a PR topic", async () => {
    const tg = await import("../telegram/client");
    const config = await import("../config");

    // mockReset() clears the stacked null from setupDefaultMocks before setting 77
    mockFindPRByThread.mockReset();
    mockFindPRByThread.mockReturnValueOnce(77);
    mockGetPR.mockResolvedValueOnce({ headBranch: "feat/77" });

    await handleCommand(makeMsg("/autofix", { message_thread_id: 55 }));

    expect(mockRunTask).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "review",
        prNumber: 77,
        manualAutoFix: true,
      })
    );
  });
});

// --- handleCallbackQuery ---

describe("handleCallbackQuery", () => {
  beforeEach(async () => {
    await setupDefaultMocks();
  });

  it("denies callback query when user is not allowed", async () => {
    const tg = await import("../telegram/client");
    mockIsAllowed.mockReturnValueOnce(false);
    await handleCallbackQuery(makeCbq("cancel:some-key"));
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("cbq1", "Permission denied.");
  });

  it("shows confirmation when cancel_ask: callback is received", async () => {
    const tg = await import("../telegram/client");
    // callback_data now carries a short callback ID, not the full key
    await handleCallbackQuery(makeCbq("cancel_ask:cb_owner/repo#42:review"));
    expect(mockCancelTask).not.toHaveBeenCalled();
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("cbq1");
    expect(tg.sendInlineKeyboard).toHaveBeenCalled();
  });

  it("answers not found when cancel_ask: ID is unresolvable", async () => {
    const tg = await import("../telegram/client");
    await handleCallbackQuery(makeCbq("cancel_ask:unknown_id"));
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith(
      "cbq1",
      expect.stringContaining("not found")
    );
  });

  it("cancels a task when cancel_confirm: callback is received", async () => {
    const tg = await import("../telegram/client");
    mockCancelTask.mockReturnValueOnce(true);
    // short callback ID → resolveCallbackId returns full key
    await handleCallbackQuery(makeCbq("cancel_confirm:cb_owner/repo#42:review"));
    expect(mockCancelTask).toHaveBeenCalledWith("owner/repo#42:review");
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("cbq1", "Task cancelled.");
  });

  it("answers when task not found for cancel_confirm:", async () => {
    const tg = await import("../telegram/client");
    mockCancelTask.mockReturnValueOnce(false);
    // unresolvable callback ID → resolveCallbackId returns null
    await handleCallbackQuery(makeCbq("cancel_confirm:unknown_id"));
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith(
      "cbq1",
      expect.stringContaining("not found")
    );
  });

  it("dismisses when cancel_dismiss: callback is received", async () => {
    const tg = await import("../telegram/client");
    await handleCallbackQuery(makeCbq("cancel_dismiss:cb_owner/repo#42:review"));
    expect(mockCancelTask).not.toHaveBeenCalled();
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("cbq1", "已取消操作。");
  });

  it("switches provider when provider: callback is received", async () => {
    const config = await import("../config");
    const tg = await import("../telegram/client");
    await handleCallbackQuery(makeCbq("provider:codex"));
    expect(config.setProvider).toHaveBeenCalledWith(CHAT_ID, "codex");
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("cbq1", "Switched to codex");
  });

  it("rejects invalid provider in provider: callback", async () => {
    const tg = await import("../telegram/client");
    await handleCallbackQuery(makeCbq("provider:gpt4"));
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("cbq1", "Invalid provider.");
  });

  it("rejects provider: callback when not allowed by isCommandAllowed", async () => {
    const config = await import("../config");
    const tg = await import("../telegram/client");
    vi.mocked(config.isCommandAllowed).mockReturnValueOnce(false);
    await handleCallbackQuery(makeCbq("provider:claude"));
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith(
      "cbq1",
      "This action is not available."
    );
  });

  it("loads a PR when load: callback is received", async () => {
    const config = await import("../config");
    const tg = await import("../telegram/client");

    vi.mocked(config.isSyncPREnabled).mockReturnValueOnce(true);
    mockGetTopicThread.mockReturnValueOnce(null);
    mockGetPR.mockResolvedValueOnce({ title: "My PR", headBranch: "feat/5" });

    await handleCallbackQuery(makeCbq("load:5"));

    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("cbq1", "Loading PR #5...");
    expect(mockSetTopicThread).toHaveBeenCalled();
  });

  it("rejects load: callback when load is not allowed", async () => {
    const config = await import("../config");
    const tg = await import("../telegram/client");
    vi.mocked(config.isCommandAllowed).mockReturnValueOnce(false);
    await handleCallbackQuery(makeCbq("load:5"));
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith(
      "cbq1",
      "This action is not available."
    );
  });

  it("marks topic as read when mark_read: callback is received with base title", async () => {
    const tg = await import("../telegram/client");
    mockFindPRByThread.mockReturnValueOnce(42);
    mockGetTopicBaseTitle.mockReturnValueOnce("#42 Fix login bug");
    await handleCallbackQuery(makeCbq(`mark_read:${CHAT_ID}:1001`));
    expect(tg.editForumTopicIcon).toHaveBeenCalledWith(CHAT_ID, 1001, "#42 Fix login bug", "✅");
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("cbq1", "✅ 已标记为已读");
  });

  it("marks topic as read with empty title fallback when no PR found", async () => {
    const tg = await import("../telegram/client");
    mockFindPRByThread.mockReturnValueOnce(null);
    await handleCallbackQuery(makeCbq(`mark_read:${CHAT_ID}:1001`));
    expect(tg.editForumTopicIcon).toHaveBeenCalledWith(CHAT_ID, 1001, "", "✅");
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("cbq1", "✅ 已标记为已读");
  });

  it("handles editForumTopicIcon failure in mark_read gracefully", async () => {
    const tg = await import("../telegram/client");
    mockFindPRByThread.mockReturnValueOnce(null);
    vi.mocked(tg.editForumTopicIcon).mockRejectedValueOnce(new Error("TG error"));
    await handleCallbackQuery(makeCbq(`mark_read:${CHAT_ID}:1001`));
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("cbq1", "Failed to update topic icon.");
  });

  it("answers empty for unknown callback data", async () => {
    const tg = await import("../telegram/client");
    await handleCallbackQuery(makeCbq("unknown-action"));
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("cbq1");
  });
});
