import type { ProviderDef } from "./types";

const modelArgs = process.env.CLAUDE_MODEL ? ["--model", process.env.CLAUDE_MODEL] : [];

export const claudeProvider: ProviderDef = {
  bin: "claude",
  args: ["-p", "--dangerously-skip-permissions", ...modelArgs],
  env: {
    // Required by Claude Code CLI >= 2.1.x when running as root/under sudo
    CLAUDECODE: "",
    IS_SANDBOX: "1",
  },
};
