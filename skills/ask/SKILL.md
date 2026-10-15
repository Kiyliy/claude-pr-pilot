# Skill: Free Q&A

## Objective

Answer the user's question about the repository. You have full read access to the codebase to explore, analyze, and explain.

## Mode Detection

Check the prompt for context to determine your mode:

### Mode A: Issue-bound (follow-up question)
If the prompt mentions "linked to Issue #N", you are continuing a conversation on an existing Issue. Do NOT create a new Issue.

### Mode B: Standalone (first question, no linked Issue)
If there is no linked Issue mentioned, this is a new conversation. You should create a GitHub Issue to anchor it.

## Rules

1. **Read-only on code** — Do NOT modify any files, create commits, or push changes. If the user's question implies they want code changes, answer the question but suggest they use `/do` or `/fix` commands for actual modifications.
2. **Be accurate** — Base your answers on actual code you've read, not assumptions. Cite specific files and line numbers when relevant.
3. **Be concise** — Answer the question directly. Provide context only when it helps understanding.
4. **Stay scoped** — Focus on the repository and codebase. Don't speculate about things outside the repo.

## Workflow

### Step 1: Understand the question

Parse what the user is actually asking. If the question is too broad or unclear, ask for clarification instead of guessing.

### Step 2: Explore the codebase

First, ensure you have the latest remote state:
```bash
git fetch origin  # pull latest remote refs so file reads reflect the current codebase
```

Then read relevant files, search for patterns, trace call chains — whatever is needed to answer accurately.

### Step 3: Formulate your answer

Provide a clear, well-structured response with code references.

### Step 4: Create Issue and post answer

**Mode B (first question — no linked Issue):**

1. Create a GitHub Issue to anchor this Q&A conversation:
   ```
   gh api repos/{owner}/{repo}/issues -f title="ask: <short summary of the question>" -f body="<the user's original question>"
   ```
   Save the returned issue number.

2. Post your answer as a comment on the Issue:
   ```
   gh api repos/{owner}/{repo}/issues/{issue_number}/comments -f body="<your answer>"
   ```

3. Output the issue number marker on its own line: `CREATED_ISSUE=#<number>`

**Mode A (follow-up — Issue already linked):**

1. Post your answer as a comment on the existing Issue:
   ```
   gh api repos/{owner}/{repo}/issues/{issue_number}/comments -f body="<your answer>"
   ```

2. Do NOT output `CREATED_ISSUE=...` — the Issue is already bound.

## Output

Output your answer directly to stdout. The system will automatically relay it to the user via Telegram.
Format your answer in plain text or Markdown. Keep it structured and readable.
Write your answer in zh_CN (简体中文) by default. If the user's question is in another language, follow that language instead.
