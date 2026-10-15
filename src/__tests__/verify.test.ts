import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { verifySignature } from "../webhook/verify";

function sign(payload: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

describe("verifySignature", () => {
  const secret = "test-webhook-secret";
  const payload = '{"action":"opened"}';

  it("returns true for a valid signature", () => {
    const sig = sign(payload, secret);
    expect(verifySignature(payload, sig, secret)).toBe(true);
  });

  it("returns false for an invalid signature", () => {
    expect(verifySignature(payload, "sha256=invalid", secret)).toBe(false);
  });

  it("returns false when signature is undefined", () => {
    expect(verifySignature(payload, undefined, secret)).toBe(false);
  });

  it("returns false when secret is empty", () => {
    const sig = sign(payload, secret);
    expect(verifySignature(payload, sig, "")).toBe(false);
  });

  it("returns false for signature length mismatch", () => {
    expect(verifySignature(payload, "sha256=abc", secret)).toBe(false);
  });

  it("returns false for different payload", () => {
    const sig = sign(payload, secret);
    expect(verifySignature('{"action":"closed"}', sig, secret)).toBe(false);
  });
});
