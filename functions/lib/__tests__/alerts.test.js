import { describe, it, expect, vi, afterEach } from "vitest";
import { makeFakeSupabase } from "./fake-supabase.js";
import { raiseAlert, resolveAlert, reconcileAlert } from "../alerts.js";

describe("raiseAlert", () => {
  it("inserts an open alert row", async () => {
    const db = makeFakeSupabase({ operational_alerts: [] });
    const result = await raiseAlert(db, {
      kind: "lease_pool_exhausted",
      severity: "critical",
      dedupKey: "node:n1:lease_pool_exhausted",
      message: "Lease pool exhausted for node n1",
      nodeId: "n1",
    });
    expect(result.ok).toBe(true);
    expect(db._tables.operational_alerts).toHaveLength(1);
    expect(db._tables.operational_alerts[0]).toMatchObject({
      alert_type: "lease_pool_exhausted",
      severity: "critical",
      dedup_key: "node:n1:lease_pool_exhausted",
      node_id: "n1",
    });
  });

  it("swallows a duplicate-key error (23505) instead of failing", async () => {
    const db = {
      from: () => ({
        insert: () =>
          Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } }),
      }),
    };
    const result = await raiseAlert(db, {
      kind: "lease_pool_exhausted",
      severity: "critical",
      dedupKey: "node:n1:lease_pool_exhausted",
      message: "x",
      nodeId: "n1",
    });
    expect(result.ok).toBe(true);
  });

  it("returns ok: false for a genuine insert error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      from: () => ({
        insert: () => Promise.resolve({ data: null, error: { code: "42P01", message: "no such table" } }),
      }),
    };
    const result = await raiseAlert(db, {
      kind: "lease_pool_exhausted",
      severity: "critical",
      dedupKey: "node:n1:lease_pool_exhausted",
      message: "x",
    });
    expect(result.ok).toBe(false);
    spy.mockRestore();
  });
});

describe("resolveAlert", () => {
  it("marks a matching open alert resolved", async () => {
    const db = makeFakeSupabase({
      operational_alerts: [
        { dedup_key: "node:n1:lease_pool_exhausted", status: "open" },
      ],
    });
    const result = await resolveAlert(db, "node:n1:lease_pool_exhausted");
    expect(result.ok).toBe(true);
    expect(db._tables.operational_alerts[0].status).toBe("resolved");
    expect(db._tables.operational_alerts[0].resolved_at).toBeTruthy();
  });
});

describe("reconcileAlert", () => {
  afterEach(() => vi.restoreAllMocks());

  it("raises when active is true", async () => {
    const db = makeFakeSupabase({ operational_alerts: [] });
    await reconcileAlert(db, {
      kind: "pending_job_age",
      active: true,
      severity: "warning",
      dedupKey: "queue:pending_job_age",
      message: "Oldest pending job is 45m old",
    });
    expect(db._tables.operational_alerts).toHaveLength(1);
  });

  it("resolves when active is false", async () => {
    const db = makeFakeSupabase({
      operational_alerts: [{ dedup_key: "queue:pending_job_age", status: "open" }],
    });
    await reconcileAlert(db, {
      kind: "pending_job_age",
      active: false,
      severity: "warning",
      dedupKey: "queue:pending_job_age",
      message: "",
    });
    expect(db._tables.operational_alerts[0].status).toBe("resolved");
  });
});

describe("raiseAlert dispatch seam (Phase 15)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not call dispatch when env is omitted (default, unchanged behaviour)", async () => {
    const db = makeFakeSupabase({ operational_alerts: [] });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("fetch must not be called without env");
    });
    const result = await raiseAlert(db, {
      kind: "node_failed",
      severity: "critical",
      dedupKey: "node:n1:node_failed",
      message: "Node n1 is FAILED",
      nodeId: "n1",
    });
    expect(result.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dispatches a critical alert to email when env is passed and configured", async () => {
    const db = makeFakeSupabase({ operational_alerts: [] });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, text: async () => "" });
    const env = { RESEND_API_KEY: "key", ALERT_TO_EMAIL: "ops@example.com" };
    const result = await raiseAlert(db, {
      kind: "node_failed",
      severity: "critical",
      dedupKey: "node:n1:node_failed",
      message: "Node n1 is FAILED",
      nodeId: "n1",
      env,
    });
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://api.resend.com/emails");
  });

  it("does not dispatch non-critical severities even when env is passed", async () => {
    const db = makeFakeSupabase({ operational_alerts: [] });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, text: async () => "" });
    const env = { RESEND_API_KEY: "key", ALERT_TO_EMAIL: "ops@example.com" };
    await raiseAlert(db, {
      kind: "disk_high",
      severity: "warning",
      dedupKey: "node:n1:disk_high",
      message: "Node n1 disk usage is at or above 90%",
      nodeId: "n1",
      env,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a dispatch failure never turns a successful raise into ok: false", async () => {
    const db = makeFakeSupabase({ operational_alerts: [] });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = { RESEND_API_KEY: "key", ALERT_TO_EMAIL: "ops@example.com" };
    const result = await raiseAlert(db, {
      kind: "node_failed",
      severity: "critical",
      dedupKey: "node:n1:node_failed",
      message: "Node n1 is FAILED",
      nodeId: "n1",
      env,
    });
    expect(result.ok).toBe(true);
    expect(db._tables.operational_alerts).toHaveLength(1);
  });
});
