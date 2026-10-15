import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Module mocks (hoisted) ---

const mockHandleCommand = vi.fn().mockResolvedValue(undefined);
const mockHandleCallbackQuery = vi.fn().mockResolvedValue(undefined);
const mockSyncTGMessageToGitHub = vi.fn().mockResolvedValue(undefined);
const mockRecordUserMessage = vi.fn();

vi.mock("../utils/logger", async () => await import("./helpers/mock-logger"));

vi.mock("../telegram/client", async () => await import("./helpers/mock-telegram"));

vi.mock("../telegram/commands", () => ({
  handleCommand: mockHandleCommand,
  handleCallbackQuery: mockHandleCallbackQuery,
}));

vi.mock("../telegram/sync-github", () => ({
  syncTGMessageToGitHub: mockSyncTGMessageToGitHub,
  notifyTaskStart: vi.fn().mockResolvedValue(undefined),
  notifyTaskComplete: vi.fn().mockResolvedValue(undefined),
  sendOutputToTG: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../review/topic-context", () => ({
  recordUserMessage: mockRecordUserMessage,
  loadTaskContext: vi.fn().mockResolvedValue(null),
}));

// Helper: flush macrotasks so the event loop can run afterEach cleanup
const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));

// Import once at the top level — avoids vi.resetModules() which breaks mock resolution
const tg = await import("../telegram/client");
const logger = await import("./helpers/mock-logger");
const { startBot, stopBot } = await import("../telegram/bot");

// Self-stopping getUpdates: calls stopBot() so the poll loop exits after one iteration.
// This prevents the while(running) loop from becoming an infinite microtask loop.
function useSelfStoppingGetUpdates(updates: any[] = []) {
  vi.mocked(tg.getUpdates).mockImplementation(async () => {
    stopBot();
    return updates;
  });
}

beforeEach(() => {
  // restoreMocks:true only restores spies, not vi.fn() instances — clear manually
  vi.clearAllMocks();
  vi.mocked(tg.getMe).mockResolvedValue({ id: 42, username: "testbot" });
  vi.mocked(tg.sendMessage).mockResolvedValue({ message_id: 1 } as any);
  mockHandleCommand.mockResolvedValue(undefined);
  mockHandleCallbackQuery.mockResolvedValue(undefined);
  mockSyncTGMessageToGitHub.mockResolvedValue(undefined);
  // Default: stop after one empty poll so no test leaks a running loop
  useSelfStoppingGetUpdates();
});

afterEach(async () => {
  stopBot(); // Safety: ensure running=false
  await flushPromises();
});

describe("startBot", () => {
  it("initializes the telegram client with the given token", async () => {
    await startBot("my-token");
    expect(tg.initTelegramClient).toHaveBeenCalledWith("my-token");
  });

  it("calls getMe and logs the bot username", async () => {
    vi.mocked(tg.getMe).mockResolvedValue({ id: 99, username: "mybot" });

    await startBot("token");

    expect(tg.getMe).toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("@mybot"));
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("99"));
  });

  it("starts polling after initialization", async () => {
    let callCount = 0;
    vi.mocked(tg.getUpdates).mockImplementation(async () => {
      callCount++;
      stopBot();
      return [];
    });

    await startBot("token");
    await flushPromises();

    expect(callCount).toBeGreaterThanOrEqual(1);
  });
});

describe("stopBot", () => {
  it("logs a stopping message", async () => {
    await startBot("token");

    vi.clearAllMocks(); // Clear startBot's log calls
    stopBot();

    expect(logger.log).toHaveBeenCalledWith("Telegram bot stopping...");
  });
});

