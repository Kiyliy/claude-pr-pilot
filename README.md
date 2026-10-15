# Claude PR Pilot

> A self-hosted AI teammate for your repos. It reviews every PR with Claude Code, fixes what it finds, verifies the result like a PM, and lets you drive all of it from Telegram.

![typescript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![node](https://img.shields.io/badge/Node.js-18+-339933?logo=nodedotjs&logoColor=white)
![claude code](https://img.shields.io/badge/Claude_Code-D97757?logo=claude&logoColor=white)
![codex](https://img.shields.io/badge/Codex-supported-black)
![telegram](https://img.shields.io/badge/Telegram-bot-26A5E4?logo=telegram&logoColor=white)
![license](https://img.shields.io/badge/license-MIT-blue)

```text
 PR opened / pushed ─┐
 @mikoto /command  ──┼─► webhook ─► task queue ─► Claude Code / Codex (isolated git worktree)
 Telegram /command ──┘                                   │
                                                         ▼
          review comment ─► auto-fix ─► re-review ─► product verify ─► auto-merge
                     └──────────── every step mirrored to a Telegram topic ────────────┘
```

## What it does

- **Reviews every PR.** On `opened` / `synchronize` it runs a staff-engineer review skill and posts a structured review comment from your own GitHub App bot.
- **Fixes its own findings.** With `autoFix`, it loops review → fix → review until the PR is approved or a round limit is hit.
- **Verifies like a PM.** With `autoVerify`, a second skill checks requirements, runnability and product logic after the review passes.
- **Merges when green.** Optional `autoMerge` once review (and verify) pass.
- **Takes orders in comments.** `@mikoto /review`, `/fix`, `/do`, `/ask`, `/autofix`, `/verify` on any PR or Issue.
- **Lives in Telegram.** Each PR gets its own forum topic with comments synced both ways. Run `/do add rate limiting` from chat and it opens a new PR. `/pm` breaks a requirement into Issues and dispatches them one by one.
- **Pluggable agents.** Switch between Claude Code and Codex per chat with `/provider`.
- **Skills are just Markdown.** Every command maps to a `SKILL.md` you can override per repo.

## Quick start

Requirements: Node.js 18+, [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (or Codex) installed and logged in, and a [GitHub App](https://docs.github.com/en/apps/creating-github-apps) with read/write access to pull requests, issues and contents.

```bash
git clone https://github.com/Kiyliy/claude-pr-pilot.git
cd claude-pr-pilot
npm install

cp .env.example .env                    # webhook secret, GitHub App ID + key path
cp repos.example.json repos.json        # the repos to watch
cp telegram.example.json telegram.json  # optional, delete to disable Telegram
```

Point each repo's webhook at the server (`pull_request` + `issue_comment` events):

```bash
gh api repos/OWNER/REPO/hooks --method POST --input - <<'EOF'
{
  "name": "web",
  "active": true,
  "events": ["pull_request", "issue_comment"],
  "config": { "url": "https://your-server:9876/webhook", "content_type": "json", "secret": "<WEBHOOK_SECRET>" }
}
EOF
```

Run it:

```bash
npm start                      # foreground
pm2 start ecosystem.config.js  # or keep it alive with PM2
curl localhost:9876/health
```

A step-by-step guide in Chinese, from creating the GitHub App to setting up Telegram, lives in [`skills/guide/SKILL.md`](skills/guide/SKILL.md).

## Configuration

### `repos.json`

| Field | Default | Description |
| --- | --- | --- |
| `dir` | required | Absolute path to a local clone; tasks run in worktrees under it |
| `baseBranch` | all | Only handle PRs targeting this branch |
| `installationId` | | GitHub App installation ID for this repo's owner |
| `commands` | built-ins | Map a command to your own skill file, e.g. `{ "review": "skills/my-review.md" }` |
| `autoFix` / `maxAutoFixRounds` | off / 10 | Review → fix loop |
| `autoVerify` / `maxAutoVerifyRounds` | off / 3 | Product verification after review passes |
| `autoMerge` | off | Merge once everything passes |
| `taskTimeoutMs` | 24h | Kill a task after this long; `0` disables |

### `telegram.json`

Bind a forum group to a repo, whitelist users, and choose which commands each group may run. See [`telegram.example.json`](telegram.example.json).

### Environment

`WEBHOOK_SECRET`, `PORT`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` are required. Optional: `CLAUDE_MODEL`, `AI_PROVIDER`, `XAI_API_KEY` / `XAI_BASE_URL` (auto-titles Telegram topics), `LOG_LEVEL`, `LOG_FORMAT`.

## Commands

| Where | Command | What happens |
| --- | --- | --- |
| PR comment | `@mikoto /review` | Review now |
| PR comment | `@mikoto /fix <what>` | Push a fix commit to the PR |
| PR comment | `@mikoto /do <task>` | Do a dev task on the PR branch |
| PR comment | `@mikoto /autofix` | Run one review → fix cycle even if `autoFix` is off |
| Telegram | `/do <task>` | New branch, new PR |
| Telegram | `/pm <requirement>` | Plan it into sub-Issues and auto-dispatch |
| Telegram | `/ask <question>` | Read-only Q&A about the codebase |
| Telegram | `/load`, `/close`, `/status`, `/system`, `/provider` | Manage topics, tasks, usage and the agent |

The mention pattern and bot login live in [`src/config.ts`](src/config.ts) (`MENTION_PATTERN`, `BOT_LOGIN`); change them to match your GitHub App's name.

## Development

```bash
npm test          # vitest unit tests
npx tsc --noEmit  # type check
```

End-to-end tests drive a real Telegram account and a test repo; see [`tests/e2e/README.md`](tests/e2e/README.md).

## Security notes

- Agents run with `--dangerously-skip-permissions` inside per-task git worktrees. Only connect repos you trust, and deploy on an isolated machine or container.
- Webhooks are verified with HMAC-SHA256. Telegram commands are limited to whitelisted users.
- `.env`, `repos.json`, `telegram.json` and `*.pem` are git-ignored. Keep them out of commits.
- Long tasks can be cancelled from `/status` in Telegram; `taskTimeoutMs` sets a hard limit per repo.

## License

[MIT](LICENSE)
