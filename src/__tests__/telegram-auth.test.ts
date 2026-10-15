import { describe, it, expect, vi, beforeEach } from "vitest";
import { matchesUser } from "../telegram/auth";

// Mock config to control TELEGRAM_CONFIG
vi.mock("../config", () => ({
  TELEGRAM_CONFIG: {
    botToken: "test-token",
    adminUsers: [111, "admin_user"],
    groups: {
      "-100123": {
        repo: "owner/repo",
        name: "Test Group",
        allowedUsers: [222, "group_user"],
      },
      "-100456": {
        repo: "owner/other",
        name: "No Users",
      },
    },
  },
}));

// Re-import after mock
const auth = await import("../telegram/auth");

describe("matchesUser", () => {
  it("matches by numeric userId", () => {
    expect(matchesUser([111, 222], 111)).toBe(true);
    expect(matchesUser([111, 222], 333)).toBe(false);
  });

  it("matches by username string", () => {
    expect(matchesUser(["admin_user", "other"], 999, "admin_user")).toBe(true);
    expect(matchesUser(["admin_user"], 999, "other")).toBe(false);
  });

  it("does not match without username", () => {
    expect(matchesUser(["admin_user"], 999)).toBe(false);
  });
});

describe("isAllowed", () => {
  it("allows global admin by userId", () => {
    expect(auth.isAllowed("-100123", 111)).toBe(true);
  });

  it("allows global admin by username", () => {
    expect(auth.isAllowed("-100123", 999, "admin_user")).toBe(true);
  });

  it("allows per-group user by userId", () => {
    expect(auth.isAllowed("-100123", 222)).toBe(true);
  });

  it("allows per-group user by username", () => {
    expect(auth.isAllowed("-100123", 999, "group_user")).toBe(true);
  });

  it("denies unrecognized user", () => {
    expect(auth.isAllowed("-100123", 999, "stranger")).toBe(false);
  });

  it("denies user in group without allowedUsers", () => {
    expect(auth.isAllowed("-100456", 999, "stranger")).toBe(false);
  });
});

describe("isAdmin", () => {
  it("returns true for admin userId", () => {
    expect(auth.isAdmin(111)).toBe(true);
  });

  it("returns true for admin username", () => {
    expect(auth.isAdmin(999, "admin_user")).toBe(true);
  });

  it("returns false for non-admin", () => {
    expect(auth.isAdmin(222, "group_user")).toBe(false);
  });
});
