# 配置指南：auto-pr-reviewer

本文档介绍如何从零开始配置和部署 auto-pr-reviewer 机器人。

---

## 1. 系统要求

| 依赖 | 最低版本 | 用途 |
|------|---------|------|
| Node.js | 18+ | 运行时 |
| PM2 | latest | 进程管理 |
| Claude Code CLI | 2.1+ | AI 代码审查引擎 |
| GitHub CLI (`gh`) | latest | GitHub API 交互 |

安装示例：

```bash
# Node.js (推荐 nvm)
nvm install 20

# PM2
npm install -g pm2

# GitHub CLI
# https://cli.github.com/

# Claude Code CLI
# https://docs.anthropic.com/en/docs/claude-code
```

---

## 2. 项目安装

```bash
git clone https://github.com/Kiyliy/claude-pr-pilot.git
cd claude-pr-pilot
npm install
```

---

## 3. 配置文件总览

```
auto-pr-reviewer/
├── .env                 # 环境变量（密钥、端口）
├── repos.json           # 被监控仓库列表
├── telegram.json        # Telegram 机器人配置（可选）
├── ecosystem.config.js  # PM2 进程配置
└── *.pem                # GitHub App 私钥
```

---

## 4. 创建 GitHub App

### 4.1 创建 App

1. 前往 **GitHub → Settings → Developer Settings → GitHub Apps → New GitHub App**
2. 填写基本信息：
   - **App Name**: 你的 bot 名称（如 `mikoto-devs`）
   - **Homepage URL**: 随意填写
   - **Webhook URL**: `http://<你的服务器IP>:<端口>/webhook`（如 `http://1.2.3.4:9876/webhook`）
   - **Webhook Secret**: 生成一个随机密钥（见下方）

### 4.2 配置权限

**Repository permissions:**
| 权限 | 级别 | 用途 |
|------|------|------|
| Contents | Read & write | 读取代码、合并 PR |
| Pull requests | Read & write | 读取/评论 PR |
| Issues | Read & write | 创建 Issue、评论 |

**Subscribe to events:**
- `Pull request` — 新 PR 创建/更新时触发 review
- `Issue comment` — PR 评论中 @mention 触发命令

### 4.3 生成私钥

1. 在 App 设置页 → **Private keys** → **Generate a private key**
2. 下载 `.pem` 文件，放到项目根目录

### 4.4 安装 App 到目标仓库

1. 在 App 设置页 → **Install App**
2. 选择目标 organization 或个人账号
3. 选择需要监控的仓库
4. 安装后，记录 **Installation ID**（在 URL 中可以看到：`/installations/<id>`）

> 如果有多个 org/账号，需要分别安装，每个安装会有独立的 Installation ID。

---

## 5. 配置 `.env`

```bash
# 生成 Webhook Secret
openssl rand -hex 32
```

创建 `.env` 文件：

```bash
# ---- 服务器 ----
PORT=9876
WEBHOOK_SECRET=<上面生成的随机密钥>

# ---- GitHub App ----
GITHUB_APP_ID=<你的 App ID>
GITHUB_APP_PRIVATE_KEY_PATH=./your-app-name.YYYY-MM-DD.private-key.pem
```

**字段说明：**

| 变量 | 必填 | 说明 |
|------|------|------|
| `PORT` | 否 | HTTP 监听端口，默认 `9876` |
| `WEBHOOK_SECRET` | 是 | 与 GitHub App Webhook Secret 一致 |
| `GITHUB_APP_ID` | 是 | GitHub App 的 ID（App 设置页可见） |
| `GITHUB_APP_PRIVATE_KEY_PATH` | 是 | 私钥 `.pem` 文件路径（相对或绝对） |

---

## 6. 配置 `repos.json`

定义所有需要监控的仓库及其行为。

```json
{
  "owner/repo-name": {
    "dir": "/absolute/path/to/local/clone",
    "baseBranch": "main",
    "installationId": 123456789,
    "autoFix": false,
    "maxAutoFixRounds": 10,
    "autoMerge": false,
    "commands": {}
  }
}
```

