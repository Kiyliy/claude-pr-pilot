/**
 * Tests for autoLoadPR behavior in handlePullRequest.
 *
 * The autoLoadPR function tries to bind a newly opened PR to an existing
 * standalone topic (created by a /do or /fix task). The key invariant is:
 * a standalone topic may only be claimed by ONE PR. If a second PR is opened
 * while the same standalone task is still running, it must NOT be bound to the
 * same topic — otherwise both PRs' messages end up in the same Telegram topic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/logger", () => ({
  log: vi.fn(),
  logger: { warn: vi.fn() },
  formatDuration: vi.fn(() => "1s"),
}));

const mockRunTask = vi.fn();
const mockFindActiveStandaloneThread = vi.fn();
const mockConsumeAutoFixRound = vi.fn(() => ({ round: 0, manualAutoFix: false }));
const mockCleanupAutoFixState = vi.fn();

vi.mock("../review/manager", () => ({
  runTask: mockRunTask,
  findActiveStandaloneThread: mockFindActiveStandaloneThread,
  consumeAutoFixRound: mockConsumeAutoFixRound,
  cleanupAutoFixState: mockCleanupAutoFixState,
}));

vi.mock("../telegram/sync-github", () => ({
  syncGitHubCommentToTG: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config", () => ({
  // TELEGRAM_CONFIG must be truthy to trigger autoLoadPR in handlePullRequest
  TELEGRAM_CONFIG: { groups: { "-100": { repo: "owner/repo", syncPR: true } } },
  REPOS: {
    "owner/repo": {
      dir: "/tmp/repo",
      commands: {},
      baseBranch: "main",
      installationId: 12345,
    },
  },
  MENTION_PATTERN: /@mikoto(-devs)?/i,
  BOT_LOGIN: "mikoto-devs[bot]",
  resolveSkillPath: vi.fn(() => "skills/review-pr/SKILL.md"),
  isSyncPREnabled: vi.fn(() => true),
  getGroupsByRepo: vi.fn(() => [["-100", { repo: "owner/repo", syncPR: true }]]),
}));

vi.mock("../github/api", () => ({
  getPR: vi.fn().mockResolvedValue({ headBranch: "feat/test" }),
}));

const mockGetTopicThread = vi.fn().mockReturnValue(null);
const mockFindStandaloneTopicByPR = vi.fn().mockReturnValue(null);
const mockSetTopicThread = vi.fn();
const mockUpdateStandaloneTopicPR = vi.fn();
const mockFindPRByThread = vi.fn().mockReturnValue(null);

vi.mock("../store/db", () => ({
  getTopicThread: mockGetTopicThread,
  findStandaloneTopicByPR: mockFindStandaloneTopicByPR,
  setTopicThread: mockSetTopicThread,
  updateStandaloneTopicPR: mockUpdateStandaloneTopicPR,
  findPRByThread: mockFindPRByThread,
}));

vi.mock("../telegram/client", () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  topicExists: vi.fn().mockResolvedValue(true),
}));

const mockLoadPR = vi.fn().mockResolvedValue(undefined);
vi.mock("../telegram/commands", () => ({
  loadPR: mockLoadPR,
}));

const { handlePullRequest } = await import("../webhook/handler");

const repoConfig = {
  dir: "/tmp/repo",
  commands: {},
  baseBranch: "main",
  installationId: 12345,
};

function openedPayload(prNumber: number) {
  return {
    action: "opened" as const,
    pull_request: {
      number: prNumber,
      draft: false,
      head: { ref: `feat/${prNumber}` },
      base: { ref: "main" },
      title: `PR #${prNumber}`,
      user: { login: "dev" },
    },
  };
}

describe("autoLoadPR — standalone thread claim guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTopicThread.mockReturnValue(null);
    mockFindStandaloneTopicByPR.mockReturnValue(null);
    mockFindPRByThread.mockReturnValue(null);
    mockFindActiveStandaloneThread.mockReturnValue(null);
    mockLoadPR.mockResolvedValue(undefined);
  });

  it("binds new PR to active standalone thread when thread is unclaimed", () => {
    // Thread 500 is active (a /do task is running) and not yet claimed by any PR
    mockFindActiveStandaloneThread.mockReturnValue(500);
    mockFindPRByThread.mockReturnValue(null); // unclaimed

    handlePullRequest(openedPayload(10), "owner/repo", repoConfig);

    // PR #10 should be bound to thread 500
    expect(mockSetTopicThread).toHaveBeenCalledWith("-100", 10, 500);
    expect(mockUpdateStandaloneTopicPR).toHaveBeenCalledWith("-100", 500, 10);
    // No new topic created via loadPR
    expect(mockLoadPR).not.toHaveBeenCalled();
  });

  it("does NOT bind new PR to active standalone thread already claimed by another PR", () => {
    // Thread 500 is active but already claimed by PR #9 (the first PR was bound)
    mockFindActiveStandaloneThread.mockReturnValue(500);
    mockFindPRByThread.mockReturnValue(9); // claimed by PR #9

    handlePullRequest(openedPayload(11), "owner/repo", repoConfig);

    // PR #11 must NOT be bound to thread 500 (that would cause both PRs' messages
    // to appear in the same Telegram topic — the 消息串 bug)
    expect(mockSetTopicThread).not.toHaveBeenCalledWith("-100", 11, 500);
    expect(mockUpdateStandaloneTopicPR).not.toHaveBeenCalledWith("-100", 500, 11);
    // A new topic must be created for PR #11 instead
    expect(mockLoadPR).toHaveBeenCalledWith("-100", "owner/repo", 12345, 11);
  });

  it("skips autoLoadPR entirely when no active standalone thread exists", () => {
    mockFindActiveStandaloneThread.mockReturnValue(null);

    handlePullRequest(openedPayload(12), "owner/repo", repoConfig);

    // No binding, no new topic (no installationId path falls through to loadPR but
    // REPOS has installationId so loadPR IS called here)
    expect(mockSetTopicThread).not.toHaveBeenCalled();
    expect(mockUpdateStandaloneTopicPR).not.toHaveBeenCalled();
    // loadPR is called to create a standard topic
    expect(mockLoadPR).toHaveBeenCalledWith("-100", "owner/repo", 12345, 12);
  });

  it("re-binds idempotently when active thread is already claimed by the SAME PR", () => {
    // Race-condition scenario: the real-time CREATED_PR handler already set
    // standalone_topics.pr_number = 15, so findPRByThread returns 15.
    // autoLoadPR must treat this as idempotent (not fall through to loadPR).
    mockFindActiveStandaloneThread.mockReturnValue(500);
    mockFindPRByThread.mockReturnValue(15); // already claimed by same PR #15

    handlePullRequest(openedPayload(15), "owner/repo", repoConfig);

    // Should still call setTopicThread / updateStandaloneTopicPR to ensure pr_topics is populated
    expect(mockSetTopicThread).toHaveBeenCalledWith("-100", 15, 500);
    expect(mockUpdateStandaloneTopicPR).toHaveBeenCalledWith("-100", 500, 15);
    // Must NOT create a new topic via loadPR
    expect(mockLoadPR).not.toHaveBeenCalled();
  });

  it("two sequential PRs opened while same task is running: each gets its own topic", () => {
    // Simulate: task in thread 500 is running
    // PR #20 opens first → thread 500 is unclaimed → PR #20 gets thread 500
    // PR #21 opens second → thread 500 is now claimed by PR #20 → PR #21 gets new topic

    mockFindActiveStandaloneThread.mockReturnValue(500);

    // First PR: thread 500 is unclaimed
    mockFindPRByThread.mockReturnValue(null);
    handlePullRequest(openedPayload(20), "owner/repo", repoConfig);

    expect(mockSetTopicThread).toHaveBeenCalledWith("-100", 20, 500);
    expect(mockLoadPR).not.toHaveBeenCalled();

    // Simulate DB now reflects PR #20 → thread 500
    mockFindPRByThread.mockReturnValue(20);

    // Second PR: thread 500 is now claimed by PR #20
    handlePullRequest(openedPayload(21), "owner/repo", repoConfig);

    // PR #21 must NOT use thread 500
    expect(mockSetTopicThread).not.toHaveBeenCalledWith("-100", 21, 500);
    // PR #21 should get its own topic via loadPR
    expect(mockLoadPR).toHaveBeenCalledWith("-100", "owner/repo", 12345, 21);
  });
});
