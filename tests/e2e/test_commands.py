"""
命令级 E2E 测试 — 对 bot 核心命令做内容级验证。

对 /help、/start、/status 等命令的回复内容进行关键词断言，
覆盖私聊和群组两种 chat 类型。
"""
from __future__ import annotations

import pytest
from telethon import TelegramClient

from helpers import send_and_wait, send_and_wait_for_content, send_to_group_and_wait


class TestCommandsPrivate:
    """私聊命令内容验证测试。"""

    async def test_help_contains_keywords(
        self, client: TelegramClient, bot_username: str
    ):
        """/help 回复包含帮助相关关键词（help 或 command）。"""
        await send_and_wait_for_content(
            client,
            bot_username,
            "/help",
            ["help", "command", "/"],
            mode="OR",
            timeout=30,
        )

    async def test_start_contains_keywords(
        self, client: TelegramClient, bot_username: str
    ):
        """/start 回复包含欢迎或初始化相关关键词。"""
        await send_and_wait_for_content(
            client,
            bot_username,
            "/start",
            ["Mikoto", "Commands", "/load", "/review"],
            mode="OR",
            timeout=30,
        )

    async def test_status_does_not_crash(
        self, client: TelegramClient, bot_username: str
    ):
        """
        私聊发送 /status 不应触发 bot 崩溃。
        /status 在私聊中可能无响应（需要群组权限），测试仅验证不报错。
        """
        replies = await send_and_wait(client, bot_username, "/status", timeout=8)
        # /status 在私聊中可能无响应（未配置 adminUsers），仅验证无异常即可
        # 若有响应，确保不含运行时错误特征
        for r in replies:
            text = r.text or ""
            assert "Traceback" not in text, f"Bot returned Python traceback: {text}"
            assert "TypeError" not in text, f"Bot returned TypeError: {text}"


class TestCommandsGroup:
    """群组命令内容验证测试（需要 TEST_GROUP_ID 配置）。"""

    async def test_help_in_group(
        self,
        client: TelegramClient,
        bot_username: str,
        test_group_id: int | None,
    ):
        """在群组中发送 /help，验证回复包含帮助相关关键词。"""
        if not test_group_id:
            pytest.skip("TEST_GROUP_ID not configured")

        replies = await send_to_group_and_wait(
            client,
            test_group_id,
            bot_username,
            f"/help@{bot_username}",
            timeout=30,
        )
        assert len(replies) > 0, "Bot did not respond to /help in group"
        reply_text = " ".join(m.text or "" for m in replies)
        assert any(kw in reply_text for kw in ["help", "command", "/"]), (
            f"Reply does not contain expected help keywords: {reply_text!r}"
        )

    async def test_start_in_group(
        self,
        client: TelegramClient,
        bot_username: str,
        test_group_id: int | None,
    ):
        """在群组中发送 /start，验证回复包含欢迎相关关键词。"""
        if not test_group_id:
            pytest.skip("TEST_GROUP_ID not configured")

        replies = await send_to_group_and_wait(
            client,
            test_group_id,
            bot_username,
            f"/start@{bot_username}",
            timeout=30,
        )
        assert len(replies) > 0, "Bot did not respond to /start in group"
        reply_text = " ".join(m.text or "" for m in replies)
        assert any(kw in reply_text for kw in ["Mikoto", "Commands", "/load", "/review"]), (
            f"Reply does not contain expected start keywords: {reply_text!r}"
        )

    async def test_status_in_group(
        self,
        client: TelegramClient,
        bot_username: str,
        test_group_id: int | None,
    ):
        """在群组中发送 /status，验证回复包含状态相关关键词。"""
        if not test_group_id:
            pytest.skip("TEST_GROUP_ID not configured")

        replies = await send_to_group_and_wait(
            client,
            test_group_id,
            bot_username,
            f"/status@{bot_username}",
            timeout=30,
        )
        assert len(replies) > 0, "Bot did not respond to /status in group"
        reply_text = " ".join(m.text or "" for m in replies)
        assert any(kw in reply_text for kw in ["status", "running", "ok", "active", "状态", "运行", "Permission", "No active", "Tasks"]), (
            f"Reply does not contain expected status keywords: {reply_text!r}"
        )
