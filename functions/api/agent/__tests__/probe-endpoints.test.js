import { describe, it, expect, vi, beforeEach } from "vitest";

let authNode = "node-a";
vi.mock("../../../lib/node-auth.js", () => ({ authenticateNode: vi.fn(async () => authNode) }));

const state = { upserts: [], nodes: [], creds: [], self: { lifecycle_state: "READY" } };
function q(table) {
  const chain = {
    filters: [],
    select: () => chain,
    eq: (...a) => (chain.filters.push(["eq", ...a]), chain),
    in: (...a) => (chain.filters.push(["in", ...a]), chain),
    is: () => chain,
    neq: (...a) => (chain.filters.push(["neq", ...a]), chain),
    maybeSingle: async () => ({ data: table === "nodes" ? state.self : null, error: null }),
    upsert: async (row) => (state.upserts.push(row), { error: null }),
    then: (r) => r({ data: table === "nodes" ? state.nodes : state.creds, error: null }),
  };
  return chain;
}
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({ from: (t) => q(t) })) }));

const env = { SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "k" };
const post = (body) =>
  new Request("https://x/api/agent/probe-credential", { method: "POST", headers: { Authorization: "Bearer k" }, body: JSON.stringify(body) });

beforeEach(() => {
  authNode = "node-a";
  state.upserts = [];
  state.self = { lifecycle_state: "READY" };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/agent/probe-credential", () => {
  it("rejects unauthenticated agents", async () => {
    authNode = null;
    const { onRequestPost } = await import("../probe-credential.js");
    expect((await onRequestPost({ env, request: post({}) })).status).toBe(401);
  });
  it("stores valid probe links for the calling node only", async () => {
    const { onRequestPost } = await import("../probe-credential.js");
    const res = await onRequestPost({ env, request: post({ node_id: "someone-else", reality_uri: "vless://u@h:1?security=reality", hysteria2_uri: "hysteria2://p@h:1" }) });
    expect(res.status).toBe(200);
    expect(state.upserts[0]).toMatchObject({ node_id: "node-a", reality_uri: "vless://u@h:1?security=reality" });
    expect(JSON.stringify(await res.json())).not.toContain("vless://");
  });
  it("rejects wrong schemes and empty bodies", async () => {
    const { onRequestPost } = await import("../probe-credential.js");
    expect((await onRequestPost({ env, request: post({ reality_uri: "hysteria2://p@h:1" }) })).status).toBe(400);
    expect((await onRequestPost({ env, request: post({}) })).status).toBe(400);
  });
});

describe("GET /api/agent/probe-targets", () => {
  const get = () => new Request("https://x/api/agent/probe-targets", { headers: { Authorization: "Bearer k" } });
  it("returns peers that have published credentials, with expected IPs", async () => {
    state.nodes = [{ node_id: "node-b", ip_address: "62.238.46.190" }, { node_id: "node-c", ip_address: "1.2.3.4" }];
    state.creds = [{ node_id: "node-b", reality_uri: "vless://u@h:1", hysteria2_uri: "hysteria2://p@h:1" }];
    const { onRequestGet } = await import("../probe-targets.js");
    const body = await (await onRequestGet({ env, request: get() })).json();
    expect(body.targets).toEqual([{ node_id: "node-b", expected_ipv4: "62.238.46.190", reality_uri: "vless://u@h:1", hysteria2_uri: "hysteria2://p@h:1" }]);
  });
  it("gives a quarantined caller nothing", async () => {
    state.self = { lifecycle_state: "QUARANTINED" };
    const { onRequestGet } = await import("../probe-targets.js");
    const body = await (await onRequestGet({ env, request: get() })).json();
    expect(body.targets).toEqual([]);
  });
});
