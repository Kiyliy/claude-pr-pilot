# 开发规范 (Agent Guidelines)

本仓库已接入自动审核系统（auto-pr-reviewer），所有代码修改必须通过 PR 提交以触发自动 review。

## 工作流程

1. **创建分支**：从最新 `main` 创建新分支
   ```bash
   git checkout main
   git pull origin main
   git checkout -b feat/<short-description>
   ```
   分支命名规范：`feat/xxx`、`fix/xxx`、`refactor/xxx`、`chore/xxx`

2. **编写代码**：按需求修改代码，确保：
   - TypeScript 编译通过：`npx tsc --noEmit`
   - 不破坏现有功能
   - 遵循现有代码风格

3. **提交并推送**：
   ```bash
   git add -A
   git commit -m "<type>: <description>"
   git push origin feat/<short-description>
   ```

4. **创建 PR**：目标分支为 `main`
   ```bash
   gh pr create --base main --head feat/<short-description> \
     --title "<type>: <description>" \
     --body "<PR body>"
   ```
   PR body 必须包含：
   - **背景/需求**：引用用户的原始指令
   - **改动内容**：做了什么、为什么这样做
   - **涉及文件**：列出主要修改的文件

5. **等待自动审核**：PR 创建后会自动触发 review
   - 🟢 通过 → 可以合并
   - 🔴/🟡 有问题 → 如果开启了 `autoFix`，bot 会自动修复并重新审核

## 禁止事项

- **禁止**直接推送到 `main` 分支
- **禁止**删除或弱化已有测试
- **禁止**在代码中硬编码密钥或凭证
- **禁止**修改与任务无关的文件

## 项目结构

```
auto-pr-reviewer/
├── src/
│   ├── config.ts          # 配置加载（repos.json, telegram.json, skills）
│   ├── server.ts          # HTTP webhook 服务器
│   ├── types.ts           # TypeScript 类型定义
│   ├── github/            # GitHub API 交互
│   ├── review/            # 任务管理（manager.ts）、提示词构建（prompt.ts）
│   ├── store/             # 持久化存储（SQLite）
│   ├── telegram/          # Telegram bot（命令、同步、客户端）
│   ├── utils/             # 工具函数
│   └── webhook/           # GitHub webhook 事件处理
├── skills/                # Skill 定义文件
│   ├── ask/SKILL.md       # /ask 命令
│   ├── do/SKILL.md        # /do 命令
│   ├── fix/SKILL.md       # /fix 命令
│   ├── review-pr/SKILL.md # /review 命令
│   └── ops/               # 运维命令
│       └── update/SKILL.md
├── repos.json             # 仓库配置
├── telegram.json          # Telegram 群组配置
└── package.json
```

## 配置文件说明

### repos.json
每个仓库的基本配置：`dir`（工作目录）、`baseBranch`（目标分支）、`installationId`（GitHub App）、`autoFix`、`maxAutoFixRounds`

### telegram.json
Telegram 群组配置：`repo`（绑定仓库）、`dir`（可选，覆盖仓库 dir）、`allowedCommands`（可用命令白名单）、`syncPR`（是否同步 PR）

## 默认语言

所有输出、PR 描述、commit message 使用**中文（zh_CN）**。
