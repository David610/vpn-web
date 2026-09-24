import { describe, it, expect } from "vitest";
import { onRequestPost } from "../invites.js";

describe("POST /api/account/invites", () => {
  it("is retired: accounts are for one person", async () => {
    const res = await onRequestPost();
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe("invites_retired");
  });
});
