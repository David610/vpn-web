import { describe, it, expect, vi } from "vitest";
import { handleSubscriptionUpdated } from "../stripe-events.js";

function makeSupabaseAdminMock({ updateResult }) {
  const update = vi.fn().mockReturnThis();
  const eq = vi.fn().mockReturnThis();
  const select = vi.fn().mockReturnThis();
  const maybeSingle = vi.fn().mockResolvedValue(updateResult);
  return {
    from: vi.fn(() => ({ update, eq, select, maybeSingle })),
    _update: update,
  };
}

describe("handleSubscriptionUpdated", () => {
  it("persists cancel_at_period_end from the Stripe subscription object", async () => {
    const supabaseAdmin = makeSupabaseAdminMock({
      updateResult: { data: { user_id: "user-1" }, error: null },
    });

    await handleSubscriptionUpdated(supabaseAdmin, {
      id: "sub_123",
      status: "active",
      cancel_at_period_end: true,
      current_period_end: 1893456000,
    });

    expect(supabaseAdmin._update).toHaveBeenCalledWith(
      expect.objectContaining({ cancel_at_period_end: true })
    );
  });
});
