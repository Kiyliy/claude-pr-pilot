"""
TGBotChecker 验证码提供器。

通过轮询 TGBotChecker 的 HTML 页面，自动提取 Telegram 登录验证码。
当 Telethon 请求验证码时，会自动从该页面抓取最新的验证码。
"""
from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass
from typing import Optional

import httpx
from bs4 import BeautifulSoup


TGBOTCHECKER_URL = "https://tgbotchecker.com/GetHTML?uuid={uuid}"


@dataclass
class LoginInfo:
    code: Optional[str] = None
    password_2fa: Optional[str] = None
    login_time: Optional[str] = None
    last_fetch_time: Optional[str] = None


class TGBotCheckerCodeProvider:
    """从 TGBotChecker HTML 页面抓取验证码和 2FA 密码。"""

    def __init__(self, uuid: str, password_2fa_fallback: Optional[str] = None):
        self._uuid = uuid
        self._url = TGBOTCHECKER_URL.format(uuid=uuid)
        self._password_2fa_fallback = password_2fa_fallback
        self._last_info: Optional[LoginInfo] = None

    async def fetch_login_info(self) -> LoginInfo:
        """抓取一次 TGBotChecker 页面，解析出验证码和 2FA 密码。"""
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(self._url)
            resp.raise_for_status()

        soup = BeautifulSoup(resp.text, "html.parser")
        info = LoginInfo()

        # 验证码: <input id="code" ... value="xxxxx">
        code_input = soup.find("input", {"id": "code"})
        if code_input:
            info.code = code_input.get("value", "").strip()

        # 2FA 密码: <input id="pass2fa" ... value="xxxxx">
        pass_input = soup.find("input", {"id": "pass2fa"})
        if pass_input:
            info.password_2fa = pass_input.get("value", "").strip()

        # 登录时间
        inputs = soup.find_all("input", {"class": "form-input"})
        for inp in inputs:
            val = inp.get("value", "")
            # 匹配时间格式 YYYY-MM-DD HH:MM:SS
            if re.match(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", val):
                if info.login_time is None:
                    info.login_time = val
                else:
                    info.last_fetch_time = val

        self._last_info = info
        return info

    async def wait_for_new_code(
        self,
        *,
        timeout: float = 120,
        poll_interval: float = 3,
        known_code: Optional[str] = None,
    ) -> str:
        """
        轮询等待新的验证码出现。

        Args:
            timeout: 最大等待秒数
            poll_interval: 轮询间隔秒数
            known_code: 已知的旧验证码，等到出现不同的验证码才返回

        Returns:
            新的验证码字符串

        Raises:
            TimeoutError: 超时未获取到新验证码
        """
        start = time.monotonic()
        while time.monotonic() - start < timeout:
            try:
                info = await self.fetch_login_info()
                if info.code and info.code != known_code:
                    return info.code
            except Exception as e:
                print(f"[CodeProvider] fetch error: {e}, retrying...")
            await asyncio.sleep(poll_interval)

        raise TimeoutError(
            f"Timed out after {timeout}s waiting for new verification code "
            f"(known_code={known_code!r})"
        )

    async def get_code_callback(self) -> str:
        """
        Telethon code_callback 兼容接口。

        在调用 client.sign_in() 之前先记录当前验证码，
        然后等待新验证码出现。
        """
        # 先获取当前页面上的旧验证码
        try:
            old_info = await self.fetch_login_info()
            old_code = old_info.code
        except Exception:
            old_code = None

        print(f"[CodeProvider] Current code on page: {old_code}, waiting for new code...")
        new_code = await self.wait_for_new_code(known_code=old_code)
        print(f"[CodeProvider] Got new code: {new_code}")
        return new_code

    def get_2fa_password(self) -> Optional[str]:
        """返回 2FA 密码（优先用页面上的，其次用 fallback）。"""
        if self._last_info and self._last_info.password_2fa:
            return self._last_info.password_2fa
        return self._password_2fa_fallback
