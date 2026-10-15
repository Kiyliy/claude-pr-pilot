"""
GitHub REST API helpers for e2e tests.

All functions are async, use httpx, and authenticate via a PAT (GITHUB_TOKEN).
"""
from __future__ import annotations

import asyncio
import base64
import time
from typing import Optional

import httpx

_BASE = "https://api.github.com"


def _headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


async def get_default_branch_sha(repo: str, token: str, branch: str = "main") -> str:
    """Return the HEAD commit SHA of the given branch."""
    async with httpx.AsyncClient() as c:
        r = await c.get(
            f"{_BASE}/repos/{repo}/git/refs/heads/{branch}",
            headers=_headers(token),
        )
        r.raise_for_status()
        return r.json()["object"]["sha"]


async def create_branch(repo: str, token: str, branch_name: str, sha: str) -> None:
    """Create a new branch pointing at sha."""
    async with httpx.AsyncClient() as c:
        r = await c.post(
            f"{_BASE}/repos/{repo}/git/refs",
            json={"ref": f"refs/heads/{branch_name}", "sha": sha},
            headers=_headers(token),
        )
        r.raise_for_status()


async def create_file(
    repo: str,
    token: str,
    path: str,
    content: str,
    branch: str,
    message: str,
) -> None:
    """Create (or update) a file on a branch via GitHub Contents API."""
    async with httpx.AsyncClient() as c:
        r = await c.put(
            f"{_BASE}/repos/{repo}/contents/{path}",
            json={
                "message": message,
                "content": base64.b64encode(content.encode()).decode(),
                "branch": branch,
            },
            headers=_headers(token),
        )
        r.raise_for_status()


async def create_pr(
    repo: str,
    token: str,
    title: str,
    head: str,
    base: str = "main",
    body: str = "",
) -> dict:
    """Open a PR from head → base. Returns the PR object."""
    async with httpx.AsyncClient() as c:
        r = await c.post(
            f"{_BASE}/repos/{repo}/pulls",
            json={"title": title, "head": head, "base": base, "body": body},
            headers=_headers(token),
        )
        r.raise_for_status()
        return r.json()


async def close_pr(repo: str, token: str, pr_number: int) -> None:
    """Close (but don't merge) a PR."""
    async with httpx.AsyncClient() as c:
        r = await c.patch(
            f"{_BASE}/repos/{repo}/pulls/{pr_number}",
            json={"state": "closed"},
            headers=_headers(token),
        )
        r.raise_for_status()


async def delete_branch(repo: str, token: str, branch: str) -> None:
    """Delete a branch ref."""
    async with httpx.AsyncClient() as c:
        r = await c.delete(
            f"{_BASE}/repos/{repo}/git/refs/heads/{branch}",
            headers=_headers(token),
        )
        r.raise_for_status()


async def create_issue_comment(
    repo: str,
    token: str,
    issue_number: int,
    body: str,
) -> dict:
    """Post a comment on a PR or Issue. Returns the created comment object."""
    async with httpx.AsyncClient() as c:
        r = await c.post(
            f"{_BASE}/repos/{repo}/issues/{issue_number}/comments",
            json={"body": body},
            headers=_headers(token),
        )
        r.raise_for_status()
        return r.json()


async def get_open_prs(repo: str, token: str) -> list[dict]:
    """Return all open PRs in the repo."""
    async with httpx.AsyncClient() as c:
        r = await c.get(
            f"{_BASE}/repos/{repo}/pulls?state=open&per_page=100",
            headers=_headers(token),
        )
        r.raise_for_status()
        return r.json()


async def get_issue_comments(repo: str, token: str, issue_number: int) -> list[dict]:
    """Return all comments on a PR/Issue."""
    async with httpx.AsyncClient() as c:
        r = await c.get(
            f"{_BASE}/repos/{repo}/issues/{issue_number}/comments",
            headers=_headers(token),
        )
        r.raise_for_status()
        return r.json()


async def wait_for_new_pr(
    repo: str,
    token: str,
    known_pr_numbers: set[int],
    *,
    timeout: float = 180,
    poll_interval: float = 5,
) -> Optional[dict]:
    """
    Poll until a PR whose number is NOT in known_pr_numbers appears.
    Returns the new PR object, or None if timeout is reached.
    """
    deadline = time.monotonic() + timeout
    async with httpx.AsyncClient() as c:
        while time.monotonic() < deadline:
            r = await c.get(
                f"{_BASE}/repos/{repo}/pulls?state=open&per_page=100",
                headers=_headers(token),
            )
            r.raise_for_status()
            for pr in r.json():
                if pr["number"] not in known_pr_numbers:
                    return pr
            await asyncio.sleep(poll_interval)
    return None


async def wait_for_comment_with_keyword(
    repo: str,
    token: str,
    issue_number: int,
    keyword: str,
    *,
    timeout: float = 180,
    poll_interval: float = 5,
) -> Optional[dict]:
    """
    Poll until a comment containing keyword appears on the given PR/Issue.
    Returns the first matching comment, or None if timeout is reached.
    """
    deadline = time.monotonic() + timeout
    async with httpx.AsyncClient() as c:
        while time.monotonic() < deadline:
            r = await c.get(
                f"{_BASE}/repos/{repo}/issues/{issue_number}/comments",
                headers=_headers(token),
            )
            r.raise_for_status()
            for comment in r.json():
                if keyword in (comment.get("body") or ""):
                    return comment
            await asyncio.sleep(poll_interval)
    return None
