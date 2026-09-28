import { describe, it, expect, vi } from "vitest";

vi.mock("../rate-limit.js", () => ({
  checkRateLimit: vi.fn(),
}));

const { checkRateLimit } = await import("../rate-limit.js");
const { checkNodeMutationBudget, DEFAULT_NODE_MUTATION_BUDGET } = await import("../node-mutation-budget.js");

describe("checkNodeMutationBudget (F-10)", () => {
  it("keys the bucket by account and node, and uses the default budget", async () => {
    checkRateLimit.mockResolvedValue(true);
    const supabaseAdmin = {};
    const ok = await checkNodeMutationBudget(supabaseAdmin, "acct-1", "node-1");
    expect(ok).toBe(true);
    expect(checkRateLimit).toHaveBeenCalledWith(
      supabaseAdmin,
      "node-mutation:acct-1:node-1",
      DEFAULT_NODE_MUTATION_BUDGET
    );
  });

  it("propagates a budget-exceeded result", async () => {
    checkRateLimit.mockResolvedValue(false);
    const ok = await checkNodeMutationBudget({}, "acct-1", "node-1");
    expect(ok).toBe(false);
  });

  it("accepts a custom budget override", async () => {
    checkRateLimit.mockResolvedValue(true);
    const customBudget = { windowSeconds: 30, limit: 2 };
    await checkNodeMutationBudget({}, "acct-1", "node-1", customBudget);
    expect(checkRateLimit).toHaveBeenCalledWith({}, "node-mutation:acct-1:node-1", customBudget);
  });
});
