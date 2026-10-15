import { vi } from "vitest";

export const log = vi.fn();
export const formatDuration = vi.fn(() => "1s");
export const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
