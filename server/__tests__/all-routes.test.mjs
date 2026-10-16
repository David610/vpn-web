import { describe, expect, it } from "vitest";
import path from "node:path";
import { createApp } from "../app.mjs";
import { discoverRoutes, loadHandler } from "../routes.mjs";

const FUNCTIONS = path.resolve(import.meta.dirname, "../../functions");
const env = {
  SUPABASE_URL: "http://127.0.0.1:9", // nothing listens: any DB call must fail closed, not crash the process
  SUPABASE_SERVICE_ROLE_KEY: "service",
  SUPABASE_ANON_KEY: "anon",
  SUBSCRIPTION_TOKEN_HASH_KEY: "x".repeat(40),
  VPN_SECRETS_ENCRYPTION_KEY: "00".repeat(32),
  SITE_URL: "https://example.test",
  TELEGRAM_BOT_TOKEN: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
};

describe("every Pages Function runs on the Node adapter", () => {
  const routes = discoverRoutes(FUNCTIONS);

  it("imports every route module without Cloudflare-only globals", async () => {
    const failures = [];
    for (const route of routes) {
      for (const method of route.methods) {
        try {
          const handler = await loadHandler(route, method === "ANY" ? "GET" : method);
          if (typeof handler !== "function") failures.push(`${route.file}: no handler for ${method}`);
        } catch (error) {
          failures.push(`${route.file}: ${error.message}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);

  it("fails closed (never 2xx, never an unhandled crash) for anonymous calls to every non-public route", async () => {
    const app = createApp({ functionsDir: FUNCTIONS, env, publicOrigin: "https://api.example.test", log: () => {} });
    const publicPrefixes = ["/sub/", "/api/stripe", "/healthz", "/v1/auth", "/api/auth", "/api/public", "/api/contact", "/api/version", "/api/account/password-reset"];
    const surprising = [];
    for (const route of routes) {
      const template = `/${route.pattern.map((p) => ("param" in p ? "x" : p.literal)).join("/")}`;
      if (publicPrefixes.some((prefix) => template.startsWith(prefix))) continue;
      for (const method of route.methods) {
        const m = method === "ANY" ? "GET" : method;
        const res = await app.handle({
          method: m, path: template, search: "", headers: new Headers({ "content-type": "application/json" }),
          body: m === "GET" || m === "HEAD" ? undefined : Buffer.from("{}"), remoteAddress: "203.0.113.5", host: "h",
        });
        if (res.status >= 200 && res.status < 300 && !template.startsWith("/api/agent/")) surprising.push(`${m} ${template} -> ${res.status}`);
      }
    }
    expect(surprising).toEqual([]);
  }, 120_000);
});
