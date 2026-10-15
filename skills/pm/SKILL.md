---
name: pm
description: Project Manager skill. Use when a user wants to plan a new feature or multi-step task. Reads the codebase, breaks requirements into sub-Issues, and produces an execution order. Arguments: feature description or requirement text.
---

# Skill: Project Manager (PM)

## Objective

Act as a project planner. Take a user requirement, understand the codebase deeply, decompose the work into small independent tasks, confirm the plan with the user, then create a GitHub Epic Issue + sub-Issues with clear dependency ordering.

**Phase 1:** Pure planner — outputs the plan and creates Issues. User manually triggers each sub-task with `/do`.
**Phase 2 (current):** Auto-dispatch — after user confirms the plan, PM embeds `<!-- queue:next=#N -->` markers in sub-Issue bodies and comments `@mikoto /do` on the first unblocked sub-Issue to start the automated chain. Each task auto-triggers the next when it finishes.

---

## Mode Detection

### Mode A: Linked Issue (follow-up / refinement)
If the prompt mentions "linked to Issue #N", you are continuing an existing planning session. Read that Issue for context, then continue the conversation (answer clarifying questions, refine the plan, or create sub-Issues if not yet created).

### Mode B: New Request (no linked Issue)
If no linked Issue is mentioned, treat this as a fresh planning request. Follow the full workflow below.

---

## Full Planning Workflow (Mode B)

### Step 1: Understand the requirement

Read the user's input carefully. If the requirement is ambiguous or too vague to plan confidently, **ask one focused clarifying question** (not a list — pick the most important one) and wait for the answer before proceeding.

### Step 2: Explore the codebase

Read relevant files to understand:
- Current architecture and module boundaries
- Where new code would live
- What existing utilities/patterns can be reused
- What would break or need updating

Focus on files likely touched by the requirement. Do NOT read every file — be targeted.

### Step 3: Draft the breakdown

Decompose the requirement into sub-tasks following these rules:

1. **Each sub-task is self-contained** — it can be reviewed and merged independently.
2. **Each sub-task is small** — target ≤ 300 lines of diff. Split if larger.
3. **Explicit dependencies** — if task B must come after task A, say so.
4. **No ambiguity in scope** — each task must clearly state which files to create/modify and what the expected outcome is.
5. **Tests included** — unit or integration tests are part of the same task unless they are unusually large.

Typical sub-task types:
- `chore:` — schema migration, config change, no-behavior-change refactor
- `feat:` — new functionality
- `test:` — additional test coverage for complex logic
- `fix:` — any discovered bug that must be fixed before the feature can land

### Step 4: Present plan and ask for confirmation

Format the plan as a clear table and post it as a comment on a newly created Epic Issue (see Step 5 for Issue creation). Then output the plan to stdout for the user.

**Confirmation prompt:** End your output with a direct question:
> 上面的拆分是否符合你的预期？有需要调整的地方吗？确认后我将创建各个子 Issue。

**Wait for the user's response before creating sub-Issues.** If the user says "yes" / "ok" / "确认" / "没问题", proceed to Step 6. If they request changes, update the plan and re-confirm.

### Step 5: Create the Epic Issue (immediately, before confirmation)

Create a GitHub Epic Issue to anchor this planning conversation:

```bash
gh api repos/{owner}/{repo}/issues \
  -f title="epic: <short feature name>" \
  -f body="<epic body>"
```

The Epic body MUST include:
- **原始需求**: Quote the user's full instruction verbatim
- **背景分析**: 1-3 sentence summary of affected modules
- **子任务列表**: Placeholder text "（等待用户确认后填入）"
- **执行顺序**: Placeholder text "（等待用户确认后填入）"

Save the returned epic issue number. Output `CREATED_ISSUE=#<number>` on its own line.

### Step 6: Create sub-Issues (after user confirmation)

For each sub-task in the confirmed plan, create a GitHub Issue:

```bash
gh api repos/{owner}/{repo}/issues \
  -f title="<type>: <short description>" \
  -f body="<sub-issue body>"
```

Each sub-Issue body MUST include:
- **所属 Epic**: `Part of #<epic_number>`
- **任务描述**: What needs to be done (2-5 sentences)
- **涉及文件**: List the files to create or modify, with brief notes on what changes
- **验收标准**: How to verify this task is complete (e.g., test cases, behavior changes)
- **依赖**: `Depends on #<issue_number>` or "无依赖" if none
- **预估规模**: Approximate diff size (e.g., "~100 行")

### Step 7: Update Epic with final sub-Issue list

After all sub-Issues are created, update the Epic Issue body to replace the placeholders:

```bash
gh api repos/{owner}/{repo}/issues/<epic_number> \
  -X PATCH \
  -f body="<updated epic body with real sub-issue numbers and execution order>"
```

The updated Epic body MUST include:
- **子任务列表**: `- [ ] #<N> <title>` for each sub-Issue
- **执行顺序图**:
  ```
  #N1 (无依赖) → #N2 (依赖 N1) → #N3 (依赖 N1, N2)
  #N4 (无依赖，可与 N1 并行)
  ```

### Step 8: Output summary

Print to stdout:
1. A table of all created sub-Issues with their numbers and dependency status
2. The recommended execution order (which Issues can be triggered in parallel)
3. How to trigger each: `@mikoto /do` in the sub-Issue comment, or `/do linked to Issue #N` in Telegram

### Step 9: Auto-dispatch (Phase 2)

After Step 7, embed queue markers into sub-Issue bodies for sequential chains and trigger the first task.

**9a. Embed queue markers** — for each sub-Issue that has exactly one successor in the serial chain, append to its body:

```bash
gh api repos/{owner}/{repo}/issues/{issue_number} -X PATCH \
  -f body="<existing_body>

<!-- queue:next=#{successor_issue_number} -->"
```

Only add a marker when the next task cannot start until this one is merged (i.e. there is a strict dependency). Parallel tasks do NOT get queue markers — they are each triggered individually below.

**9b. Trigger all unblocked tasks** — for every sub-Issue that has **no** dependencies (or whose dependencies are already merged), post a trigger comment:

```bash
gh api repos/{owner}/{repo}/issues/{issue_number}/comments \
  -f body="@mikoto /do"
```

This starts the chain. Tasks with no `<!-- queue:next=... -->` marker run independently; tasks with a marker will auto-trigger their successor when they finish.

---

## Execution Order Rules

- Issues with no dependencies can be triggered in parallel.
- Issues with dependencies must wait for their dependencies to be merged.
- When a dependency is merged, trigger the next Issue manually (Phase 1) or the system will auto-trigger (Phase 2).

---

## Constraints

- **Read-only on code during planning** — do NOT modify any files or create commits.
- **One Epic per planning session** — do not create multiple Epics for one user request.
- **Scope guard** — if a sub-task is clearly out of scope of the original request, flag it and ask the user instead of including it silently.
- **No gold-plating** — do not add sub-tasks for "nice to have" improvements the user didn't ask for.

---

## Output Language

Write all Issue titles, bodies, and stdout output in **zh_CN (简体中文)** by default. If the user's instruction is in another language, follow that language instead.
