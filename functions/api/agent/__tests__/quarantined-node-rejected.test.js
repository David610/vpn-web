import { describe, it, expect, vi, beforeEach } from "vitest";

// F-05/C-09 enumerated-route regression test: authenticateNode is the ONE
// gate every /api/agent/* handler relies on to reject a quarantined/
// retired node's key. This test does not mock node-auth.js — it runs the
// real authenticateNode against a mocked Supabase client that reports a
// QUARANTINED node, then calls every handler in functions/api/agent/**
// (including nested job/lease/revision routes) and asserts each one
// returns 401 before doing anything else. A new route added later that
// forgets to call authenticateNode, or calls it but ignores the result,
// fails this test the moment it's added to the ROUTES list below.

function makeThenable(result) {
  return { then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected) };
}

function makeSupabaseAdmin(nodeRow) {
  // authenticateNode does: .from("nodes").select(...).eq("api_key_hash", x).maybeSingle()
  const maybeSingle = vi.fn().mockResolvedValue({ data: nodeRow, error: null });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  // Some handlers query `.from("nodes")` again AFTER auth for their own
  // purposes, but none of that is reachable once authenticateNode returns
  // null, so a single generic chainable stub is enough for every table.
  const genericChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    update: vi.fn().mockReturnValue(makeThenable({ data: null, error: null })),
    delete: vi.fn().mockReturnValue(makeThenable({ data: null, error: null })),
    insert: vi.fn().mockReturnValue(makeThenable({ data: null, error: null })),
  };
  const from = vi.fn((table) => {
    if (table === "nodes") return { select };
    return genericChain;
  });
  return { from, rpc: vi.fn().mockResolvedValue({ data: null, error: null }) };
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => makeSupabaseAdmin({ node_id: "de-fra-1", revoked_at: null, lifecycle_state: "QUARANTINED" })),
}));

const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function req(method = "POST") {
  return new Request("https://example.test/api/agent/x", {
    method,
    headers: { Authorization: "Bearer quarantined-nodes-old-key" },
  });
}

const ROUTES = [
  { name: "bootstrap-status", mod: () => import("../bootstrap-status.js"), fn: "onRequestPost" },
  { name: "claim", mod: () => import("../claim.js"), fn: "onRequestPost" },
  { name: "heartbeat", mod: () => import("../heartbeat.js"), fn: "onRequestPost" },
  { name: "jobs/[id]/complete", mod: () => import("../jobs/[id]/complete.js"), fn: "onRequestPost", params: { id: "1" } },
  { name: "jobs/[id]/fail", mod: () => import("../jobs/[id]/fail.js"), fn: "onRequestPost", params: { id: "1" } },
  { name: "leases/sync", mod: () => import("../leases/sync.js"), fn: "onRequestPost" },
  { name: "metrics", mod: () => import("../metrics.js"), fn: "onRequestPost" },
  { name: "probe-credential", mod: () => import("../probe-credential.js"), fn: "onRequestPost" },
  { name: "probe-targets", mod: () => import("../probe-targets.js"), fn: "onRequestGet", method: "GET" },
  { name: "revision/[revision]", mod: () => import("../revision/[revision].js"), fn: "onRequestGet", method: "GET", params: { revision: "1" } },
  { name: "traffic", mod: () => import("../traffic.js"), fn: "onRequestPost" },
];

describe("every /api/agent/* handler rejects a QUARANTINED node's key with 401", () => {
  for (const route of ROUTES) {
    it(route.name, async () => {
      const module = await route.mod();
      const handler = module[route.fn];
      expect(typeof handler).toBe("function");
      const response = await handler({
        env,
        request: req(route.method ?? "POST"),
        params: route.params ?? {},
      });
      expect(response.status).toBe(401);
    }, 20000);
  }
});
