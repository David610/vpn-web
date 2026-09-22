import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const maybeSingle = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle,
    })),
  })),
}));

const { authenticateAdmin, requireAdmin } = await import("../admin-auth.js");
const { createClient } = await import("@supabase/supabase-js");
const supabaseAdmin = createClient("url", "key");

function makeRequest(token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return new Request("https://example.test/api/admin/overview", { headers });
}

/** Shape of a successful getClaims() result for the given sub/aal. */
function claimsFor(sub, aal) {
  return { data: { claims: { sub, aal } }, error: null };
}

beforeEach(() => {
  getClaims.mockReset();
  maybeSingle.mockReset();
});

describe("authenticateAdmin", () => {
  it("returns null with no Authorization header", async () => {
    const result = await authenticateAdmin(makeRequest(), supabaseAdmin);
    expect(result).toBeNull();
    expect(getClaims).not.toHaveBeenCalled();
  });

  it("returns null when the token is invalid", async () => {
    getClaims.mockResolvedValue({ data: null, error: { message: "bad token" } });
    const result = await authenticateAdmin(makeRequest("bad"), supabaseAdmin);
    expect(result).toBeNull();
  });

  it("returns null when the user is not in admin_users", async () => {
    getClaims.mockResolvedValue(claimsFor("user-1", "aal2"));
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const result = await authenticateAdmin(makeRequest("good"), supabaseAdmin);
    expect(result).toBeNull();
  });

  it("returns null when the admin_users lookup errors", async () => {
    getClaims.mockResolvedValue(claimsFor("user-1", "aal2"));
    maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    const result = await authenticateAdmin(makeRequest("good"), supabaseAdmin);
    expect(result).toBeNull();
  });

  it("returns { userId, role, aal } for a valid admin", async () => {
    getClaims.mockResolvedValue(claimsFor("user-1", "aal2"));
    maybeSingle.mockResolvedValue({ data: { role: "owner" }, error: null });
    const result = await authenticateAdmin(makeRequest("good"), supabaseAdmin);
    expect(result).toEqual({ userId: "user-1", role: "owner", aal: "aal2" });
  });

  it("reports aal1 for a password-only session", async () => {
    getClaims.mockResolvedValue(claimsFor("user-1", "aal1"));
    maybeSingle.mockResolvedValue({ data: { role: "owner" }, error: null });
    const result = await authenticateAdmin(makeRequest("good"), supabaseAdmin);
    expect(result).toEqual({ userId: "user-1", role: "owner", aal: "aal1" });
  });

  it("defaults a missing aal claim to aal1 rather than assuming step-up", async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null });
    maybeSingle.mockResolvedValue({ data: { role: "owner" }, error: null });
    const result = await authenticateAdmin(makeRequest("good"), supabaseAdmin);
    expect(result).toEqual({ userId: "user-1", role: "owner", aal: "aal1" });
  });
});

describe("requireAdmin", () => {
  it("returns a 401 Response when not an admin", async () => {
    getClaims.mockResolvedValue({ data: null, error: { message: "bad" } });
    const { admin, response } = await requireAdmin(makeRequest("bad"), supabaseAdmin);
    expect(admin).toBeNull();
    expect(response.status).toBe(401);
  });

  it("returns the admin with a null response when authorized at aal2", async () => {
    getClaims.mockResolvedValue(claimsFor("user-1", "aal2"));
    maybeSingle.mockResolvedValue({ data: { role: "owner" }, error: null });
    const { admin, response } = await requireAdmin(makeRequest("good"), supabaseAdmin);
    expect(admin).toEqual({ userId: "user-1", role: "owner", aal: "aal2" });
    expect(response).toBeNull();
  });

  it("refuses an admin whose session has not stepped up to aal2", async () => {
    getClaims.mockResolvedValue(claimsFor("user-1", "aal1"));
    maybeSingle.mockResolvedValue({ data: { role: "owner" }, error: null });
    const { admin, response } = await requireAdmin(makeRequest("good"), supabaseAdmin);
    expect(admin).toBeNull();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Multi-factor authentication required.",
      code: "mfa_required",
    });
  });

  it("distinguishes not-an-admin (401) from needs-MFA (403)", async () => {
    getClaims.mockResolvedValue(claimsFor("user-1", "aal1"));
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const { response } = await requireAdmin(makeRequest("good"), supabaseAdmin);
    // A non-admin at aal1 must still read as 401, not as "enroll MFA" —
    // otherwise the dashboard would invite a random customer to enroll.
    expect(response.status).toBe(401);
  });
});
