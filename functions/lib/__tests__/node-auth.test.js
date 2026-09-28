import { describe, it, expect, vi, beforeEach } from "vitest";
import { authenticateNode } from "../node-auth.js";

function makeSupabase(nodeRow, { lookupError = null } = {}) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: nodeRow, error: lookupError });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { from };
}

function request(bearer) {
  const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {};
  return new Request("https://example.test/api/agent/whatever", { method: "POST", headers });
}

describe("authenticateNode", () => {
  it("returns null when there is no Authorization header", async () => {
    const supabase = makeSupabase(null);
    expect(await authenticateNode(request(), supabase)).toBeNull();
  });

  it("returns the node_id for a live, non-revoked, READY node", async () => {
    const supabase = makeSupabase({ node_id: "de-fra-1", revoked_at: null, lifecycle_state: "READY" });
    expect(await authenticateNode(request("secret"), supabase)).toBe("de-fra-1");
  });

  it("returns null when revoked_at is set", async () => {
    const supabase = makeSupabase({
      node_id: "de-fra-1",
      revoked_at: "2026-01-01T00:00:00Z",
      lifecycle_state: "READY",
    });
    expect(await authenticateNode(request("secret"), supabase)).toBeNull();
  });

  // F-05 regression: before this fix, a row whose api_key_hash/revoked_at
  // were not yet cleared for some other reason (e.g. a pre-migration row,
  // or a future code path that flips lifecycle_state without going through
  // revoke_node_key_and_transition) would still authenticate successfully
  // as long as revoked_at was null, even though the node is QUARANTINED —
  // a state the spec calls a one-way security containment.
  it("returns null for a QUARANTINED node even if revoked_at is not set", async () => {
    const supabase = makeSupabase({ node_id: "de-fra-1", revoked_at: null, lifecycle_state: "QUARANTINED" });
    expect(await authenticateNode(request("secret"), supabase)).toBeNull();
  });

  it("returns null for a RETIRED node even if revoked_at is not set", async () => {
    const supabase = makeSupabase({ node_id: "de-fra-1", revoked_at: null, lifecycle_state: "RETIRED" });
    expect(await authenticateNode(request("secret"), supabase)).toBeNull();
  });

  it("returns null when the lookup errors", async () => {
    const supabase = makeSupabase(null, { lookupError: { message: "boom" } });
    expect(await authenticateNode(request("secret"), supabase)).toBeNull();
  });
});
