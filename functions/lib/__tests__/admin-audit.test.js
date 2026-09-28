import { describe, it, expect, vi, beforeEach } from "vitest";

const insert = vi.fn();
const supabaseAdmin = { from: vi.fn(() => ({ insert })) };

const { writeAdminAudit } = await import("../admin-audit.js");

beforeEach(() => {
  insert.mockReset();
  insert.mockResolvedValue({ error: null });
});

describe("writeAdminAudit", () => {
  it("inserts one admin_audit_log row with the given fields", async () => {
    await writeAdminAudit(supabaseAdmin, {
      adminUserId: "admin-1",
      action: "admin.disable_user",
      targetType: "vpn_account",
      targetId: 42,
      metadata: { node_id: "node-1" },
    });
    expect(supabaseAdmin.from).toHaveBeenCalledWith("admin_audit_log");
    expect(insert).toHaveBeenCalledWith({
      admin_user_id: "admin-1",
      action: "admin.disable_user",
      target_type: "vpn_account",
      target_id: "42",
      metadata: { node_id: "node-1" },
    });
  });

  it("defaults metadata to {}", async () => {
    insert.mockResolvedValue({ error: null });
    await writeAdminAudit(supabaseAdmin, {
      adminUserId: "admin-1",
      action: "admin.enable_user",
      targetType: "vpn_account",
      targetId: 1,
    });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ metadata: {} }));
  });

  // F-39: an audit write is the only record a privileged action happened.
  // Silently swallowing an insert failure (old behavior: log to console,
  // return success) would let an admin mutation succeed with no audit
  // trail at all. Callers await this and propagate the failure to the
  // request instead.
  it("throws when the insert fails, instead of silently logging and continuing", async () => {
    insert.mockResolvedValue({ error: { message: "db down" } });
    await expect(
      writeAdminAudit(supabaseAdmin, {
        adminUserId: "admin-1",
        action: "admin.enable_user",
        targetType: "vpn_account",
        targetId: 1,
      })
    ).rejects.toThrow(/db down/);
  });
});
