import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXPORT_RE = /export\s+(?:async\s+)?(?:function|const)\s+onRequest(Get|Post|Put|Patch|Delete|Head|Options)?\b/g;

function listSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

function toSegments(relativePath) {
  const segments = relativePath.replace(/\.js$/, "").split(path.sep);
  if (segments.at(-1) === "index") segments.pop();
  return segments;
}

export function discoverRoutes(functionsDir) {
  const routes = [];
  for (const file of listSourceFiles(functionsDir)) {
    const relative = path.relative(functionsDir, file);
    const base = path.basename(file);
    const source = readFileSync(file, "utf8");
    const methods = new Set([...source.matchAll(EXPORT_RE)].map((m) => (m[1] ?? "ANY").toUpperCase()));
    if (base === "_middleware.js") throw new Error(`Pages middleware is not supported by the portable server: ${relative}`);
    if (methods.size === 0) continue;
    if (relative.includes("[[")) throw new Error(`Catch-all routes are not supported by the portable server: ${relative}`);
    routes.push({
      file,
      pattern: toSegments(relative).map((segment) => {
        const param = /^\[(.+)\]$/.exec(segment);
        return param ? { param: param[1] } : { literal: segment };
      }),
      methods,
    });
  }
  return routes.sort((a, b) => specificity(b) - specificity(a));
}

function specificity(route) {
  return route.pattern.reduce((score, part, index) => score + ("literal" in part ? 2 ** (20 - index) : 0), 0);
}

export function matchRoute(routes, pathname) {
  const segments = pathname.split("/").filter(Boolean);
  for (const route of routes) {
    if (route.pattern.length !== segments.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < segments.length; i += 1) {
      const part = route.pattern[i];
      if ("literal" in part) {
        if (part.literal !== segments[i]) { matched = false; break; }
      } else {
        try { params[part.param] = decodeURIComponent(segments[i]); } catch { matched = false; break; }
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

export async function loadHandler(route, method) {
  route.module ??= import(pathToFileURL(route.file).href);
  const mod = await route.module;
  const suffix = method === "HEAD" && !route.methods.has("HEAD") ? "Get" : method[0] + method.slice(1).toLowerCase();
  return mod[`onRequest${suffix}`] ?? mod.onRequest ?? null;
}
