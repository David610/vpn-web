import { describe, it, expect, vi } from "vitest";
import { requireUser, requireRecentUser } from "../user-auth.js";

function request() {
  return new Request("https://example.test/api/test", {
    headers: { Authorization: "Bearer token-123" },
  });
}

function client(claims, error = null) {
  return {
    auth: {
      getClaims: vi.fn().mockResolvedValue({
        data: { claims },
        error,
      }),
      // If requireUser/recent-user regresses to getUser, these tests should
      // fail loudly instead of hiding the extra Auth-server round trip.
      getUser: vi.fn(() => {
        throw new Error("getUser must not be called");
      }),
    },
  };
}

describe("customer auth helpers", () => {
  it("accepts a valid signed JWT without a GoTrue user lookup", async () => {
    const supabase = client({
      sub: "user-1",
      email: "user@example.com",
      role: "authenticated",
    });

    const result = await requireUser(request(), supabase);

    expect(result.response).toBeNull();
    expect(result.user).toEqual({
      id: "user-1",
      email: "user@example.com",
      role: "authenticated",
    });
    expect(supabase.auth.getClaims).toHaveBeenCalledWith("token-123");
    expect(supabase.auth.getUser).not.toHaveBeenCalled();
  });

  it("fails closed for an invalid JWT", async () => {
    const result = await requireUser(
      request(),
      client(null, { message: "bad signature" })
    );
    expect(result.user).toBeNull();
    expect(result.response.status).toBe(401);
  });

  it("accepts a fresh real authentication event for sensitive actions", async () => {
    const now = Math.floor(Date.now() / 1000);
    const supabase = client({
      sub: "user-1",
      email: "user@example.com",
      amr: [{ method: "password", timestamp: now - 30 }],
    });

    const result = await requireRecentUser(request(), supabase, 15 * 60);
    expect(result.response).toBeNull();
    expect(result.user.id).toBe("user-1");
    expect(supabase.auth.getUser).not.toHaveBeenCalled();
  });

  it("rejects a stale authentication event even when the session itself is valid", async () => {
    const now = Math.floor(Date.now() / 1000);
    const result = await requireRecentUser(
      request(),
      client({
        sub: "user-1",
        email: "user@example.com",
        amr: [{ method: "password", timestamp: now - 3600 }],
      }),
      15 * 60
    );

    expect(result.user).toBeNull();
    expect(result.response.status).toBe(403);
    expect((await result.response.json()).code).toBe("reauth_required");
  });

  it("does not treat token refresh as human reauthentication", async () => {
    const now = Math.floor(Date.now() / 1000);
    const result = await requireRecentUser(
      request(),
      client({
        sub: "user-1",
        amr: [{ method: "token_refresh", timestamp: now }],
      })
    );

    expect(result.user).toBeNull();
    expect(result.response.status).toBe(403);
    expect((await result.response.json()).code).toBe("reauth_required");
  });
});
