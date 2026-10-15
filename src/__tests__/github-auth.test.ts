import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  default: {
    readFileSync: vi.fn(() => "mock-private-key"),
  },
}));

vi.mock("../utils/logger", () => ({
  log: vi.fn(),
}));

vi.mock("jsonwebtoken", () => ({
  default: {
    sign: vi.fn(() => "mock-jwt-token"),
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { getInstallationToken } = await import("../github/auth");

describe("getInstallationToken", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("requests and caches installation token", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        token: "ghs_test_token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      }),
    });

    const token = await getInstallationToken(12345);
    expect(token).toBe("ghs_test_token");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call should use cache
    const token2 = await getInstallationToken(12345);
    expect(token2).toBe("ghs_test_token");
    expect(mockFetch).toHaveBeenCalledTimes(1); // No additional fetch
  });

  it("throws on API error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Bad credentials",
    });

    await expect(getInstallationToken(99999)).rejects.toThrow("Failed to get installation token");
  });
});
