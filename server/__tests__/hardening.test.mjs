import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../app.mjs";

let dir;
const logs = [];
let release;
const gate = new Promise((r) => { release = r; });

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "arcana-hardening-"));
  mkdirSync(path.join(dir, "api", "agent", "jobs", "[id]"), { recursive: true });
  mkdirSync(path.join(dir, "api", "account"), { recursive: true });
  writeFileSync(path.join(dir, "api", "agent", "ping.js"), "export const onRequestGet=()=>Response.json({pong:true});\n");
  writeFileSync(path.join(dir, "api", "agent", "slow.js"), "export const onRequestGet=async({env})=>{await env.GATE;return Response.json({slow:true})};\n");
  writeFileSync(path.join(dir, "api", "agent", "jobs", "[id]", "complete.js"), "export const onRequestPost=({params})=>Response.json({id:params.id});\n");
  writeFileSync(path.join(dir, "api", "account", "me.js"), "export const onRequestGet=()=>Response.json({me:true});\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const make = (opts = {}) => createApp({
  functionsDir: dir, env: { GATE: gate }, publicOrigin: "https://api.example.test",
  log: (e) => logs.push(e), ...opts,
});
const call = (app, overrides) => app.handle({
  method: "GET", path: "/", search: "", headers: new Headers(), body: undefined, remoteAddress: "10.0.0.2", host: "h", ...overrides,
});

describe("route allowlist", () => {
  it("mounts only the allowed prefixes so the agent host exposes no other function", async () => {
    const app = make({ routePrefixes: ["/api/agent"] });
    expect(app.routeCount).toBe(3);
    expect((await call(app, { path: "/api/agent/ping" })).status).toBe(200);
    expect((await call(app, { path: "/api/account/me" })).status).toBe(404);
  });

  it("mounts everything when no allowlist is configured", async () => {
    const app = make();
    expect((await call(app, { path: "/api/account/me" })).status).toBe(200);
  });
});

describe("in-flight cap", () => {
  it("sheds load with 503 + Retry-After instead of queueing without bound, then recovers", async () => {
    const app = make({ maxInFlight: 2 });
    const a = call(app, { path: "/api/agent/slow" });
    const b = call(app, { path: "/api/agent/slow" });
    const shed = await call(app, { path: "/api/agent/ping" });
    expect(shed.status).toBe(503);
    expect(Number(shed.headers.get("retry-after"))).toBeGreaterThan(0);
    release();
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    expect((await call(app, { path: "/api/agent/ping" })).status).toBe(200);
  });

  it("never sheds the health check", async () => {
    const app = make({ maxInFlight: 0 });
    expect((await call(app, { path: "/healthz" })).status).toBe(200);
  });
});

describe("metrics and access log", () => {
  it("is invisible unless a metrics token is configured", async () => {
    expect((await call(make(), { path: "/metrics" })).status).toBe(404);
  });

  it("requires the bearer token", async () => {
    const app = make({ metricsToken: "m-secret" });
    expect((await call(app, { path: "/metrics" })).status).toBe(401);
    expect((await call(app, { path: "/metrics", headers: new Headers({ authorization: "Bearer wrong" }) })).status).toBe(401);
    expect((await call(app, { path: "/metrics", headers: new Headers({ authorization: "Bearer m-secret" }) })).status).toBe(200);
  });

  it("aggregates by route TEMPLATE, never by raw path (no ids or tokens in labels)", async () => {
    const app = make({ metricsToken: "m" });
    await call(app, { method: "POST", path: "/api/agent/jobs/123/complete", body: Buffer.from("{}") });
    await call(app, { method: "POST", path: "/api/agent/jobs/456/complete", body: Buffer.from("{}") });
    await call(app, { path: "/api/agent/ping" });
    const metrics = await (await call(app, { path: "/metrics", headers: new Headers({ authorization: "Bearer m" }) })).json();
    const keys = Object.keys(metrics.requests);
    expect(keys).toContain("POST /api/agent/jobs/:id/complete 2xx");
    expect(metrics.requests["POST /api/agent/jobs/:id/complete 2xx"]).toBe(2);
    expect(JSON.stringify(metrics)).not.toMatch(/123|456/);
    expect(metrics).toHaveProperty("inFlight");
    expect(metrics.latencyMs["GET /api/agent/ping"]).toMatchObject({ count: 1 });
  });

  it("logs template, status and duration but never the query string or raw ids", async () => {
    logs.length = 0;
    const app = make();
    await call(app, { method: "POST", path: "/api/agent/jobs/secret-id-1/complete", search: "?token=abc", body: Buffer.from("{}") });
    const entry = logs.find((e) => e.msg === "request");
    expect(entry).toMatchObject({ route: "/api/agent/jobs/:id/complete", method: "POST", status: 200 });
    expect(typeof entry.ms).toBe("number");
    expect(JSON.stringify(logs)).not.toMatch(/secret-id-1|token=abc/);
  });

  it("keeps long-poll waits out of the latency histogram", async () => {
    const app = make({ metricsToken: "m", longPollRoutes: ["/api/agent/ping"] });
    await call(app, { path: "/api/agent/ping" });
    const metrics = await (await call(app, { path: "/metrics", headers: new Headers({ authorization: "Bearer m" }) })).json();
    expect(metrics.latencyMs["GET /api/agent/ping"]).toBeUndefined();
    expect(metrics.requests["GET /api/agent/ping 2xx"]).toBe(1);
  });
});
