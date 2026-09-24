import { describe, it, expect, vi } from "vitest";
import { selectNodeForDevice, scheduleNodeForDevice, scheduleDoubleHopForDevice } from "../scheduler.js";

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
      { device_id: "device-1", node_id: "has-room", hop: "EXIT" },
      { onConflict: "device_id,hop" }
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

describe("scheduleDoubleHopForDevice (DB-facing)", () => {
  // Every device_node_assignments lookup now filters on hop; the mock reads
  // whichever eq("hop", ...) argument the code passed so a single mock table
  // can serve the RELAY sticky lookup, the EXIT sticky lookup and the
  // upsert's own reads without knowing the call order.
  function makeSupabase({ allowedPath, relaySticky, exitSticky, relayNodes, exitNodes, upsertError = null }) {
    const upsert = vi.fn().mockResolvedValue({ error: upsertError });

    const from = vi.fn((table) => {
      if (table === "allowed_paths") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: allowedPath, error: null }),
        };
      }
      if (table === "device_node_assignments") {
        let hop = null;
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn(function (column, value) {
            if (column === "hop") hop = value;
            return this;
          }),
          maybeSingle: vi.fn(() =>
            Promise.resolve({ data: hop === "RELAY" ? relaySticky : exitSticky, error: null })
          ),
          upsert,
        };
      }
      if (table === "nodes") {
        let role = null;
        const query = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn(function (column, value) {
            if (column === "role") role = value;
            return this;
          }),
        };
        query.then = (resolve) =>
          resolve({ data: role === "RELAY" ? relayNodes : exitNodes, error: null });
        return query;
      }
      throw new Error(`unexpected table ${table}`);
    });
    return { from, upsert };
  }

  it("fails closed (returns null) when no enabled double-hop allowed_paths row exists", async () => {
    const { from, upsert } = makeSupabase({
      allowedPath: null,
      relaySticky: null,
      exitSticky: null,
      relayNodes: [],
      exitNodes: [],
    });
    const result = await scheduleDoubleHopForDevice(
      { from },
      { deviceId: "device-1", entryLocationId: "loc-ru", exitLocationId: "loc-de" }
    );
    expect(result).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("schedules both hops and upserts both rows when neither has a sticky assignment", async () => {
    const { from, upsert } = makeSupabase({
      allowedPath: { id: "path-1" },
      relaySticky: null,
      exitSticky: null,
      relayNodes: [{ node_id: "ru-relay-1", configured_users: 5, max_sessions: 100 }],
      exitNodes: [{ node_id: "de-exit-1", configured_users: 5, max_sessions: 100 }],
    });
    const result = await scheduleDoubleHopForDevice(
      { from },
      { deviceId: "device-1", entryLocationId: "loc-ru", exitLocationId: "loc-de" }
    );
    expect(result).toEqual({ relayNodeId: "ru-relay-1", exitNodeId: "de-exit-1" });
    expect(upsert).toHaveBeenCalledWith(
      [
        { device_id: "device-1", node_id: "ru-relay-1", hop: "RELAY" },
        { device_id: "device-1", node_id: "de-exit-1", hop: "EXIT" },
      ],
      { onConflict: "device_id,hop" }
    );
  });

  it("fails closed on a partial placement: no relay candidate means nothing is scheduled or written", async () => {
    const { from, upsert } = makeSupabase({
      allowedPath: { id: "path-1" },
      relaySticky: null,
      exitSticky: null,
      relayNodes: [],
      exitNodes: [{ node_id: "de-exit-1", configured_users: 5, max_sessions: 100 }],
    });
    const result = await scheduleDoubleHopForDevice(
      { from },
      { deviceId: "device-1", entryLocationId: "loc-ru", exitLocationId: "loc-de" }
    );
    expect(result).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("fails closed on a partial placement: no exit candidate means nothing is scheduled or written", async () => {
    const { from, upsert } = makeSupabase({
      allowedPath: { id: "path-1" },
      relaySticky: null,
      exitSticky: null,
      relayNodes: [{ node_id: "ru-relay-1", configured_users: 5, max_sessions: 100 }],
      exitNodes: [],
    });
    const result = await scheduleDoubleHopForDevice(
      { from },
      { deviceId: "device-1", entryLocationId: "loc-ru", exitLocationId: "loc-de" }
    );
    expect(result).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("keeps each hop sticky independently and only upserts the hop that changed", async () => {
    const { from, upsert } = makeSupabase({
      allowedPath: { id: "path-1" },
      relaySticky: { node_id: "ru-relay-1" },
      exitSticky: null,
      relayNodes: [
        { node_id: "ru-relay-1", configured_users: 50, max_sessions: 100 },
        { node_id: "ru-relay-2", configured_users: 1, max_sessions: 100 },
      ],
      exitNodes: [{ node_id: "de-exit-1", configured_users: 5, max_sessions: 100 }],
    });
    const result = await scheduleDoubleHopForDevice(
      { from },
      { deviceId: "device-1", entryLocationId: "loc-ru", exitLocationId: "loc-de" }
    );
    expect(result).toEqual({ relayNodeId: "ru-relay-1", exitNodeId: "de-exit-1" });
    expect(upsert).toHaveBeenCalledWith(
      [{ device_id: "device-1", node_id: "de-exit-1", hop: "EXIT" }],
      { onConflict: "device_id,hop" }
    );
  });

  it("does not upsert when both hops match their existing sticky assignment", async () => {
    const { from, upsert } = makeSupabase({
      allowedPath: { id: "path-1" },
      relaySticky: { node_id: "ru-relay-1" },
      exitSticky: { node_id: "de-exit-1" },
      relayNodes: [{ node_id: "ru-relay-1", configured_users: 5, max_sessions: 100 }],
      exitNodes: [{ node_id: "de-exit-1", configured_users: 5, max_sessions: 100 }],
    });
    const result = await scheduleDoubleHopForDevice(
      { from },
      { deviceId: "device-1", entryLocationId: "loc-ru", exitLocationId: "loc-de" }
    );
    expect(result).toEqual({ relayNodeId: "ru-relay-1", exitNodeId: "de-exit-1" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("propagates an allowed_paths lookup error instead of silently allowing", async () => {
    const from = vi.fn((table) => {
      if (table === "allowed_paths") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
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
      scheduleDoubleHopForDevice(
        { from },
        { deviceId: "device-1", entryLocationId: "loc-ru", exitLocationId: "loc-de" }
      )
    ).rejects.toThrow(/allowed_paths lookup failed/);
  });
});
