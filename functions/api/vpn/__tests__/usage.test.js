import { describe, it, expect } from "vitest";
import { onRequestGet } from "../usage.js";

describe("GET /api/vpn/usage", () => {
  it("is retired: no writer ever produces per-user usage samples", async () => {
    const res = await onRequestGet();
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe("usage_retired");
  });
});
