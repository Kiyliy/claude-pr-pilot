export interface RepoConfig {
  dir: string;
  commands: Record<string, string>;  // command name → skill file path
  baseBranch?: string;
  installationId?: number;
  autoFix?: boolean;                  // auto-trigger /fix after review finds issues
  maxAutoFixRounds?: number;         // max review→fix→review cycles (default: 10)
  autoMerge?: boolean;               // auto-merge PR when review passes (🟢 Approved)
  autoVerify?: boolean;              // auto-run /verify after review passes (default: false)
  maxAutoVerifyRounds?: number;    // max verify→fix cycles (default: 3)
  taskTimeoutMs?: number;            // task timeout in ms (default: 86400000 = 24h, 0 = disabled)
}

export interface RepoMap {
  [fullName: string]: RepoConfig;
}

export interface TaskRequest {
  repoFullName: string;
  prNumber?: number;          // undefined for standalone /ask, /do, /fix
  issueNumber?: number;       // linked Issue number (from /ask → Issue binding)
  headBranch?: string | null;
  command: string;            // "review", "fix", "do", "ask"
  skillPath?: string;         // resolved SKILL.md path
  userInput?: string;         // user's extra text (additive to skill)
  tgChatId?: string;          // Telegram chat ID for output routing
  tgThreadId?: number;        // Telegram thread ID for output routing
  autoFixRound?: number;      // current auto-fix cycle (0 = not auto-fix, 1+ = auto-fix round)
  manualAutoFix?: boolean;    // manually triggered via /autofix command (bypasses autoFix config)
  verifyRound?: number;            // current product-verify cycle (0 = not in verify cycle, 1+ = verify round)
}

export interface ActiveTask {
  startedAt: number;
  prNumber?: number;
  headBranch: string | null;
  command: string;
  label?: string;             // short description for /status display
  tgChatId?: string;
  tgThreadId?: number;
  worktreeDir?: string;       // worktree path (for branch detection by webhook)
}

export interface TaskRejection {
  reason: string;             // human-readable rejection message
}

export interface ActiveTaskInfo {
  key: string;
  command: string;
  branch: string;
  elapsed: string;
  label?: string;
  tgChatId?: string;
  tgThreadId?: number;
}

export interface HandlerResult {
  status: number;
  message: string;
}

// --- Store types ---

export interface StandaloneTopicInfo {
  repo: string;
  branch?: string;
  prNumber?: number;
  issueNumber?: number;
  description?: string;  // user's task instruction, used for PR binding verification
}

export interface TelegramMessageRef {
  chatId: string;
  threadId: number;
  messageId: number;
}

export interface TopicMessage {
  role: string;
  author: string | null;
  content: string;
  createdAt: string;
}

// --- Telegram types ---

export interface TelegramConfig {
  botToken: string;
  adminUsers: (number | string)[];
  groups: Record<string, TelegramGroup>; // chatId (string) → group
}

export interface TelegramGroup {
  repo: string;   // "owner/repo" — must match a key in repos.json
  name: string;   // display name
  dir?: string;   // per-group working directory override (default: use repos.json dir)
  allowedUsers?: (number | string)[];  // per-group whitelist
  allowedCommands?: string[];          // whitelist of allowed commands (null/undefined = all allowed)
  syncPR?: boolean;                    // sync PR comments between GH ↔ TG (default: true)
}

// --- GitHub webhook payload (lightweight) ---

export interface WebhookPayload {
  action?: string;
  repository?: { full_name: string };
  sender?: { login: string };
  issue?: {
    number: number;
    pull_request?: unknown;
  };
  pull_request?: {
    number: number;
    title?: string;
    draft?: boolean;
    merged?: boolean;
    head?: { ref: string };
    base?: { ref: string };
    user?: { login: string };
  };
  comment?: {
    id: number;
    body: string;
    user?: { login: string };
    created_at: string;
  };
}

// --- Telegram update types (lightweight) ---

export interface TGUser {
  id: number;
  first_name?: string;
  username?: string;
}

export interface TGMessage {
  message_id: number;
  chat: { id: number };
  from?: TGUser;
  text?: string;
  message_thread_id?: number;
}

export interface TGCallbackQuery {
  id: string;
  data?: string;
  from: TGUser;
  message?: TGMessage;
}

export interface TGUpdate {
  update_id: number;
  message?: TGMessage;
  callback_query?: TGCallbackQuery;
}
