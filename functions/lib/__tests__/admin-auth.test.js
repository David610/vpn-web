import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const maybeSingle = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser },
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

beforeEach(() => {
  getUser.mockReset();
  maybeSingle.mockReset();
});

describe("authenticateAdmin", () => {
  it("returns null with no Authorization header", async () => {
    const result = await authenticateAdmin(makeRequest(), supabaseAdmin);
    expect(result).toBeNull();
    expect(getUser).not.toHaveBeenCalled();
  });

  it("returns null when the token is invalid", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "bad token" } });
    const result = await authenticateAdmin(makeRequest("bad"), supabaseAdmin);
    expect(result).toBeNull();
  });

  it("returns null when the user is not in admin_users", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const result = await authenticateAdmin(makeRequest("good"), supabaseAdmin);
    expect(result).toBeNull();
  });

  it("returns { userId, role } for a valid admin", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    maybeSingle.mockResolvedValue({ data: { role: "owner" }, error: null });
    const result = await authenticateAdmin(makeRequest("good"), supabaseAdmin);
    expect(result).toEqual({ userId: "user-1", role: "owner" });
  });
});

describe("requireAdmin", () => {
  it("returns a 401 Response when not an admin", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "bad" } });
    const { admin, response } = await requireAdmin(makeRequest("bad"), supabaseAdmin);
    expect(admin).toBeNull();
    expect(response.status).toBe(401);
  });

  it("returns the admin with a null response when authorized", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    maybeSingle.mockResolvedValue({ data: { role: "owner" }, error: null });
    const { admin, response } = await requireAdmin(makeRequest("good"), supabaseAdmin);
    expect(admin).toEqual({ userId: "user-1", role: "owner" });
    expect(response).toBeNull();
  });
});
