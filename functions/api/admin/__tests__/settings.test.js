import { describe, it, expect, vi } from "vitest";

vi.mock("../../../lib/admin-auth.js", () => ({
  requireAdmin: vi.fn(async () => ({ admin: { userId: "a" }, response: null })),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({})) }));

const { onRequestGet } = await import("../settings.js");

describe("GET /api/admin/settings", () => {
  it("reports presence of secrets, never their values", async () => {
    const env = {
      STRIPE_API_KEY: "sk_live_SECRET",
      STRIPE_SEAT_PRICE_ID: "price_pack",
      VPN_SECRETS_ENCRYPTION_KEY: "abcd",
      FEATURE_MULTI_NODE_SCHEDULING: "true",
      FLEET_REALITY_HANDSHAKE_SERVER: "www.cloudflare.com",
    };
    const res = await onRequestGet({ env, request: new Request("https://x/api/admin/settings") });
    const text = await res.text();
    expect(text).not.toContain("sk_live_SECRET");
    expect(text).not.toContain("abcd");
    const body = JSON.parse(text);
    expect(body.billing).toMatchObject({ stripeApiKey: true, packPrice: true, basePrice: false });
    expect(body.plan).toMatchObject({ includedDevices: 3, devicesPerPack: 3, basePriceCents: 699 });
    expect(body.fleet.multiNodeScheduling).toBe(true);
    expect(body.fleet.realityHandshakeServer).toBe("www.cloudflare.com");
  });

  it("reports realityHandshakeServer as null when not configured", async () => {
    const res = await onRequestGet({ env: {}, request: new Request("https://x/api/admin/settings") });
    const body = await res.json();
    expect(body.fleet.realityHandshakeServer).toBeNull();
  });
});
