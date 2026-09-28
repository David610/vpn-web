import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/user-auth.js", () => ({
  requireRecentUser: vi.fn(),
  jsonResponse: (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
}));

vi.mock("../../../lib/accounts.js", () => ({
  getAccountForUser: vi.fn(),
  getEffectiveEntitlement: vi.fn(),
}));

vi.mock("../../../lib/node-mutation-budget.js", () => ({
  checkNodeMutationBudget: vi.fn(),
}));

const insert = vi.fn();
const maybeSingle = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle,
      insert: insert.mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { id: "job-1" }, error: null }),
        }),
      }),
    })),
  })),
}));

const { requireRecentUser } = await import("../../../lib/user-auth.js");
const { getAccountForUser, getEffectiveEntitlement } = await import("../../../lib/accounts.js");
const { checkNodeMutationBudget } = await import("../../../lib/node-mutation-budget.js");
const { onRequestPost } = await import("../rotate-credentials.js");

const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/vpn/rotate-credentials", { method: "POST" });
}

beforeEach(() => {
  requireRecentUser.mockReset().mockResolvedValue({ user: { id: "user-1" }, response: null });
  getAccountForUser.mockReset().mockResolvedValue({ accountId: "acct-1" });
  getEffectiveEntitlement.mockReset().mockResolvedValue({ entitled: true });
  checkNodeMutationBudget.mockReset().mockResolvedValue(true);
  maybeSingle.mockReset().mockResolvedValue({
    data: { id: "vpn-1", vpn_user_id: "u1", node_id: "node-1", enabled: true },
    error: null,
  });
  insert.mockClear();
});

describe("POST /api/vpn/rotate-credentials", () => {
  it("enqueues a rotation job when within the per-account/node budget (F-10)", async () => {
    const res = await onRequestPost({ env, request: makeRequest(), params: {} });
    expect(res.status).toBe(202);
    expect(checkNodeMutationBudget).toHaveBeenCalledWith(expect.anything(), "acct-1", "node-1");
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("returns 429 without enqueuing a job once the node-mutation budget is exhausted (F-10)", async () => {
    checkNodeMutationBudget.mockResolvedValue(false);
    const res = await onRequestPost({ env, request: makeRequest(), params: {} });
    expect(res.status).toBe(429);
    expect(insert).not.toHaveBeenCalled();
  });

  it("uses a deterministic, time-windowed idempotency key rather than a random one per call (F-10)", async () => {
    await onRequestPost({ env, request: makeRequest(), params: {} });
    await onRequestPost({ env, request: makeRequest(), params: {} });
    expect(insert).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = insert.mock.calls;
    expect(firstCall[0].idempotency_key).toBe(secondCall[0].idempotency_key);
    expect(firstCall[0].idempotency_key).toMatch(/^self-rotate-credentials:vpn-1:\d+$/);
  });
});
