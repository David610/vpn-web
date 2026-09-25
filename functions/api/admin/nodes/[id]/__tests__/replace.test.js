import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const nodesMaybeSingle = vi.fn();
const auditInsert = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    from: vi.fn((table) => {
      if (table === "admin_users") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      }
      if (table === "nodes") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: nodesMaybeSingle };
      }
      if (table === "admin_audit_log") return { insert: auditInsert };
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

vi.mock("../../../../../lib/provider-adapter.js", () => ({
  getProviderAdapter: vi.fn((provider) => {
    if (provider !== "hetzner") throw new Error(`Unknown or unsupported provider: ${provider}`);
    return { name: "hetzner" };
  }),
}));

const startReplaceNodeOperation = vi.fn();
const advanceOperation = vi.fn();
vi.mock("../../../../../lib/fleet-operations.js", () => ({
  startReplaceNodeOperation,
  advanceOperation,
  DEFAULT_REPLACE_MAX_WAIT_HOURS: 72,
}));
vi.mock("../../../../../lib/dns-adapter.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getDnsAdapter: vi.fn(() => ({ name: "cloudflare" })),
}));

const { onRequestPost } = await import("../replace.js");
const env = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "key",
  FLEET_SINGBOX_VPN_VERSION: "v1.1.0",
  FLEET_NODE_DOMAIN: "nodes.example.test",
  SITE_URL: "https://arcana.example.test",
};

function makeRequest(body) {
  return new Request("https://example.test/api/admin/nodes/de-fsn-001/replace", {
    method: "POST",
    headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: "admin-1", aal: "aal2" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  nodesMaybeSingle.mockReset().mockResolvedValue({
    data: { node_id: "de-fsn-001", role: "EXIT", location_id: "loc-1", lifecycle_state: "READY", provider: "hetzner" },
    error: null,
  });
  auditInsert.mockReset().mockResolvedValue({ error: null });
  startReplaceNodeOperation.mockReset().mockResolvedValue({ operation: { id: "op-1" } });
  advanceOperation.mockReset().mockResolvedValue({ status: "RUNNING" });
});

describe("POST /api/admin/nodes/:id/replace", () => {
  it("returns 400 for an invalid newNodeId", async () => {
    const res = await onRequestPost({
      env,
      request: makeRequest({ newNodeId: "BAD ID", region: "fsn1" }),
      params: { id: "de-fsn-001" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when region is missing", async () => {
    const res = await onRequestPost({
      env,
      request: makeRequest({ newNodeId: "de-fsn-002" }),
      params: { id: "de-fsn-001" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the old node does not exist", async () => {
    nodesMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPost({
      env,
      request: makeRequest({ newNodeId: "de-fsn-002", region: "fsn1" }),
      params: { id: "de-fsn-001" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when the old node is QUARANTINED", async () => {
    nodesMaybeSingle.mockResolvedValue({
      data: { node_id: "de-fsn-001", role: "EXIT", location_id: "loc-1", lifecycle_state: "QUARANTINED", provider: "hetzner" },
      error: null,
    });
    const res = await onRequestPost({
      env,
      request: makeRequest({ newNodeId: "de-fsn-002", region: "fsn1" }),
      params: { id: "de-fsn-001" },
    });
    expect(res.status).toBe(409);
    expect(startReplaceNodeOperation).not.toHaveBeenCalled();
  });

  it("returns 409 when a replacement for this node is already in progress", async () => {
    startReplaceNodeOperation.mockResolvedValue({ error: { code: "23505", message: "duplicate key" } });
    const res = await onRequestPost({
      env,
      request: makeRequest({ newNodeId: "de-fsn-002", region: "fsn1" }),
      params: { id: "de-fsn-001" },
    });
    expect(res.status).toBe(409);
  });

  it("starts the replacement and returns 202 with the new node id and operation id", async () => {
    const res = await onRequestPost({
      env,
      request: makeRequest({ newNodeId: "de-fsn-002", region: "fsn1" }),
      params: { id: "de-fsn-001" },
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, oldNodeId: "de-fsn-001", newNodeId: "de-fsn-002", operationId: "op-1" });
    expect(startReplaceNodeOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        newNodeId: "de-fsn-002",
        oldNodeId: "de-fsn-001",
        provider: "hetzner",
        region: "fsn1",
        role: "EXIT",
        locationId: "loc-1",
      })
    );
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.node_replace_initiated", target_id: "de-fsn-001" })
    );
  });

  it("rejects a read-only admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: { role: "readonly" }, error: null });
    const res = await onRequestPost({
      env,
      request: makeRequest({ newNodeId: "de-fsn-002", region: "fsn1" }),
      params: { id: "de-fsn-001" },
    });
    expect(res.status).toBe(403);
    expect(startReplaceNodeOperation).not.toHaveBeenCalled();
  });
});
