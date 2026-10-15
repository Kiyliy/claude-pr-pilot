"""
GitHub → TG 双向同步 E2E 测试（标记: github_sync）。

测试场景：
  在 GitHub PR 上创建评论，验证 TG group 的对应 topic 收到同步消息。

所需配置（tests/e2e/.env.e2e）：
  TEST_GROUP_ID   — 已绑定测试仓库、syncPR=true 的 TG 群组
  TEST_REPO       — 测试 GitHub 仓库（owner/repo）
  GITHUB_TOKEN    — 有 repo write 权限的 PAT
"""
from __future__ import annotations

import asyncio
import time

import pytest
from telethon import TelegramClient

from helpers import send_to_group_and_wait, wait_for_bot_message_in_group
from github_api import create_issue_comment

pytestmark = pytest.mark.github_sync


def _skip_if_not_configured(
    test_group_id: int | None,
    test_repo: str | None,
    github_token: str | None,
    github_pr: int | None,
) -> None:
    if not test_group_id:
        pytest.skip("TEST_GROUP_ID not configured")
    if not test_repo or not github_token:
        pytest.skip("TEST_REPO or GITHUB_TOKEN not configured")
    if not github_pr:
        pytest.skip("Could not create test PR — check GITHUB_TOKEN and repo access")


class TestGitHubToTGSync:
    """GitHub comment → TG topic 同步测试。"""

    async def test_github_comment_syncs_to_tg(
        self,
        client: TelegramClient,
        bot_username: str,
        test_group_id: int | None,
        test_repo: str | None,
        github_token: str | None,
        github_pr: int | None,
    ):
        """
        在 GitHub PR 创建评论，验证它出现在 TG 群组的对应 topic 中。

        流程：
          1. /load 将测试 PR 加载到 TG group topic
          2. 通过 GitHub API 发一条含唯一 marker 的评论
          3. 监听 TG group，等待 bot 把这条评论同步过来（含相同 marker）

        依赖 bot 的 syncGitHubCommentToTG 功能和 webhook 可达性。
        """
        _skip_if_not_configured(test_group_id, test_repo, github_token, github_pr)

        # Step 1: Load the test PR into TG group
        load_replies = await send_to_group_and_wait(
            client,
            test_group_id,
            bot_username,
            f"/load@{bot_username} {github_pr}",
            timeout=15,
        )
        assert len(load_replies) > 0, (
            f"Bot did not respond to /load {github_pr}. "
            "Ensure the PR exists and the group is configured."
        )

        # Step 2 & 3: Register listener BEFORE creating the comment to avoid
        # a race condition where a fast webhook could deliver the sync message
        # before the handler is registered.
        marker = f"e2e-sync-{int(time.time())}"
        handler_task = asyncio.create_task(
            wait_for_bot_message_in_group(
                client,
                test_group_id,
                bot_username,
                marker,
                timeout=30,
            )
        )
        await create_issue_comment(
            test_repo,
            github_token,
            github_pr,
            f"e2e test comment: {marker}",
        )
        msg = await handler_task
        assert msg is not None, (
            f"GitHub comment (marker={marker!r}) did not sync to TG within 30s. "
            "Check that syncPR=true for the group and webhook is reachable from GitHub."
        )
