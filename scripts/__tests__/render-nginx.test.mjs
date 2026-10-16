import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { headersFor, parseHeaders, parseRedirects, renderNginx } from "../vps/render-nginx.mjs";

const real = readFileSync(path.resolve(import.meta.dirname, "../../public/_headers"), "utf8").replace(/__CSP_NONCE__/g, "NONCE123");
const redirects = readFileSync(path.resolve(import.meta.dirname, "../../public/_redirects"), "utf8");
const rules = parseHeaders(real);
const value = (list, name) => list.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];

describe("Pages _headers semantics", () => {
  it("applies the default set to ordinary pages", () => {
    const h = headersFor(rules, "/account/");
    expect(value(h, "X-Frame-Options")).toBe("DENY");
    expect(value(h, "Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(value(h, "Content-Security-Policy")).toContain("'nonce-NONCE123'");
  });

  it("lets the Telegram Mini App be framed by Telegram only, and drops X-Frame-Options there", () => {
    const h = headersFor(rules, "/telegram/x");
    expect(value(h, "X-Frame-Options")).toBeUndefined();
    expect(value(h, "Content-Security-Policy")).toContain("frame-ancestors 'self' https://web.telegram.org");
    expect(value(h, "Content-Security-Policy")).toContain("https://telegram.org");
    expect(headersFor(rules, "/account/").length).toBeGreaterThan(5);
  });

  it("keeps the default frame-deny CSP for the admin area", () => {
    const h = headersFor(rules, "/admin/x");
    expect(value(h, "Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });
});

describe("rendered Nginx config", () => {
  const conf = renderNginx({ domain: "app.example.test", root: "/opt/arcana/current/site", tlsDir: "/etc/letsencrypt/live/app.example.test", headersText: real, redirectsText: redirects });

  it("serves static files with try_files and ships the site's real CSP including the build nonce", () => {
    expect(conf).toContain("try_files $uri $uri.html $uri/index.html =404;");
    expect(conf).toContain("'nonce-NONCE123'");
    expect(conf).toContain("Strict-Transport-Security");
  });

  it("proxies the dynamic API paths to the Node server on the same origin", () => {
    for (const p of ["/api/", "/v1/", "/sub/", "/api/agent/"]) expect(conf).toContain(`location ${p} {`);
    expect(conf).toContain("proxy_pass http://arcana_api;");
    expect(conf).not.toMatch(/access-control-allow-origin/i);
  });

  it("never lets API responses be cached and never buffers long polls", () => {
    expect(conf.match(/Cache-Control "no-store"/g).length).toBeGreaterThanOrEqual(4);
    expect(conf).toContain("proxy_buffering off;");
  });

  it("carries over every redirect", () => {
    for (const r of parseRedirects(redirects)) expect(conf).toContain(`location = ${r.from} { return ${r.status} ${r.to}; }`);
  });

  it("redirects HTTP to HTTPS but still answers ACME challenges", () => {
    expect(conf).toContain("location /.well-known/acme-challenge/");
    expect(conf).toContain("return 301 https://$host$request_uri;");
  });

  it("rate limits public and token endpoints per client address", () => {
    expect(conf).toContain("limit_req zone=arcana_auth");
    expect(conf).toContain("limit_req zone=arcana_public");
  });

  it("rejects a hostile domain argument", () => {
    expect(() => renderNginx({ domain: "x; } server { listen 1;", root: "/r", tlsDir: "/t", headersText: real, redirectsText: "" })).toThrow(/invalid domain/);
  });

  it("uses a Telegram-specific CSP only on /telegram", () => {
    const telegramBlock = conf.slice(conf.indexOf("location = /telegram"));
    expect(telegramBlock).toContain("https://web.telegram.org");
    const adminBlock = conf.slice(conf.indexOf("location = /admin"), conf.indexOf("location /admin/ {"));
    expect(adminBlock).not.toContain("web.telegram.org");
  });
});
