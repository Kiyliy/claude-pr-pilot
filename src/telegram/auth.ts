import { TELEGRAM_CONFIG } from "../config";

export function matchesUser(list: (number | string)[], userId: number, username?: string): boolean {
  if (list.includes(userId)) return true;
  if (username && list.includes(username)) return true;
  return false;
}

export function isAllowed(chatId: string, userId: number, username?: string): boolean {
  if (!TELEGRAM_CONFIG) return false;
  // Global admin → always allowed
  if (matchesUser(TELEGRAM_CONFIG.adminUsers, userId, username)) return true;
  // Per-group allowedUsers
  const group = TELEGRAM_CONFIG.groups[chatId];
  if (group?.allowedUsers && matchesUser(group.allowedUsers, userId, username)) return true;
  return false;
}

export function isAdmin(userId: number, username?: string): boolean {
  if (!TELEGRAM_CONFIG) return false;
  return matchesUser(TELEGRAM_CONFIG.adminUsers, userId, username);
}
