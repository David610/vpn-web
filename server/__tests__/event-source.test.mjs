import { describe, expect, it, vi } from "vitest";
import { createSupabaseEventHub } from "../event-source.mjs";

describe("supabase-backed event hub", () => {
  it("maps the wake-token rpc rows onto cursor fields and asks for all waiting nodes in one call", async () => {
    const rpc = vi.fn(async (name) => name === "agent_wake_tokens"
      ? { data: [{ node_id: "n1", jobs_token: "5:2", auth_revision: 9, lease_token: "abc" }], error: null }
      : { data: [{ node_id: "n1", entitlement_token: "e" }], error: null });
    const hub = createSupabaseEventHub({ db: { rpc } });
    const first = await hub.wait("n1", undefined, { timeoutMs: 10 });
    expect(first.reason).toBe("resync");
    expect(rpc).toHaveBeenCalledWith("agent_wake_tokens", { p_node_ids: ["n1"] });
    expect(rpc).toHaveBeenCalledWith("agent_entitlement_tokens", { p_node_ids: ["n1"] });
    const again = await hub.wait("n1", first.cursor, { timeoutMs: 5 });
    expect(again.reason).toBe("timeout");
    hub.close();
  });

  it("surfaces a database error without leaking its message", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "relation secret_table missing" } }));
    const hub = createSupabaseEventHub({ db: { rpc } });
    await expect(hub.wait("n1", undefined, { timeoutMs: 5 })).rejects.toThrow(/agent_wake_tokens failed/);
  });

  it("marks a missing wake-token function as an unsupported channel, not a generic failure", async () => {
    for (const error of [{ code: "PGRST202", message: "x" }, { code: "42883", message: "x" }, { message: "Could not find the function public.agent_wake_tokens" }]) {
      const hub = createSupabaseEventHub({ db: { rpc: vi.fn(async () => ({ data: null, error })) } });
      await expect(hub.wait("n1", undefined, { timeoutMs: 5 })).rejects.toMatchObject({ code: "EVENT_CHANNEL_UNSUPPORTED" });
    }
  });

  it("reports an unknown node as an error rather than as an empty state", async () => {
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    const hub = createSupabaseEventHub({ db: { rpc } });
    await expect(hub.wait("ghost", undefined, { timeoutMs: 5 })).rejects.toThrow();
  });
});
