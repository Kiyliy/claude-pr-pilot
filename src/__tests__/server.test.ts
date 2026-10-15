import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import crypto from "crypto";

// Mock all dependencies
vi.mock("../utils/logger", () => ({
  log: vi.fn(),
}));

vi.mock("../config", () => ({
  WEBHOOK_SECRET: "test-secret",
  REPOS: {
    "owner/repo": {
      dir: "/tmp/repo",
      commands: {},
      baseBranch: "main",
      installationId: 12345,
    },
  },
}));

vi.mock("../webhook/verify", () => ({
  verifySignature: vi.fn(),
}));

vi.mock("../review/manager", () => ({
  getActiveTasks: vi.fn(() => []),
}));

vi.mock("../webhook/handler", () => ({
  handleIssueComment: vi.fn(() => ({ status: 200, message: "OK" })),
  handlePullRequest: vi.fn(() => ({ status: 200, message: "OK" })),
}));

const { verifySignature } = await import("../webhook/verify");
const handler = await import("../webhook/handler");
const { createServer } = await import("../server");

function makeRequest(
  server: http.Server,
  opts: { method: string; path: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path: opts.path,
        method: opts.method,
        headers: opts.headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body: data }));
      }
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe("HTTP Server", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("responds to GET /health", async () => {
    const res = await makeRequest(server, { method: "GET", path: "/health" });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("repos");
    expect(body).toHaveProperty("activeTasks");
  });

  it("returns 404 for unknown routes", async () => {
    const res = await makeRequest(server, { method: "GET", path: "/unknown" });
    expect(res.status).toBe(404);
    expect(res.body).toBe("Not Found");
  });

  it("returns 404 for GET /webhook", async () => {
    const res = await makeRequest(server, { method: "GET", path: "/webhook" });
    expect(res.status).toBe(404);
  });

  it("returns 401 for invalid webhook signature", async () => {
    vi.mocked(verifySignature).mockReturnValue(false);

    const res = await makeRequest(server, {
      method: "POST",
      path: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(res.body).toBe("Unauthorized");
  });

  it("returns 400 for invalid JSON", async () => {
    vi.mocked(verifySignature).mockReturnValue(true);

    const res = await makeRequest(server, {
      method: "POST",
      path: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
      },
      body: "invalid json{{{",
    });
    expect(res.status).toBe(400);
    expect(res.body).toBe("Invalid JSON");
  });

  it("returns 200 for unconfigured repo", async () => {
    vi.mocked(verifySignature).mockReturnValue(true);

    const payload = JSON.stringify({
      repository: { full_name: "unknown/repo" },
      sender: { login: "user" },
    });
    const res = await makeRequest(server, {
      method: "POST",
      path: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("not configured");
  });

  it("dispatches pull_request events", async () => {
    vi.mocked(verifySignature).mockReturnValue(true);
    vi.mocked(handler.handlePullRequest).mockReturnValue({ status: 200, message: "OK - review triggered" });

    const payload = JSON.stringify({
      action: "opened",
      repository: { full_name: "owner/repo" },
      sender: { login: "user" },
      pull_request: { number: 1 },
    });
    const res = await makeRequest(server, {
      method: "POST",
      path: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(handler.handlePullRequest).toHaveBeenCalled();
  });

  it("dispatches issue_comment events", async () => {
    vi.mocked(verifySignature).mockReturnValue(true);
    vi.mocked(handler.handleIssueComment).mockReturnValue({ status: 200, message: "OK" });

    const payload = JSON.stringify({
      action: "created",
      repository: { full_name: "owner/repo" },
      sender: { login: "user" },
      issue: { number: 1 },
    });
    const res = await makeRequest(server, {
      method: "POST",
      path: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(handler.handleIssueComment).toHaveBeenCalled();
  });

  it("ignores unsupported event types", async () => {
    vi.mocked(verifySignature).mockReturnValue(true);

    const payload = JSON.stringify({
      repository: { full_name: "owner/repo" },
      sender: { login: "user" },
    });
    const res = await makeRequest(server, {
      method: "POST",
      path: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("event ignored");
  });
});
