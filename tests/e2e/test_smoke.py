"""
Smoke test — 验证 E2E 框架能正常连接 Telegram 并与 bot 交互。

这是最基础的测试，确保：
1. Telethon 客户端能登录
2. 能向 bot 发送消息
3. 能收到 bot 的回复
"""
from __future__ import annotations

import pytest
from telethon import TelegramClient

from helpers import send_and_wait


class TestSmoke:
    """基础连通性测试。"""

    async def test_client_connected(self, client: TelegramClient):
        """验证 Telethon 客户端已连接并授权。"""
        assert client.is_connected()
        assert await client.is_user_authorized()

    async def test_bot_reachable(self, client: TelegramClient, bot_username: str):
        """验证 bot 存在且可以接收消息。"""
        entity = await client.get_entity(bot_username)
        assert entity is not None
        assert getattr(entity, "bot", False), f"@{bot_username} is not a bot"

    async def test_bot_responds_to_start(self, client: TelegramClient, bot_username: str):
        """发送 /start，验证 bot 有回复。"""
        replies = await send_and_wait(client, bot_username, "/start", timeout=15)
        assert len(replies) > 0, "Bot did not respond to /start"

    async def test_bot_responds_to_help(self, client: TelegramClient, bot_username: str):
        """发送 /help，验证 bot 有回复。"""
        replies = await send_and_wait(client, bot_username, "/help", timeout=15)
        assert len(replies) > 0, "Bot did not respond to /help"


class TestGroupSmoke:
    """群组基础测试（需要 TEST_GROUP_ID 配置）。"""

    async def test_group_bot_responds(
        self, client: TelegramClient, bot_username: str, test_group_id: int | None
    ):
        """在群组中 @ bot，验证有回复。"""
        if not test_group_id:
            pytest.skip("TEST_GROUP_ID not configured")

        from helpers import send_to_group_and_wait

        replies = await send_to_group_and_wait(
            client,
            test_group_id,
            bot_username,
            f"/help@{bot_username}",
            timeout=15,
        )
        assert len(replies) > 0, "Bot did not respond in group"
