import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp, resolveClientIp } from "../app.mjs";
import { discoverRoutes, matchRoute } from "../routes.mjs";

const REAL_FUNCTIONS = path.resolve(import.meta.dirname, "../../functions");

describe("resolveClientIp", () => {
  it("uses the socket address when no proxy is trusted, ignoring spoofed headers", () => {
    expect(resolveClientIp({ remoteAddress: "203.0.113.9", forwardedFor: "1.1.1.1", trustedProxyHops: 0 })).toBe("203.0.113.9");
  });

  it("takes the address the trusted proxy appended, not what the client claimed", () => {
    const forwardedFor = "6.6.6.6, 198.51.100.7";
    expect(resolveClientIp({ remoteAddress: "10.0.0.2", forwardedFor, trustedProxyHops: 1 })).toBe("198.51.100.7");
  });

  it("counts hops from the right when two proxies are trusted", () => {
    const forwardedFor = "6.6.6.6, 198.51.100.7, 10.1.1.1";
    expect(resolveClientIp({ remoteAddress: "10.0.0.2", forwardedFor, trustedProxyHops: 2 })).toBe("198.51.100.7");
  });

  it("falls back to the socket address when the chain is shorter than the trusted hops", () => {
    expect(resolveClientIp({ remoteAddress: "10.0.0.2", forwardedFor: "", trustedProxyHops: 1 })).toBe("10.0.0.2");
  });
});

describe("route discovery on the real functions tree", () => {
  const routes = discoverRoutes(REAL_FUNCTIONS);

  it("finds the routes that Pages would serve", () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it("maps files to Pages-style paths and params", () => {
    expect(matchRoute(routes, "/sub/abc")?.params).toEqual({ token: "abc" });
    expect(matchRoute(routes, "/api/account/links/L1/clients/C1/access-link")?.params).toEqual({ id: "L1", clientId: "C1" });
    expect(matchRoute(routes, "/v1/links")).not.toBeNull();
    expect(matchRoute(routes, "/api/stripe-webhook")).not.toBeNull();
  });

  it("prefers a literal segment over a parameter at the same depth", () => {
    const usage = matchRoute(routes, "/api/account/links/usage");
    expect(usage?.params).toEqual({});
    expect(matchRoute(routes, "/api/account/links/some-id")?.params).toEqual({ id: "some-id" });
  });

  it("does not expose library modules", () => {
    expect(matchRoute(routes, "/lib/crypto")).toBeNull();
  });
});

describe("app", () => {
  let dir;
  let app;
  const seen = [];

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "arcana-server-"));
    mkdirSync(path.join(dir, "api", "things", "[id]"), { recursive: true });
    mkdirSync(path.join(dir, "lib"), { recursive: true });
    writeFileSync(path.join(dir, "api", "things", "index.js"),
      "export async function onRequestGet({request,env}){return Response.json({ip:request.headers.get('cf-connecting-ip'),xff:request.headers.get('x-forwarded-for'),url:request.url,marker:env.MARKER})}\n" +
      "export async function onRequestPost({request}){return Response.json({body:await request.text()},{status:201})}\n");
    writeFileSync(path.join(dir, "api", "things", "[id]", "index.js"),
      "export const onRequestGet=({params})=>Response.json({id:params.id});\n");
    writeFileSync(path.join(dir, "api", "boom.js"), "export async function onRequestGet(){throw new Error('secret detail')}\n");
    writeFileSync(path.join(dir, "lib", "helper.js"), "export const helper=1;\n");
    app = createApp({
      functionsDir: dir,
      env: { MARKER: "env-ok" },
      publicOrigin: "https://api.example.test",
      corsOrigins: ["https://site.example.test"],
      trustedProxyHops: 1,
      log: (entry) => seen.push(entry),
    });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const call = (overrides) => app.handle({
    method: "GET", path: "/", search: "", headers: new Headers(), body: undefined,
    remoteAddress: "10.0.0.2", host: "ignored", ...overrides,
  });

  it("passes env and a trusted public origin to the handler", async () => {
    const res = await call({ path: "/api/things", search: "?a=1" });
    const data = await res.json();
    expect(data.marker).toBe("env-ok");
    expect(data.url).toBe("https://api.example.test/api/things?a=1");
  });

  it("replaces client-supplied CF-Connecting-IP and X-Forwarded-For", async () => {
    const headers = new Headers({ "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": "8.8.8.8, 198.51.100.7" });
    const data = await (await call({ path: "/api/things", headers })).json();
    expect(data.ip).toBe("198.51.100.7");
    expect(data.xff).toBeNull();
  });

  it("decodes route params and ignores trailing slashes", async () => {
    const data = await (await call({ path: "/api/things/a%20b/" })).json();
    expect(data.id).toBe("a b");
  });

  it("forwards the request body", async () => {
    const res = await call({ method: "POST", path: "/api/things", body: Buffer.from("payload") });
    expect(res.status).toBe(201);
    expect((await res.json()).body).toBe("payload");
  });

  it("answers 405 with Allow for unsupported methods and 404 for unknown paths", async () => {
    const wrong = await call({ method: "DELETE", path: "/api/things" });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET, POST");
    expect((await call({ path: "/api/missing" })).status).toBe(404);
    expect((await call({ path: "/lib/helper" })).status).toBe(404);
  });

  it("serves HEAD from the GET handler without a body", async () => {
    const res = await call({ method: "HEAD", path: "/api/things" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("hides handler errors from the client but records the route", async () => {
    const res = await call({ path: "/api/boom" });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret detail");
    expect(seen.at(-1)).toEqual({ level: "error", route: "/api/boom", error: "Error" });
  });

  it("reports health without touching a handler", async () => {
    expect(await (await call({ path: "/healthz" })).json()).toEqual({ ok: true });
  });

  describe("CORS", () => {
    it("allows only listed origins on /api", async () => {
      const allowed = await call({ path: "/api/things", headers: new Headers({ origin: "https://site.example.test" }) });
      expect(allowed.headers.get("access-control-allow-origin")).toBe("https://site.example.test");
      const denied = await call({ path: "/api/things", headers: new Headers({ origin: "https://evil.example.test" }) });
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("answers preflight for listed origins and rejects others", async () => {
      const ok = await call({ method: "OPTIONS", path: "/api/things", headers: new Headers({ origin: "https://site.example.test" }) });
      expect(ok.status).toBe(204);
      expect(ok.headers.get("access-control-allow-headers")).toContain("X-Telegram-Init-Data");
      const no = await call({ method: "OPTIONS", path: "/api/things", headers: new Headers({ origin: "https://evil.example.test" }) });
      expect(no.status).toBe(403);
    });
  });
});
