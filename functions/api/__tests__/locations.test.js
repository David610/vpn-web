import { describe, it, expect, vi, beforeEach } from "vitest";

const nodesResult = vi.fn();
const locationsResult = vi.fn();
const locationsIn = vi.fn();

function chain(result, onIn) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    in: vi.fn((column, values) => {
      onIn?.(column, values);
      return builder;
    }),
    order: vi.fn(() => result()),
    then: (resolve, reject) => result().then(resolve, reject),
  };
  return builder;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table) => {
      if (table === "nodes") return chain(nodesResult);
      if (table === "locations") return chain(locationsResult, locationsIn);
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestGet } = await import("../locations.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

beforeEach(() => {
  nodesResult.mockReset();
  locationsResult.mockReset();
  locationsIn.mockReset();
});

describe("GET /api/locations", () => {
  it("lists only enabled locations that have a READY node", async () => {
    nodesResult.mockResolvedValue({
      data: [{ location_id: "loc-de" }, { location_id: "loc-de" }, { location_id: "loc-se" }],
      error: null,
    });
    locationsResult.mockResolvedValue({
      data: [
        { country_code: "DE", city: "Frankfurt", display_name: "Germany" },
        { country_code: "SE", city: null, display_name: "Sweden" },
      ],
      error: null,
    });

    const res = await onRequestGet({ env });

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(locationsIn).toHaveBeenCalledWith("id", ["loc-de", "loc-se"]);
    expect(await res.json()).toEqual({
      locations: [
        { countryCode: "DE", city: "Frankfurt", name: "Germany" },
        { countryCode: "SE", city: null, name: "Sweden" },
      ],
    });
  });

  it("returns an empty list, not every enabled location, when no node is READY", async () => {
    nodesResult.mockResolvedValue({ data: [], error: null });

    const res = await onRequestGet({ env });

    expect(await res.json()).toEqual({ locations: [] });
    expect(locationsResult).not.toHaveBeenCalled();
  });

  it("never exposes node or infrastructure fields", async () => {
    nodesResult.mockResolvedValue({ data: [{ location_id: "loc-de" }], error: null });
    locationsResult.mockResolvedValue({
      data: [{ country_code: "DE", city: "Frankfurt", display_name: "Germany", id: "loc-de" }],
      error: null,
    });

    const body = await (await onRequestGet({ env })).json();

    expect(Object.keys(body.locations[0]).sort()).toEqual(["city", "countryCode", "name"]);
  });

  it("fails closed with a generic error", async () => {
    nodesResult.mockResolvedValue({ data: null, error: { message: "boom" } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await onRequestGet({ env });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal error" });
    spy.mockRestore();
  });
});
