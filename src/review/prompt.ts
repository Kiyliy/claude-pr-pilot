import fs from "fs";
import path from "path";
import { BUILTIN_SKILLS, ROOT_DIR, getRepoConfig } from "../config";
import type { TaskRequest } from "../types";

const GH_API_INSTRUCTION = `IMPORTANT: When posting comments to the PR, you MUST use the REST API via "gh api" instead of "gh pr comment". Example:
gh api repos/{owner}/{repo}/issues/{number}/comments -f body="your comment here"
This is required because the authentication token is a GitHub App installation token that does not support GraphQL mutations.`;

export function buildPrompt(task: TaskRequest): string {
  const parts: string[] = [];

  // [1] Agent context (per-repo)
  const [owner, repo] = task.repoFullName.split("/");
  const agentPath = path.join(ROOT_DIR, "data", owner, repo, "agent.md");
  if (fs.existsSync(agentPath)) {
    parts.push(`Read the agent context file at ${agentPath} for repository background and interaction rules. Follow those rules throughout this task.`);
  }

  // [2] Skill instructions (explicit skillPath > built-in fallback)
  const skillPath = task.skillPath || BUILTIN_SKILLS[task.command];
  if (skillPath) {
    const absSkill = path.isAbsolute(skillPath)
      ? skillPath
      : path.join(ROOT_DIR, skillPath);
    if (task.prNumber) {
      parts.push(`Then follow the skill instructions at ${absSkill} to ${task.command} PR #${task.prNumber}.`);
    } else {
      parts.push(`Follow the skill instructions at ${absSkill}.`);
    }
  }

  // [2.5] Issue context (for /ask follow-up or /do with linked issue)
  if (task.issueNumber) {
    if (task.command === "ask") {
      parts.push(`This conversation is linked to Issue #${task.issueNumber}. When posting your answer, add it as a comment to this Issue using:\ngh api repos/${task.repoFullName}/issues/${task.issueNumber}/comments -f body="your answer here"\nDo NOT create a new Issue — use the existing one.`);
    } else {
      // For /do, /fix etc: reference the linked Issue in the PR body
      parts.push(`This task is linked to Issue #${task.issueNumber}. When creating a PR, include \`Closes #${task.issueNumber}\` in the PR body to close it. You do NOT need to create a new Issue — use #${task.issueNumber} as the reference.`);
    }
  }

  // [3] User input (additive — extra focus, description, or free-form instruction)
  if (task.userInput) {
    if (skillPath) {
      parts.push(`Additional instructions from the user:\n${task.userInput}`);
    } else {
      // No skill file — user input IS the full instruction
      if (task.prNumber) {
        parts.push(`You are working on PR #${task.prNumber}. The user's instruction:\n${task.userInput}`);
      } else {
        parts.push(`The user's instruction:\n${task.userInput}`);
      }
    }
  }

  // [4] Context is injected later by loadTaskContext() in spawnTaskProcess

  // GitHub API constraint for PR-bound or Issue-bound tasks
  if (task.prNumber) {
    parts.push(
      GH_API_INSTRUCTION
        .replace("{owner}/{repo}", task.repoFullName)
        .replace("{number}", String(task.prNumber))
    );
  } else if (task.command === "ask") {
    // /ask tasks need gh api access for Issue creation/comments
    parts.push(
      `IMPORTANT: When creating Issues or posting comments, use the REST API via "gh api". ` +
      `Example: gh api repos/${task.repoFullName}/issues -f title="..." -f body="..."\n` +
      `This is required because the authentication token is a GitHub App installation token that does not support GraphQL mutations.`
    );
  }

  // Auto-merge: inject instruction for AI to merge PR when review passes
  const config = getRepoConfig(task.repoFullName);
  const shouldInjectAutoMerge = config?.autoMerge
    && task.prNumber
    && (
      task.command === "verify"
      || (task.command === "review" && !config.autoVerify)
    );
  if (shouldInjectAutoMerge) {
    const triggerCondition = task.command === "review"
      ? "当且仅当你的 Review Verdict 为 🟢 Approved 时"
      : "当且仅当你的 VERIFY_STATUS 为 passed 时";
    const commentType = task.command === "review" ? "review" : "verify";
    const notCondition = task.command === "review"
      ? "Verdict 不是 🟢 Approved"
      : "VERIFY_STATUS 不是 passed";
    parts.push(`## Auto-Merge 指令
${triggerCondition}，执行以下操作：
1. 使用 REST API 合并 PR：
   gh api repos/${task.repoFullName}/pulls/${task.prNumber}/merge -X PUT -f merge_method=squash
2. 如果合并成功：
   a. 在 ${commentType} comment 末尾追加：✅ 已自动合并
   b. 在 stdout 打印：MERGE_STATUS: success
3. 如果合并失败：
   a. 在 ${commentType} comment 末尾追加：⚠️ 自动合并失败: [错误信息]
   b. 在 stdout 打印：MERGE_STATUS: failed
注意：如果${notCondition}，绝对不要执行合并。`);
  }

  return parts.join("\n\n");
}
