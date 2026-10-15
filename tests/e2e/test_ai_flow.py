"""
TG 命令 → AI 执行 → GitHub 结果验证 E2E 测试（标记: ai_flow）。

测试场景：
  A. /do: 发命令 → Claude 创建文件 → GitHub 出现新 PR
  B. /review: 发命令 → Claude review PR → GitHub 出现 CLAUDE REVIEW 评论

注意：
  - 这些测试会真正调用 Claude API，单次耗时 60-180s。
  - 测试结束后会自动关闭并清理在 GitHub 创建的资源。

所需配置（tests/e2e/.env.e2e）：
  TEST_GROUP_ID, TEST_REPO, GITHUB_TOKEN
  CLAUDE_MODEL=claude-haiku-4-5-20251001（推荐，降低测试成本）
"""
from __future__ import annotations

import time

import pytest
from telethon import TelegramClient

from helpers import send_to_group_and_wait
from github_api import (
    get_open_prs,
    wait_for_new_pr,
    wait_for_comment_with_keyword,
    close_pr,
    delete_branch,
)

pytestmark = pytest.mark.ai_flow


def _skip_if_not_configured(
    test_group_id: int | None,
    test_repo: str | None,
    github_token: str | None,
) -> None:
    if not test_group_id:
        pytest.skip("TEST_GROUP_ID not configured")
    if not test_repo or not github_token:
        pytest.skip("TEST_REPO or GITHUB_TOKEN not configured")


class TestDoFlow:
    """/do 命令：TG → AI → GitHub 创建新 PR。"""

    async def test_do_creates_pr(
        self,
        client: TelegramClient,
        bot_username: str,
        test_group_id: int | None,
        test_repo: str | None,
        github_token: str | None,
        model_name: str,
    ):
        """
        发送 /do 命令，验证 AI 在 GitHub 上真正创建了 PR。

        任务描述：在仓库根目录创建一个包含时间戳的测试文件，提交并开 PR。
        断言：GitHub 上出现新的 open PR（与命令发出前的 PR 列表对比）。
        最长等待：180s（涵盖 AI worktree 创建 + 执行 + 推送 + 开 PR）
        """
        _skip_if_not_configured(test_group_id, test_repo, github_token)

        ts = int(time.time())
        task = (
            f"Create a new file named `do_e2e_{ts}.txt` in the repository root "
            f"with the content `e2e test {ts}`. "
            f"Commit the change and open a PR titled `[e2e] do test {ts}`."
        )

        # Record PR numbers before the command
        existing_prs = {pr["number"] for pr in await get_open_prs(test_repo, github_token)}

        # Send /do command and verify bot acknowledges it
        replies = await send_to_group_and_wait(
            client,
            test_group_id,
            bot_username,
            f"/do@{bot_username} {task}",
            timeout=15,
        )
        assert len(replies) > 0, (
            f"Bot did not acknowledge /do command (model={model_name}). "
            "Ensure bot is running and the group is configured."
        )

        # Poll GitHub until a new PR appears (AI needs time to execute)
        new_pr = await wait_for_new_pr(
            test_repo,
            github_token,
            existing_prs,
            timeout=180,
        )
        assert new_pr is not None, (
            f"No new PR appeared on GitHub within 180s after /do (model={model_name}). "
            "AI may have failed — check bot logs for errors."
        )
        assert new_pr["title"].strip(), "New PR has an empty title"
        # Verify the PR was created by this test (prevent mismatching unrelated PRs)
        assert str(ts) in new_pr["title"], (
            f"Found unexpected PR #{new_pr['number']}: {new_pr['title']!r}, "
            f"expected title containing timestamp {ts}"
        )

        # Cleanup: close the PR and delete its branch
        try:
            await close_pr(test_repo, github_token, new_pr["number"])
            head_branch = new_pr.get("head", {}).get("ref", "")
            if head_branch and head_branch not in ("main", "master"):
                await delete_branch(test_repo, github_token, head_branch)
        except Exception as exc:
            print(f"\n[e2e] Cleanup warning: {exc}")


class TestReviewFlow:
    """/review 命令：TG → AI → GitHub 出现结构化 CLAUDE REVIEW 评论。"""

    async def test_review_posts_claude_comment(
        self,
        client: TelegramClient,
        bot_username: str,
        test_group_id: int | None,
        test_repo: str | None,
        github_token: str | None,
        github_pr: int | None,
        model_name: str,
    ):
        """
        在群组发送 /review <PR#>，验证 GitHub PR 上出现结构化 CLAUDE REVIEW 评论。

        格式断言：
          - 评论 body 包含 "CLAUDE REVIEW" 标记
          - 包含 verdict emoji（🔴 NEEDS REVIEW / 🟡 NEEDS FIXES / 🟢 APPROVED）

        最长等待：180s
        """
        _skip_if_not_configured(test_group_id, test_repo, github_token)
        if not github_pr:
            pytest.skip("Could not create test PR — check GITHUB_TOKEN and repo access")

        # Send /review with explicit PR number
        replies = await send_to_group_and_wait(
            client,
            test_group_id,
            bot_username,
            f"/review@{bot_username} {github_pr}",
            timeout=20,
        )
        assert len(replies) > 0, (
            f"Bot did not acknowledge /review {github_pr} (model={model_name})"
        )

        # Poll GitHub for the CLAUDE REVIEW comment
        comment = await wait_for_comment_with_keyword(
            test_repo,
            github_token,
            github_pr,
            "CLAUDE REVIEW",
            timeout=180,
        )
        assert comment is not None, (
            f"No CLAUDE REVIEW comment appeared on PR #{github_pr} within 180s "
            f"(model={model_name}). Check bot logs."
        )

        # Verify verdict structure (skill 约定的三种 verdict)
        body = comment["body"]
        assert any(v in body for v in ["🔴", "🟡", "🟢"]), (
            f"CLAUDE REVIEW comment missing verdict emoji (🔴/🟡/🟢). "
            f"First 300 chars: {body[:300]!r}"
        )
