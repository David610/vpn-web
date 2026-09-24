import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHetznerProvider } from "../hetzner.js";

const env = { HETZNER_API_TOKEN: "test-token", SITE_URL: "https://arcana.test" };

function okJson(body) {
  return { ok: true, status: 200, json: async () => body };
}

const SERVER = {
  id: 12345,
  status: "initializing",
  public_net: { ipv4: { ip: "203.0.113.9" }, ipv6: { ip: "2001:db8::/64" } },
  datacenter: { location: { name: "fsn1" } },
};

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

  it("createInstance posts the caller's user_data, labels the server with its node id, and defaults to AlmaLinux 9", async () => {
    global.fetch.mockResolvedValue(okJson({ server: SERVER }));

    const provider = createHetznerProvider(env);
    const result = await provider.createInstance({
      nodeId: "de-fsn-001",
      region: "fsn1",
      userData: "#cloud-config\n",
    });

    expect(result).toEqual({
      providerInstanceId: "12345",
      ipAddress: "203.0.113.9",
      ipv6Network: "2001:db8::/64",
      region: "fsn1",
      status: "initializing",
    });

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.hetzner.cloud/v1/servers");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer test-token");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      name: "de-fsn-001",
      location: "fsn1",
      image: "alma-9",
      server_type: "cx23",
      user_data: "#cloud-config\n",
      labels: { "arcana-node-id": "de-fsn-001", "arcana-managed": "true" },
    });
  });

  it("honours server type / image overrides from env", async () => {
    global.fetch.mockResolvedValue(okJson({ server: SERVER }));
    const provider = createHetznerProvider({ ...env, FLEET_HETZNER_SERVER_TYPE: "cx33", FLEET_HETZNER_IMAGE: "alma-10" });
    await provider.createInstance({ nodeId: "de-fsn-001", region: "fsn1", userData: "x" });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.server_type).toBe("cx33");
    expect(body.image).toBe("alma-10");
  });

  it("refuses to create a server with no bootstrap user_data", async () => {
    const provider = createHetznerProvider(env);
    await expect(provider.createInstance({ nodeId: "de-fsn-001", region: "fsn1" })).rejects.toThrow(
      /userData is required/
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("findInstanceByNodeId looks the server up by its node label (idempotent adopt after a lost create response)", async () => {
    global.fetch.mockResolvedValue(okJson({ servers: [SERVER] }));
    const provider = createHetznerProvider(env);
    const found = await provider.findInstanceByNodeId("de-fsn-001");
    expect(found.providerInstanceId).toBe("12345");
    expect(global.fetch.mock.calls[0][0]).toBe(
      "https://api.hetzner.cloud/v1/servers?label_selector=arcana-node-id%3D%3Dde-fsn-001"
    );
  });

  it("findInstanceByNodeId returns null when no server carries the label", async () => {
    global.fetch.mockResolvedValue(okJson({ servers: [] }));
    const provider = createHetznerProvider(env);
    expect(await provider.findInstanceByNodeId("de-fsn-001")).toBeNull();
  });

  it("findInstanceByNodeId refuses to guess when several servers share one node label", async () => {
    global.fetch.mockResolvedValue(okJson({ servers: [SERVER, { ...SERVER, id: 2 }] }));
    const provider = createHetznerProvider(env);
    await expect(provider.findInstanceByNodeId("de-fsn-001")).rejects.toThrow(/2 servers/);
  });

  it("throws on a non-2xx Hetzner response instead of returning a partial result", async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: "invalid token" } }),
    });
    const provider = createHetznerProvider(env);
    await expect(
      provider.createInstance({ nodeId: "de-fsn-001", region: "fsn1", userData: "x" })
    ).rejects.toThrow(/invalid token/);
  });

  it("throws if Hetzner returns a server with no ip address", async () => {
    global.fetch.mockResolvedValue(okJson({ server: { id: 1, public_net: {} } }));
    const provider = createHetznerProvider(env);
    await expect(
      provider.createInstance({ nodeId: "de-fsn-001", region: "fsn1", userData: "x" })
    ).rejects.toThrow(/unexpected response shape/);
  });

  it("destroyInstance issues a DELETE to /servers/:id", async () => {
    global.fetch.mockResolvedValue(okJson({}));
    const provider = createHetznerProvider(env);
    await provider.destroyInstance({ providerInstanceId: "12345" });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.hetzner.cloud/v1/servers/12345");
    expect(init.method).toBe("DELETE");
  });

  it("destroyInstance treats an already-deleted server as success", async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: { message: "not found" } }) });
    const provider = createHetznerProvider(env);
    await expect(provider.destroyInstance({ providerInstanceId: "12345" })).resolves.toBeUndefined();
  });
});
