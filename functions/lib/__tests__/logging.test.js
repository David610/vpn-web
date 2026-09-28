import { describe, it, expect, vi, afterEach } from "vitest";
import { redact, logEvent, logger, newRequestId, requestIdFrom } from "../logging.js";

describe("redact", () => {
  it("redacts values under secret-shaped key names", () => {
    const out = redact({ password: "hunter2", user_id: "u_123" });
    expect(out.password).toBe("[redacted]");
    expect(out.user_id).toBe("u_123");
  });

  it("redacts a Stripe secret key even under an innocuous field name", () => {
    const out = redact({ value: "sk_live_abc123def456" });
    expect(out.value).toBe("[redacted]");
  });

  it("redacts a bearer token", () => {
    const out = redact({ header: "Bearer eyJhbGciOiJIUzI1NiJ9.x.y" });
    expect(out.header).toBe("[redacted]");
  });

  it("redacts a JWT-shaped string", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.dGVzdHNpZ25hdHVyZQ";
    const out = redact({ token_like: jwt });
    expect(out.token_like).toBe("[redacted]");
  });

  it("redacts a long hex blob (e.g. a raw secret or lease key)", () => {
    const out = redact({ blob: "a".repeat(48) });
    expect(out.blob).toBe("[redacted]");
  });

  it("leaves short, ordinary values alone", () => {
    const out = redact({ node_id: "n1", status: "ok", count: 3 });
    expect(out).toEqual({ node_id: "n1", status: "ok", count: 3 });
  });

  it("recurses into nested objects and arrays", () => {
    const out = redact({ nested: { password: "x", ok: "fine" }, list: ["sk_live_abcdefgh", "ok"] });
    expect(out.nested.password).toBe("[redacted]");
    expect(out.nested.ok).toBe("fine");
    expect(out.list[0]).toBe("[redacted]");
    expect(out.list[1]).toBe("ok");
  });
});

describe("newRequestId / requestIdFrom", () => {
  it("mints distinct ids", () => {
    expect(newRequestId()).not.toBe(newRequestId());
  });

  it("prefers an inbound cf-ray header", () => {
    const request = { headers: { get: (k) => (k === "cf-ray" ? "abc-ray" : null) } };
    expect(requestIdFrom(request)).toBe("abc-ray");
  });

  it("mints a fresh id when no inbound id is present", () => {
    const request = { headers: { get: () => null } };
    expect(requestIdFrom(request)).toBeTruthy();
  });
});

describe("logEvent / logger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits one JSON line with level, msg, ts and redacted fields", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logEvent("error", "stripe_webhook.handler_failed", { password: "x", event_type: "invoice.paid" });
    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed.level).toBe("error");
    expect(parsed.msg).toBe("stripe_webhook.handler_failed");
    expect(parsed.event_type).toBe("invoice.paid");
    expect(parsed.password).toBe("[redacted]");
    expect(typeof parsed.ts).toBe("string");
  });

  it("logger() binds a request id and static fields onto every call", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = logger("req-1", { fn: "agent/heartbeat" });
    log.warn("node_restart_storm", { node_id: "n1" });
    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed.request_id).toBe("req-1");
    expect(parsed.fn).toBe("agent/heartbeat");
    expect(parsed.node_id).toBe("n1");
  });
});
