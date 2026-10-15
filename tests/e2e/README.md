# E2E Tests

端到端测试框架，基于 [Telethon](https://docs.telethon.dev/) 模拟真实 Telegram 用户与 bot 交互。

## 前置条件

1. 一个 Telegram 测试账号
2. [TGBotChecker](https://tgbotchecker.com/) UUID（用于自动获取登录验证码）
3. Bot 已运行并可接收消息

## 安装

```bash
pip install -r tests/e2e/requirements.txt
```

## 配置

复制 `.env.e2e.example` 并填入真实值：

```bash
cp tests/e2e/.env.e2e.example tests/e2e/.env.e2e
```

## 运行

```bash
# 运行所有 e2e 测试
cd tests/e2e && python -m pytest -v

# 只运行 smoke test
cd tests/e2e && python -m pytest test_smoke.py -v
```

首次运行时会自动通过 TGBotChecker 获取验证码完成 Telethon 登录。
后续运行会复用 session 文件，无需重新登录。

## 文件结构

```
tests/e2e/
├── .env.e2e.example   # 环境变量模板
├── .env.e2e           # 实际配置（gitignored）
├── conftest.py        # pytest fixtures（client 登录、config 加载）
├── code_provider.py   # TGBotChecker 验证码抓取器
├── helpers.py         # 通用工具（send_and_wait 等）
├── pytest.ini         # pytest 配置
├── requirements.txt   # Python 依赖
└── test_smoke.py      # 基础连通性测试
```

## 编写新测试

```python
from helpers import send_and_wait

class TestMyFeature:
    async def test_something(self, client, bot_username):
        replies = await send_and_wait(client, bot_username, "/my_command", timeout=15)
        assert len(replies) > 0
        assert "expected text" in replies[0].text
```
