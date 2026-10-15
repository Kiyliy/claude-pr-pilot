# Skill: Free Development Task

## Objective

Execute a user-specified development task. This could be implementing a feature, refactoring code, writing tests, or any other code change the user requests.

## Mode Detection

You will be working in one of three modes:

### Mode A: PR-bound (you are on a PR branch)
If the prompt mentions a specific PR number (e.g. "PR #123"), you are working on an existing PR branch. No need to create a new Issue or PR.
1. **Check out the branch** (the worktree starts in detached HEAD state):
   ```bash
   git checkout <headBranch>     # switch from detached HEAD to the named branch
   git pull origin <headBranch>  # ensure you have the latest commits
   ```
2. Read the user's instruction carefully. If ambiguous, ask for clarification.
3. Read the relevant codebase to understand context.
4. Implement and verify your changes (run tests if available).
5. Commit and push directly to this branch.

### Mode C: Issue-bound (triggered by PM from a GitHub Issue)
If the prompt says "This task is linked to Issue #N", you are being dispatched by the PM workflow. Issue #N already contains the full requirements — **skip Step 1** (do not create a new Issue).
1. **Read the Issue** to understand requirements: `gh api repos/{owner}/{repo}/issues/{N}`
2. Proceed from **Step 2** (create branch and implement).
3. In **Step 3**, use `Closes #N` in the PR body.
4. After creating the PR (**Step 4**), execute **Step 5** (trigger queue next task).

### Mode B: Standalone (no PR, no linked Issue)
If neither a PR number nor a linked Issue number is mentioned, follow the full workflow below.

> **Note on closed PRs:** If a PR number is mentioned but that PR is **already closed or merged**, do NOT treat it as Mode A. Instead, treat the closed PR as background context (prior work / reference information) and enter **Mode B** to create a new branch and new PR. This ensures your changes can actually be merged — pushing to a closed PR's branch will not result in a mergeable PR.

## Standalone Workflow

> Before starting, read the user's instruction carefully. If the instruction is ambiguous or unclear, ask for clarification instead of guessing.

### Step 1: Create an Issue (requirements & design)

Before writing any code, create a GitHub Issue to document the requirements analysis:
```
gh api repos/{owner}/{repo}/issues -f title="<type>: <short-description>" -f body="<issue-body>"
```

The Issue body **MUST** include:
- **原始需求**: Quote the user's full instruction verbatim
- **需求分析**: Break down what needs to be done, identify affected components
- **设计方案**: Outline the technical approach — which files to modify, what logic to add/change (初步方案，阅读代码后如需调整可更新 Issue)
- **影响范围**: List potential side effects or areas that need testing

Save the returned issue number for later use.

### Step 2: Create a branch and implement

1. **Fetch the latest remote state and create a fresh branch**:
   ```bash
   git fetch origin                          # ensure remote refs are up to date
   git checkout -b feat/<short-description>  # branch from the current (already-latest) HEAD
   ```
   Use a descriptive name like `feat/short-description` or `chore/short-description`.
   **NEVER checkout or reuse an existing branch** — always create a new one.
2. **Read the codebase**: Explore relevant files to understand the architecture, patterns, and conventions.
3. **Implement**: Write clean, idiomatic code following the project's conventions.
4. **Verify**: Run tests, linters, or build commands if available. Fix any issues before committing.
5. **Commit and push**:
   ```
   git add <relevant-files>  # only stage files related to the task
   git commit -m "<type>: <description>" -m "Refs #<issue-number>"
   git push origin feat/<short-description>
   ```

### Step 3: Create a PR linked to the Issue

Determine the base branch by running `git remote show origin | grep 'HEAD branch'`, then:
```
gh api repos/{owner}/{repo}/pulls -f title="<title>" -f body="<body>" -f head="feat/<short-description>" -f base="<base-branch>"
```

The PR body **MUST** include:
- **关联 Issue**: `Closes #<issue-number>` or `Refs #<issue-number>` (this auto-links the PR to the Issue)
- **改动内容**: What was done and why
- **涉及文件**: List the key files modified
- **测试验证**: How the changes were verified

### Step 4: Output

After creating the PR, output the PR number on its own line in this exact format: `CREATED_PR=#<number>`

### Step 5: Trigger next queued task (Mode C only)

> Only execute this step in Mode C (Issue-bound). Skip in Modes A and B.

After creating the PR, check the linked Issue body for a queue marker:
```bash
gh api repos/{owner}/{repo}/issues/{N} --jq '.body' | grep -o '<!-- queue:next=#[0-9]* -->'
```

If a marker like `<!-- queue:next=#M -->` is found, post a trigger comment on Issue #M:
```bash
gh api repos/{owner}/{repo}/issues/M/comments -f body="@mikoto /do"
```

This chains the PM-dispatched task queue so the next task starts automatically. If no marker is found, skip this step.

## Safety Rules

These rules are **non-negotiable** and must be followed regardless of the user's instruction:

1. **Do not delete or weaken existing tests** unless the user explicitly asks you to and explains why.
2. **Do not remove or break existing functionality** — your changes should be additive or corrective, not destructive.
3. **Do not modify files unrelated to the task** — keep your changes scoped to what the user asked for.
4. **Run existing tests** (if available) before committing to verify you haven't broken anything.
5. **Do not hardcode secrets, API keys, or credentials** in source code.
6. **Preserve existing code style** — match indentation, naming conventions, and patterns used in the codebase.

## Commit Guidelines

- Use conventional commit format: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`, etc.
- Keep the commit message concise but descriptive
- Reference the Issue or PR number in the commit body (Issue number for standalone, PR number for PR-bound)

## Output

After completing the task:
1. If PR-bound: Post a comment on the PR summarizing what was changed, why, and any caveats. Include the commit SHA.
2. If standalone: Output a summary to stdout describing what was done. The system will relay this to the user.
3. If you couldn't complete the task fully, explain what's left and why.
4. Write all output and PR descriptions in zh_CN (简体中文) by default. If the user's instruction is in another language, follow that language instead.
