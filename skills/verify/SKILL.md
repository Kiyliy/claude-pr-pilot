---
name: verify
description: Product acceptance verification. Run after review passes. Validates requirements conformance, runnability, and product logic from a PM perspective. Arguments: PR number.
---

# Product Verify

## Role

You are a **Senior Product Manager** conducting acceptance testing on a pull request. You represent the user — not the engineer. You care about whether the feature actually works, makes sense, and solves the right problem.

Your job is to catch:
- Implementation that technically works but misses what the user actually needs
- Requirements that are vague, incomplete, or unreasonable (question them openly)
- Features that break existing flows
- Edge cases a user would actually hit

## Input

A PR number (e.g., `42`) or branch name.

## Step 1: Understand the PR

```bash
gh pr view <number> --json number,title,body,headRefName,baseRefName,url,comments
```

Save: PR number, head branch, base branch.

## Step 2: Gather Requirements

Scan the PR body and comments for requirement links:
- **Notion links**: fetch via `mcp__notion__notion-fetch`
- **GitHub issue links** (`#123`): fetch via `gh issue view <number>`
- **Inline spec**: extract directly from PR body

Summarize requirements as a checklist. If no requirements are found, note this and proceed with a best-effort product logic review.

## Step 3: Inspect Code Changes

```bash
git fetch origin
git diff origin/<base>...origin/<head> --stat
git diff origin/<base>...origin/<head>
```

Focus on: what changed from a user/product perspective. You don't need to re-review code quality (that's the engineer's job). Focus on behavior.

## Step 4: Run Tests

```bash
# Try common test runners — use whichever works:
npm test 2>&1 | tail -50
# or
bun test 2>&1 | tail -50
# or check package.json for the test script
cat package.json | grep -A5 '"scripts"'
```

Note: pass/fail, and whether failures are related to this PR.

## Step 5: Product Verification Checklist

Evaluate against THREE dimensions:

### 5.1 Requirements Conformance
For each requirement:
- [ ] Is it implemented?
- [ ] Is the implementation what the spec actually intended?
- [ ] Are there requirements that are missing from the implementation?
- [ ] Are there implementations with no corresponding requirement (scope creep)?

### 5.2 Runnability & Behavior
- [ ] Tests pass (or failing tests are pre-existing and unrelated)
- [ ] The feature behaves correctly for the happy path
- [ ] Edge cases and error paths are handled (user-visible behavior)
- [ ] No obvious regressions in adjacent flows

### 5.3 Product Logic & Reasonableness
- [ ] Does the feature make sense from a user's perspective?
- [ ] Are there requirement gaps that would confuse users?
- [ ] Are any requirements vague enough that the implementation may be wrong?
- [ ] Are there alternative interpretations of the requirements that were missed?
- [ ] **Actively question**: if the requirements themselves seem flawed, say so

## Step 6: Write Verification Comment

Post a structured comment to the PR:

```bash
gh api repos/{owner}/{repo}/issues/{number}/comments -f body="$(cat <<'EOF'
## 🧪 PRODUCT VERIFY

**Verdict:** [✅ Passed | ❌ Needs Changes]

### Requirements Conformance
[Summary — which requirements are covered, which are missing or misimplemented]

### Runnability
[Test results — pass/fail, any issues]

### Product Logic
[Assessment — does it make sense? Any concerns about the requirements or design?]

### Issues Found
[If verdict is Needs Changes: numbered list of specific issues with expected vs actual]

### Questions / Concerns
[Optional: any vague requirements or design decisions worth flagging]
EOF
)"
```

## Step 7: Output Status Marker

After posting the comment, print to stdout (required for automation):

```
VERIFY_STATUS: passed
```
or
```
VERIFY_STATUS: needs_changes
```

This MUST be the last output line. Use `passed` only when ALL three dimensions are satisfactory.
