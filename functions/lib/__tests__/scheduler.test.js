import { describe, it, expect, vi } from "vitest";
import { selectNodeForDevice, scheduleNodeForDevice } from "../scheduler.js";

describe("selectNodeForDevice (pure)", () => {
  it("returns null when there are no candidates", () => {
    expect(selectNodeForDevice({ candidates: [], stickyNodeId: null })).toBeNull();
  });

  it("picks the least-loaded candidate when there is no sticky assignment", () => {
    const candidates = [
      { nodeId: "de-fra-1", configuredUsers: 50 },
      { nodeId: "de-fra-2", configuredUsers: 10 },
      { nodeId: "de-fra-3", configuredUsers: 30 },
    ];
    expect(selectNodeForDevice({ candidates, stickyNodeId: null })).toBe("de-fra-2");
  });

  it("breaks a load tie deterministically on node_id", () => {
    const candidates = [
      { nodeId: "de-fra-2", configuredUsers: 10 },
      { nodeId: "de-fra-1", configuredUsers: 10 },
    ];
    expect(selectNodeForDevice({ candidates, stickyNodeId: null })).toBe("de-fra-1");
  });

  it("prefers the sticky node even if a less-loaded candidate exists", () => {
    const candidates = [
      { nodeId: "de-fra-1", configuredUsers: 50 },
      { nodeId: "de-fra-2", configuredUsers: 5 },
    ];
    expect(selectNodeForDevice({ candidates, stickyNodeId: "de-fra-1" })).toBe("de-fra-1");
  });

  it("treats a null configured_users (no heartbeat yet) as worse than a known low load, not as zero", () => {
    const candidates = [
      { nodeId: "no-heartbeat-yet", configuredUsers: null },
      { nodeId: "known-low-load", configuredUsers: 3 },
    ];
    expect(selectNodeForDevice({ candidates, stickyNodeId: null })).toBe("known-low-load");
  });

  it("falls back to load-based selection when the sticky node is no longer a candidate", () => {
    // e.g. it went DRAINING or QUARANTINED and was already filtered out
    // by the DB-facing caller before candidates ever reached here.
    const candidates = [{ nodeId: "de-fra-2", configuredUsers: 5 }];
    expect(selectNodeForDevice({ candidates, stickyNodeId: "de-fra-1" })).toBe("de-fra-2");
  });
});

describe("scheduleNodeForDevice (DB-facing)", () => {
  // The nodes table chain needs to resolve to { data, error } once all
  // three .eq() filters are applied; simplest is to make eq itself
  // thenable-returning on the last call by resolving a promise directly.
  function makeSupabaseWithNodes({ allowedPath, sticky, nodes, upsertError = null }) {
    const upsert = vi.fn().mockResolvedValue({ error: upsertError });
    const nodesQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
    };
    // Make the query awaitable: awaiting a plain object with no `.then`
    // just resolves to itself, so give it a `.then` that resolves to the
    // final { data, error } payload.
    nodesQuery.then = (resolve) => resolve({ data: nodes, error: null });

    const from = vi.fn((table) => {
      if (table === "allowed_paths") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: allowedPath, error: null }),
        };
      }
      if (table === "device_node_assignments") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: sticky, error: null }),
          upsert,
        };
      }
      if (table === "nodes") return nodesQuery;
      throw new Error(`unexpected table ${table}`);
    });
    return { from, upsert };
  }

  it("fails closed (returns null) when no enabled direct allowed_paths row exists", async () => {
    const { from, upsert } = makeSupabaseWithNodes({ allowedPath: null, sticky: null, nodes: [] });
    const result = await scheduleNodeForDevice(
      { from },
      { deviceId: "device-1", exitLocationId: "loc-1" }
    );
    expect(result).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("returns null and does not upsert when no READY EXIT node exists in the location", async () => {
    const { from, upsert } = makeSupabaseWithNodes({
      allowedPath: { id: "path-1" },
      sticky: null,
      nodes: [],
    });
    const result = await scheduleNodeForDevice(
      { from },
      { deviceId: "device-1", exitLocationId: "loc-1" }
    );
    expect(result).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("excludes nodes at or over max_sessions from candidates", async () => {
    const { from, upsert } = makeSupabaseWithNodes({
      allowedPath: { id: "path-1" },
      sticky: null,
      nodes: [
        { node_id: "full", configured_users: 100, max_sessions: 100 },
        { node_id: "has-room", configured_users: 5, max_sessions: 100 },
      ],
    });
    const result = await scheduleNodeForDevice(
      { from },
      { deviceId: "device-1", exitLocationId: "loc-1" }
    );
    expect(result).toBe("has-room");
    expect(upsert).toHaveBeenCalledWith(
      { device_id: "device-1", node_id: "has-room" },
      { onConflict: "device_id" }
    );
  });

  it("does not re-upsert when the scheduled node matches the existing sticky assignment", async () => {
    const { from, upsert } = makeSupabaseWithNodes({
      allowedPath: { id: "path-1" },
      sticky: { node_id: "de-fra-1" },
      nodes: [{ node_id: "de-fra-1", configured_users: 5, max_sessions: 100 }],
    });
    const result = await scheduleNodeForDevice(
      { from },
      { deviceId: "device-1", exitLocationId: "loc-1" }
    );
    expect(result).toBe("de-fra-1");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("propagates an allowed_paths lookup error instead of silently allowing", async () => {
    const from = vi.fn((table) => {
      if (table === "allowed_paths") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }),
        };
      }
      if (table === "device_node_assignments") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
    await expect(
      scheduleNodeForDevice({ from }, { deviceId: "device-1", exitLocationId: "loc-1" })
    ).rejects.toThrow(/allowed_paths lookup failed/);
  });
});
