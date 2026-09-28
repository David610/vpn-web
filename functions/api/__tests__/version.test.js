import { describe, it, expect, vi, afterEach } from "vitest";

let selectResult = { data: [{ id: 1 }], error: null };

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        limit: vi.fn(async () => selectResult),
      })),
    })),
  })),
}));

const { onRequestGet } = await import("../version.js");

afterEach(() => {
  selectResult = { data: [{ id: 1 }], error: null };
});

const env = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "key",
  CF_PAGES_COMMIT_SHA: "abc123def456",
  CF_PAGES_BRANCH: "main",
  CF_PAGES_URL: "https://arcana-web-epw.pages.dev",
};

describe("GET /api/version", () => {
  it("returns the deployed git SHA and branch from the Cloudflare Pages build env", async () => {
    const res = await onRequestGet({ env });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.commit_sha).toBe("abc123def456");
    expect(body.branch).toBe("main");
  });

  it("reports schema_check ok when the marker table is queryable", async () => {
    const res = await onRequestGet({ env });
    const body = await res.json();
    expect(body.schema_check).toBe("ok");
  });

  it("reports schema_check behind_or_unreachable when the marker table is missing", async () => {
    selectResult = { data: null, error: { message: 'relation "public.node_probe_results" does not exist' } };
    const res = await onRequestGet({ env });
    const body = await res.json();
    expect(body.schema_check).toBe("behind_or_unreachable");
    expect(body.schema_check_detail).toMatch(/does not exist/);
  });

  it("returns null commit_sha/branch outside a Cloudflare Pages build (local dev)", async () => {
    const res = await onRequestGet({ env: { SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY } });
    const body = await res.json();
    expect(body.commit_sha).toBeNull();
    expect(body.branch).toBeNull();
  });

  it("never throws when Supabase env vars are absent", async () => {
    const res = await onRequestGet({ env: {} });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schema_check).toBe("unknown");
  });
});
