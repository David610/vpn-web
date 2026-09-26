import { describe, it, expect, vi } from "vitest";

// Every table returns rows polluted with credential-shaped fields, as if a
// future query used select("*") or a jsonb blob carried a secret. None of
// these values may ever appear in an admin fleet response.
const SECRETS = {
  api_key_hash: "LEAK_NODE_API_KEY_HASH",
  api_key: "LEAK_NODE_API_KEY",
  enrollment_token_hash: "LEAK_ENROLL_HASH",
  reality_private_key: "LEAK_REALITY_PRIVATE",
  hysteria2_password: "LEAK_VPN_PASSWORD",
  vless_uuid: "LEAK_VLESS_UUID",
  subscription_token: "LEAK_SUB_TOKEN",
  subscription_url: "https://x/sub/LEAK_SUB_URL",
  service_role_key: "LEAK_SERVICE_ROLE",
  stripe_secret: "sk_live_LEAK_STRIPE",
};

const ROWS = {
  nodes: [{ node_id: "de-fra-1", role: "EXIT", lifecycle_state: "READY", location_id: "l1", desired_revision: 2, observed_revision: 1, max_sessions: 10, protocol_health: { reality: { ok: true, dims: { dns: true }, password: "LEAK_SUMMARY_PW", uri: "vless://LEAK_SUMMARY_URI" } }, ...SECRETS }],
  locations: [{ id: "l1", country_code: "DE", display_name: "Frankfurt", enabled: true, ...SECRETS }],
  allowed_paths: [{ id: "p1", entry_location_id: null, exit_location_id: "l1", enabled: true, ...SECRETS }],
  device_node_assignments: [{ device_id: "d1", node_id: "de-fra-1", hop: "EXIT", devices: { account_id: "a1", ...SECRETS }, ...SECRETS }],
  fleet_operations: [{ id: "o1", type: "REPLACE_NODE", status: "RUNNING", detail: { enrollmentToken: "LEAK_ENROLL_TOKEN", provider: "hetzner", ...SECRETS }, ...SECRETS }],
  operation_steps: [{ operation_id: "o1", step_index: 0, status: "COMPLETED", detail: { privateKey: "LEAK_PK", ...SECRETS } }],
  node_revisions: [{ node_id: "de-fra-1", revision: 2, reason: "r", config: { reality: { private_key: "LEAK_CFG_PK" } }, ...SECRETS }],
  node_probe_results: [{ id: 1, observed_at: "2026-09-26T00:00:00Z", reporter_node_id: "a", target_node_id: "de-fra-1", vantage: "peer", protocol: "reality", dimension: "dns", ok: true, ...SECRETS }],
  node_probe_credentials: [{ node_id: "de-fra-1", reality_uri: "vless://LEAK_PROBE_UUID@h:1", hysteria2_uri: "hysteria2://LEAK_PROBE_PW@h:1" }],
  admin_audit_log: [{ id: 1, action: "admin.node_lifecycle", target_id: "de-fra-1", metadata: { token: "LEAK_META_TOKEN" } }],
};

function query(table) {
  const q = {
    select: () => q, order: () => q, limit: () => q, eq: () => q, in: () => q,
    then: (res) => res({ data: ROWS[table] ?? [], error: null }),
  };
  return q;
}

vi.mock("../../../../lib/admin-auth.js", () => ({
  requireAdmin: vi.fn(async () => ({ admin: { userId: "a", role: "owner" }, response: null })),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({ from: (t) => query(t) })) }));

const ENV = {
  SUPABASE_SERVICE_ROLE_KEY: "LEAK_ENV_SERVICE_ROLE",
  HETZNER_API_TOKEN: "LEAK_ENV_HETZNER",
  ROUTE_SIGNING_PRIVATE_KEY: "LEAK_ENV_ROUTE_KEY",
  STRIPE_API_KEY: "sk_live_LEAK_ENV",
  FLEET_TICK_SECRET: "LEAK_ENV_TICK",
  FEATURE_AUTO_NODE_HEALTH: "true",
};

const endpoints = ["topology", "assignments", "operations", "health", "readiness"];

describe("admin fleet APIs never return secrets", () => {
  for (const name of endpoints) {
    it(`GET /api/admin/fleet/${name}`, async () => {
      const { onRequestGet } = await import(`../${name}.js`);
      const res = await onRequestGet({ env: ENV, request: new Request(`https://x/api/admin/fleet/${name}`) });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toMatch(/LEAK_/);
      expect(text).not.toMatch(/sk_live/);
      for (const key of ["api_key\"", "private_key\"", "privateKey\"", "password", "vless_uuid", "subscription_token", "service_role", "enrollmentToken"]) {
        expect(text).not.toContain(`"${key}`);
      }
    });
  }

  it("readiness reports presence and flags only", async () => {
    const { onRequestGet } = await import("../readiness.js");
    const body = await (await onRequestGet({ env: ENV, request: new Request("https://x/") })).json();
    const hetzner = body.variables.find((v) => v.name === "HETZNER_API_TOKEN");
    expect(hetzner).toMatchObject({ present: true });
    expect(body.flags.find((f) => f.name === "FEATURE_AUTO_NODE_HEALTH").enabled).toBe(true);
    expect(body.provisioningReady).toBe(false);
  });
});
