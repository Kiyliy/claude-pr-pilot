import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import { log } from "../utils/logger";

interface TokenCache {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<number, TokenCache>();

const APP_ID = process.env.GITHUB_APP_ID || "";
const PRIVATE_KEY_PATH = process.env.GITHUB_APP_PRIVATE_KEY_PATH || "";

let privateKey: string | null = null;

function getPrivateKey(): string {
  if (privateKey) return privateKey;
  const keyPath = path.isAbsolute(PRIVATE_KEY_PATH)
    ? PRIVATE_KEY_PATH
    : path.join(__dirname, "..", "..", PRIVATE_KEY_PATH);
  privateKey = fs.readFileSync(keyPath, "utf-8");
  return privateKey;
}

function generateJWT(): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60, // 60s clock drift tolerance
    exp: now + 600, // 10 minutes max
    iss: APP_ID,
  };
  return jwt.sign(payload, getPrivateKey(), { algorithm: "RS256" });
}

async function requestInstallationToken(
  installationId: number
): Promise<{ token: string; expiresAt: string }> {
  const jwtToken = generateJWT();
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwtToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Failed to get installation token (${res.status}): ${body}`
    );
  }

  const data = await res.json();
  return { token: data.token, expiresAt: data.expires_at };
}

export async function getInstallationToken(
  installationId: number
): Promise<string> {
  const cached = tokenCache.get(installationId);
  // Refresh if no cache or expires within 5 minutes
  if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
    return cached.token;
  }

  log(`Requesting new installation token for installation ${installationId}`);
  const { token, expiresAt } = await requestInstallationToken(installationId);
  const expiresAtMs = new Date(expiresAt).getTime();
  tokenCache.set(installationId, { token, expiresAt: expiresAtMs });
  log(
    `Installation token obtained, expires at ${expiresAt}`
  );
  return token;
}
