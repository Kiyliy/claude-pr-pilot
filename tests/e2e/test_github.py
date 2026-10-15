"""
GitHub 集成 E2E 测试。

测试 bot 的 GitHub 集成功能：
- /load 命令：加载 PR 列表或指定 PR
- review 流程：验证 bot 能对 GitHub 集成请求做出合理响应

依赖配置（在 tests/e2e/.env.e2e 中设置）：
  TEST_REPO                  — GitHub 仓库（owner/repo 格式，如 Kiyliy/auto-review-e2e-test）
  GITHUB_APP_INSTALLATION_ID — GitHub App installation ID
  TEST_GROUP_ID              — 已绑定 TEST_REPO 的 Telegram 群组 ID
  CLAUDE_MODEL               — 建议设为 claude-haiku-4-5-20251001 以降低测试成本
"""
from __future__ import annotations

import pytest
from telethon import TelegramClient

from helpers import send_and_wait, send_and_wait_for_content, send_to_group_and_wait


def _skip_if_github_not_configured(
    test_repo: str | None,
    github_app_installation_id: int | None,
) -> None:
    """若未配置 GitHub 集成变量则跳过当前测试。"""
    if not test_repo or not github_app_installation_id:
        pytest.skip("TEST_REPO or GITHUB_APP_INSTALLATION_ID not configured")


def _skip_if_group_not_configured(test_group_id: int | None) -> None:
    """若未配置 TEST_GROUP_ID 则跳过当前测试。"""
    if not test_group_id:
        pytest.skip("TEST_GROUP_ID not configured")


class TestGitHubLoad:
    """测试 /load 命令的 GitHub PR 列表查询功能。"""

    async def test_load_in_dm_returns_response(
        self,
        client: TelegramClient,
        bot_username: str,
        test_repo: str | None,
        github_app_installation_id: int | None,
    ):
        """
        在私聊中发送 /load，验证 bot 有回复。
        私聊无群组上下文，bot 应返回提示信息（非崩溃）。
        """
        _skip_if_github_not_configured(test_repo, github_app_installation_id)

        replies = await send_and_wait(client, bot_username, "/load", timeout=15)
        assert len(replies) > 0, "Bot 未响应 /load 命令"

    async def test_load_lists_prs_in_group(
        self,
        client: TelegramClient,
        bot_username: str,
        test_repo: str | None,
        github_app_installation_id: int | None,
        test_group_id: int | None,
    ):
        """
        在绑定了测试仓库的群组中发送 /load，验证 bot 返回 PR 列表相关内容。
        回复应包含 PR 编号（如 #1）、仓库名、"PR" 关键词，或带有 PR 选择的 inline keyboard。
        """
        _skip_if_github_not_configured(test_repo, github_app_installation_id)
        _skip_if_group_not_configured(test_group_id)

        repo_short = test_repo.split("/")[-1]  # type: ignore[union-attr]

        replies = await send_to_group_and_wait(
            client,
            test_group_id,  # type: ignore[arg-type]
            bot_username,
            f"/load@{bot_username}",
            timeout=30,
        )
        assert len(replies) > 0, "Bot 未在群组中响应 /load 命令"

        full_text = " ".join(r.text or "" for r in replies)

        # bot 可能通过 inline keyboard 展示 PR 列表，也可能在文本中列出
        has_inline_keyboard = any(r.reply_markup is not None for r in replies)
        pr_keywords = ["#", "PR", "pull", "open", "Open", repo_short]
        has_text_keywords = any(kw in full_text for kw in pr_keywords)

        assert has_text_keywords or has_inline_keyboard, (
            f"Bot 回复既不含 PR 列表关键词 {pr_keywords!r}，也不含 inline keyboard。"
            f"实际回复：{full_text!r}"
        )

    async def test_load_specific_pr_in_group(
        self,
        client: TelegramClient,
        bot_username: str,
        test_repo: str | None,
        github_app_installation_id: int | None,
        test_group_id: int | None,
    ):
        """
        在群组中发送 /load 1，验证 bot 能响应加载指定 PR 的请求。
        bot 应回复 PR 加载状态或相关提示，不应无响应。
        """
        _skip_if_github_not_configured(test_repo, github_app_installation_id)
        _skip_if_group_not_configured(test_group_id)

        replies = await send_to_group_and_wait(
            client,
            test_group_id,  # type: ignore[arg-type]
            bot_username,
            f"/load@{bot_username} 1",
            timeout=30,
        )
        assert len(replies) > 0, "Bot 未响应 /load 1 命令"


class TestGitHubReview:
    """测试 GitHub PR review 响应流程。"""

    async def test_load_responds_without_runtime_error(
        self,
        client: TelegramClient,
        bot_username: str,
        test_repo: str | None,
        github_app_installation_id: int | None,
        test_group_id: int | None,
        model_name: str,
    ):
        """
        在群组中发送 /load，验证 bot 能对 GitHub 集成请求做出合理响应。
        回复应有内容，且不包含未捕获的运行时错误信息。
        model_name 记录当前测试使用的 Claude 模型（应为 Haiku 以控制成本）。
        """
        _skip_if_github_not_configured(test_repo, github_app_installation_id)
        _skip_if_group_not_configured(test_group_id)

        replies = await send_to_group_and_wait(
            client,
            test_group_id,  # type: ignore[arg-type]
            bot_username,
            f"/load@{bot_username}",
            timeout=30,
        )
        assert len(replies) > 0, (
            f"Bot 未响应 GitHub /load 请求（使用模型：{model_name}）"
        )

        full_text = " ".join(r.text or "" for r in replies)

        # 验证回复不包含 Python/Node.js 运行时错误特征词
        runtime_error_keywords = ["Traceback", "TypeError", "UnhandledPromiseRejection", "Error:"]
        for err_kw in runtime_error_keywords:
            assert err_kw not in full_text, (
                f"Bot 回复包含运行时错误关键词 {err_kw!r}，实际回复：{full_text!r}"
            )

    async def test_review_responds_in_group(
        self,
        client: TelegramClient,
        bot_username: str,
        test_repo: str | None,
        github_app_installation_id: int | None,
        test_group_id: int | None,
        model_name: str,
    ):
        """
        在群组中发送 /review 命令，验证 bot 能做出响应（不报错、有内容）。
        即使在无 PR 上下文的情况下，bot 也应返回使用提示而非崩溃。
        """
        _skip_if_github_not_configured(test_repo, github_app_installation_id)
        _skip_if_group_not_configured(test_group_id)

        replies = await send_to_group_and_wait(
            client,
            test_group_id,  # type: ignore[arg-type]
            bot_username,
            f"/review@{bot_username}",
            timeout=30,
        )
        assert len(replies) > 0, (
            f"Bot 未响应 /review 命令（使用模型：{model_name}）"
        )

        full_text = " ".join(r.text or "" for r in replies)
        assert full_text.strip(), f"Bot /review 回复为空（使用模型：{model_name}）"
