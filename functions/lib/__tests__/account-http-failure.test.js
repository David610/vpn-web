import { describe, expect, it } from "vitest";
import { runAccountAction } from "../account-http.js";

describe("account HTTP failure boundary", () => {
  it("rejects missing authorization even when Supabase configuration is unavailable", async () => {
    const response = await runAccountAction(
      { request: new Request("https://arcana.test/api/account/links"), env: {} },
      "test",
      () => { throw new Error("must not run"); },
      { recent: false }
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authorization required" });
  });
});