**字段说明：**

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `dir` | string | 是 | — | 本地 clone 的绝对路径，必须已存在且包含 `.git` |
| `baseBranch` | string | 否 | 无（所有分支） | 仅审查目标为此分支的 PR；省略则审查所有 PR |
| `installationId` | number | 是 | — | GitHub App 安装 ID |
| `autoFix` | boolean | 否 | `false` | Review 发现问题后是否自动触发 `/fix` |
| `maxAutoFixRounds` | number | 否 | `10` | 最大 review → fix → review 循环次数 |
| `autoMerge` | boolean | 否 | `false` | Review 通过（🟢 Approved）后是否自动合并 PR |
| `commands` | object | 否 | `{}` | 自定义命令 → skill 文件路径映射，覆盖内置 skill |

**前置步骤：** 在服务器上为每个仓库创建本地 clone：

```bash
git clone https://github.com/owner/repo-name.git /path/to/local/clone
```

**示例：完整的多仓库配置**

```json
{
  "MyOrg/backend-api": {
    "dir": "/opt/repos/backend-api",
    "baseBranch": "main",
    "installationId": 111111111,
    "autoFix": true,
    "maxAutoFixRounds": 5,
    "autoMerge": false
  },
  "MyOrg/frontend-app": {
    "dir": "/opt/repos/frontend-app",
    "baseBranch": "dev",
    "installationId": 111111111,
    "autoFix": false,
    "autoMerge": false
  }
}
```

---

## 7. 配置 Telegram 机器人（可选）

如果不需要 Telegram 集成，跳过此步。删除或不创建 `telegram.json` 即可。

### 7.1 创建 Telegram Bot

1. 在 Telegram 中找到 `@BotFather`
2. 发送 `/newbot`，按提示创建 bot
3. 记录返回的 **Bot Token**
4. 将 bot 添加到目标群组，并设为**管理员**

### 7.2 获取 ID

- **群组 ID**：将 `@getidsbot` 拉入群组，它会自动发送群组 ID（负数）
- **用户 ID**：转发任意消息给 `@getidsbot`，或在群组中 `@getidsbot`

### 7.3 创建 `telegram.json`

```json
{
  "botToken": "<BotFather 返回的 token>",
  "adminUsers": [123456789],
  "groups": {
    "-100xxxxxxxxxx": {
      "repo": "owner/repo-name",
      "name": "my-project-dev",
      "allowedCommands": ["review", "fix", "do", "ask", "load", "close", "status"],
      "syncPR": true,
      "allowedUsers": [123456789, "teammate_username"]
    }
  }
}
```

**字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `botToken` | string | Telegram Bot Token |
| `adminUsers` | array | 全局管理员，拥有所有权限。元素可以是用户 ID（数字）或用户名（字符串） |
| `groups` | object | key 为群组 chat ID（字符串），value 为群组配置 |

**群组配置字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `repo` | string | 是 | 关联的仓库，必须与 `repos.json` 中的 key 一致 |
| `name` | string | 是 | 群组显示名称 |
| `dir` | string | 否 | 覆盖该群组使用的工作目录（默认使用 `repos.json` 中的 `dir`） |
| `allowedCommands` | string[] | 否 | 允许的命令白名单；省略则允许所有命令 |
| `syncPR` | boolean | 否 | 是否启用 PR ↔ Telegram 双向同步（默认 `true`） |
| `allowedUsers` | array | 否 | 允许使用命令的用户白名单（ID 或用户名） |

**特殊用法：运维群组**

设置 `syncPR: false` 可以创建一个只接收通知和执行运维命令的群组：

```json
{
  "-100yyyyyyyyyy": {
    "repo": "owner/repo-name",
    "name": "ops-channel",
    "dir": "/opt/repos/production-clone",
    "allowedCommands": ["status", "update"],
    "syncPR": false,
    "allowedUsers": [123456789]
  }
}
```

