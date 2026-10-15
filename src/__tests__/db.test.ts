import { describe, it, expect, vi, afterEach } from "vitest";
import RealDatabase from "better-sqlite3";

// memDb is set by the MockDatabase constructor in each getStore() call
let memDb: InstanceType<typeof RealDatabase>;

describe("store/db", () => {
  async function getStore() {
    vi.resetModules();
    vi.doMock("../utils/logger", () => ({ log: vi.fn() }));
    vi.doMock("../config", () => ({ ROOT_DIR: "/tmp/test-app" }));
    vi.doMock("fs", () => ({
      default: { mkdirSync: vi.fn(), existsSync: vi.fn(() => false), readFileSync: vi.fn(() => "{}") },
    }));
    vi.doMock("better-sqlite3", async () => {
      const actual = await vi.importActual<typeof import("better-sqlite3")>("better-sqlite3");
      return {
        default: class MockDatabase {
          constructor(_path: string) {
            memDb = new actual.default(":memory:");
            return memDb;
          }
        },
      };
    });
    return import("../store/db");
  }

  afterEach(() => {
    try { memDb?.close(); } catch {}
  });

  describe("PR Topics", () => {
    it("set and get topic thread", async () => {
      const store = await getStore();
      store.setTopicThread("-100", 42, 1001);
      expect(store.getTopicThread("-100", 42)).toBe(1001);
    });

    it("returns null for missing topic", async () => {
      const store = await getStore();
      expect(store.getTopicThread("-100", 999)).toBeNull();
    });

    it("overwrites existing topic", async () => {
      const store = await getStore();
      store.setTopicThread("-100", 42, 1001);
      store.setTopicThread("-100", 42, 2002);
      expect(store.getTopicThread("-100", 42)).toBe(2002);
    });

    it("getAllTopics returns all topics for a chat", async () => {
      const store = await getStore();
      store.setTopicThread("-100", 1, 1001);
      store.setTopicThread("-100", 2, 1002);
      store.setTopicThread("-200", 3, 2003);
      expect(store.getAllTopics("-100")).toEqual({ "1": 1001, "2": 1002 });
    });

    it("getAllTopics returns empty object when no topics", async () => {
      const store = await getStore();
      expect(store.getAllTopics("-999")).toEqual({});
    });

    it("removeTopicThread cleans up related data", async () => {
      const store = await getStore();
      store.setTopicThread("-100", 42, 1001);
      store.setMessageRef("owner/repo", 42, 999, { chatId: "-100", threadId: 1001, messageId: 5555 });
      store.addTopicMessage("-100", 1001, "user", "test", "dev");

      store.removeTopicThread("-100", 42, "owner/repo");

      expect(store.getTopicThread("-100", 42)).toBeNull();
      expect(store.getMessageRef("owner/repo", 42, 999)).toBeNull();
      expect(store.getTopicMessages("-100", 1001)).toEqual([]);
    });

    it("removeTopicThread without repo still cleans message_refs by PR", async () => {
      const store = await getStore();
      store.setTopicThread("-100", 42, 1001);
      store.setMessageRef("owner/repo", 42, 999, { chatId: "-100", threadId: 1001, messageId: 5555 });

      store.removeTopicThread("-100", 42);

      expect(store.getTopicThread("-100", 42)).toBeNull();
      expect(store.getMessageRef("owner/repo", 42, 999)).toBeNull();
    });

    it("removeTopicThread is safe when topic does not exist", async () => {
      const store = await getStore();
      // Should not throw
      expect(() => store.removeTopicThread("-100", 9999)).not.toThrow();
    });

    it("isolates topics between different chats", async () => {
      const store = await getStore();
      store.setTopicThread("-100", 42, 1001);
      store.setTopicThread("-200", 42, 2001);

      expect(store.getTopicThread("-100", 42)).toBe(1001);
      expect(store.getTopicThread("-200", 42)).toBe(2001);
    });
  });

  describe("Standalone Topics", () => {
    it("set and get standalone topic", async () => {
      const store = await getStore();
      store.setStandaloneTopic("-100", 1001, { repo: "owner/repo", branch: "feat/test", prNumber: 42 });
      expect(store.getStandaloneTopic("-100", 1001)).toEqual({
        repo: "owner/repo",
        branch: "feat/test",
        prNumber: 42,
      });
    });

    it("returns null for missing standalone topic", async () => {
      const store = await getStore();
      expect(store.getStandaloneTopic("-100", 999)).toBeNull();
    });

    it("stores topic without branch/PR", async () => {
      const store = await getStore();
      store.setStandaloneTopic("-100", 2002, { repo: "owner/repo" });
      expect(store.getStandaloneTopic("-100", 2002)).toEqual({
        repo: "owner/repo",
        branch: undefined,
        prNumber: undefined,
      });
    });

    it("updateStandaloneTopicPR updates PR number", async () => {
      const store = await getStore();
      store.setStandaloneTopic("-100", 1001, { repo: "owner/repo" });
      store.updateStandaloneTopicPR("-100", 1001, 42);
      expect(store.getStandaloneTopic("-100", 1001)!.prNumber).toBe(42);
    });

    it("updateStandaloneTopicPR updates PR and branch", async () => {
      const store = await getStore();
      store.setStandaloneTopic("-100", 1001, { repo: "owner/repo" });
      store.updateStandaloneTopicPR("-100", 1001, 42, "feat/new");
      const info = store.getStandaloneTopic("-100", 1001)!;
      expect(info.prNumber).toBe(42);
      expect(info.branch).toBe("feat/new");
    });

    it("findStandaloneTopicByPR finds topic by PR number", async () => {
      const store = await getStore();
      store.setStandaloneTopic("-100", 1001, { repo: "owner/repo", prNumber: 42 });
      expect(store.findStandaloneTopicByPR("-100", 42)).toBe(1001);
      expect(store.findStandaloneTopicByPR("-100", 999)).toBeNull();
    });

    it("overwrites standalone topic on same chat+thread", async () => {
      const store = await getStore();
      store.setStandaloneTopic("-100", 1001, { repo: "owner/repo", branch: "feat/old" });
      store.setStandaloneTopic("-100", 1001, { repo: "owner/repo2", branch: "feat/new" });
      const info = store.getStandaloneTopic("-100", 1001)!;
      expect(info.repo).toBe("owner/repo2");
      expect(info.branch).toBe("feat/new");
    });

    it("stores and retrieves issueNumber", async () => {
      const store = await getStore();
      store.setStandaloneTopic("-100", 1001, { repo: "owner/repo", issueNumber: 10 });
      const info = store.getStandaloneTopic("-100", 1001)!;
      expect(info.issueNumber).toBe(10);
    });

    it("updateStandaloneTopicIssue updates issue number", async () => {
      const store = await getStore();
      store.setStandaloneTopic("-100", 1001, { repo: "owner/repo" });
      store.updateStandaloneTopicIssue("-100", 1001, 55);
      const info = store.getStandaloneTopic("-100", 1001)!;
      expect(info.issueNumber).toBe(55);
    });
  });

  describe("Message Refs", () => {
    it("set and get message ref", async () => {
      const store = await getStore();
      const ref = { chatId: "-100", threadId: 1001, messageId: 5555 };
      store.setMessageRef("owner/repo", 42, 999, ref);
      expect(store.getMessageRef("owner/repo", 42, 999)).toEqual(ref);
    });

    it("returns null for missing message ref", async () => {
      const store = await getStore();
      expect(store.getMessageRef("owner/repo", 42, 999)).toBeNull();
    });

    it("overwrites existing message ref", async () => {
      const store = await getStore();
      store.setMessageRef("owner/repo", 42, 999, { chatId: "-100", threadId: 1001, messageId: 5555 });
      store.setMessageRef("owner/repo", 42, 999, { chatId: "-200", threadId: 2002, messageId: 6666 });
      expect(store.getMessageRef("owner/repo", 42, 999)).toEqual({ chatId: "-200", threadId: 2002, messageId: 6666 });
    });

    it("isolates refs by repo", async () => {
      const store = await getStore();
      store.setMessageRef("owner/repo1", 42, 999, { chatId: "-100", threadId: 1001, messageId: 1111 });
      store.setMessageRef("owner/repo2", 42, 999, { chatId: "-100", threadId: 1001, messageId: 2222 });
      expect(store.getMessageRef("owner/repo1", 42, 999)!.messageId).toBe(1111);
      expect(store.getMessageRef("owner/repo2", 42, 999)!.messageId).toBe(2222);
    });

    it("isolates refs by prNumber", async () => {
      const store = await getStore();
      store.setMessageRef("owner/repo", 1, 999, { chatId: "-100", threadId: 1001, messageId: 1111 });
      store.setMessageRef("owner/repo", 2, 999, { chatId: "-100", threadId: 1001, messageId: 2222 });
      expect(store.getMessageRef("owner/repo", 1, 999)!.messageId).toBe(1111);
      expect(store.getMessageRef("owner/repo", 2, 999)!.messageId).toBe(2222);
    });
  });

  describe("findPRByThread", () => {
    it("finds PR in pr_topics", async () => {
      const store = await getStore();
      store.setTopicThread("-100", 42, 1001);
      expect(store.findPRByThread("-100", 1001)).toBe(42);
    });

    it("finds PR in standalone_topics", async () => {
      const store = await getStore();
      store.setStandaloneTopic("-100", 2002, { repo: "owner/repo", prNumber: 55 });
      expect(store.findPRByThread("-100", 2002)).toBe(55);
    });

    it("returns null when no PR found", async () => {
      const store = await getStore();
      expect(store.findPRByThread("-100", 9999)).toBeNull();
    });

    it("prefers pr_topics over standalone_topics", async () => {
      const store = await getStore();
      store.setTopicThread("-100", 42, 1001);
      store.setStandaloneTopic("-100", 1001, { repo: "owner/repo", prNumber: 55 });
      expect(store.findPRByThread("-100", 1001)).toBe(42);
    });

    it("ignores standalone topics without prNumber", async () => {
      const store = await getStore();
      store.setStandaloneTopic("-100", 3003, { repo: "owner/repo" });
      expect(store.findPRByThread("-100", 3003)).toBeNull();
    });
  });

  describe("Topic Messages", () => {
    it("add and get messages", async () => {
      const store = await getStore();
      store.addTopicMessage("-100", 1001, "user", "hello", "dev");
      store.addTopicMessage("-100", 1001, "assistant", "hi there", "claude");

      const messages = store.getTopicMessages("-100", 1001);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("hello");
      expect(messages[0].author).toBe("dev");
      expect(messages[1].role).toBe("assistant");
    });

    it("returns empty array for no messages", async () => {
      const store = await getStore();
      expect(store.getTopicMessages("-100", 9999)).toEqual([]);
    });

    it("respects limit parameter", async () => {
      const store = await getStore();
      for (let i = 0; i < 10; i++) {
        store.addTopicMessage("-100", 1001, "user", `msg ${i}`, "dev");
      }
      const messages = store.getTopicMessages("-100", 1001, 3);
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe("msg 7");
      expect(messages[2].content).toBe("msg 9");
    });

    it("stores message without author", async () => {
      const store = await getStore();
      store.addTopicMessage("-100", 1001, "command", "/do fix bug");
      const messages = store.getTopicMessages("-100", 1001);
      expect(messages[0].author).toBeNull();
    });

    it("returns messages in chronological order", async () => {
      const store = await getStore();
      store.addTopicMessage("-100", 1001, "user", "first");
      store.addTopicMessage("-100", 1001, "assistant", "second");
      store.addTopicMessage("-100", 1001, "user", "third");

      const messages = store.getTopicMessages("-100", 1001);
      expect(messages[0].content).toBe("first");
      expect(messages[1].content).toBe("second");
      expect(messages[2].content).toBe("third");
    });

    it("isolates messages between different threads", async () => {
      const store = await getStore();
      store.addTopicMessage("-100", 1001, "user", "thread 1 msg");
      store.addTopicMessage("-100", 2002, "user", "thread 2 msg");

      expect(store.getTopicMessages("-100", 1001)).toHaveLength(1);
      expect(store.getTopicMessages("-100", 2002)).toHaveLength(1);
      expect(store.getTopicMessages("-100", 1001)[0].content).toBe("thread 1 msg");
    });

    it("isolates messages between different chats", async () => {
      const store = await getStore();
      store.addTopicMessage("-100", 1001, "user", "chat A");
      store.addTopicMessage("-200", 1001, "user", "chat B");

      expect(store.getTopicMessages("-100", 1001)[0].content).toBe("chat A");
      expect(store.getTopicMessages("-200", 1001)[0].content).toBe("chat B");
    });

    it("has createdAt field populated", async () => {
      const store = await getStore();
      store.addTopicMessage("-100", 1001, "user", "test");
      const messages = store.getTopicMessages("-100", 1001);
      expect(messages[0].createdAt).toBeDefined();
      expect(messages[0].createdAt.length).toBeGreaterThan(0);
    });

    it("default limit of 50 works correctly", async () => {
      const store = await getStore();
      for (let i = 0; i < 60; i++) {
        store.addTopicMessage("-100", 1001, "user", `msg ${i}`);
      }
      const messages = store.getTopicMessages("-100", 1001);
      expect(messages).toHaveLength(50);
      // Should get the last 50 messages (10-59)
      expect(messages[0].content).toBe("msg 10");
      expect(messages[49].content).toBe("msg 59");
    });
  });

  describe("Autofix State", () => {
    it("getAutofixState returns null for missing key", async () => {
      const store = await getStore();
      expect(store.getAutofixState("owner/repo#42")).toBeNull();
    });

    it("setAutofixRounds creates a new row and getAutofixState retrieves it", async () => {
      const store = await getStore();
      store.setAutofixRounds("owner/repo#42", 3, true);
      const state = store.getAutofixState("owner/repo#42");
      expect(state).not.toBeNull();
      expect(state!.rounds).toBe(3);
      expect(state!.isManual).toBe(true);
      expect(state!.headSha).toBeNull();
    });

    it("setAutofixRounds updates existing row and preserves head_sha", async () => {
      const store = await getStore();
      store.setAutofixHeadSHA("owner/repo#42", "abc123");
      store.setAutofixRounds("owner/repo#42", 2, false);
      const state = store.getAutofixState("owner/repo#42");
      expect(state!.rounds).toBe(2);
      expect(state!.isManual).toBe(false);
      expect(state!.headSha).toBe("abc123");
    });

    it("setAutofixHeadSHA creates a placeholder row with rounds=0", async () => {
      const store = await getStore();
      store.setAutofixHeadSHA("owner/repo#10", "sha-xyz");
      const state = store.getAutofixState("owner/repo#10");
      expect(state).not.toBeNull();
      expect(state!.headSha).toBe("sha-xyz");
      expect(state!.rounds).toBe(0);
      expect(state!.isManual).toBe(false);
    });

    it("setAutofixHeadSHA updates existing row and preserves rounds", async () => {
      const store = await getStore();
      store.setAutofixRounds("owner/repo#10", 5, true);
      store.setAutofixHeadSHA("owner/repo#10", "sha-new");
      const state = store.getAutofixState("owner/repo#10");
      expect(state!.headSha).toBe("sha-new");
      expect(state!.rounds).toBe(5);
      expect(state!.isManual).toBe(true);
    });

    it("clearAutofixHeadSHA sets head_sha to null", async () => {
      const store = await getStore();
      store.setAutofixHeadSHA("owner/repo#42", "abc123");
      store.clearAutofixHeadSHA("owner/repo#42");
      const state = store.getAutofixState("owner/repo#42");
      expect(state!.headSha).toBeNull();
    });

    it("clearAutofixRoundsAndManual keeps row when head_sha is not null", async () => {
      const store = await getStore();
      store.setAutofixHeadSHA("owner/repo#42", "abc123");
      store.setAutofixRounds("owner/repo#42", 3, true);
      store.clearAutofixRoundsAndManual("owner/repo#42");
      const state = store.getAutofixState("owner/repo#42");
      expect(state).not.toBeNull();
      expect(state!.rounds).toBe(0);
      expect(state!.isManual).toBe(false);
      expect(state!.headSha).toBe("abc123");
    });

    it("clearAutofixRoundsAndManual deletes row when head_sha is null", async () => {
      const store = await getStore();
      store.setAutofixRounds("owner/repo#42", 3, true);
      store.clearAutofixRoundsAndManual("owner/repo#42");
      expect(store.getAutofixState("owner/repo#42")).toBeNull();
    });

    it("clearAutofixRoundsAndManual is safe when key does not exist", async () => {
      const store = await getStore();
      expect(() => store.clearAutofixRoundsAndManual("owner/repo#999")).not.toThrow();
    });

    it("deleteAutofixState removes specific row", async () => {
      const store = await getStore();
      store.setAutofixRounds("owner/repo#1", 2, false);
      store.setAutofixRounds("owner/repo#2", 3, true);
      store.deleteAutofixState("owner/repo#1");
      expect(store.getAutofixState("owner/repo#1")).toBeNull();
      expect(store.getAutofixState("owner/repo#2")).not.toBeNull();
    });

    it("clearAllAutofixState removes all rows", async () => {
      const store = await getStore();
      store.setAutofixRounds("owner/repo#1", 2, false);
      store.setAutofixRounds("owner/repo#2", 3, true);
      store.clearAllAutofixState();
      expect(store.getAutofixState("owner/repo#1")).toBeNull();
      expect(store.getAutofixState("owner/repo#2")).toBeNull();
    });
  });

  describe("Autoverify State", () => {
    it("getAutoverifyState returns null for unknown key", async () => {
      const store = await getStore();
      expect(store.getAutoverifyState("owner/repo#1")).toBeNull();
    });

    it("setAutoverifyRounds creates row and getAutoverifyState returns it", async () => {
      const store = await getStore();
      store.setAutoverifyRounds("owner/repo#1", 2);
      expect(store.getAutoverifyState("owner/repo#1")).toEqual({ verifyRounds: 2 });
    });

    it("setAutoverifyRounds updates existing row", async () => {
      const store = await getStore();
      store.setAutoverifyRounds("owner/repo#1", 1);
      store.setAutoverifyRounds("owner/repo#1", 3);
      expect(store.getAutoverifyState("owner/repo#1")).toEqual({ verifyRounds: 3 });
    });

    it("deleteAutoverifyState removes the row", async () => {
      const store = await getStore();
      store.setAutoverifyRounds("owner/repo#1", 1);
      store.deleteAutoverifyState("owner/repo#1");
      expect(store.getAutoverifyState("owner/repo#1")).toBeNull();
    });

    it("clearAllAutoverifyState removes all rows", async () => {
      const store = await getStore();
      store.setAutoverifyRounds("owner/repo#1", 1);
      store.setAutoverifyRounds("owner/repo#2", 2);
      store.clearAllAutoverifyState();
      expect(store.getAutoverifyState("owner/repo#1")).toBeNull();
      expect(store.getAutoverifyState("owner/repo#2")).toBeNull();
    });
  });
});
