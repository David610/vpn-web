import { describe, it, expect } from "vitest";

const { onRequestPost } = await import("../resume-subscription.js");

describe("resume-subscription (retired, F-12/C-03)", () => {
  it("answers 410 Gone rather than performing any Stripe/DB action", async () => {
    const res = await onRequestPost();
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toMatch(/retired/i);
  });
});