---

## 8. 配置 PM2

编辑 `ecosystem.config.js`：

```javascript
module.exports = {
  apps: [
    {
      name: "auto-reviewer",
      script: "main.ts",
      interpreter: "./node_modules/.bin/tsx",
      cwd: "/absolute/path/to/auto-pr-reviewer",  // 项目根目录
      env: {
        NODE_ENV: "production",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "/absolute/path/to/auto-pr-reviewer/logs/error.log",
      out_file: "/absolute/path/to/auto-pr-reviewer/logs/out.log",
      merge_logs: true,
      max_restarts: 10,      // 崩溃后最多重启 10 次
      restart_delay: 5000,   // 重启间隔 5 秒
      kill_timeout: 15000,   // 优雅关闭等待 15 秒
    },
  ],
};
```

> 确保 `cwd` 指向项目根目录的绝对路径。日志目录需要提前创建：`mkdir -p logs`

---

## 9. 启动与验证

### 9.1 启动

```bash
# 首次启动
pm2 start ecosystem.config.js

# 设置开机自启
pm2 save
pm2 startup
```

### 9.2 健康检查

```bash
curl http://localhost:9876/health
```

预期返回：

```json
{
  "status": "ok",
  "repos": ["owner/repo-name", "owner/another-repo"],
  "activeTasks": []
}
```

### 9.3 查看日志

```bash
# 实时日志
pm2 logs auto-reviewer

# 最近 100 行
pm2 logs auto-reviewer --lines 100
```

### 9.4 端到端验证

1. 在任一已配置仓库中创建一个 PR
2. 观察 PM2 日志，确认收到 webhook 并触发 review
3. 等待 Claude Code 完成审查，检查 PR 上是否出现 `## CLAUDE REVIEW` 评论
4. （如果配置了 Telegram）检查 Telegram 群组是否收到通知

---

## 10. 触发方式

### GitHub 触发（自动）

| 事件 | 条件 | 动作 |
|------|------|------|
| PR 创建 (`opened`) | 非 draft、目标分支匹配 | 自动触发 `/review` |
| PR 更新 (`synchronize`) | 非 draft、目标分支匹配 | 自动触发 `/review` |

### GitHub 触发（手动）

在 PR 评论中 @mention bot：

```
@mikoto /review             # 手动触发 review
@mikoto /fix 请修复 XX 问题   # 手动触发 fix
@mikoto /do 请添加 XX 功能    # 手动触发任务
@mikoto /autofix            # 触发 review + auto-fix 循环
```

> `@mikoto` 是默认的 mention 模式，匹配 `@mikoto` 或 `@mikoto-devs`。如需修改，编辑 `src/config.ts` 中的 `MENTION_PATTERN`。

### Telegram 触发

在已配置的群组中使用命令：

```
/review #42              # 审查 PR #42
/fix #42 修复登录问题      # 修复 PR #42 的问题
/do 添加日志模块           # 独立任务（会创建 Issue + PR）
/ask 这个模块怎么工作的     # 提问（会创建 Issue）
/load #42                # 加载 PR 到当前群组话题
/close                   # 关闭当前话题
/status                  # 查看运行中的任务
/update                  # 拉取最新代码并重启（仅运维群组）
```

---

## 11. Skill 系统

Bot 的行为由 `skills/` 目录下的 SKILL.md 文件控制。

### 内置 Skill

| 命令 | Skill 路径 | 功能 |
|------|-----------|------|
| `review` | `skills/review-pr/SKILL.md` | PR 代码审查 |
| `fix` | `skills/fix/SKILL.md` | 修复 review 发现的问题 |
| `do` | `skills/do/SKILL.md` | 执行开发任务 |
| `ask` | `skills/ask/SKILL.md` | 代码相关提问 |
| `update` | `skills/ops/update/SKILL.md` | 自更新（git pull + 重启） |

### 自定义 Skill

