import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { log, logger, formatDuration } from "../utils/logger";

describe("formatDuration", () => {
  it("formats seconds under 60", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(500)).toBe("0s");
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(30000)).toBe("30s");
    expect(formatDuration(59999)).toBe("59s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(60000)).toBe("1m0s");
    expect(formatDuration(61000)).toBe("1m1s");
    expect(formatDuration(90000)).toBe("1m30s");
    expect(formatDuration(3600000)).toBe("60m0s");
    expect(formatDuration(3661000)).toBe("61m1s");
  });
});

describe("log (backward compat)", () => {
  it("outputs timestamped message to console", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("test message");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T.+\] INFO\s+test message$/,
    );
    spy.mockRestore();
  });
});

describe("logger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_FORMAT;
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_FORMAT;
  });

  describe("log levels", () => {
    it("logger.info writes to console.log", () => {
      logger.info("hello");
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][0]).toMatch(/INFO\s+hello/);
    });

    it("logger.warn writes to console.warn", () => {
      logger.warn("caution");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/WARN\s+caution/);
    });

    it("logger.error writes to console.error", () => {
      logger.error("fail");
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toMatch(/ERROR fail/);
    });

    it("logger.debug is suppressed by default (level=info)", () => {
      logger.debug("hidden");
      expect(logSpy).not.toHaveBeenCalled();
    });

    it("logger.debug outputs when LOG_LEVEL=debug", () => {
      process.env.LOG_LEVEL = "debug";
      logger.debug("visible");
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][0]).toMatch(/DEBUG visible/);
    });
  });

  describe("level filtering", () => {
    it("LOG_LEVEL=warn suppresses info", () => {
      process.env.LOG_LEVEL = "warn";
      logger.info("hidden");
      logger.warn("shown");
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("LOG_LEVEL=error suppresses warn and info", () => {
      process.env.LOG_LEVEL = "error";
      logger.info("hidden");
      logger.warn("hidden");
      logger.error("shown");
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("JSON format", () => {
    it("outputs structured JSON when LOG_FORMAT=json", () => {
      process.env.LOG_FORMAT = "json";
      logger.info("structured");
      expect(logSpy).toHaveBeenCalledTimes(1);

      const parsed = JSON.parse(logSpy.mock.calls[0][0]);
      expect(parsed).toMatchObject({
        level: "info",
        msg: "structured",
      });
      expect(parsed.timestamp).toBeDefined();
    });

    it("includes context fields in JSON output", () => {
      process.env.LOG_FORMAT = "json";
      logger.info("with context", { repo: "foo/bar", pr: 42 });

      const parsed = JSON.parse(logSpy.mock.calls[0][0]);
      expect(parsed).toMatchObject({
        level: "info",
        msg: "with context",
        repo: "foo/bar",
        pr: 42,
      });
    });

    it("omits context when empty", () => {
      process.env.LOG_FORMAT = "json";
      logger.info("no context");

      const parsed = JSON.parse(logSpy.mock.calls[0][0]);
      expect(Object.keys(parsed)).toEqual(["timestamp", "level", "msg"]);
    });
  });

  describe("text format (default)", () => {
    it("includes level tag in text output", () => {
      logger.info("text mode");
      const output = logSpy.mock.calls[0][0] as string;
      expect(output).toMatch(/^\[\d{4}-\d{2}-\d{2}T.+\] INFO\s+text mode$/);
    });

    it("ignores context in text format", () => {
      logger.info("text mode", { extra: "data" });
      const output = logSpy.mock.calls[0][0] as string;
      expect(output).not.toContain("extra");
      expect(output).not.toContain("data");
    });
  });
});
