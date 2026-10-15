import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

vi.mock("../config", () => ({
  ROOT_DIR: "/app",
  BUILTIN_SKILLS: {
    ask: "skills/ask/SKILL.md",
    do: "skills/do/SKILL.md",
    review: "skills/review-pr/SKILL.md",
    fix: "skills/fix/SKILL.md",
  },
  getRepoConfig: vi.fn().mockReturnValue(null),
}));

vi.mock("../utils/logger", () => ({
  log: vi.fn(),
}));

const fs = (await import("fs")).default;
const config = await import("../config");
const { buildPrompt } = await import("../review/prompt");

describe("buildPrompt", () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(config.getRepoConfig).mockReturnValue(null);
  });

  it("includes skill path for PR-bound review", () => {
    const prompt = buildPrompt({
      repoFullName: "owner/repo",
      prNumber: 42,
      command: "review",
    });
    expect(prompt).toContain("SKILL.md");
    expect(prompt).toContain("PR #42");
  });

  it("includes skill path for standalone command", () => {
    const prompt = buildPrompt({
      repoFullName: "owner/repo",
      command: "do",
    });
    expect(prompt).toContain("SKILL.md");
    expect(prompt).not.toContain("PR #");
  });

  it("includes user input as additional instructions when skill exists", () => {
    const prompt = buildPrompt({
      repoFullName: "owner/repo",
      prNumber: 1,
      command: "review",
      userInput: "Focus on security issues",
    });
    expect(prompt).toContain("Additional instructions from the user");
    expect(prompt).toContain("Focus on security issues");
  });

  it("includes user input as primary instruction when no skill", () => {
    const prompt = buildPrompt({
      repoFullName: "owner/repo",
      prNumber: 1,
      command: "unknown_cmd",
      userInput: "Do something custom",
    });
    expect(prompt).toContain("The user's instruction");
    expect(prompt).toContain("Do something custom");
    expect(prompt).toContain("PR #1");
  });

  it("includes user input without PR context for standalone", () => {
    const prompt = buildPrompt({
      repoFullName: "owner/repo",
      command: "unknown_cmd",
      userInput: "Custom task",
    });
    expect(prompt).toContain("The user's instruction");
    expect(prompt).toContain("Custom task");
    expect(prompt).not.toContain("PR #");
  });

  it("includes GitHub API instructions for PR-bound tasks", () => {
    const prompt = buildPrompt({
      repoFullName: "owner/repo",
      prNumber: 10,
      command: "review",
    });
    expect(prompt).toContain("gh api");
    expect(prompt).toContain("owner/repo");
    expect(prompt).toContain("10");
  });

  it("does not include GitHub API instructions for standalone tasks", () => {
    const prompt = buildPrompt({
      repoFullName: "owner/repo",
      command: "do",
    });
    expect(prompt).not.toContain("IMPORTANT: When posting comments");
  });

  it("includes agent context when file exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const prompt = buildPrompt({
      repoFullName: "owner/repo",
      prNumber: 1,
      command: "review",
    });
    expect(prompt).toContain("agent context file");
  });

  it("uses explicit skillPath over built-in", () => {
    const prompt = buildPrompt({
      repoFullName: "owner/repo",
      prNumber: 1,
      command: "review",
      skillPath: "/custom/path/SKILL.md",
    });
    expect(prompt).toContain("/custom/path/SKILL.md");
  });

  it("includes auto-merge instruction when config has autoMerge", () => {
    vi.mocked(config.getRepoConfig).mockReturnValue({
      dir: "/tmp/repo",
      commands: {},
      autoMerge: true,
    });
    const prompt = buildPrompt({
      repoFullName: "owner/repo",
      prNumber: 5,
      command: "review",
    });
    expect(prompt).toContain("Auto-Merge");
    expect(prompt).toContain("owner/repo");
  });

  it("does not include auto-merge for review when autoVerify is enabled", () => {
    vi.mocked(config.getRepoConfig).mockReturnValue({
      dir: "/tmp/repo",
      commands: {},
      autoMerge: true,
      autoVerify: true,
    });
    const prompt = buildPrompt({
      repoFullName: "owner/repo",
      prNumber: 5,
      command: "review",
    });
    expect(prompt).not.toContain("Auto-Merge");
  });

  it("includes auto-merge for verify when autoVerify is enabled", () => {
    vi.mocked(config.getRepoConfig).mockReturnValue({
      dir: "/tmp/repo",
      commands: {},
      autoMerge: true,
      autoVerify: true,
    });
    const prompt = buildPrompt({
      repoFullName: "owner/repo",
      prNumber: 5,
      command: "verify",
    });
    expect(prompt).toContain("Auto-Merge");
    expect(prompt).toContain("VERIFY_STATUS");
  });

  it("does not include auto-merge for non-review commands", () => {
    vi.mocked(config.getRepoConfig).mockReturnValue({
      dir: "/tmp/repo",
      commands: {},
      autoMerge: true,
    });
    const prompt = buildPrompt({
      repoFullName: "owner/repo",
      prNumber: 5,
      command: "fix",
    });
    expect(prompt).not.toContain("Auto-Merge");
  });
});