在 `repos.json` 的 `commands` 字段中覆盖：

```json
{
  "owner/repo-name": {
    "dir": "/path/to/repo",
    "installationId": 123456789,
    "commands": {
      "review": "skills/my-custom-review/SKILL.md",
      "deploy": "skills/custom/deploy/SKILL.md"
    }
  }
}
```

优先级：`repos.json commands` > 内置 `BUILTIN_SKILLS`

---

## 12. 数据库

系统使用 SQLite（`better-sqlite3`），数据库文件自动创建在 `./data/store.db`。

**无需手动初始化** — 表结构在启动时自动迁移。

| 表 | 用途 |
|---|------|
| `pr_topics` | PR ↔ Telegram 话题映射 |
| `standalone_topics` | 独立任务话题元数据 |
| `message_refs` | GitHub 评论 ↔ Telegram 消息映射 |
| `topic_messages` | 对话历史（用于上下文注入） |

如需清理历史数据：

```bash
sqlite3 ./data/store.db "DELETE FROM topic_messages WHERE created_at < date('now', '-30 days')"
```

---

## 13. Auto-Fix 流程

当 `autoFix: true` 时：

```
PR 创建/更新
  → /review
  → 结果为 🔴 或 🟡
    → 自动发起 /fix
    → Claude 修复并推送
    → 推送触发 /review（synchronize 事件）
    → 重复直到 🟢 Approved 或达到 maxAutoFixRounds
```

手动触发：在 PR 评论中 `@mikoto /autofix`，即使 `autoFix: false` 也会执行一轮循环。

---

## 14. 常见问题

### Webhook 没有触发 review

1. 确认 GitHub App 的 Webhook URL 正确且可达（服务器防火墙放行端口）
2. 确认 Webhook Secret 与 `.env` 中一致
3. 在 GitHub App 设置 → **Advanced** → **Recent Deliveries** 查看投递状态
4. 检查 PM2 日志是否有 `Webhook signature verification failed`

### Review 触发了但没有结果

1. 检查 Claude Code CLI 是否已安装并认证：`claude --version`
2. 检查仓库本地 clone 是否存在且 `.git` 完整
3. 检查 PM2 日志中的具体错误

### Telegram bot 没有响应

1. 确认 `telegram.json` 格式正确（JSON 语法）
2. 确认 bot 已添加到群组且为管理员
3. 确认群组 ID 正确（注意负号和 `-100` 前缀）
4. 确认用户在 `allowedUsers` 白名单中

### GitHub App token 过期

GitHub App 安装 token 有效期 1 小时。如果长时间运行的任务失败，重新触发即可（token 会自动刷新）。

---

## 15. 安全注意事项

- `.env`、`repos.json`、`telegram.json`、`*.pem` 都已写进 `.gitignore`，不要提交到仓库；仓库里只放 `*.example` 模板
- 所有任务都以 `--dangerously-skip-permissions` 运行 Claude Code，请只接入你信任的仓库，并在隔离的机器或容器里部署
- Webhook 请求通过 HMAC-SHA256 签名验证，防止伪造
- Telegram 命令通过用户白名单控制访问

---

## 16. 运维命令速查

```bash
# 启动/停止/重启
pm2 start ecosystem.config.js
pm2 stop auto-reviewer
pm2 restart auto-reviewer

# 查看状态
pm2 list
pm2 show auto-reviewer
curl http://localhost:9876/health

# 查看日志
pm2 logs auto-reviewer
pm2 logs auto-reviewer --lines 200

# 开机自启
pm2 save && pm2 startup

# 手动注册 webhook（替换变量）
gh api repos/OWNER/REPO/hooks --method POST \
  -f name="web" -f active=true \
  -f "config[url]=http://SERVER:PORT/webhook" \
  -f "config[content_type]=json" \
  -f "config[secret]=WEBHOOK_SECRET" \
  -f "events[]=pull_request" \
  -f "events[]=issue_comment"

# 运行测试
npm test
```
