import type { ProviderDef } from "./types";

export const codexProvider: ProviderDef = {
  bin: "codex",
  args: ["exec", "--dangerously-bypass-approvals-and-sandbox", "-"],
  // Clear Claude-specific env vars to avoid interference
  clearEnv: ["CLAUDECODE", "IS_SANDBOX"],
};