describe("pollLoop (via startBot)", () => {
  it("routes callback_query updates to handleCallbackQuery", async () => {
    const cbq = { id: "cbq1", from: { id: 1 }, data: "test" };

    // First call returns the update; self-stopping impl fires on second call
    vi.mocked(tg.getUpdates)
      .mockResolvedValueOnce([{ update_id: 1, callback_query: cbq }]);
    // Default from beforeEach (self-stopping) handles subsequent calls

    await startBot("token");
    await flushPromises();

    expect(mockHandleCallbackQuery).toHaveBeenCalledWith(cbq);
  });

  it("routes command messages to handleCommand", async () => {
    const msg = {
      message_id: 1,
      chat: { id: -100 },
      from: { id: 5, first_name: "Alice" },
      text: "/review",
    };

    vi.mocked(tg.getUpdates)
      .mockResolvedValueOnce([{ update_id: 2, message: msg }]);

    await startBot("token");
    await flushPromises();

    expect(mockHandleCommand).toHaveBeenCalledWith(msg);
  });

  it("records and syncs thread messages from non-bot users", async () => {
    // bot user id = 42 (from beforeEach mock); non-bot user id = 7
    const msg = {
      message_id: 2,
      chat: { id: -100 },
      from: { id: 7, first_name: "Bob" },
      text: "hello world",
      message_thread_id: 55,
    };

    vi.mocked(tg.getUpdates)
      .mockResolvedValueOnce([{ update_id: 3, message: msg }]);

    await startBot("token");
    await flushPromises();

    expect(mockRecordUserMessage).toHaveBeenCalledWith("-100", 55, "hello world", "Bob");
    expect(mockSyncTGMessageToGitHub).toHaveBeenCalledWith(msg);
  });

  it("does not sync thread messages sent by the bot itself", async () => {
    // bot user id = 42 — message from the bot itself should be skipped
    const msg = {
      message_id: 3,
      chat: { id: -100 },
      from: { id: 42, first_name: "Mikoto" },
      text: "I am the bot",
      message_thread_id: 55,
    };

    vi.mocked(tg.getUpdates)
      .mockResolvedValueOnce([{ update_id: 4, message: msg }]);

    await startBot("token");
    await flushPromises();

    expect(mockRecordUserMessage).not.toHaveBeenCalled();
    expect(mockSyncTGMessageToGitHub).not.toHaveBeenCalled();
  });

  it("skips messages without text in thread context", async () => {
    const msg = {
      message_id: 4,
      chat: { id: -100 },
      from: { id: 7, first_name: "Bob" },
      // No text field
      message_thread_id: 55,
    };

    vi.mocked(tg.getUpdates)
      .mockResolvedValueOnce([{ update_id: 5, message: msg }]);

    await startBot("token");
    await flushPromises();

    expect(mockRecordUserMessage).not.toHaveBeenCalled();
    expect(mockHandleCommand).not.toHaveBeenCalled();
  });

  it("advances offset after processing updates", async () => {
    let secondCallOffset: number | undefined;

    vi.mocked(tg.getUpdates)
      .mockResolvedValueOnce([{ update_id: 10 }])
      .mockImplementation((offset) => {
        secondCallOffset = offset as number;
        stopBot();
        return Promise.resolve([]);
      });

    await startBot("token");
    await flushPromises();

    // offset should become update_id + 1 = 11
    expect(secondCallOffset).toBe(11);
  });

  it("logs polling errors and retries after delay", async () => {
    vi.useFakeTimers();

    // First call: rejects to trigger error handling.
    // Second call: self-stopping so the loop exits after the 5000ms retry.
    vi.mocked(tg.getUpdates)
      .mockRejectedValueOnce(new Error("network failure"))
      .mockImplementation(() => { stopBot(); return Promise.resolve([]); });

    await startBot("token");

    // Advance past the 5000ms retry delay; vi.runAllTimersAsync awaits callbacks
    await vi.runAllTimersAsync();

    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("network failure")
    );

    vi.useRealTimers();
  });

  it("catches individual update errors without stopping the loop", async () => {
    const cbq = { id: "cbq_err", from: { id: 1 }, data: "bad" };
    mockHandleCallbackQuery.mockRejectedValueOnce(new Error("handler error"));

    vi.mocked(tg.getUpdates)
      .mockResolvedValueOnce([{ update_id: 20, callback_query: cbq }]);

    await startBot("token");
    await flushPromises();

    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("Error processing update 20")
    );
  });
});
