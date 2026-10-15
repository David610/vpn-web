import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeSupabase } from "../../lib/__tests__/fake-supabase.js";
import { encryptSecret } from "../../lib/crypto.js";
import { subscriptionTokenHash } from "../../lib/external-credentials.js";

let db;
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => db) }));

const { onRequestGet } = await import("../[token].js");

const KEY = "22".repeat(32);
const env = {
  SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "service",
  SUBSCRIPTION_TOKEN_HASH_KEY: "k".repeat(40), VPN_SECRETS_ENCRYPTION_KEY: KEY,
};
const TOKEN = "T".repeat(43);
const VLESS_UUID = "018f4f18-8b5d-7c21-9f2b-0f8a7c6d5e4f";
const HY2_PASSWORD = "hysteria2-user-password-value";
const OBFS = "node-obfs-password-value-123";

async function seed({ node = {}, obfs = true, device = {}, route = {} } = {}) {
  const cred = await encryptSecret(JSON.stringify({ vless_uuid: VLESS_UUID, hysteria2_password: HY2_PASSWORD }), KEY);
  const obfsRow = obfs ? await encryptSecret(OBFS, KEY) : null;
  db = makeFakeSupabase({
    external_vpn_devices: [{
      device_id: "dev1", client_type: "shadowrocket", principal_id: "ext_1", desired_route_id: "r1", revoked_at: null,
      subscription_expires_at: null, subscription_token_hash: await subscriptionTokenHash(TOKEN, env), ...device,
    }],
    logical_routes: [{ id: "r1", privacy_class: "fast", display_name: "Germany — Fast", enabled: true, ...route }],
    logical_route_targets: [{ route_id: "r1", hop: 1, node_id: "n1", priority: 1, enabled: true }],
    nodes: [{
      node_id: "n1", hostname: "vpn.example.com", ip_address: "203.0.113.7", transport: "vless-reality", transport_port: 443,
      tls_server_name: "www.cloudflare.com", reality_public_key: "pub-key_with-base64url_chars", reality_short_id: "a1b2c3d4",
      reality_fingerprint: "chrome", vless_flow: "xtls-rprx-vision", hysteria2_obfs_type: null, lifecycle_state: "READY", ...node,
    }],
    compatibility_credentials: [{
      hop: 1, credential_id: "c1", credential_ciphertext: cred.ciphertext, credential_nonce: cred.nonce,
      valid_from: "2026-01-01T00:00:00Z", valid_until: "2999-01-01T00:00:00Z", publish_from: "2026-01-01T00:00:00Z",
      revoked_at: null, device_id: "dev1",
    }],
    node_transport_secrets: obfsRow ? [{ node_id: "n1", hysteria2_obfs_ciphertext: obfsRow.ciphertext, hysteria2_obfs_nonce: obfsRow.nonce }] : [],
  }, { rpc: {
    check_rate_limit: () => ({ data: true, error: null }),
    device_entitlement: () => ({ data: [{ entitled: true }], error: null }),
  } });
}

const get = (query, token = TOKEN) =>
  onRequestGet({ env, request: new Request(`https://account.example/sub/${token}?${query}`), params: { token } });
const lines = (text) => text.trim().split("\n");

describe("GET /sub/:token (external-client subscription)", () => {
  beforeEach(() => seed());

  it("serves VLESS+REALITY with the decoy SNI and Hysteria2 with the certificate name and node obfuscation", async () => {
    const res = await get("format=hiddify");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const [vless, hy2] = lines(await res.text()).map((l) => new URL(l));
    expect(vless.protocol).toBe("vless:");
    expect(vless.searchParams.get("sni")).toBe("www.cloudflare.com");
    expect(vless.searchParams.get("pbk")).toBe("pub-key_with-base64url_chars");
    expect(hy2.protocol).toBe("hysteria2:");
    expect(hy2.searchParams.get("sni")).toBe("vpn.example.com");
    expect(hy2.searchParams.get("obfs")).toBe("salamander");
    expect(hy2.searchParams.get("obfs-password")).toBe(OBFS);
  });

  it("delivers a REALITY public key containing '-' and '_' byte-for-byte in every share-link format", async () => {
    // A leading '-' is real: the production exit's own key starts with one. Any layer that strips or
    // re-encodes base64url characters would hand clients a key that fails the REALITY handshake.
    const pbk = "-_Ab0-9_zZ-aB_cD-eF_gH-iJ_kL-mN_oP-qR_sT-uV";
    expect(pbk).toHaveLength(43);
    await seed({ node: { reality_public_key: pbk } });
    for (const format of ["hiddify", "shadowrocket", "incy", "links"]) {
      const first = new URL(lines(await (await get(`format=${format}`)).text())[0]);
      expect(first.searchParams.get("pbk"), format).toBe(pbk);
    }
    const encoded = atob(await (await get("format=shadowrocket&encoding=base64")).text());
    expect(new URL(lines(encoded)[0]).searchParams.get("pbk")).toBe(pbk);
    const json = JSON.parse(await (await get("format=singbox")).text());
    expect(json.outbounds[0].tls.reality.public_key).toBe(pbk);
  });

  it("publishes VLESS only while the node's obfuscation password is unknown", async () => {
    await seed({ obfs: false });
    const body = await (await get("format=hiddify")).text();
    expect(lines(body)).toHaveLength(1);
    expect(body).toContain("vless://");
    expect(body).not.toContain("hysteria2://");
  });

  it("does not offer Hysteria2 for a node that is only an IP address", async () => {
    await seed({ node: { hostname: null } });
    const body = await (await get("format=links")).text();
    expect(body).not.toContain("hysteria2://");
    expect(body).toContain("@203.0.113.7:443");
  });

  it("returns the identical share links Base64-wrapped for Shadowrocket only on request", async () => {
    const plain = await (await get("format=shadowrocket")).text();
    const res = await get("format=shadowrocket&encoding=base64");
    expect(res.status).toBe(200);
    expect(atob(await res.text())).toBe(plain);
  });

  it("refuses an encoding it cannot honour instead of silently ignoring it", async () => {
    expect((await get("format=hiddify&encoding=base64")).status).toBe(400);
    expect((await get("format=shadowrocket&encoding=gzip")).status).toBe(400);
  });

  it("serves INCY the VLESS link only, as its capability declares", async () => {
    const body = await (await get("format=incy")).text();
    expect(lines(body)).toHaveLength(1);
    expect(body).toContain("vless://");
  });

  it("hides revoked, expired and malformed subscriptions as not found", async () => {
    await seed({ device: { revoked_at: "2026-01-01T00:00:00Z" } });
    expect((await get("format=hiddify")).status).toBe(404);
    await seed({ device: { subscription_expires_at: "2020-01-01T00:00:00Z" } });
    expect((await get("format=hiddify")).status).toBe(404);
    await seed();
    expect((await get("format=hiddify", "short")).status).toBe(404);
    expect((await get("format=hiddify", "U".repeat(43))).status).toBe(404);
  });

  it("rejects unknown formats and plain HTTP", async () => {
    expect((await get("format=nope")).status).toBe(400);
    expect((await get("")).status).toBe(400);
    const res = await onRequestGet({ env, request: new Request(`http://account.example/sub/${TOKEN}?format=hiddify`), params: { token: TOKEN } });
    expect(res.status).toBe(400);
  });

  it("never leaks internal identifiers or other secrets into the body", async () => {
    const body = await (await get("format=singbox")).text();
    for (const forbidden of ["account_id", "principal", "ext_1", "service", OBFS, HY2_PASSWORD]) {
      expect(body).not.toContain(forbidden);
    }
  });
});
