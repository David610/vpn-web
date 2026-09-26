import { describe, it, expect } from "vitest";
import { makeFakeSupabase } from "./fake-supabase.js";
import { signRouteDirectory } from "../route-signing.js";
import { canonicalJsonString } from "../canonical-json.js";
import { ed25519 } from "@noble/curves/ed25519.js";

// A fixed test keypair -- never a real signing key. Hex seed chosen
// arbitrarily; any 32-byte hex value works with ed25519.getPublicKey.
const PRIVATE_KEY_HEX = "11".repeat(32);
const PUBLIC_KEY = ed25519.getPublicKey(Buffer.from(PRIVATE_KEY_HEX, "hex"));

const NODES = [
  {
    nodeId: "de-fsn-001", role: "EXIT", locationId: "loc-de", lifecycleState: "READY",
    configuredUsers: 5, maxSessions: 100, hostname: "de-fsn-001.nodes.example.test",
    ipAddress: "203.0.113.10",
    transport: "vless-reality", transportPort: 443, tlsServerName: "decoy.example.test",
    realityPublicKey: "pub", realityShortId: "sid", realityFingerprint: "chrome", vlessFlow: "xtls-rprx-vision",
  },
];
const LOCATIONS = [{ id: "loc-de", countryCode: "DE", displayName: "Germany" }];
const DIRECT = [{ entryLocationId: null, exitLocationId: "loc-de" }];

describe("signRouteDirectory", () => {
  it("produces an envelope whose signature verifies against the public key", async () => {
    const db = makeFakeSupabase({ route_directory_state: [{ id: true, version: 0, last_payload_hash: null }] });
    const envelope = await signRouteDirectory(db, {
      nodes: NODES, locations: LOCATIONS, allowedPaths: DIRECT,
      privateKeyHex: PRIVATE_KEY_HEX, keyId: "routes-2026-a",
    });
    expect(envelope.schema_version).toBe(1);
    expect(envelope.key_id).toBe("routes-2026-a");
    const signed = {
      schema_version: envelope.schema_version,
      directory_version: envelope.directory_version,
      issued_at: envelope.issued_at,
      expires_at: envelope.expires_at,
      key_id: envelope.key_id,
      payload: envelope.payload,
    };
    const ok = ed25519.verify(
      Buffer.from(envelope.signature, "base64"),
      Buffer.from(canonicalJsonString(signed), "utf8"),
      PUBLIC_KEY
    );
    expect(ok).toBe(true);
  });

  it("sets expires_at exactly 1 hour after issued_at", async () => {
    const db = makeFakeSupabase({ route_directory_state: [{ id: true, version: 0, last_payload_hash: null }] });
    const envelope = await signRouteDirectory(db, {
      nodes: NODES, locations: LOCATIONS, allowedPaths: DIRECT,
      privateKeyHex: PRIVATE_KEY_HEX, keyId: "routes-2026-a",
    });
    const diffMs = new Date(envelope.expires_at).getTime() - new Date(envelope.issued_at).getTime();
    expect(diffMs).toBe(60 * 60 * 1000);
  });

  it("starts directory_version at 1 on the very first call (route_directory_state seeded at 0)", async () => {
    const db = makeFakeSupabase({ route_directory_state: [{ id: true, version: 0, last_payload_hash: null }] });
    const envelope = await signRouteDirectory(db, {
      nodes: NODES, locations: LOCATIONS, allowedPaths: DIRECT,
      privateKeyHex: PRIVATE_KEY_HEX, keyId: "routes-2026-a",
    });
    expect(envelope.directory_version).toBe(1);
  });

  it("reuses the same directory_version across two calls with unchanged route content", async () => {
    const db = makeFakeSupabase({ route_directory_state: [{ id: true, version: 0, last_payload_hash: null }] });
    const first = await signRouteDirectory(db, {
      nodes: NODES, locations: LOCATIONS, allowedPaths: DIRECT,
      privateKeyHex: PRIVATE_KEY_HEX, keyId: "routes-2026-a",
    });
    const second = await signRouteDirectory(db, {
      nodes: NODES, locations: LOCATIONS, allowedPaths: DIRECT,
      privateKeyHex: PRIVATE_KEY_HEX, keyId: "routes-2026-a",
    });
    expect(second.directory_version).toBe(first.directory_version);
    // issued_at still advances -- the validity window is refreshed even
    // when content (and therefore version) did not change.
    expect(new Date(second.issued_at).getTime()).toBeGreaterThanOrEqual(new Date(first.issued_at).getTime());
  });

  it("bumps directory_version when the underlying route content changes", async () => {
    const db = makeFakeSupabase({ route_directory_state: [{ id: true, version: 0, last_payload_hash: null }] });
    const first = await signRouteDirectory(db, {
      nodes: NODES, locations: LOCATIONS, allowedPaths: DIRECT,
      privateKeyHex: PRIVATE_KEY_HEX, keyId: "routes-2026-a",
    });
    const changedNodes = [{ ...NODES[0], transportPort: 8443 }];
    const second = await signRouteDirectory(db, {
      nodes: changedNodes, locations: LOCATIONS, allowedPaths: DIRECT,
      privateKeyHex: PRIVATE_KEY_HEX, keyId: "routes-2026-a",
    });
    expect(second.directory_version).toBe(first.directory_version + 1);
  });
});
