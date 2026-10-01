import { describe, expect, it } from "vitest";
import { clientCapabilities, renderers, UnsupportedClientModeError } from "../subscription-renderers.js";

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
    }
  });

  it("rejects Privacy+ for every unqualified external client without fallback", () => {
    for (const [format, render] of Object.entries(renderers)) {
      expect(() => render({ route: { ...route, mode: "privacy_plus" }, credential }), format)
        .toThrow(UnsupportedClientModeError);
    }
    expect(Object.values(clientCapabilities()).every((c) => c.privacy_plus.length === 0)).toBe(true);
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
});
