import { describe, it, expect } from "vitest";
import { getProviderDef, listProviders, isValidProvider } from "../providers";

describe("getProviderDef", () => {
  it("returns correct config for claude", () => {
    const def = getProviderDef("claude");
    expect(def.bin).toBe("claude");
    expect(def.args).toContain("-p");
    expect(def.env).toBeDefined();
  });

  it("returns correct config for codex", () => {
    const def = getProviderDef("codex");
    expect(def.bin).toBe("codex");
    expect(def.clearEnv).toBeDefined();
    expect(def.clearEnv).toContain("CLAUDECODE");
  });
});

describe("listProviders", () => {
  it("returns all registered providers", () => {
    const providers = listProviders();
    expect(providers).toContain("claude");
    expect(providers).toContain("codex");
    expect(providers).toHaveLength(2);
  });
});

describe("isValidProvider", () => {
  it("returns true for registered provider names", () => {
    expect(isValidProvider("claude")).toBe(true);
    expect(isValidProvider("codex")).toBe(true);
  });

  it("returns false for unknown names", () => {
    expect(isValidProvider("unknown")).toBe(false);
    expect(isValidProvider("")).toBe(false);
    expect(isValidProvider("__proto__")).toBe(false);
  });
});
