import { describe, expect, it } from "vitest";
import { encryptSecret } from "../crypto.js";
import { hysteria2Material } from "../external-hysteria2.js";

const KEY = "22".repeat(32);
const env = { VPN_SECRETS_ENCRYPTION_KEY: KEY };

function fakeDb(row, error = null) {
  const calls = [];
  const builder = { select: () => builder, eq: (col, value) => { calls.push([col, value]); return builder; }, maybeSingle: async () => ({ data: row, error }) };
  return { calls, from: (table) => { calls.push(["from", table]); return builder; } };
}

async function secretRow(plain) {
  const { ciphertext, nonce } = await encryptSecret(plain, KEY);
  return { hysteria2_obfs_ciphertext: ciphertext, hysteria2_obfs_nonce: nonce };
}

const realityNode = { node_id: "n1", transport: "vless-reality", hostname: "vpn.example.com", tls_server_name: "www.cloudflare.com", hysteria2_obfs_type: null };

describe("external Hysteria2 link material", () => {
  it("uses the node hostname (its certificate name), not the REALITY decoy, and the stored Salamander password", async () => {
    const db = fakeDb(await secretRow("obfs-secret-value-123"));
    expect(await hysteria2Material(db, env, realityNode)).toEqual({
      serverName: "vpn.example.com", obfs: { type: "salamander", password: "obfs-secret-value-123" },
    });
    expect(db.calls).toContainEqual(["from", "node_transport_secrets"]);
    expect(db.calls).toContainEqual(["node_id", "n1"]);
  });

  it("publishes no Hysteria2 when the node has not reported its obfuscation password", async () => {
    expect(await hysteria2Material(fakeDb(null), env, realityNode)).toBeNull();
    expect(await hysteria2Material(fakeDb({ hysteria2_obfs_ciphertext: null }), env, realityNode)).toBeNull();
  });

  it("publishes no Hysteria2 for a node that is only known by IP address", async () => {
    const db = fakeDb(await secretRow("obfs-secret-value-123"));
    for (const hostname of [null, "", "203.0.113.7", "2001:db8::1"]) {
      expect(await hysteria2Material(db, env, { ...realityNode, hostname }), String(hostname)).toBeNull();
    }
  });

  it("describes a dedicated Hysteria2 node using its own certificate name without reading any secret", async () => {
    const db = fakeDb(null);
    const node = { node_id: "h1", transport: "hysteria2", hostname: "ignored.example.com", tls_server_name: "hy.example.com", hysteria2_obfs_type: null };
    expect(await hysteria2Material(db, env, node)).toEqual({ serverName: "hy.example.com" });
    expect(db.calls).toEqual([]);
  });

  it("honours the obfuscation type a dedicated Hysteria2 node declares", async () => {
    const db = fakeDb(await secretRow("obfs-secret-value-123"));
    const node = { node_id: "h1", transport: "hysteria2", hostname: "x.example.com", tls_server_name: "hy.example.com", hysteria2_obfs_type: "salamander" };
    expect(await hysteria2Material(db, env, node)).toEqual({ serverName: "hy.example.com", obfs: { type: "salamander", password: "obfs-secret-value-123" } });
  });

  it("fails closed to no Hysteria2, never to an exception, on a database or decryption error", async () => {
    expect(await hysteria2Material(fakeDb(null, { message: "boom" }), env, realityNode)).toBeNull();
    const bad = { hysteria2_obfs_ciphertext: "\\x00", hysteria2_obfs_nonce: "\\x00" };
    expect(await hysteria2Material(fakeDb(bad), env, realityNode)).toBeNull();
  });
});
