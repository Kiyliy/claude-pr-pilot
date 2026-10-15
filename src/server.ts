import http from "http";
import { log } from "./utils/logger";
import { WEBHOOK_SECRET, REPOS } from "./config";
import { verifySignature } from "./webhook/verify";
import { getActiveTasks } from "./review/manager";
import { handleIssueComment, handlePullRequest } from "./webhook/handler";
import type { WebhookPayload } from "./types";

export function createServer(): http.Server {
  return http.createServer((req, res) => {
    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          repos: Object.keys(REPOS),
          activeTasks: getActiveTasks(),
        })
      );
      return;
    }

    if (req.method !== "POST" || req.url !== "/webhook") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk;
    });

    req.on("end", () => {
      // Verify signature
      const signature = req.headers["x-hub-signature-256"] as
        | string
        | undefined;
      if (!verifySignature(body, signature, WEBHOOK_SECRET)) {
        log("Webhook signature verification failed");
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }

      // Parse event
      const event = req.headers["x-github-event"] as string;
      let payload: WebhookPayload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("Invalid JSON");
        return;
      }

      const repoFullName = payload.repository?.full_name;
      const sender: string = payload.sender?.login || "unknown";
      log(
        `Received event: ${event}, action: ${payload.action || "N/A"}, repo: ${repoFullName}, sender: ${sender}`
      );

      if (!repoFullName || !REPOS[repoFullName]) {
        res.writeHead(200);
        res.end("OK - repo not configured");
        return;
      }

      const repoConfig = REPOS[repoFullName];
      let result = { status: 200, message: "OK - event ignored" };

      if (event === "issue_comment") {
        result = handleIssueComment(payload, repoFullName, repoConfig);
      } else if (event === "pull_request") {
        result = handlePullRequest(payload, repoFullName, repoConfig);
      }

      res.writeHead(result.status);
      res.end(result.message);
    });
  });
}
