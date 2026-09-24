import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHetznerProvider } from "../hetzner.js";

const env = { HETZNER_API_TOKEN: "test-token", SITE_URL: "https://arcana.test" };

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Hetzner provider adapter", () => {
  it("throws immediately when HETZNER_API_TOKEN is not configured", () => {
    expect(() => createHetznerProvider({})).toThrow(/HETZNER_API_TOKEN/);
  });

  it("createInstance posts to /servers with the enrollment token embedded in user_data", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        server: {
          id: 12345,
          public_net: { ipv4: { ip: "203.0.113.9" } },
          datacenter: { location: { name: "fsn1" } },
        },
      }),
    });

    const provider = createHetznerProvider(env);
    const result = await provider.createInstance({
      nodeId: "de-fra-3",
      region: "fsn1",
      enrollmentToken: "raw-enrollment-token",
    });

    expect(result).toEqual({ providerInstanceId: "12345", ipAddress: "203.0.113.9", region: "fsn1" });

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.hetzner.cloud/v1/servers");
    expect(init.headers.Authorization).toBe("Bearer test-token");
    const body = JSON.parse(init.body);
    expect(body.name).toBe("de-fra-3");
    expect(body.location).toBe("fsn1");
    expect(body.user_data).toContain("raw-enrollment-token");
    expect(body.user_data).toContain("https://arcana.test/api/agent/enroll");
    // The enrollment token must never appear in a URL (query string, logs,
    // proxy access logs) -- only in the request header, consistent with
    // how functions/api/agent/enroll.js itself expects it.
    expect(body.user_data).not.toMatch(/enroll\?.*raw-enrollment-token/);
  });

  it("throws on a non-2xx Hetzner response instead of returning a partial result", async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: "invalid token" } }),
    });
    const provider = createHetznerProvider(env);
    await expect(
      provider.createInstance({ nodeId: "de-fra-3", region: "fsn1", enrollmentToken: "t" })
    ).rejects.toThrow(/invalid token/);
  });

  it("throws if Hetzner returns a server with no ip address", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ server: { id: 1, public_net: {} } }),
    });
    const provider = createHetznerProvider(env);
    await expect(
      provider.createInstance({ nodeId: "de-fra-3", region: "fsn1", enrollmentToken: "t" })
    ).rejects.toThrow(/unexpected response shape/);
  });

  it("destroyInstance issues a DELETE to /servers/:id", async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    const provider = createHetznerProvider(env);
    await provider.destroyInstance({ providerInstanceId: "12345" });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.hetzner.cloud/v1/servers/12345");
    expect(init.method).toBe("DELETE");
  });
});
