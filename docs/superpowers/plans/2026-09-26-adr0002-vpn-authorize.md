# ADR-0002 Sub-project B: POST /v1/vpn/authorize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `POST /v1/vpn/authorize`, resolving a `route_id` from `GET /v1/routes` into short-lived, pseudonymous, per-hop VPN credentials by reusing each device's existing `vpn_accounts` identity on the scheduler-selected node(s).

**Architecture:** Parse `route_id` deterministically back into location(s), delegate node selection entirely to `scheduler.js`'s already-tested `scheduleNodeForDevice`/`scheduleDoubleHopForDevice`, then look up (or lazily enqueue creation of) each hop's `vpn_accounts` identity. A pure-ish orchestration module (`vpn-authorize.js`, injected `supabaseAdmin`, same style as `device-provisioning.js`) is wired into a thin `/v1` route handler.

**Tech Stack:** Cloudflare Pages Functions, Supabase (via `supabaseAdmin` client), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-26-adr0002-vpn-authorize-design.md`

## Global Constraints

- vpn-web-only this pass — no `singbox-vpn` change (per spec's Decision section).
- No new migration — every table used already exists with needed columns/constraints.
- `authorize` must never grant a route `scheduleNodeForDevice`/`scheduleDoubleHopForDevice` would not otherwise allow (reuse them as-is; do not re-derive eligibility).
- `authorize` must never return a partial `credential_envelope` (some hops real, some missing) — a missing identity on any hop fails the whole request with 503, after enqueueing `CREATE_USER` for every missing hop.
- `credential_envelope` must never contain account email, account id, billing/payment id, or subscription id — only `vpn_accounts.vpn_user_id` per hop.
- Route ids are 2-letter lowercase country codes per Sub-project A (`` `${cc}-fast` ``, `` `${entryCc}-${exitCc}-privacy` ``); `locations.country_code` is stored uppercase (seed data: `'XX'`).
- `AUTHORIZE_TTL_MS = 15 * 60 * 1000` (15 minutes), matching the contract doc's example `expires_at`.
- HTTP status convention (from `functions/lib/v1-http.js`'s own header comment): 401/403 = session invalid (client signs out); a missing/not-entitled item = 409 with a `code`, never 404; temporary unavailability = 503. Never use 403 for "not entitled" — that is a billing state, not a session-validity one.

## Review Focus

- A `route_id` whose two location halves are identical (`"de-de-privacy"`) with an enabled `allowed_paths` row where `entry_location_id = exit_location_id` — must resolve normally, not be special-cased into a failure.
- A syntactically valid `fast` route id whose location exists but has `enabled = false` — must be 409 `route_not_found`, not 500 or a silent node lookup against a disabled location.
- Two concurrent `authorize` calls for the same device+node racing to enqueue the same `CREATE_USER` job — the second must see `23505` and still return a clean 503, never a raw DB error surfaced to the client.
- A device whose entitlement has `clearExpiry: false` and `serviceExpiresAt: null` (an invariant violation `reconcileDeviceProvisioning` already guards against) — `authorizeRoute` must let the resulting throw propagate to `withV1User`'s catch-all (503, logged), not swallow it into a misleading response.
- A `privacy_plus` route where only one hop (relay or exit) has an existing identity — the response must still enqueue `CREATE_USER` for the missing hop specifically (not the wrong one, not both) and return a single clean 503, never a `credential_envelope` with one real hop and one empty/undefined entry.

---

## Task 1: Extract `buildCreateUserPayload` from `device-provisioning.js`

**Files:**
- Modify: `functions/lib/device-provisioning.js:225-238` (the `CREATE_USER` payload-building block inside `reconcileDeviceProvisioning`)
- Test: `functions/lib/__tests__/device-provisioning.test.js`

**Interfaces:**
- Produces: `export function buildCreateUserPayload(device, entitlement)` — `device` is `{ id, user_id, ... }`, `entitlement` is `{ clearExpiry: boolean, serviceExpiresAt: string|null }`. Returns `{ user_id, device_id, expires_at? }`. Throws `Error("finite entitlement is missing serviceExpiresAt")` when `entitlement.clearExpiry` is `false` and `entitlement.serviceExpiresAt` is falsy. Task 2 imports this from `functions/lib/vpn-authorize.js`.

- [ ] **Step 1: Write the failing test**

Add to `functions/lib/__tests__/device-provisioning.test.js` (new top-level `describe`, after the existing imports — add `buildCreateUserPayload` to the existing `import { reconcileDeviceProvisioning, reconcileAccountProvisioning, revokeDevice } from "../device-provisioning.js";` line, making it:
```js
import {
  reconcileDeviceProvisioning,
  reconcileAccountProvisioning,
  revokeDevice,
  buildCreateUserPayload,
} from "../device-provisioning.js";
```
Then add this `describe` block anywhere at the top level of the file (e.g. right after the `directPath` helper, before the first existing `describe`):
```js
describe("buildCreateUserPayload", () => {
  const device = { id: "dev-1", user_id: "user-1" };

  it("omits expires_at for a clearExpiry entitlement", () => {
    const payload = buildCreateUserPayload(device, { clearExpiry: true, serviceExpiresAt: null });
    expect(payload).toEqual({ user_id: "user-1", device_id: "dev-1" });
  });

  it("includes expires_at for a finite entitlement", () => {
    const payload = buildCreateUserPayload(device, {
      clearExpiry: false,
      serviceExpiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(payload).toEqual({
      user_id: "user-1",
      device_id: "dev-1",
      expires_at: "2030-01-01T00:00:00.000Z",
    });
  });

  it("throws when a finite entitlement has no serviceExpiresAt", () => {
    expect(() => buildCreateUserPayload(device, { clearExpiry: false, serviceExpiresAt: null })).toThrow(
      "finite entitlement is missing serviceExpiresAt"
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- device-provisioning`
Expected: FAIL — `buildCreateUserPayload is not a function` (or a named-export import error), because `device-provisioning.js` does not export it yet.

- [ ] **Step 3: Extract the function and use it at the call site**

In `functions/lib/device-provisioning.js`, add this exported function above `reconcileDeviceProvisioning` (e.g. directly above its JSDoc block):
```js
/**
 * The CREATE_USER job payload for a device's identity on a node — pulled
 * out so vpn-authorize.js can enqueue an identical job when authorize-time
 * credential resolution finds no existing identity, without re-deriving
 * the clearExpiry/serviceExpiresAt branching here.
 */
export function buildCreateUserPayload(device, entitlement) {
  const payload = { user_id: device.user_id, device_id: device.id };
  if (!entitlement.clearExpiry) {
    if (!entitlement.serviceExpiresAt) throw new Error("finite entitlement is missing serviceExpiresAt");
    payload.expires_at = entitlement.serviceExpiresAt;
  }
  return payload;
}
```
Then replace the inline block inside `reconcileDeviceProvisioning` (currently):
```js
  if (!current) {
    const payload = { user_id: device.user_id, device_id: device.id };
    if (!entitlement.clearExpiry) {
      if (!entitlement.serviceExpiresAt) throw new Error("finite entitlement is missing serviceExpiresAt");
      payload.expires_at = entitlement.serviceExpiresAt;
    }
    await insertJob(supabaseAdmin, {
```
with:
```js
  if (!current) {
    const payload = buildCreateUserPayload(device, entitlement);
    await insertJob(supabaseAdmin, {
```
(the rest of that `insertJob` call — `idempotency_key`, `node_id`, `job_type`, `vpn_account_id`, `device_id`, `payload` — is unchanged).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- device-provisioning`
Expected: PASS — all tests in the file, including the 3 new ones and every pre-existing `reconcileDeviceProvisioning`/`reconcileAccountProvisioning`/`revokeDevice` test (the extraction is behavior-preserving).

- [ ] **Step 5: Commit**

```bash
git add functions/lib/device-provisioning.js functions/lib/__tests__/device-provisioning.test.js
git commit -m "refactor(fleet): extract buildCreateUserPayload for reuse by authorize"
```

---

## Task 2: `functions/lib/vpn-authorize.js` — route resolution and credential issuance

**Files:**
- Create: `functions/lib/vpn-authorize.js`
- Test: `functions/lib/__tests__/vpn-authorize.test.js`

**Interfaces:**
- Consumes: `scheduleNodeForDevice(supabaseAdmin, { deviceId, exitLocationId })` and `scheduleDoubleHopForDevice(supabaseAdmin, { deviceId, entryLocationId, exitLocationId })` from `functions/lib/scheduler.js` (both return `null` on failure — a plain node id string for the first, `{ relayNodeId, exitNodeId }` for the second). `buildCreateUserPayload(device, entitlement)` from `functions/lib/device-provisioning.js` (Task 1).
- Produces: `export const AUTHORIZE_TTL_MS = 15 * 60 * 1000;` and `export async function authorizeRoute(supabaseAdmin, env, { device, entitlement, routeId })`, returning either `{ ok: true, routeId, expiresAt, credentialEnvelope: { version: 1, hops: [{ uuid }, ...] } }` or `{ ok: false, status: 400|409|503, message, code? }`. `device` is `{ id, user_id, account_id }`. `env` is accepted for interface symmetry with other `lib/*.js` DB-facing functions but unused by this module's own logic. Task 3 (`functions/v1/vpn/authorize.js`) calls this directly.

- [ ] **Step 1: Write the failing tests**

Create `functions/lib/__tests__/vpn-authorize.test.js`:
```js
import { describe, it, expect } from "vitest";
import { makeFakeSupabase } from "./fake-supabase.js";
import { authorizeRoute, AUTHORIZE_TTL_MS } from "../vpn-authorize.js";

const DEVICE = { id: "dev-1", user_id: "user-1", account_id: "acct-1" };
const PAID = { source: "stripe", serviceExpiresAt: "2030-01-01T00:00:00.000Z", clearExpiry: false };

const DE = "loc-de";
const FI = "loc-fi";

function node(node_id, location_id, role, extra = {}) {
  return { node_id, location_id, role, lifecycle_state: "READY", configured_users: 0, max_sessions: null, ...extra };
}

function world({ locations = [], nodes = [], paths = [], identities = [] } = {}) {
  return makeFakeSupabase({
    locations,
    nodes,
    allowed_paths: paths,
    vpn_accounts: identities.map((i, n) => ({ id: n + 1, device_id: DEVICE.id, enabled: true, ...i })),
  });
}

const jobs = (db) => db._tables.provisioning_jobs;
const directPath = (loc) => ({ id: `p-${loc}`, entry_location_id: null, exit_location_id: loc, enabled: true });
const doublePath = (entry, exit) => ({ id: `p-${entry}-${exit}`, entry_location_id: entry, exit_location_id: exit, enabled: true });

describe("authorizeRoute: route_id validation", () => {
  it("rejects an empty route_id", async () => {
    const db = world();
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "" });
    expect(result).toEqual({ ok: false, status: 400, message: expect.any(String) });
  });

  it("rejects a route_id over 160 characters", async () => {
    const db = world();
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "a".repeat(161) });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it("rejects an unrecognized route_id format", async () => {
    const db = world();
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "not-a-real-route" });
    expect(result).toEqual({ ok: false, status: 400, message: expect.any(String) });
  });
});

describe("authorizeRoute: fast routes", () => {
  it("returns 409 route_not_found when the location does not exist or is disabled", async () => {
    const db = world({ locations: [{ id: DE, country_code: "DE", enabled: false }] });
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "de-fast" });
    expect(result).toEqual({ ok: false, status: 409, message: expect.any(String), code: "route_not_found" });
  });

  it("returns 503 when no direct allowed_paths row exists for the location", async () => {
    const db = world({
      locations: [{ id: DE, country_code: "DE", enabled: true }],
      nodes: [node("node-de-1", DE, "EXIT")],
    });
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "de-fast" });
    expect(result).toEqual({ ok: false, status: 503, message: expect.any(String) });
  });

  it("returns a single-hop credential envelope when the identity already exists", async () => {
    const db = world({
      locations: [{ id: DE, country_code: "DE", enabled: true }],
      nodes: [node("node-de-1", DE, "EXIT")],
      paths: [directPath(DE)],
      identities: [{ node_id: "node-de-1", vpn_user_id: "uuid-de-1" }],
    });
    const before = Date.now();
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "de-fast" });
    expect(result.ok).toBe(true);
    expect(result.routeId).toBe("de-fast");
    expect(result.credentialEnvelope).toEqual({ version: 1, hops: [{ uuid: "uuid-de-1" }] });
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThanOrEqual(before + AUTHORIZE_TTL_MS);
    expect(jobs(db)).toHaveLength(0);
  });

  it("enqueues CREATE_USER and returns 503 when no identity exists yet", async () => {
    const db = world({
      locations: [{ id: DE, country_code: "DE", enabled: true }],
      nodes: [node("node-de-1", DE, "EXIT")],
      paths: [directPath(DE)],
    });
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "de-fast" });
    expect(result).toEqual({ ok: false, status: 503, message: expect.any(String) });
    expect(jobs(db)).toHaveLength(1);
    expect(jobs(db)[0]).toMatchObject({
      job_type: "CREATE_USER",
      node_id: "node-de-1",
      device_id: "dev-1",
      idempotency_key: "authorize:create:dev-1:node-de-1",
      payload: { user_id: "user-1", device_id: "dev-1", expires_at: "2030-01-01T00:00:00.000Z" },
    });
  });

  it("does not error when a CREATE_USER job is already in flight, and still returns 503", async () => {
    const db = world({
      locations: [{ id: DE, country_code: "DE", enabled: true }],
      nodes: [node("node-de-1", DE, "EXIT")],
      paths: [directPath(DE)],
    });
    await db.from("provisioning_jobs").insert({
      idempotency_key: "reconcile:create:dev-1:node-de-1",
      node_id: "node-de-1",
      job_type: "CREATE_USER",
      device_id: "dev-1",
      status: "pending",
      payload: {},
    });
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "de-fast" });
    expect(result).toEqual({ ok: false, status: 503, message: expect.any(String) });
    expect(jobs(db)).toHaveLength(1);
  });
});

describe("authorizeRoute: privacy_plus routes", () => {
  it("returns a two-hop envelope, relay first, when both identities exist", async () => {
    const db = world({
      locations: [
        { id: FI, country_code: "FI", enabled: true },
        { id: DE, country_code: "DE", enabled: true },
      ],
      nodes: [node("node-fi-1", FI, "RELAY"), node("node-de-1", DE, "EXIT")],
      paths: [doublePath(FI, DE)],
      identities: [
        { node_id: "node-fi-1", vpn_user_id: "uuid-fi-1" },
        { node_id: "node-de-1", vpn_user_id: "uuid-de-1" },
      ],
    });
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "fi-de-privacy" });
    expect(result.ok).toBe(true);
    expect(result.credentialEnvelope).toEqual({
      version: 1,
      hops: [{ uuid: "uuid-fi-1" }, { uuid: "uuid-de-1" }],
    });
  });

  it("enqueues CREATE_USER only for the missing hop when one identity exists", async () => {
    const db = world({
      locations: [
        { id: FI, country_code: "FI", enabled: true },
        { id: DE, country_code: "DE", enabled: true },
      ],
      nodes: [node("node-fi-1", FI, "RELAY"), node("node-de-1", DE, "EXIT")],
      paths: [doublePath(FI, DE)],
      identities: [{ node_id: "node-fi-1", vpn_user_id: "uuid-fi-1" }],
    });
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "fi-de-privacy" });
    expect(result).toEqual({ ok: false, status: 503, message: expect.any(String) });
    expect(jobs(db)).toHaveLength(1);
    expect(jobs(db)[0].node_id).toBe("node-de-1");
  });

  it("enqueues CREATE_USER for both hops when neither identity exists", async () => {
    const db = world({
      locations: [
        { id: FI, country_code: "FI", enabled: true },
        { id: DE, country_code: "DE", enabled: true },
      ],
      nodes: [node("node-fi-1", FI, "RELAY"), node("node-de-1", DE, "EXIT")],
      paths: [doublePath(FI, DE)],
    });
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "fi-de-privacy" });
    expect(result).toEqual({ ok: false, status: 503, message: expect.any(String) });
    expect(jobs(db).map((j) => j.node_id).sort()).toEqual(["node-de-1", "node-fi-1"]);
  });

  it("resolves normally when entry and exit locations are the same", async () => {
    const db = world({
      locations: [{ id: DE, country_code: "DE", enabled: true }],
      nodes: [node("node-de-relay", DE, "RELAY"), node("node-de-exit", DE, "EXIT")],
      paths: [doublePath(DE, DE)],
      identities: [
        { node_id: "node-de-relay", vpn_user_id: "uuid-relay" },
        { node_id: "node-de-exit", vpn_user_id: "uuid-exit" },
      ],
    });
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "de-de-privacy" });
    expect(result.ok).toBe(true);
    expect(result.credentialEnvelope.hops).toEqual([{ uuid: "uuid-relay" }, { uuid: "uuid-exit" }]);
  });

  it("propagates the finite-entitlement-missing-expiry error rather than returning 503", async () => {
    const db = world({
      locations: [{ id: DE, country_code: "DE", enabled: true }],
      nodes: [node("node-de-1", DE, "EXIT")],
      paths: [directPath(DE)],
    });
    const brokenEntitlement = { clearExpiry: false, serviceExpiresAt: null };
    await expect(
      authorizeRoute(db, {}, { device: DEVICE, entitlement: brokenEntitlement, routeId: "de-fast" })
    ).rejects.toThrow("finite entitlement is missing serviceExpiresAt");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- vpn-authorize`
Expected: FAIL — cannot find module `../vpn-authorize.js` (the file does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `functions/lib/vpn-authorize.js`:
```js
import { scheduleNodeForDevice, scheduleDoubleHopForDevice } from "./scheduler.js";
import { buildCreateUserPayload } from "./device-provisioning.js";

/**
 * POST /v1/vpn/authorize's credential-resolution core (see
 * docs/superpowers/specs/2026-09-26-adr0002-vpn-authorize-design.md).
 *
 * Route ids are Sub-project A's deterministic, unstored ids
 * (`${cc}-fast` / `${entryCc}-${exitCc}-privacy`, 2-letter lowercase
 * country codes) -- there is no `routes` table row to join against, so
 * this parses the id back into location(s) and re-runs the same
 * scheduler placement GET /v1/routes' rendering already trusts.
 *
 * expires_at is a short, advisory TTL on the *response*, matching the
 * tamara-next contract's example -- it does not mean the underlying
 * vpn_accounts credential itself rotates that fast. Real per-connection
 * rotation needs singbox-vpn changes (Sub-project B2, not this pass).
 */
export const AUTHORIZE_TTL_MS = 15 * 60 * 1000;

const FAST_RE = /^([a-z]{2})-fast$/;
const PRIVACY_RE = /^([a-z]{2})-([a-z]{2})-privacy$/;

const badRequest = (message) => ({ ok: false, status: 400, message });
const notFound = (message) => ({ ok: false, status: 409, message, code: "route_not_found" });
const unavailable = (message) => ({ ok: false, status: 503, message });

async function findEnabledLocationId(supabaseAdmin, countryCode) {
  const { data, error } = await supabaseAdmin
    .from("locations")
    .select("id")
    .eq("country_code", countryCode.toUpperCase())
    .eq("enabled", true)
    .maybeSingle();
  if (error) throw new Error(`locations lookup failed: ${error.message}`);
  return data?.id ?? null;
}

/**
 * Resolves each hop's credential from its existing vpn_accounts identity,
 * enqueueing CREATE_USER for any hop that has none yet. Never returns a
 * partial envelope: if any hop is missing, every missing hop still gets
 * its job enqueued before this returns 503, so a retry a few seconds
 * later has strictly better odds across every hop, not just the first.
 */
async function resolveCredentials(supabaseAdmin, device, entitlement, routeId, nodeIds) {
  const hops = [];
  let missing = false;

  for (const nodeId of nodeIds) {
    const { data, error } = await supabaseAdmin
      .from("vpn_accounts")
      .select("vpn_user_id")
      .eq("device_id", device.id)
      .eq("node_id", nodeId)
      .eq("enabled", true)
      .maybeSingle();
    if (error) throw new Error(`vpn_accounts lookup failed: ${error.message}`);

    if (data) {
      hops.push({ uuid: data.vpn_user_id });
      continue;
    }

    missing = true;
    const { error: insertError } = await supabaseAdmin.from("provisioning_jobs").insert({
      idempotency_key: `authorize:create:${device.id}:${nodeId}`,
      node_id: nodeId,
      job_type: "CREATE_USER",
      vpn_account_id: null,
      device_id: device.id,
      payload: buildCreateUserPayload(device, entitlement),
    });
    // 23505: reconcileDeviceProvisioning (or a previous authorize call)
    // already has one in flight for this (device, node) -- already the
    // established "already enqueued" signal (device-provisioning.js's
    // insertJob).
    if (insertError && insertError.code !== "23505") {
      throw new Error(`provisioning_jobs insert failed: ${insertError.message}`);
    }
  }

  if (missing) return unavailable("Your credentials are being provisioned. Try again shortly.");
  return {
    ok: true,
    routeId,
    expiresAt: new Date(Date.now() + AUTHORIZE_TTL_MS).toISOString(),
    credentialEnvelope: { version: 1, hops },
  };
}

export async function authorizeRoute(supabaseAdmin, env, { device, entitlement, routeId }) {
  const id = typeof routeId === "string" ? routeId.trim() : "";
  if (!id || id.length > 160) return badRequest("route_id is required.");

  const fastMatch = FAST_RE.exec(id);
  const privacyMatch = fastMatch ? null : PRIVACY_RE.exec(id);
  if (!fastMatch && !privacyMatch) return badRequest("route_id has an unrecognized format.");

  if (fastMatch) {
    const exitLocationId = await findEnabledLocationId(supabaseAdmin, fastMatch[1]);
    if (!exitLocationId) return notFound("This route is not currently offered.");
    const nodeId = await scheduleNodeForDevice(supabaseAdmin, { deviceId: device.id, exitLocationId });
    if (!nodeId) return unavailable("No server is currently available for this route.");
    return resolveCredentials(supabaseAdmin, device, entitlement, id, [nodeId]);
  }

  const [entryLocationId, exitLocationId] = await Promise.all([
    findEnabledLocationId(supabaseAdmin, privacyMatch[1]),
    findEnabledLocationId(supabaseAdmin, privacyMatch[2]),
  ]);
  if (!entryLocationId || !exitLocationId) return notFound("This route is not currently offered.");
  const placed = await scheduleDoubleHopForDevice(supabaseAdmin, { deviceId: device.id, entryLocationId, exitLocationId });
  if (!placed) return unavailable("No server is currently available for this route.");
  return resolveCredentials(supabaseAdmin, device, entitlement, id, [placed.relayNodeId, placed.exitNodeId]);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- vpn-authorize`
Expected: PASS — all tests in `vpn-authorize.test.js`.

Then run: `npm test`
Expected: PASS — the full suite (no regression in `device-provisioning.test.js`, `scheduler.test.js`, etc.).

- [ ] **Step 5: Commit**

```bash
git add functions/lib/vpn-authorize.js functions/lib/__tests__/vpn-authorize.test.js
git commit -m "feat(fleet): add authorizeRoute -- ADR-0002 sub-project B credential resolution"
```

---

## Task 3: `POST /v1/vpn/authorize` route handler

**Files:**
- Create: `functions/v1/vpn/authorize.js`
- Test: `functions/v1/vpn/__tests__/authorize.test.js`

**Interfaces:**
- Consumes: `authorizeRoute(supabaseAdmin, env, { device, entitlement, routeId })` from Task 2 (`functions/lib/vpn-authorize.js`). `ensureSessionDevice(supabaseAdmin, env, user, sessionId)` from `functions/lib/account-service.js` (returns `{ id, status, subscription_id }`). `loadDeviceEntitlements(supabaseAdmin, accountId, devices)` from `functions/lib/subscriptions.js` (returns a `Map` keyed by device id). `readV1Json`, `withV1User`, `v1Json`, `v1Error` from `functions/lib/v1-http.js`.
- Produces: `export async function onRequestPost(context)` — the Cloudflare Pages Function entry point Cloudflare's router dispatches `POST /v1/vpn/authorize` to (file-based routing, same convention as `functions/v1/routes.js`'s `onRequestGet`).

- [ ] **Step 1: Write the failing tests**

Create `functions/v1/vpn/__tests__/authorize.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase } from "../../../lib/__tests__/fake-supabase.js";

const requireUser = vi.fn();
vi.mock("../../../lib/user-auth.js", () => ({ requireUser }));

let db;
vi.mock("../../../lib/account-http.js", () => ({ adminClient: vi.fn(() => db) }));

const authorizeRoute = vi.fn();
vi.mock("../../../lib/vpn-authorize.js", () => ({ authorizeRoute }));

const { onRequestPost } = await import("../authorize.js");

const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function req(body) {
  return new Request("https://arcana.example.test/v1/vpn/authorize", {
    method: "POST",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ENTITLED_ENVELOPE = {
  ok: true,
  routeId: "de-fast",
  expiresAt: "2026-09-26T00:15:00.000Z",
  credentialEnvelope: { version: 1, hops: [{ uuid: "uuid-de-1" }] },
};

beforeEach(() => {
  requireUser.mockReset().mockResolvedValue({ user: { id: "user-1" }, claims: { session_id: "sess-1" }, response: null });
  authorizeRoute.mockReset().mockResolvedValue(ENTITLED_ENVELOPE);
  db = makeFakeSupabase({
    devices: [{ id: "dev-1", account_id: "acct-1", user_id: "user-1", status: "ACTIVE", auth_session_id: "sess-1", subscription_id: 1, created_at: "2026-01-01T00:00:00.000Z" }],
    subscriptions: [{ id: 1, account_id: "acct-1", status: "active", extra_seats: 0, created_at: "2026-01-01T00:00:00.000Z" }],
  });
});

describe("POST /v1/vpn/authorize", () => {
  it("requires authentication, matching every other /v1 route", async () => {
    requireUser.mockResolvedValue({ user: null, claims: null, response: new Response(null, { status: 401 }) });
    const res = await onRequestPost({ env, request: req({ route_id: "de-fast" }) });
    expect(res.status).toBe(401);
    expect(authorizeRoute).not.toHaveBeenCalled();
  });

  it("rejects a missing route_id with 400 before touching the database", async () => {
    const res = await onRequestPost({ env, request: req({}) });
    expect(res.status).toBe(400);
    expect(authorizeRoute).not.toHaveBeenCalled();
  });

  it("returns 409 not_entitled when the device has no live entitlement", async () => {
    db = makeFakeSupabase({
      devices: [{ id: "dev-1", account_id: "acct-1", user_id: "user-1", status: "ACTIVE", auth_session_id: "sess-1", subscription_id: null, created_at: "2026-01-01T00:00:00.000Z" }],
      subscriptions: [],
    });
    const res = await onRequestPost({ env, request: req({ route_id: "de-fast" }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("not_entitled");
    expect(authorizeRoute).not.toHaveBeenCalled();
  });

  it("returns the authorizeRoute envelope on success", async () => {
    const res = await onRequestPost({ env, request: req({ route_id: "de-fast" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      route_id: "de-fast",
      expires_at: "2026-09-26T00:15:00.000Z",
      credential_envelope: { version: 1, hops: [{ uuid: "uuid-de-1" }] },
    });
    expect(authorizeRoute).toHaveBeenCalledWith(
      db,
      env,
      expect.objectContaining({ routeId: "de-fast", device: expect.objectContaining({ id: "dev-1" }) })
    );
  });

  it("maps a failed authorizeRoute result to its status/message/code", async () => {
    authorizeRoute.mockResolvedValue({ ok: false, status: 503, message: "No server is currently available for this route." });
    const res = await onRequestPost({ env, request: req({ route_id: "de-fast" }) });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.message).toBe("No server is currently available for this route.");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- authorize.test.js`
Expected: FAIL — cannot find module `../authorize.js` (`functions/v1/vpn/authorize.js` does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `functions/v1/vpn/authorize.js`:
```js
import { ensureSessionDevice } from "../../lib/account-service.js";
import { loadDeviceEntitlements } from "../../lib/subscriptions.js";
import { authorizeRoute } from "../../lib/vpn-authorize.js";
import { readV1Json, withV1User, v1Json, v1Error } from "../../lib/v1-http.js";

/**
 * POST /v1/vpn/authorize -- per-connection pseudonymous credential
 * issuance for a route from GET /v1/routes. See
 * docs/superpowers/specs/2026-09-26-adr0002-vpn-authorize-design.md.
 */
export async function onRequestPost(context) {
  const { body, error } = await readV1Json(context.request);
  if (error) return error;

  return withV1User(context, "v1/vpn/authorize", async (db, user, sessionId) => {
    const routeId = typeof body.route_id === "string" ? body.route_id.trim() : "";
    if (!routeId) return v1Error(400, "route_id is required.");

    const sessionDevice = await ensureSessionDevice(db, context.env, user, sessionId);
    const { data: device, error: deviceError } = await db
      .from("devices")
      .select("id, account_id, user_id")
      .eq("id", sessionDevice.id)
      .single();
    if (deviceError) throw new Error(`devices lookup failed: ${deviceError.message}`);

    const { data: accountDevices, error: devicesError } = await db
      .from("devices")
      .select("id, status, subscription_id, created_at")
      .eq("account_id", device.account_id);
    if (devicesError) throw new Error(`devices lookup failed: ${devicesError.message}`);

    const entitlement = (await loadDeviceEntitlements(db, device.account_id, accountDevices ?? [])).get(device.id);
    if (!entitlement) return v1Error(409, "This device is not entitled to connect.", "not_entitled");

    const result = await authorizeRoute(db, context.env, { device, entitlement, routeId });
    if (!result.ok) return v1Error(result.status, result.message, result.code);
    return v1Json({
      route_id: result.routeId,
      expires_at: result.expiresAt,
      credential_envelope: result.credentialEnvelope,
    });
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- authorize.test.js`
Expected: PASS — all 5 tests in `functions/v1/vpn/__tests__/authorize.test.js`.

Then run: `npm test`
Expected: PASS — the full suite, 0 regressions.

Then run: `npm run lint`
Expected: PASS — no lint errors in the 2 new files.

- [ ] **Step 5: Commit**

```bash
git add functions/v1/vpn/authorize.js functions/v1/vpn/__tests__/authorize.test.js
git commit -m "feat(fleet): wire POST /v1/vpn/authorize -- ADR-0002 sub-project B"
```

---

## Final Documentation Update

- [ ] **Step 1: Update the ADR status**

In `docs/ADR/0002-managed-client-route-contract.md`, replace:
```
- **B — `POST /v1/vpn/authorize` (per-connection pseudonymous credential
  issuance): not started.** Needs its own design pass — today's per-node
  credential model is per-device, not per-connection/short-lived.
```
with:
```
- **B — `POST /v1/vpn/authorize` (per-connection pseudonymous credential
  issuance): SHIPPED**
  (`docs/superpowers/specs/2026-09-26-adr0002-vpn-authorize-design.md`).
  Reuses each device's existing `vpn_accounts` identity per resolved hop;
  `expires_at` is a short advisory TTL on the response, not a real
  per-connection credential rotation yet (that needs a `singbox-vpn`
  change — Sub-project B2, not started, needs a Rust-toolchain session).
```

- [ ] **Step 2: Commit**

```bash
git add docs/ADR/0002-managed-client-route-contract.md
git commit -m "docs: mark ADR-0002 sub-project B shipped"
```
