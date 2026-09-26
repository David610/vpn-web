import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase } from "../../lib/__tests__/fake-supabase.js";

const requireUser = vi.fn();
vi.mock("../../lib/user-auth.js", () => ({ requireUser }));

let db;
vi.mock("../../lib/account-http.js", () => ({ adminClient: vi.fn(() => db) }));

const signRouteDirectory = vi.fn();
vi.mock("../../lib/route-signing.js", () => ({ signRouteDirectory }));

const { onRequestGet } = await import("../routes.js");

const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://arcana.example.test/v1/routes", {
    headers: { Authorization: "Bearer token" },
  });
}

const ENVELOPE = {
  schema_version: 1,
  directory_version: 1,
  issued_at: "2026-09-26T00:00:00Z",
  expires_at: "2026-09-26T01:00:00Z",
  key_id: "routes-2026-a",
  payload: { routes: [] },
  signature: "c2ln",
};

beforeEach(() => {
  requireUser.mockReset().mockResolvedValue({ user: { id: "user-1" }, claims: { session_id: "sess-1" }, response: null });
  signRouteDirectory.mockReset().mockResolvedValue(ENVELOPE);
  db = makeFakeSupabase({ nodes: [], locations: [], allowed_paths: [] });
});

describe("GET /v1/routes", () => {
  it("returns the signed envelope signRouteDirectory produces", async () => {
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(ENVELOPE);
  });

  it("requires authentication, matching every other /v1 route", async () => {
    requireUser.mockResolvedValue({ user: null, claims: null, response: new Response(null, { status: 401 }) });
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(401);
    expect(signRouteDirectory).not.toHaveBeenCalled();
  });

  it("queries only READY/CANARY nodes and enabled locations/allowed_paths", async () => {
    await onRequestGet({ env, request: makeRequest() });
    expect(signRouteDirectory).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ nodes: [], locations: [], allowedPaths: [] })
    );
  });
});
