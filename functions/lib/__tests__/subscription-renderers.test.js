import { describe, expect, it, vi } from "vitest";
import { renderers, UnsupportedClientModeError } from "../subscription-renderers.js";
import { clientCapabilities, isSupportedClient, protocolsForMode, supportsMode } from "../client-capabilities.js";
import { readFileSync } from "node:fs";

const credential = { vless_uuid: "018f4f18-8b5d-7c21-9f2b-0f8a7c6d5e4f", hysteria2_password: "secret-that-is-not-a-subscription-token" };
const route = { mode: "fast", displayName: "Germany — Fast", server: "edge.example.net", port: 443,
  tlsServerName: "cdn.example.net", realityPublicKey: "public-key", realityShortId: "a1b2c3d4",
  realityFingerprint: "chrome", vlessFlow: "xtls-rprx-vision" };

describe("subscription renderers", () => {
  it("is deterministic and contains only public route/protocol material", () => {
    for (const [format, render] of Object.entries(renderers)) {
      const first = render({ route, credential });
      expect(render({ route, credential })).toBe(first);
      expect(first).toContain("Germany");
      expect(first).toContain("edge.example.net");
      expect(first).toContain(credential.vless_uuid);
      expect(first).not.toContain("account_id");
      expect(first).not.toContain("stripe");
      expect(first).not.toContain("supabase");
      if (format === "incy" || format === "xray") expect(first).not.toContain("hysteria2://");
      expect(first).toBe(readFileSync(new URL(`../../../fixtures/subscriptions/${format}-fast.golden`, import.meta.url), "utf8"));
    }
  });

  it("rejects Privacy+ for every unqualified external client without fallback", () => {
    for (const [format, render] of Object.entries(renderers)) {
      expect(() => render({ route: { ...route, mode: "privacy_plus" }, credential }), format)
        .toThrow(UnsupportedClientModeError);
    }
    expect(Object.values(clientCapabilities()).every((c) => c.privacy_plus.length === 0)).toBe(true);
    expect(supportsMode("singbox", "privacy_plus")).toBe(false);
    expect(supportsMode("hiddify", "fast")).toBe(true);
    expect(protocolsForMode("incy", "fast")).toEqual(["vless"]);
    expect(isSupportedClient("unknown-client")).toBe(false);
  });

  it("publishes a rotated B credential without changing the logical name", () => {
    const b = { ...credential, vless_uuid: "118f4f18-8b5d-7c21-9f2b-0f8a7c6d5e4f" };
    const before = renderers.xray({ route, credential });
    const after = renderers.xray({ route, credential: b });
    expect(before).toContain(credential.vless_uuid);
    expect(after).toContain(b.vless_uuid);
    expect(after).not.toContain(credential.vless_uuid);
    expect(after).toContain("Germany — Fast");
  });

  it("renderSingBox refuses Privacy+ on its own, even if the capability gate were ever opened", async () => {
    // Regression test for a real bug found while investigating two-hop
    // compat support: renderSingBox used to build a `detour`-chained
    // outbound from `route.entry`'s flat fields directly, which is missing
    // `type`, `server_port` and a `tls` block, and carries no credential at
    // all for that hop -- it only looked complete because the capability
    // gate (asserted first) made the branch unreachable. This proves the
    // function refuses on its own merits, not only because the gate happens
    // to be closed today -- so a future capability flip alone can never
    // resurrect the old broken behavior.
    vi.resetModules();
    vi.doMock("../client-capabilities.js", async () => {
      const actual = await vi.importActual("../client-capabilities.js");
      return {
        ...actual,
        supportsMode: (format, mode) => (format === "singbox" ? true : actual.supportsMode(format, mode)),
        protocolsForMode: (format, mode) =>
          format === "singbox" && mode === "privacy_plus" ? ["vless"] : actual.protocolsForMode(format, mode),
      };
    });
    const { renderSingBox, UnsupportedClientModeError: MockedError } = await import("../subscription-renderers.js");
    expect(() =>
      renderSingBox({
        route: { ...route, mode: "privacy_plus", entry: { server: "entry.example.net", port: 443 } },
        credential,
      })
    ).toThrow(MockedError);
    vi.doUnmock("../client-capabilities.js");
    vi.resetModules();
  });
});
