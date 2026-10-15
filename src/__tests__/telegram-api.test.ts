/**
 * Tests for Telegram API forum topic icon fallback behavior.
 *
 * Telegram only supports a limited set of emoji as Forum Topic icons.
 * When the requested emoji is not in the sticker map, the functions should
 * fall back to prefixing the topic name with the emoji.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/logger", async () => await import("./helpers/mock-logger"));

// We need to control the fetch calls made by api.ts.
// Use vi.stubGlobal to inject a mock fetch before importing the module.

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import after stubbing fetch so the module picks up the mock.
const { createForumTopic, editForumTopicIcon, _resetIconStickerMapCache } = await import("../telegram/api");

/** Sticker map with only ✅ and ❌ — mimics real Telegram limitations */
const SUPPORTED_STICKERS = [
  { emoji: "✅", custom_emoji_id: "sticker_check" },
  { emoji: "❌", custom_emoji_id: "sticker_cross" },
];

/** Build a successful mock fetch response */
function mockOk(result: unknown) {
  return Promise.resolve({
    json: () => Promise.resolve({ ok: true, result }),
  } as Response);
}

beforeEach(() => {
  _resetIconStickerMapCache();
  mockFetch.mockReset();
});

// ---------------------------------------------------------------------------
// createForumTopic
// ---------------------------------------------------------------------------

describe("createForumTopic", () => {
  it("uses icon_custom_emoji_id when emoji IS in sticker map (✅)", async () => {
    mockFetch
      // First call: getForumTopicIconStickers
      .mockResolvedValueOnce(mockOk(SUPPORTED_STICKERS))
      // Second call: createForumTopic
      .mockResolvedValueOnce(mockOk({ message_thread_id: 42, name: "done: task" }));

    await createForumTopic("-100chat", "done: task", "✅");

    const createCall = mockFetch.mock.calls[1];
    const body = JSON.parse(createCall[1].body);
    expect(body.name).toBe("done: task");
    expect(body.icon_custom_emoji_id).toBe("sticker_check");
  });

  it("prefixes name with emoji when emoji is NOT in sticker map (🔨)", async () => {
    mockFetch
      .mockResolvedValueOnce(mockOk(SUPPORTED_STICKERS))
      .mockResolvedValueOnce(mockOk({ message_thread_id: 43, name: "🔨 do: task" }));

    await createForumTopic("-100chat", "do: task", "🔨");

    const createCall = mockFetch.mock.calls[1];
    const body = JSON.parse(createCall[1].body);
    expect(body.name).toBe("🔨 do: task");
    expect(body.icon_custom_emoji_id).toBeUndefined();
  });

  it("prefixes name with emoji when emoji is NOT in sticker map (⏳)", async () => {
    mockFetch
      .mockResolvedValueOnce(mockOk(SUPPORTED_STICKERS))
      .mockResolvedValueOnce(mockOk({ message_thread_id: 44, name: "⏳ do: task" }));

    await createForumTopic("-100chat", "do: task", "⏳");

    const createCall = mockFetch.mock.calls[1];
    const body = JSON.parse(createCall[1].body);
    expect(body.name).toBe("⏳ do: task");
    expect(body.icon_custom_emoji_id).toBeUndefined();
  });

  it("creates topic without icon when no emoji is passed", async () => {
    mockFetch
      .mockResolvedValueOnce(mockOk({ message_thread_id: 45, name: "task" }));

    await createForumTopic("-100chat", "task");

    const createCall = mockFetch.mock.calls[0];
    const body = JSON.parse(createCall[1].body);
    expect(body.name).toBe("task");
    expect(body.icon_custom_emoji_id).toBeUndefined();
  });

  it("caches the sticker map — only calls getForumTopicIconStickers once across multiple createForumTopic calls", async () => {
    mockFetch
      .mockResolvedValueOnce(mockOk(SUPPORTED_STICKERS))   // sticker map fetch
      .mockResolvedValueOnce(mockOk({ message_thread_id: 50, name: "🔨 do: first" }))
      .mockResolvedValueOnce(mockOk({ message_thread_id: 51, name: "⏳ do: second" }));

    await createForumTopic("-100chat", "do: first", "🔨");
    await createForumTopic("-100chat", "do: second", "⏳");

    // fetch called 3 times total: 1 sticker map + 2 createForumTopic
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// editForumTopicIcon
// ---------------------------------------------------------------------------

describe("editForumTopicIcon", () => {
  it("sets icon_custom_emoji_id and uses plain name when emoji IS in sticker map (✅)", async () => {
    mockFetch
      .mockResolvedValueOnce(mockOk(SUPPORTED_STICKERS))
      .mockResolvedValueOnce(mockOk(true));

    await editForumTopicIcon("-100chat", 42, "do: task", "✅");

    const editCall = mockFetch.mock.calls[1];
    const body = JSON.parse(editCall[1].body);
    expect(body.name).toBe("do: task");
    expect(body.icon_custom_emoji_id).toBe("sticker_check");
  });

  it("prefixes name with emoji and omits icon_custom_emoji_id when emoji is NOT in sticker map (⏳)", async () => {
    mockFetch
      .mockResolvedValueOnce(mockOk(SUPPORTED_STICKERS))
      .mockResolvedValueOnce(mockOk(true));

    await editForumTopicIcon("-100chat", 42, "do: task", "⏳");

    const editCall = mockFetch.mock.calls[1];
    const body = JSON.parse(editCall[1].body);
    expect(body.name).toBe("⏳ do: task");
    expect(body.icon_custom_emoji_id).toBeUndefined();
  });

  it("prefixes name with emoji for all unsupported emojis (🔧, 🔍, 💭, 🔨, 💬, ⚡)", async () => {
    const unsupported = ["🔧", "🔍", "💭", "🔨", "💬", "⚡"];
    for (const emoji of unsupported) {
      _resetIconStickerMapCache();
      mockFetch
        .mockResolvedValueOnce(mockOk(SUPPORTED_STICKERS))
        .mockResolvedValueOnce(mockOk(true));

      await editForumTopicIcon("-100chat", 42, "task", emoji);

      const editCall = mockFetch.mock.calls[1];
      const body = JSON.parse(editCall[1].body);
      expect(body.name).toBe(`${emoji} task`);
      expect(body.icon_custom_emoji_id).toBeUndefined();
      mockFetch.mockReset();
    }
  });

  it("truncates combined name+emoji prefix to 128 characters", async () => {
    mockFetch
      .mockResolvedValueOnce(mockOk(SUPPORTED_STICKERS))
      .mockResolvedValueOnce(mockOk(true));

    const longName = "x".repeat(200);
    await editForumTopicIcon("-100chat", 42, longName, "⏳");

    const editCall = mockFetch.mock.calls[1];
    const body = JSON.parse(editCall[1].body);
    expect(body.name.length).toBeLessThanOrEqual(128);
    expect(body.name.startsWith("⏳ ")).toBe(true);
  });

  it("handles sticker map fetch failure gracefully — falls back to emoji prefix", async () => {
    // getForumTopicIconStickers throws
    mockFetch
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(mockOk(true));

    await editForumTopicIcon("-100chat", 42, "do: task", "⏳");

    const editCall = mockFetch.mock.calls[1];
    const body = JSON.parse(editCall[1].body);
    // On failure, getTopicIconStickerMap returns empty Map → emoji not found → prefix applied
    expect(body.name).toBe("⏳ do: task");
    expect(body.icon_custom_emoji_id).toBeUndefined();
  });
});
