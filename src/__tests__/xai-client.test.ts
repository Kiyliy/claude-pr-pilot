import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger as mockLogger } from "./helpers/mock-logger";

vi.mock("../utils/logger", async () => await import("./helpers/mock-logger"));

// Stub global fetch before importing the module under test
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { generateTopicTitle } = await import("../xai/client");

describe("generateTopicTitle", () => {
  const ORIGINAL_KEY = process.env.XAI_API_KEY;
  const ORIGINAL_BASE_URL = process.env.XAI_BASE_URL;

  beforeEach(() => {
    mockFetch.mockReset();
    mockLogger.debug.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    process.env.XAI_API_KEY = "test-api-key";
    delete process.env.XAI_BASE_URL;
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env.XAI_API_KEY;
    } else {
      process.env.XAI_API_KEY = ORIGINAL_KEY;
    }
    if (ORIGINAL_BASE_URL === undefined) {
      delete process.env.XAI_BASE_URL;
    } else {
      process.env.XAI_BASE_URL = ORIGINAL_BASE_URL;
    }
  });

  it("returns fallback when XAI_API_KEY is not set", async () => {
    delete process.env.XAI_API_KEY;
    const result = await generateTopicTitle(42, "feat: add new feature");
    expect(result).toBe("#42 feat: add new feature");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns generated title on successful API call", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "新增功能" } }],
      }),
    });

    const result = await generateTopicTitle(7, "feat: 新增用户认证模块");
    expect(result).toBe("#7 新增功能");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("sends correct request to xAI API", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Add auth module" } }],
      }),
    });

    await generateTopicTitle(10, "feat: add auth module");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit & { body: string }];
    expect(url).toBe("https://api.x.ai/v1/chat/completions");
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer test-api-key",
    });

    const body = JSON.parse(options.body);
    expect(body.model).toBe("grok-4-1-fast-non-reasoning");
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toContain("PR #10");
    expect(body.messages[0].content).toContain("feat: add auth module");
  });

  it("returns fallback when API responds with non-OK status", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });

    const result = await generateTopicTitle(5, "fix: crash on startup");
    expect(result).toBe("#5 fix: crash on startup");
  });

  it("returns fallback when API returns empty choices array", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [] }),
    });

    const result = await generateTopicTitle(3, "refactor: cleanup");
    expect(result).toBe("#3 refactor: cleanup");
  });

  it("returns fallback when API returns null content", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: null } }],
      }),
    });

    const result = await generateTopicTitle(8, "chore: update deps");
    expect(result).toBe("#8 chore: update deps");
  });

  it("returns fallback when API returns empty string content", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "   " } }],
      }),
    });

    const result = await generateTopicTitle(9, "docs: update readme");
    expect(result).toBe("#9 docs: update readme");
  });

  it("returns fallback when fetch throws AbortError (timeout)", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    mockFetch.mockRejectedValue(abortError);

    const result = await generateTopicTitle(11, "feat: slow feature");
    expect(result).toBe("#11 feat: slow feature");
  });

  it("returns fallback when fetch throws a network error", async () => {
    mockFetch.mockRejectedValue(new Error("Network failure"));

    const result = await generateTopicTitle(12, "fix: network bug");
    expect(result).toBe("#12 fix: network bug");
  });

  it("trims whitespace from generated title", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "  Trimmed Title  " } }],
      }),
    });

    const result = await generateTopicTitle(20, "feat: something");
    expect(result).toBe("#20 Trimmed Title");
  });

  it("logs debug before making API call", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Debug Test" } }],
      }),
    });

    await generateTopicTitle(30, "feat: debug test");

    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining("[xAI]"),
      expect.objectContaining({ prNumber: 30 })
    );
  });

  it("logs warn on missing API key with prNumber context", async () => {
    delete process.env.XAI_API_KEY;

    await generateTopicTitle(31, "feat: no key");

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("XAI_API_KEY not set"),
      expect.objectContaining({ prNumber: 31 })
    );
  });

  it("logs info on successful title generation with structured context", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Generated Title" } }],
      }),
    });

    await generateTopicTitle(32, "feat: structured log test");

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("#32"),
      expect.objectContaining({ prNumber: 32, generated: "Generated Title" })
    );
  });

  it("logs warn on API error with status context", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    });

    await generateTopicTitle(33, "fix: api error test");

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("403"),
      expect.objectContaining({ prNumber: 33, status: 403 })
    );
  });

  it("logs warn on timeout with prNumber and timeoutMs context", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    mockFetch.mockRejectedValue(abortError);

    await generateTopicTitle(34, "feat: timeout test");

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("timed out"),
      expect.objectContaining({ prNumber: 34, timeoutMs: expect.any(Number) })
    );
  });

  it("uses custom XAI_BASE_URL when set", async () => {
    process.env.XAI_BASE_URL = "https://my-proxy.example.com";
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Proxy Title" } }],
      }),
    });

    await generateTopicTitle(50, "feat: proxy test");

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://my-proxy.example.com/v1/chat/completions");
  });

  it("strips trailing slashes from XAI_BASE_URL", async () => {
    process.env.XAI_BASE_URL = "https://my-proxy.example.com///";
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Slash Title" } }],
      }),
    });

    await generateTopicTitle(51, "feat: slash test");

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://my-proxy.example.com/v1/chat/completions");
  });

  it("defaults to api.x.ai when XAI_BASE_URL is not set", async () => {
    delete process.env.XAI_BASE_URL;
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Default Title" } }],
      }),
    });

    await generateTopicTitle(52, "feat: default url test");

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.x.ai/v1/chat/completions");
  });
});
