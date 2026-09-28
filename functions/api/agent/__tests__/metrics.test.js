import { describe, it, expect } from "vitest";
import { onRequestPost } from "../metrics.js";

describe("POST /api/agent/metrics", () => {
  it("is retired: no caller in singbox-vpn ever posts usage samples here", async () => {
    const res = await onRequestPost();
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe("metrics_retired");
  });
});
