// Minimal PostgREST stand-in for staging/load tests of the agent API. It
// implements only what /api/agent/* calls, with configurable per-call latency
// and a shared mutable `state` so tests can flip jobs, revisions and
// entitlement. It measures OUR API's overhead; it says nothing about real
// Supabase round-trip time, which must be measured separately.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { encryptSecret } from "../../functions/lib/crypto.js";

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export async function startMockSupabase({ latencyMs = 0, nodes = 3, authorizationsPerNode = 12, encryptionKeyHex = "00".repeat(32) } = {}) {
  const sealed = await encryptSecret(JSON.stringify({ vless_uuid: "018f4f18-8b5d-7c21-9f2b-0f8a7c6d5e4f", hysteria2_password: "load-test-password-0001" }), encryptionKeyHex);
  const state = {
    calls: new Map(),
    failRpc: new Set(),
    nodes: new Map(),
    jobs: new Map(),
    authRevision: new Map(),
    entitled: true,
  };
  for (let i = 0; i < nodes; i += 1) {
    const id = `node-${i}`;
    state.nodes.set(sha256(`key-${i}`), { node_id: id, revoked_at: null, lifecycle_state: "READY" });
    state.jobs.set(id, 0);
    state.authRevision.set(id, 1);
  }
  const bump = (name) => state.calls.set(name, (state.calls.get(name) ?? 0) + 1);
  const delay = () => (latencyMs ? new Promise((r) => setTimeout(r, latencyMs)) : null);
  const principals = (nodeId) => Array.from({ length: authorizationsPerNode }, (_, i) => `ext_${nodeId}_${i}`);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    await delay();
    const send = (status, payload) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    const route = url.pathname.replace("/rest/v1/", "");
    bump(`${req.method} ${route}`);

    if (route === "nodes" && req.method === "GET") {
      const hash = (url.searchParams.get("api_key_hash") ?? "").replace("eq.", "");
      const row = state.nodes.get(hash);
      return send(200, row ? [row] : []);
    }
    if (route === "nodes" && req.method === "PATCH") return send(204);
    if (route === "external_vpn_devices") {
      const wanted = (url.searchParams.get("principal_id") ?? "").replace(/^in\.\(|\)$/g, "").split(",").map((p) => p.replace(/"/g, ""));
      return send(200, wanted.filter(Boolean).map((p) => ({ device_id: `dev-${p}`, principal_id: p, revoked_at: null })));
    }
    if (route.startsWith("rpc/")) {
      const name = route.slice(4);
      if (state.failRpc.has(name)) return send(500, { message: "injected failure", code: "XX000" });
      if (name === "claim_next_job") return send(200, []);
      if (name === "agent_wake_tokens") {
        return send(200, body.p_node_ids.map((id) => ({
          node_id: id,
          jobs_token: `${state.jobs.get(id) ?? 0}:${state.jobs.get(id) ? 1 : 0}`,
          auth_revision: state.authRevision.get(id) ?? 0,
          lease_token: "l0",
        })));
      }
      if (name === "agent_entitlement_tokens") {
        return send(200, body.p_node_ids.map((id) => ({ node_id: id, entitlement_token: state.entitled ? "e1" : "e0" })));
      }
      if (name === "device_entitlements_batch") {
        return send(200, body.p_device_ids.map((d) => ({ device_id: d, entitled: state.entitled })));
      }
      if (name === "get_compatibility_authorization_snapshot") {
        return send(200, [{
          snapshot_revision: state.authRevision.get(body.p_node_id) ?? 0,
          authorizations: principals(body.p_node_id).map((p) => ({
            principal_id: p, credential_id: `cred_${p}`, credential_class: "compatibility",
            valid_from: "2026-10-01T00:00:00Z", valid_until: "2026-12-01T00:00:00Z", revoked: false,
            credential_ciphertext: sealed.ciphertext, credential_nonce: sealed.nonce,
          })),
        }]);
      }
      return send(404, { message: `mock has no rpc ${name}`, code: "PGRST202" });
    }
    return send(404, { message: `mock has no route ${route}` });
  });

  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    callCount: (prefix) => [...state.calls].filter(([k]) => k.includes(prefix)).reduce((n, [, v]) => n + v, 0),
    close: () => new Promise((r) => server.close(r)),
  })));
}
