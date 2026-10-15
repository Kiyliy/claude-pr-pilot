"""
E2E 测试 fixtures — 基于 Telethon 的真实 Telegram 客户端。

使用 TGBotChecker 自动获取验证码完成登录。
"""
from __future__ import annotations

import os
import asyncio
import time
from pathlib import Path

import sys

import pytest
import pytest_asyncio
from dotenv import load_dotenv
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError

# 确保 tests/e2e 目录在 sys.path 中，以便导入 code_provider
sys.path.insert(0, str(Path(__file__).parent))
from code_provider import TGBotCheckerCodeProvider
from github_api import get_default_branch_sha, create_branch, create_file, create_pr, close_pr, delete_branch

# 加载 .env.e2e 配置
_env_path = Path(__file__).parent / ".env.e2e"
load_dotenv(_env_path)


def _require_env(key: str) -> str:
    val = os.getenv(key)
    if not val:
        pytest.skip(f"Missing required env var: {key} (set it in tests/e2e/.env.e2e)")
    return val


@pytest.fixture(scope="session")
def e2e_config():
    """加载 E2E 测试配置。"""
    return {
        "api_id": int(_require_env("TG_API_ID")),
        "api_hash": _require_env("TG_API_HASH"),
        "phone": _require_env("TG_PHONE"),
        "password_2fa": os.getenv("TG_2FA_PASSWORD", ""),
        "tgbotchecker_uuid": os.getenv("TGBOTCHECKER_UUID", ""),
        "bot_username": _require_env("BOT_USERNAME"),
        "test_group_id": os.getenv("TEST_GROUP_ID", ""),
        "test_user_id": os.getenv("TEST_USER_ID", ""),
        "test_repo": os.getenv("TEST_REPO", ""),
        "github_app_installation_id": os.getenv("GITHUB_APP_INSTALLATION_ID", ""),
        "session_name": os.getenv("SESSION_NAME", "e2e_test_session"),
        "github_token": os.getenv("GITHUB_TOKEN", ""),
    }


@pytest_asyncio.fixture(scope="session")
async def client(e2e_config) -> TelegramClient:
    """
    创建并登录 Telethon 客户端。

    - 如果已有 session 文件，直接复用（无需重新登录）
    - 否则通过 TGBotChecker 自动获取验证码登录
    """
    session_path = str(Path(__file__).parent / e2e_config["session_name"])
    tg_client = TelegramClient(
        session_path,
        e2e_config["api_id"],
        e2e_config["api_hash"],
    )

    await tg_client.connect()

    if not await tg_client.is_user_authorized():
        print(f"\n[E2E] Not authorized, starting login for {e2e_config['phone']}...")

        code_provider = TGBotCheckerCodeProvider(
            uuid=e2e_config["tgbotchecker_uuid"],
            password_2fa_fallback=e2e_config["password_2fa"],
        )

        # 先记录当前页面上的旧验证码
        try:
            old_info = await code_provider.fetch_login_info()
            old_code = old_info.code
            print(f"[E2E] Current code on TGBotChecker page: {old_code}")
        except Exception:
            old_code = None

        # 发送验证码请求
        await tg_client.send_code_request(e2e_config["phone"])
        print("[E2E] Code request sent, waiting for new code on TGBotChecker...")

        # 等待新验证码出现
        code = await code_provider.wait_for_new_code(
            known_code=old_code,
            timeout=120,
            poll_interval=3,
        )
        print(f"[E2E] Got verification code: {code}")

        try:
            await tg_client.sign_in(e2e_config["phone"], code)
        except SessionPasswordNeededError:
            password = code_provider.get_2fa_password() or e2e_config["password_2fa"]
            if not password:
                raise RuntimeError(
                    "2FA password required but not provided. "
                    "Set TG_2FA_PASSWORD in .env.e2e"
                )
            print("[E2E] 2FA required, signing in with password...")
            await tg_client.sign_in(password=password)

        print("[E2E] Login successful!")

    # Populate entity cache so numeric channel IDs can be resolved
    await tg_client.get_dialogs(limit=None)

    yield tg_client

    await tg_client.disconnect()


@pytest.fixture(scope="session")
def bot_username(e2e_config) -> str:
    """被测 bot 的 username（不含 @）。"""
    return e2e_config["bot_username"]


@pytest.fixture(scope="session")
def test_group_id(e2e_config) -> int | None:
    """测试群组 ID，如果未配置则返回 None。"""
    gid = e2e_config["test_group_id"]
    return int(gid) if gid else None


@pytest.fixture(scope="session")
def test_user_id(e2e_config) -> int | None:
    """测试用户的 Telegram ID。"""
    uid = e2e_config["test_user_id"]
    return int(uid) if uid else None


@pytest.fixture(scope="session")
def test_repo(e2e_config) -> str | None:
    """E2E 测试用的 GitHub 仓库（owner/repo 格式）。"""
    return e2e_config["test_repo"] or None


@pytest.fixture(scope="session")
def github_app_installation_id(e2e_config) -> int | None:
    """GitHub App installation ID for the test repo."""
    iid = e2e_config["github_app_installation_id"]
    return int(iid) if iid else None


@pytest.fixture(scope="session")
def model_name() -> str:
    """当前使用的 Claude 模型名称，从 CLAUDE_MODEL 环境变量读取。"""
    return os.environ.get("CLAUDE_MODEL", "default")


@pytest.fixture(scope="session")
def github_token(e2e_config) -> str | None:
    """GitHub PAT（repo scope），用于测试侧创建 PR / comment。"""
    token = e2e_config["github_token"]
    return token or None


@pytest_asyncio.fixture(scope="module")
async def github_pr(e2e_config, github_token):
    """
    在测试仓库中创建一个 e2e 专用测试 PR，yield PR number，测试结束后关闭并删除分支。

    需要 TEST_REPO 和 GITHUB_TOKEN。若未配置则 yield None，使用方自行 skip。
    """
    test_repo = e2e_config["test_repo"]
    if not test_repo or not github_token:
        yield None
        return

    ts = int(time.time())
    branch = f"e2e-test-{ts}"
    filename = f"e2e_test_{ts}.txt"
    pr_number = None
    branch_created = False

    try:
        sha = await get_default_branch_sha(test_repo, github_token)
        await create_branch(test_repo, github_token, branch, sha)
        branch_created = True
        await create_file(
            test_repo, github_token,
            filename, f"e2e test content {ts}",
            branch, f"e2e: add test file {ts}",
        )
        pr_data = await create_pr(
            test_repo, github_token,
            title=f"[e2e] test PR {ts}",
            head=branch,
            body="Automated e2e test PR — safe to close.",
        )
        pr_number = pr_data["number"]
        print(f"\n[e2e] Created test PR #{pr_number} on branch {branch!r}")
        yield pr_number
    except Exception as exc:
        print(f"\n[e2e] Failed to create test PR: {exc}")
        yield None
    finally:
        # Cleanup regardless of success or failure
        if pr_number:
            try:
                await close_pr(test_repo, github_token, pr_number)
            except Exception as exc:
                print(f"\n[e2e] Cleanup warning (close PR #{pr_number}): {exc}")
        if branch_created:
            try:
                await delete_branch(test_repo, github_token, branch)
            except Exception as exc:
                print(f"\n[e2e] Cleanup warning (delete branch {branch!r}): {exc}")
        if pr_number or branch_created:
            print(f"\n[e2e] Cleaned up PR #{pr_number} and branch {branch!r}")
