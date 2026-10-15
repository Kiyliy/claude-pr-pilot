"""
E2E 测试通用工具函数。

提供发送消息并等待 bot 回复的封装，方便各测试文件复用。
"""
from __future__ import annotations

import asyncio
from typing import Optional, Sequence, Union

from telethon import TelegramClient, events
from telethon.tl.custom.message import Message


async def send_and_wait(
    client: TelegramClient,
    target: str | int,
    text: str,
    *,
    timeout: float = 15,
    reply_count: int = 1,
) -> list[Message]:
    """
    向目标发送一条消息，然后等待 bot 的回复。

    Args:
        client: 已登录的 Telethon 客户端
        target: bot username 或 chat id
        text: 要发送的消息文本
        timeout: 最大等待秒数
        reply_count: 期望收到的回复条数

    Returns:
        收到的回复消息列表
    """
    replies: list[Message] = []
    got_enough = asyncio.Event()

    async def on_new_message(event: events.NewMessage.Event):
        replies.append(event.message)
        if len(replies) >= reply_count:
            got_enough.set()

    handler = client.on(events.NewMessage(from_users=target))(on_new_message)

    try:
        await client.send_message(target, text)
        try:
            await asyncio.wait_for(got_enough.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            pass  # 返回已收到的（可能为空）
    finally:
        client.remove_event_handler(on_new_message)

    return replies


async def send_and_wait_for_content(
    client: TelegramClient,
    chat: str | int,
    text: str,
    expected_keywords: Sequence[str],
    *,
    timeout: float = 30,
    mode: str = "AND",
) -> Message:
    """
    向目标发送消息，等待 bot 回复中包含指定关键词，超时则抛出 AssertionError。

    Args:
        client: 已登录的 Telethon 客户端
        chat: bot username 或 chat id
        text: 要发送的消息文本
        expected_keywords: 期望回复中出现的关键词列表
        timeout: 最大等待秒数，默认 30
        mode: 多关键词匹配模式，"AND" 表示全部匹配，"OR" 表示任意一个匹配

    Returns:
        第一条满足关键词条件的回复消息

    Raises:
        AssertionError: 超时前未收到满足条件的回复
    """
    matched: list[Message] = []
    got_match = asyncio.Event()

    def _matches(message_text: str) -> bool:
        if not expected_keywords:
            return True
        if mode.upper() == "OR":
            return any(kw in message_text for kw in expected_keywords)
        return all(kw in message_text for kw in expected_keywords)

    async def on_new_message(event: events.NewMessage.Event):
        msg: Message = event.message
        if _matches(msg.text or ""):
            matched.append(msg)
            got_match.set()

    client.on(events.NewMessage(from_users=chat))(on_new_message)

    try:
        await client.send_message(chat, text)
        try:
            await asyncio.wait_for(got_match.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            if mode.upper() == "OR":
                kw_repr = " OR ".join(repr(k) for k in expected_keywords)
            else:
                kw_repr = " AND ".join(repr(k) for k in expected_keywords)
            raise AssertionError(
                f"Timed out after {timeout}s waiting for reply containing {kw_repr}"
            )
    finally:
        client.remove_event_handler(on_new_message)

    return matched[0]


async def send_to_group_and_wait(
    client: TelegramClient,
    group_id: int,
    bot_username: str,
    text: str,
    *,
    timeout: float = 15,
    reply_count: int = 1,
) -> list[Message]:
    """
    在群组中发送消息，等待 bot 在群内的回复。

    Args:
        client: 已登录的 Telethon 客户端
        group_id: 群组 chat id
        bot_username: bot 的 username（用于过滤回复来源）
        text: 要发送的消息文本
        timeout: 最大等待秒数
        reply_count: 期望收到的回复条数

    Returns:
        收到的回复消息列表
    """
    replies: list[Message] = []
    got_enough = asyncio.Event()

    async def on_new_message(event: events.NewMessage.Event):
        sender = await event.get_sender()
        if sender and getattr(sender, "username", None) == bot_username:
            replies.append(event.message)
            if len(replies) >= reply_count:
                got_enough.set()

    handler = client.on(events.NewMessage(chats=group_id))(on_new_message)

    try:
        await client.send_message(group_id, text)
        try:
            await asyncio.wait_for(got_enough.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            pass
    finally:
        client.remove_event_handler(on_new_message)

    return replies


async def wait_for_bot_message_in_group(
    client: TelegramClient,
    group_id: int,
    bot_username: str,
    keyword: str,
    *,
    timeout: float = 30,
) -> Optional[Message]:
    """
    不发送任何消息，纯粹等待 bot 在群组（任意 topic）发出含 keyword 的消息。

    用于异步事件验证，例如：GitHub webhook 触发 → TG 同步到达。

    Args:
        client: 已登录的 Telethon 客户端
        group_id: 群组 chat id
        bot_username: 要监听的 bot username
        keyword: 期望出现在消息中的关键词
        timeout: 最大等待秒数

    Returns:
        第一条匹配的消息，超时返回 None
    """
    found: list[Message] = []
    got_it = asyncio.Event()

    async def on_new_message(event: events.NewMessage.Event):
        msg: Message = event.message
        sender = await event.get_sender()
        if sender and getattr(sender, "username", None) == bot_username:
            if keyword in (msg.text or ""):
                found.append(msg)
                got_it.set()

    client.on(events.NewMessage(chats=group_id))(on_new_message)
    try:
        try:
            await asyncio.wait_for(got_it.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            pass
    finally:
        client.remove_event_handler(on_new_message)

    return found[0] if found else None
