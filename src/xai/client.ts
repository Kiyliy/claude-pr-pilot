/**
 * xAI API client — used to generate concise Telegram topic titles from PR info.
 */

import { logger } from "../utils/logger";

const DEFAULT_BASE_URL = "https://api.x.ai";
const MODEL = "grok-4-1-fast-non-reasoning";
const TIMEOUT_MS = 10_000;

function getApiUrl(): string {
  const base = (process.env.XAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return `${base}/v1/chat/completions`;
}

/**
 * Ask Grok to summarize a PR title into a clean, human-friendly Telegram topic title.
 * Returns `#<prNumber> <generatedTitle>` on success, falls back to
 * `#<prNumber> <rawTitle>` on any error.
 */
export async function generateTopicTitle(
  prNumber: number,
  rawTitle: string
): Promise<string> {
  const fallback = `#${prNumber} ${rawTitle}`;

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    logger.warn("[xAI] XAI_API_KEY not set, using raw PR title", { prNumber });
    return fallback;
  }

  const prompt =
    `你是一个 Telegram 群组 Forum Topic 命名助手。` +
    `请将以下 GitHub PR 标题改写为简洁、可读的 Topic 名称（不超过 45 个字符）。` +
    `去掉 "feat:"、"fix:"、"refactor:"、"[WIP]" 等技术性前缀，保留核心语义。` +
    `如果原标题是英文，可保持英文；如果是中文，保持中文。` +
    `只输出 Topic 名称本身，不要加引号或其他解释。\n\n` +
    `PR #${prNumber}: ${rawTitle}`;

  try {
    logger.debug("[xAI] Requesting title from xAI API", { prNumber, model: MODEL, rawTitle });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(getApiUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 60,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      logger.warn(`[xAI] API error ${response.status}: ${response.statusText}`, { prNumber, status: response.status });
      return fallback;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const generated = data.choices?.[0]?.message?.content?.trim();
    if (!generated) {
      logger.warn("[xAI] Empty response from API, using raw PR title", { prNumber });
      return fallback;
    }

    logger.info(`[xAI] Generated topic title for PR #${prNumber}: "${generated}"`, { prNumber, generated });
    return `#${prNumber} ${generated}`;
  } catch (err: any) {
    if (err.name === "AbortError") {
      logger.warn(`[xAI] Request timed out for PR #${prNumber}, using raw title`, { prNumber, timeoutMs: TIMEOUT_MS });
    } else {
      logger.warn(`[xAI] generateTopicTitle failed: ${err.message}`, { prNumber, error: err.message });
    }
    return fallback;
  }
}
