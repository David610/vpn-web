import { describe, it, expect } from "vitest";
import { onRequestPost } from "../seats.js";

describe("POST /api/account/seats", () => {
  it("points callers at per-subscription packs", async () => {
    const res = await onRequestPost();
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe("use_subscription_packs");
  });
});
