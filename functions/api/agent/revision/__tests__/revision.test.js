import { describe, it, expect, vi, beforeEach } from "vitest";

const nodeMaybeSingle = vi.fn();
const revisionMaybeSingle = vi.fn();
const revisionEq = vi.fn().mockReturnThis();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table) => {
      if (table === "nodes") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: nodeMaybeSingle };
      }
      if (table === "node_revisions") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: revisionEq,
          maybeSingle: revisionMaybeSingle,
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestGet } = await import("../[revision].js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest(auth = "Bearer node-key") {
  return new Request("https://example.test/api/agent/revision/3", {
    headers: auth ? { Authorization: auth } : {},
  });
}

beforeEach(() => {
  nodeMaybeSingle.mockReset().mockResolvedValue({ data: { node_id: "node-1", revoked_at: null }, error: null });
  revisionMaybeSingle.mockReset().mockResolvedValue({
    data: { revision: 3, config: { hello: "world" } },
    error: null,
  });
});

describe("GET /api/agent/revision/:revision", () => {
  it("returns the revision content for the authenticated node", async () => {
    const res = await onRequestGet({ env, request: makeRequest(), params: { revision: "3" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: 3, config: { hello: "world" } });
  });

  it("scopes the lookup to the authenticated node's own id, not anything from the request", async () => {
    // A node must not be able to fetch another node's desired config by
    // guessing a revision number.
    await onRequestGet({ env, request: makeRequest(), params: { revision: "3" } });
    expect(revisionEq).toHaveBeenCalledWith("node_id", "node-1");
  });

  it("rejects an unauthenticated request", async () => {
    const res = await onRequestGet({ env, request: makeRequest(null), params: { revision: "3" } });
    expect(res.status).toBe(401);
  });

  it("rejects a non-integer revision without querying the database", async () => {
    const res = await onRequestGet({ env, request: makeRequest(), params: { revision: "abc" } });
    expect(res.status).toBe(400);
    expect(revisionMaybeSingle).not.toHaveBeenCalled();
  });

  it.each([["scientific notation", "3e2"], ["hex", "0x3"], ["leading zero", "03"], ["decimal", "3.0"]])(
    "rejects a numeric-coercible but non-plain-decimal revision (%s)",
    async (_label, revision) => {
      const res = await onRequestGet({ env, request: makeRequest(), params: { revision } });
      expect(res.status).toBe(400);
      expect(revisionMaybeSingle).not.toHaveBeenCalled();
    }
  );

  it("returns 404 when the node has no such revision", async () => {
    revisionMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest(), params: { revision: "99" } });
    expect(res.status).toBe(404);
  });
});
