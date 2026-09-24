import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCloudflareDns } from "../cloudflare.js";

const env = { CLOUDFLARE_DNS_API_TOKEN: "t", CLOUDFLARE_DNS_ZONE_ID: "zone1" };
const ok = (result) => ({ ok: true, status: 200, json: async () => ({ success: true, result }) });

beforeEach(() => {
  global.fetch = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

describe("Cloudflare DNS adapter", () => {
  it("requires a token and zone id", () => {
    expect(() => createCloudflareDns({})).toThrow(/CLOUDFLARE_DNS_API_TOKEN/);
  });

  it("creates an unproxied, short-TTL A record when none exists", async () => {
    global.fetch.mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok({ id: "rec-1" }));
    const dns = createCloudflareDns(env);
    const res = await dns.upsertAddressRecord({ name: "n1.nodes.example.test", content: "203.0.113.9" });
    expect(res).toEqual({ recordId: "rec-1" });
    const [lookupUrl] = global.fetch.mock.calls[0];
    expect(lookupUrl).toBe(
      "https://api.cloudflare.com/client/v4/zones/zone1/dns_records?type=A&name=n1.nodes.example.test"
    );
    const [, createInit] = global.fetch.mock.calls[1];
    expect(createInit.method).toBe("POST");
    expect(JSON.parse(createInit.body)).toEqual({
      type: "A",
      name: "n1.nodes.example.test",
      content: "203.0.113.9",
      ttl: 60,
      proxied: false,
    });
  });

  it("is a no-op when the record already has the desired content (idempotent retry)", async () => {
    global.fetch.mockResolvedValueOnce(ok([{ id: "rec-1", content: "203.0.113.9", proxied: false }]));
    const dns = createCloudflareDns(env);
    expect(await dns.upsertAddressRecord({ name: "n1.x.test", content: "203.0.113.9" })).toEqual({ recordId: "rec-1" });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("updates in place (never duplicates) when the address changed, e.g. a replaced server", async () => {
    global.fetch
      .mockResolvedValueOnce(ok([{ id: "rec-1", content: "198.51.100.1", proxied: false }]))
      .mockResolvedValueOnce(ok({ id: "rec-1" }));
    const dns = createCloudflareDns(env);
    await dns.upsertAddressRecord({ name: "n1.x.test", content: "203.0.113.9" });
    const [url, init] = global.fetch.mock.calls[1];
    expect(url).toMatch(/\/dns_records\/rec-1$/);
    expect(init.method).toBe("PATCH");
  });

  it("surfaces Cloudflare's error instead of pretending success", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ success: false, errors: [{ message: "Authentication error" }] }),
    });
    const dns = createCloudflareDns(env);
    await expect(dns.upsertAddressRecord({ name: "n1.x.test", content: "203.0.113.9" })).rejects.toThrow(
      /Authentication error/
    );
  });

  it("treats deleting an already-deleted record as success", async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ success: false }) });
    const dns = createCloudflareDns(env);
    await expect(dns.deleteRecord({ recordId: "rec-1" })).resolves.toBeUndefined();
  });
});
