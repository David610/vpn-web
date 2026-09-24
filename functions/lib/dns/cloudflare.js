/**
 * Cloudflare DNS adapter. Interface (see ../dns-adapter.js):
 *
 *   upsertAddressRecord({ name, type, content }) -> { recordId }
 *   deleteRecord({ recordId, name, type }) -> void
 *
 * Both are idempotent so the fleet reconciler can re-run them after a
 * timeout or a crash without creating duplicates: upsert finds the record
 * by exact name+type first and only creates when none exists; delete treats
 * "already gone" as success.
 *
 * Node records are never proxied: REALITY and Hysteria2 must terminate on
 * the VPS itself, and certbot's HTTP-01 challenge must reach it directly.
 * TTL is short so a replaced node's new address propagates quickly.
 *
 * Credentials: CLOUDFLARE_DNS_API_TOKEN should be a token scoped to
 * Zone.DNS:Edit on CLOUDFLARE_DNS_ZONE_ID only, never the account/deploy
 * token.
 */
const API_BASE = "https://api.cloudflare.com/client/v4";
const NODE_RECORD_TTL = 60;

export function createCloudflareDns(env) {
  const token = env.CLOUDFLARE_DNS_API_TOKEN;
  const zoneId = env.CLOUDFLARE_DNS_ZONE_ID;
  if (!token || !zoneId) {
    throw new Error("CLOUDFLARE_DNS_API_TOKEN and CLOUDFLARE_DNS_ZONE_ID must be configured");
  }

  async function cf(path, init) {
    const res = await fetch(`${API_BASE}/zones/${encodeURIComponent(zoneId)}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => null);
    return { res, body };
  }

  function fail(op, res, body) {
    const message = body?.errors?.[0]?.message ?? `HTTP ${res.status}`;
    return new Error(`Cloudflare DNS ${op} failed: ${message}`);
  }

  async function findRecord(name, type) {
    const { res, body } = await cf(
      `/dns_records?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`
    );
    if (!res.ok || !body?.success) throw fail("lookup", res, body);
    return body.result?.[0] ?? null;
  }

  return {
    name: "cloudflare",

    async upsertAddressRecord({ name, type = "A", content }) {
      if (type !== "A" && type !== "AAAA") throw new Error("only A/AAAA node records are supported");
      const desired = { type, name, content, ttl: NODE_RECORD_TTL, proxied: false };
      const existing = await findRecord(name, type);
      if (existing) {
        if (existing.content === content && existing.proxied === false) {
          return { recordId: existing.id };
        }
        const { res, body } = await cf(`/dns_records/${encodeURIComponent(existing.id)}`, {
          method: "PATCH",
          body: JSON.stringify(desired),
        });
        if (!res.ok || !body?.success) throw fail("update", res, body);
        return { recordId: existing.id };
      }
      const { res, body } = await cf("/dns_records", { method: "POST", body: JSON.stringify(desired) });
      if (!res.ok || !body?.success) throw fail("create", res, body);
      return { recordId: body.result.id };
    },

    async deleteRecord({ recordId, name, type = "A" }) {
      let id = recordId;
      if (!id && name) id = (await findRecord(name, type))?.id;
      if (!id) return;
      const { res, body } = await cf(`/dns_records/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.status === 404) return;
      if (!res.ok || !body?.success) throw fail("delete", res, body);
    },
  };
}
