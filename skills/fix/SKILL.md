# Skill: Fix Bug and Commit

## Objective

Identify the bug or issue described by the user, implement a fix, and commit it.

## Mode Detection

You will be working in one of two modes:

### Mode A: PR-bound (you are on a PR branch)
If the prompt mentions a specific PR number (e.g. "PR #123"), you are working on an existing PR branch. Read the PR diff to understand the context. Commit and push directly to this branch.

> **Important**: The worktree is created in detached HEAD state. Before making any changes, check out the branch by name and pull the latest commits:
> ```bash
> git checkout <headBranch>   # switch from detached HEAD to the named branch
> git pull origin <headBranch>  # ensure you have the latest commits
> ```

### Mode B: Standalone (no PR)
If no PR number is mentioned, you need to:
1. **Fetch the latest remote state and create a fresh branch**:
   ```bash
   git fetch origin                         # ensure remote refs are up to date
   git checkout -b fix/<short-description>  # branch from the current (already-latest) HEAD
   ```
   **NEVER checkout or reuse an existing branch** — always create a new one.
2. Make your fix, commit, and push:
   ```
   git push origin fix/<short-description>
   ```
3. Create a PR. Determine the base branch by running `git remote show origin | grep 'HEAD branch'`, then:
   ```
   gh api repos/{owner}/{repo}/pulls -f title="fix: <description>" -f body="<body>" -f head="fix/<short-description>" -f base="<base-branch>"
   ```
   The PR body **MUST** include:
   - **Original request**: Quote the user's full instruction so reviewers understand the intent
   - **Root cause**: What caused the bug
   - **Fix summary**: What was changed and why
4. **IMPORTANT**: After creating the PR, output the PR number on its own line in this exact format: `CREATED_PR=#<number>`

## Steps

1. **Understand the problem**: Read the user-provided description (and PR diff if PR-bound) to understand what needs to be fixed.
2. **Analyze the codebase**: Look at relevant files to understand the context and find the root cause.
3. **Implement the fix**: Make minimal, focused changes that address the root cause. Prefer upstream fixes over downstream workarounds.
4. **Test if possible**: If there are existing tests, run them to verify the fix doesn't break anything.
5. **Commit and push**: Stage the changes, write a clear commit message, and push.

## Commit Guidelines

- Use conventional commit format: `fix: <description>`
- Keep the commit message concise but descriptive
- Reference the PR number in the commit body (if PR-bound)

## Rules

- Make minimal changes — do not refactor unrelated code
- Do not modify or delete existing tests unless they are testing incorrect behavior
- If the fix is unclear or ambiguous, output a question to stdout asking for clarification instead of guessing
- Always verify the fix compiles/builds before committing

## Output

After completing the fix:
1. If PR-bound: Post a comment on the PR summarizing what was changed and why. Include the commit SHA. Then print a single machine-readable line to stdout (required for dedup automation):
   ```
   FIX_COMMENT_POSTED
   ```
2. If standalone: Output a summary to stdout describing the fix. The system will relay this to the user.
3. If you couldn't fix the issue, explain why and what you found.
4. Write all output and PR descriptions in zh_CN (简体中文) by default. If the user's instruction is in another language, follow that language instead.
