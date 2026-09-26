# ADR-0002 Sub-project A: Signed Route Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `GET /v1/routes` — an Ed25519-signed, schema-versioned,
rollback-protected route directory matching `tamara-next`'s already-built
`RouteDirectoryVerifier` contract exactly.

**Architecture:** Pure rendering/signing logic separated from DB-facing
wrappers (matching `scheduler.js`'s existing split). A new `nodes.transport`
column family holds each node's public transport parameters, populated by
`bootstrap-status.js` when a node reports them (optional field this pass —
see Global Constraints). Route rendering reuses `scheduler.js`'s
`selectNodeForDevice` and `isUnderCapacity` without committing any
assignment. Signing uses `@noble/curves`'s Ed25519 with a canonical-JSON
encoder ported byte-for-byte from `tamara-next`'s Dart implementation.

**Tech Stack:** Cloudflare Pages Functions (JS), Supabase/Postgres,
`@noble/curves` (new dependency), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-26-adr0002-signed-route-directory-design.md`

## Global Constraints

- Additive migrations only (ADR-0001 precedent) — no dropped/renamed columns.
- Every numeric field the signed envelope emits (`schema_version`,
  `directory_version`, `server_port`, `priority`) must be an integer —
  never a float — so canonical JSON can never diverge between this
  codebase and `tamara-next`'s Dart implementation (spec §4.3).
- **This plan is `vpn-web`-only.** Nothing generates `nodes.transport*`
  data yet — that requires a `singbox-vpn`-side change (new `vpn-admin`
  subcommand or bootstrap-script file read) explicitly deferred to a
  session with a Rust toolchain (none is available here — confirmed, no
  `cargo`). `bootstrap-status.js`'s extension in Task 3 accepts and
  persists the field defensively so that future change needs zero
  `vpn-web` work when it lands. Until then, `GET /v1/routes` correctly
  returns an empty `routes` array (no node has ever reported transport
  params) — this is honest, expected behavior for this pass, not a bug.
- Follow `functions/v1/entitlement.js`'s existing pattern
  (`withV1User`/`v1Json` from `functions/lib/v1-http.js`) for the new
  route — do not introduce a second `/v1` auth convention.
- Canonical JSON, signing, and route-rendering logic must be pure
  (no Supabase client, no I/O) — mirrors `node-lifecycle.js`/`scheduler.js`'s
  existing separation, and is what makes Task 2/4/5's fixed-vector and
  round-trip tests possible without mocking a DB.

## Review Focus

- **A location with zero eligible nodes** must produce zero routes for it,
  never a route with `null`/undefined hop fields — Task 4's tests cover
  this for both `fast` and `privacy_plus`.
- **A `privacy_plus` pair where only one hop has a candidate** must be
  omitted entirely, never a half-populated route — Task 4.
- **Two consecutive `GET /v1/routes` calls with no underlying change**
  must reuse the same `directory_version` and produce a verifiably valid
  (re-signable) envelope each time despite the timestamps changing —
  Task 6.
- **A node reporting a malformed `transport` object** (wrong transport
  name, missing required field, wrong type) must have that one field
  rejected without failing the whole bootstrap-status report — Task 3.
- **The signed envelope's canonical JSON must be byte-identical** to what
  `tamara-next`'s `_canonicalJson` produces for a shared fixture value —
  Task 2's fixed-vector test is the only thing standing between "looks
  right" and "the client can never verify a real response."

---

### Task 1: Migration — transport columns + route_directory_state

**Files:**
- Create: `supabase/migrations/20260928000000_route_directory.sql`
- Test: `scripts/test-route-directory-migration.sh` (mirrors
  `scripts/test-fleet-foundations-migration.sh`'s local-Postgres pattern)

**Interfaces:**
- Produces: `nodes.transport`, `nodes.reality_public_key`,
  `nodes.reality_short_id`, `nodes.reality_fingerprint`,
  `nodes.vless_flow`, `nodes.hysteria2_obfs_type`, `nodes.transport_port`,
  `nodes.tls_server_name` (all nullable text/int); table
  `route_directory_state(id boolean primary key, version bigint,
  last_payload_hash text)` with exactly one row (`id = true`). Task 3
  writes the `nodes.*` columns; Task 5 reads/writes `route_directory_state`.

- [ ] **Step 1: Write the migration**

```sql
-- Fleet Phase 14 follow-on / ADR-0002 sub-project A: a node's public
-- transport parameters (never its private key -- see NODE_BOOTSTRAP.md's
-- Credentials table for the existing precedent) and a singleton counter
-- for the signed route directory's monotonic version.
-- Additive only -- see docs/ADR/0001 precedent.

alter table nodes
  add column if not exists transport text,
  add column if not exists reality_public_key text,
  add column if not exists reality_short_id text,
  add column if not exists reality_fingerprint text,
  add column if not exists vless_flow text,
  add column if not exists hysteria2_obfs_type text,
  add column if not exists transport_port int,
  add column if not exists tls_server_name text;

create table if not exists route_directory_state (
  id boolean primary key default true,
  version bigint not null default 0,
  last_payload_hash text,
  constraint route_directory_state_singleton check (id)
);
insert into route_directory_state (id) values (true) on conflict do nothing;
```

- [ ] **Step 2: Write the migration smoke test**

```bash
#!/usr/bin/env bash
set -euo pipefail

DB="arcana_route_directory_$RANDOM-$RANDOM"
cleanup() { sudo -u postgres dropdb --if-exists "$DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

sudo systemctl start postgresql
sudo -u postgres createdb "$DB"

psql_db() { sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

psql_db <<'SQL'
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create table public.nodes (
  node_id text primary key,
  lifecycle_state text not null default 'READY'
);
insert into public.nodes (node_id) values ('node-1');
SQL

psql_db -f supabase/migrations/20260928000000_route_directory.sql

psql_db <<'SQL'
do $$
begin
  update public.nodes set transport = 'vless-reality', reality_public_key = 'abc',
    reality_short_id = 'def', reality_fingerprint = 'chrome', vless_flow = 'xtls-rprx-vision',
    transport_port = 443, tls_server_name = 'decoy.example.test'
  where node_id = 'node-1';

  if (select count(*) from public.route_directory_state) <> 1 then
    raise exception 'route_directory_state must have exactly one row after migration';
  end if;

  if (select version from public.route_directory_state where id = true) <> 0 then
    raise exception 'route_directory_state.version must start at 0';
  end if;

  begin
    insert into public.route_directory_state (id, version) values (false, 0);
    raise exception 'a second route_directory_state row was incorrectly allowed';
  exception
    when check_violation then null;
  end;
end $$;
SQL

echo "route directory migration test passed"
```

- [ ] **Step 3: Run it**

Run: `bash scripts/test-route-directory-migration.sh`
Expected: `route directory migration test passed` (requires local
PostgreSQL — matches the existing `test-fleet-foundations-migration.sh`
convention; if PostgreSQL is unavailable in this environment, `psql -f
supabase/migrations/20260928000000_route_directory.sql` against any
scratch Postgres and a manual read of `route_directory_state` is an
acceptable substitute — record which was actually run in the ledger).

- [ ] **Step 4: Wire the new smoke test into CI**

Add to `.github/workflows/ci.yml`'s `db-migrations` job, after the
existing "Validate node enrollment migration semantics" step:

```yaml
      - name: Validate route directory migration semantics in PostgreSQL
        run: bash scripts/test-route-directory-migration.sh
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260928000000_route_directory.sql scripts/test-route-directory-migration.sh .github/workflows/ci.yml
git commit -m "feat(fleet): route directory migration (transport columns + version counter)"
```

---

### Task 2: Canonical JSON (pure)

**Files:**
- Create: `functions/lib/canonical-json.js`
- Test: `functions/lib/__tests__/canonical-json.test.js`

**Interfaces:**
- Produces: `export function canonicalJsonString(value)` — returns the
  canonical JSON string (not bytes; Task 5 UTF-8-encodes it before
  hashing/signing, matching `tamara-next`'s `canonicalJsonBytes` which is
  `utf8.encode(_canonicalJson(value))`).

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from "vitest";
import { canonicalJsonString } from "../canonical-json.js";

describe("canonicalJsonString", () => {
  it("sorts object keys alphabetically", () => {
    expect(canonicalJsonString({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts keys at every nesting depth, not just the top level", () => {
    expect(canonicalJsonString({ z: { d: 1, c: 2 }, a: 1 })).toBe(
      '{"a":1,"z":{"c":2,"d":1}}'
    );
  });

  it("preserves array element order (arrays are not sorted)", () => {
    expect(canonicalJsonString({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it("emits no whitespace anywhere", () => {
    expect(canonicalJsonString({ a: 1, b: [1, 2] })).not.toMatch(/\s/);
  });

  it("round-trips strings, numbers, booleans, and null exactly like JSON.stringify", () => {
    expect(canonicalJsonString({ s: "x\"y", n: 42, t: true, f: false, z: null })).toBe(
      '{"f":false,"n":42,"s":"x\\"y","t":true,"z":null}'
    );
  });

  it("matches tamara-next's documented fixed-vector output for a known payload", () => {
    // Cross-checked directly against tamara-next's _canonicalJson
    // (lib/infrastructure/control_plane/signed_route_directory.dart) for
    // this exact value -- this is the one test standing between "looks
    // right" and "the client can never verify a real response."
    const value = {
      schema_version: 1,
      directory_version: 42,
      issued_at: "2026-09-13T10:00:00Z",
      expires_at: "2026-09-13T11:00:00Z",
      key_id: "routes-2026-a",
      payload: { routes: [] },
    };
    expect(canonicalJsonString(value)).toBe(
      '{"directory_version":42,"expires_at":"2026-09-13T11:00:00Z","issued_at":"2026-09-13T10:00:00Z","key_id":"routes-2026-a","payload":{"routes":[]},"schema_version":1}'
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run functions/lib/__tests__/canonical-json.test.js`
Expected: FAIL — `Cannot find module '../canonical-json.js'`

- [ ] **Step 3: Implement**

```js
/**
 * Byte-for-byte port of tamara-next's _canonicalJson
 * (lib/infrastructure/control_plane/signed_route_directory.dart): sort
 * object keys recursively, encode each leaf with the platform's own JSON
 * string/number/bool/null encoder, no whitespace. The Ed25519 signature
 * in GET /v1/routes' envelope covers exactly this string's UTF-8 bytes,
 * so any divergence from Dart's own output here breaks every client's
 * ability to verify a real signature -- this file has no behavior of its
 * own to get right beyond matching that algorithm exactly.
 *
 * Every value passed to this function must contain only integers (never
 * floats) in its numeric fields -- JSON.stringify and Dart's num
 * formatting are not guaranteed to agree on float representation, and
 * nothing in this codebase's signed envelope needs a float.
 */
export function canonicalJsonString(value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonString(value[key])}`).join(",")}}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonString).join(",")}]`;
  }
  return JSON.stringify(value);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run functions/lib/__tests__/canonical-json.test.js`
Expected: PASS (6/6)

- [ ] **Step 5: Commit**

```bash
git add functions/lib/canonical-json.js functions/lib/__tests__/canonical-json.test.js
git commit -m "feat(fleet): canonical JSON encoder matching tamara-next byte-for-byte"
```

---

### Task 3: `bootstrap-status.js` accepts an optional transport report

**Files:**
- Modify: `functions/api/agent/bootstrap-status.js`
- Modify: `functions/api/agent/__tests__/bootstrap-status.test.js`

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: when the request body's `stage` is `"COMPLETE"` and it
  includes a well-formed `transport` object, the `nodes` row gains the
  Task 1 columns populated. A well-formed object has:
  `transport: "vless-reality" | "hysteria2"`, `server_port: integer
  1-65535`, `tls_server_name: non-empty string`, and (for
  `"vless-reality"` only) `reality_public_key`, `reality_short_id`,
  `reality_fingerprint`, `vless_flow` — all non-empty strings. Malformed
  or partial `transport` data is silently dropped (not persisted) without
  rejecting the rest of the bootstrap-status report — the existing
  stage/status/message fields still get written.

- [ ] **Step 1: Write the failing tests**

Add to `functions/api/agent/__tests__/bootstrap-status.test.js`, reusing
its existing `nodesUpdate` spy and `req(body, auth)` request helper
exactly as its three current tests already do (read the file first — do
not invent new helper names):

```js
it("persists a well-formed vless-reality transport report alongside COMPLETE", async () => {
  const res = await onRequestPost({
    env,
    request: req({
      stage: "COMPLETE",
      status: "OK",
      message: "bootstrap complete",
      transport: {
        transport: "vless-reality",
        server_port: 443,
        tls_server_name: "decoy.example.test",
        reality_public_key: "abc123",
        reality_short_id: "def456",
        reality_fingerprint: "chrome",
        vless_flow: "xtls-rprx-vision",
      },
    }),
  });
  expect(res.status).toBe(200);
  expect(nodesUpdate.mock.calls[0][0]).toMatchObject({
    transport: "vless-reality",
    transport_port: 443,
    tls_server_name: "decoy.example.test",
    reality_public_key: "abc123",
    reality_short_id: "def456",
    reality_fingerprint: "chrome",
    vless_flow: "xtls-rprx-vision",
  });
});

it("drops a malformed transport report without failing the rest of the bootstrap-status update", async () => {
  const res = await onRequestPost({
    env,
    request: req({
      stage: "COMPLETE",
      status: "OK",
      message: "bootstrap complete",
      transport: { transport: "carrier-pigeon", server_port: 443 },
    }),
  });
  expect(res.status).toBe(200);
  expect(nodesUpdate.mock.calls[0][0]).not.toHaveProperty("transport");
  expect(nodesUpdate.mock.calls[0][0]).toMatchObject({ bootstrap_stage: "COMPLETE", bootstrap_status: "OK" });
});

it("does nothing extra when transport is omitted entirely (today's real agents)", async () => {
  const res = await onRequestPost({
    env,
    request: req({ stage: "COMPLETE", status: "OK", message: "bootstrap complete" }),
  });
  expect(res.status).toBe(200);
  expect(nodesUpdate.mock.calls[0][0]).not.toHaveProperty("transport");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run functions/api/agent/__tests__/bootstrap-status.test.js`
Expected: FAIL — the first test's `nodesUpdate` assertion has no matching
call (the current handler never writes `transport`/`transport_port`/etc).

- [ ] **Step 3: Implement**

```js
const VALID_TRANSPORTS = new Set(["vless-reality", "hysteria2"]);

function nonEmptyString(value, max = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

/**
 * Validates an agent-reported transport object into the exact nodes.*
 * columns it maps to, or null if any required field for its declared
 * transport is missing/malformed -- a partial/wrong report is dropped
 * silently rather than failing the whole bootstrap-status update, since
 * stage/status/message are the load-bearing part of this endpoint and
 * must never be blocked by an agent build that gets this new, optional
 * field wrong.
 */
function validateTransport(transport) {
  if (!transport || typeof transport !== "object") return null;
  if (!VALID_TRANSPORTS.has(transport.transport)) return null;
  const port = transport.server_port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const tlsServerName = nonEmptyString(transport.tls_server_name, 253);
  if (!tlsServerName) return null;

  const fields = { transport: transport.transport, transport_port: port, tls_server_name: tlsServerName };
  if (transport.transport === "vless-reality") {
    const realityPublicKey = nonEmptyString(transport.reality_public_key, 128);
    const realityShortId = nonEmptyString(transport.reality_short_id, 32);
    const realityFingerprint = nonEmptyString(transport.reality_fingerprint, 32);
    const vlessFlow = nonEmptyString(transport.vless_flow, 64);
    if (!realityPublicKey || !realityShortId || !realityFingerprint || !vlessFlow) return null;
    return {
      ...fields,
      reality_public_key: realityPublicKey,
      reality_short_id: realityShortId,
      reality_fingerprint: realityFingerprint,
      vless_flow: vlessFlow,
    };
  }
  // hysteria2: only the shared fields are required; hysteria2_obfs_type is optional.
  const obfsType = nonEmptyString(transport.hysteria2_obfs_type, 32);
  return obfsType ? { ...fields, hysteria2_obfs_type: obfsType } : fields;
}
```

Then in `onRequestPost`, after the existing `message` computation and
before the `supabaseAdmin.from("nodes").update(...)` call, build the
update object incrementally instead of the current inline literal:

```js
  const update = {
    bootstrap_stage: body.stage,
    bootstrap_status: body.status,
    bootstrap_message: message,
    bootstrap_updated_at: new Date().toISOString(),
  };
  const transport = validateTransport(body.transport);
  if (transport) Object.assign(update, transport);

  const { error } = await supabaseAdmin.from("nodes").update(update).eq("node_id", nodeId);
```

(Replacing the existing inline `.update({ ... })` literal with `.update(update)`.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run functions/api/agent/__tests__/bootstrap-status.test.js`
Expected: PASS, including every pre-existing test in that file (this
change is additive to the update object, not a restructuring of existing
fields).

- [ ] **Step 5: Commit**

```bash
git add functions/api/agent/bootstrap-status.js functions/api/agent/__tests__/bootstrap-status.test.js
git commit -m "feat(fleet): bootstrap-status accepts an optional node transport report"
```

---

### Task 4: Route rendering (pure)

**Files:**
- Create: `functions/lib/route-directory.js`
- Test: `functions/lib/__tests__/route-directory.test.js`

**Interfaces:**
- Consumes: `selectNodeForDevice`, `isUnderCapacity` from `./scheduler.js`
  (signatures: `selectNodeForDevice({ candidates, stickyNodeId })` →
  `nodeId | null`; `isUnderCapacity(node)` → `boolean`, where `node` has
  `configuredUsers, maxSessions, lifecycleState`).
- Produces: `export function renderRoutes({ nodes, locations, allowedPaths })`
  → `{ routes: Array<RouteObject> }` (the exact `payload` shape Task 5
  signs and Task 6 returns). `nodes` entries carry every column Task 1
  added plus `nodeId, role, locationId, configuredUsers, maxSessions,
  lifecycleState, failureDomain` (camelCase — DB-facing mapping happens in
  Task 6, matching `scheduler.js`'s own pure/DB-facing split). `locations`
  entries: `{ id, countryCode, displayName }`. `allowedPaths` entries:
  `{ entryLocationId, exitLocationId }` (already filtered to `enabled:
  true` by the caller, matching `scheduler.js`'s own contract for its
  candidate inputs).

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from "vitest";
import { renderRoutes } from "../route-directory.js";

const EXIT_DE = {
  nodeId: "de-fsn-001",
  role: "EXIT",
  locationId: "loc-de",
  lifecycleState: "READY",
  configuredUsers: 5,
  maxSessions: 100,
  hostname: "de-fsn-001.nodes.example.test",
  failureDomain: "hetzner/de",
  transport: "vless-reality",
  transportPort: 443,
  tlsServerName: "decoy1.example.test",
  realityPublicKey: "pub-de",
  realityShortId: "sid-de",
  realityFingerprint: "chrome",
  vlessFlow: "xtls-rprx-vision",
};

const RELAY_SE = {
  ...EXIT_DE,
  nodeId: "se-fsn-001",
  role: "RELAY",
  locationId: "loc-se",
  hostname: "se-fsn-001.nodes.example.test",
  failureDomain: "hetzner/se",
  tlsServerName: "decoy2.example.test",
  realityPublicKey: "pub-se",
  realityShortId: "sid-se",
};

const LOCATIONS = [
  { id: "loc-de", countryCode: "DE", displayName: "Germany" },
  { id: "loc-se", countryCode: "SE", displayName: "Sweden" },
];

describe("renderRoutes", () => {
  it("produces one fast route per exit location with an eligible node", () => {
    const { routes } = renderRoutes({ nodes: [EXIT_DE], locations: LOCATIONS, allowedPaths: [] });
    expect(routes).toEqual([
      {
        id: "de-fast",
        label: "Germany",
        region: "DE",
        mode: "fast",
        priority: 100,
        failure_domain: "hetzner/de",
        hops: [
          {
            transport: "vless-reality",
            server_address: "de-fsn-001.nodes.example.test",
            server_port: 443,
            tls_server_name: "decoy1.example.test",
            reality_public_key: "pub-de",
            reality_short_id: "sid-de",
            reality_fingerprint: "chrome",
            vless_flow: "xtls-rprx-vision",
          },
        ],
      },
    ]);
  });

  it("produces nothing for a location with no eligible node", () => {
    const noneReady = { ...EXIT_DE, lifecycleState: "FAILED" };
    const { routes } = renderRoutes({ nodes: [noneReady], locations: LOCATIONS, allowedPaths: [] });
    expect(routes).toEqual([]);
  });

  it("excludes a node that has never reported transport params", () => {
    const { transport, ...withoutTransport } = EXIT_DE;
    const { routes } = renderRoutes({ nodes: [withoutTransport], locations: LOCATIONS, allowedPaths: [] });
    expect(routes).toEqual([]);
  });

  it("produces one privacy_plus route per enabled allowed_paths pair with both hops eligible", () => {
    const { routes } = renderRoutes({
      nodes: [EXIT_DE, RELAY_SE],
      locations: LOCATIONS,
      allowedPaths: [{ entryLocationId: "loc-se", exitLocationId: "loc-de" }],
    });
    const privacyRoute = routes.find((r) => r.mode === "privacy_plus");
    expect(privacyRoute).toMatchObject({ id: "se-de-privacy", mode: "privacy_plus" });
    expect(privacyRoute.hops).toHaveLength(2);
    expect(privacyRoute.hops[0].server_address).toBe("se-fsn-001.nodes.example.test");
    expect(privacyRoute.hops[1].server_address).toBe("de-fsn-001.nodes.example.test");
  });

  it("omits a privacy_plus pair entirely when only one hop has an eligible node -- never half-populated", () => {
    const { routes } = renderRoutes({
      nodes: [EXIT_DE], // no RELAY node for loc-se
      locations: LOCATIONS,
      allowedPaths: [{ entryLocationId: "loc-se", exitLocationId: "loc-de" }],
    });
    expect(routes.find((r) => r.mode === "privacy_plus")).toBeUndefined();
  });

  it("respects CANARY session cap via isUnderCapacity -- a full canary node is excluded", () => {
    const fullCanary = { ...EXIT_DE, lifecycleState: "CANARY", configuredUsers: 10, maxSessions: 1000 };
    const { routes } = renderRoutes({ nodes: [fullCanary], locations: LOCATIONS, allowedPaths: [] });
    expect(routes).toEqual([]);
  });

  it("omits failure_domain from the route object when the node has none set", () => {
    const { failureDomain, ...withoutDomain } = EXIT_DE;
    const { routes } = renderRoutes({ nodes: [withoutDomain], locations: LOCATIONS, allowedPaths: [] });
    expect(routes[0]).not.toHaveProperty("failure_domain");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run functions/lib/__tests__/route-directory.test.js`
Expected: FAIL — `Cannot find module '../route-directory.js'`

- [ ] **Step 3: Implement**

```js
import { selectNodeForDevice, isUnderCapacity } from "./scheduler.js";

const HAS_TRANSPORT = (node) => typeof node.transport === "string" && node.transport.length > 0;

// scheduler.js's own DB-facing callers already filter to READY/CANARY at
// the query level (`.in("lifecycle_state", ["READY", "CANARY"])`) before
// isUnderCapacity ever runs -- isUnderCapacity itself does not reject a
// FAILED/QUARANTINED node. This function is reused here with data this
// caller does not fully control the query shape of, and the cost of a
// stale/compromised node's real REALITY key ending up in a signed public
// route is high enough to filter explicitly here too, not just trust the
// caller (defense in depth, same reasoning as canTransitionLifecycle
// being re-checked at every write site even though callers already
// checked once).
const ELIGIBLE_LIFECYCLE_STATES = new Set(["READY", "CANARY"]);

function toHop(node) {
  const hop = {
    transport: node.transport,
    server_address: node.hostname,
    server_port: node.transportPort,
    tls_server_name: node.tlsServerName,
  };
  if (node.transport === "vless-reality") {
    hop.reality_public_key = node.realityPublicKey;
    hop.reality_short_id = node.realityShortId;
    hop.reality_fingerprint = node.realityFingerprint;
    hop.vless_flow = node.vlessFlow;
  } else if (node.hysteria2ObfsType) {
    hop.hysteria2_obfs_type = node.hysteria2ObfsType;
  }
  return hop;
}

function pickNode(candidates) {
  const eligible = candidates.filter(
    (node) => ELIGIBLE_LIFECYCLE_STATES.has(node.lifecycleState) && HAS_TRANSPORT(node) && isUnderCapacity(node)
  );
  const nodeId = selectNodeForDevice({ candidates: eligible, stickyNodeId: null });
  return eligible.find((node) => node.nodeId === nodeId) ?? null;
}

/**
 * Pure route-directory rendering: no I/O, no Supabase client. Reuses
 * scheduler.js's own candidate-selection logic (isUnderCapacity,
 * selectNodeForDevice) to pick, per (location, mode), whichever node the
 * scheduler currently prefers -- without committing anything. A node
 * that has never reported transport params (Task 3) is never a
 * candidate, and a location/pair with no eligible candidate produces no
 * route at all, never a partial one.
 */
export function renderRoutes({ nodes, locations, allowedPaths }) {
  const locationById = new Map(locations.map((loc) => [loc.id, loc]));
  const byLocationAndRole = (locationId, role) =>
    nodes.filter((node) => node.locationId === locationId && node.role === role);

  const routes = [];

  for (const location of locations) {
    const exitNode = pickNode(byLocationAndRole(location.id, "EXIT"));
    if (!exitNode) continue;
    const route = {
      id: `${location.countryCode.toLowerCase()}-fast`,
      label: location.displayName,
      region: location.countryCode,
      mode: "fast",
      priority: 100,
      hops: [toHop(exitNode)],
    };
    if (exitNode.failureDomain) route.failure_domain = exitNode.failureDomain;
    routes.push(route);
  }

  for (const path of allowedPaths) {
    const entryLocation = locationById.get(path.entryLocationId);
    const exitLocation = locationById.get(path.exitLocationId);
    if (!entryLocation || !exitLocation) continue;
    const relayNode = pickNode(byLocationAndRole(path.entryLocationId, "RELAY"));
    const exitNode = pickNode(byLocationAndRole(path.exitLocationId, "EXIT"));
    if (!relayNode || !exitNode) continue;
    const route = {
      id: `${entryLocation.countryCode.toLowerCase()}-${exitLocation.countryCode.toLowerCase()}-privacy`,
      label: `${entryLocation.displayName} → ${exitLocation.displayName} Privacy+`,
      region: exitLocation.countryCode,
      mode: "privacy_plus",
      priority: 100,
      hops: [toHop(relayNode), toHop(exitNode)],
    };
    if (exitNode.failureDomain) route.failure_domain = exitNode.failureDomain;
    routes.push(route);
  }

  return { routes };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run functions/lib/__tests__/route-directory.test.js`
Expected: PASS (7/7)

- [ ] **Step 5: Commit**

```bash
git add functions/lib/route-directory.js functions/lib/__tests__/route-directory.test.js
git commit -m "feat(fleet): pure route-directory rendering reusing the scheduler's own candidate logic"
```

---

### Task 5: Signing + directory_version (DB-facing)

**Files:**
- Create: `functions/lib/route-signing.js`
- Test: `functions/lib/__tests__/route-signing.test.js`
- Modify: `package.json` (add `@noble/curves` dependency)

**Interfaces:**
- Consumes: `canonicalJsonString` (Task 2), `renderRoutes` (Task 4).
- Produces: `export async function signRouteDirectory(supabase, { nodes, locations, allowedPaths, privateKeyHex, keyId })`
  → the full signed envelope object (`{ schema_version, directory_version,
  issued_at, expires_at, key_id, payload, signature }`), reading/writing
  `route_directory_state` for the version counter. Task 6 calls this with
  DB-loaded data.

- [ ] **Step 1: Add the dependency**

```bash
npm install @noble/curves@^2.0.0
```

- [ ] **Step 2: Write the failing tests**

```js
import { describe, it, expect, vi } from "vitest";
import { makeFakeSupabase } from "./fake-supabase.js";
import { signRouteDirectory } from "../route-signing.js";
import { canonicalJsonString } from "../canonical-json.js";
import { ed25519 } from "@noble/curves/ed25519";

// A fixed test keypair -- never a real signing key. Hex seed chosen
// arbitrarily; any 32-byte hex value works with ed25519.getPublicKey.
const PRIVATE_KEY_HEX = "11".repeat(32);
const PUBLIC_KEY = ed25519.getPublicKey(Buffer.from(PRIVATE_KEY_HEX, "hex"));

const NODES = [
  {
    nodeId: "de-fsn-001", role: "EXIT", locationId: "loc-de", lifecycleState: "READY",
    configuredUsers: 5, maxSessions: 100, hostname: "de-fsn-001.nodes.example.test",
    transport: "vless-reality", transportPort: 443, tlsServerName: "decoy.example.test",
    realityPublicKey: "pub", realityShortId: "sid", realityFingerprint: "chrome", vlessFlow: "xtls-rprx-vision",
  },
];
const LOCATIONS = [{ id: "loc-de", countryCode: "DE", displayName: "Germany" }];

describe("signRouteDirectory", () => {
  it("produces an envelope whose signature verifies against the public key", async () => {
    const db = makeFakeSupabase({ route_directory_state: [{ id: true, version: 0, last_payload_hash: null }] });
    const envelope = await signRouteDirectory(db, {
      nodes: NODES, locations: LOCATIONS, allowedPaths: [],
      privateKeyHex: PRIVATE_KEY_HEX, keyId: "routes-2026-a",
    });
    expect(envelope.schema_version).toBe(1);
    expect(envelope.key_id).toBe("routes-2026-a");
    const signed = {
      schema_version: envelope.schema_version,
      directory_version: envelope.directory_version,
      issued_at: envelope.issued_at,
      expires_at: envelope.expires_at,
      key_id: envelope.key_id,
      payload: envelope.payload,
    };
    const ok = ed25519.verify(
      Buffer.from(envelope.signature, "base64"),
      Buffer.from(canonicalJsonString(signed), "utf8"),
      PUBLIC_KEY
    );
    expect(ok).toBe(true);
  });

  it("sets expires_at exactly 1 hour after issued_at", async () => {
    const db = makeFakeSupabase({ route_directory_state: [{ id: true, version: 0, last_payload_hash: null }] });
    const envelope = await signRouteDirectory(db, {
      nodes: NODES, locations: LOCATIONS, allowedPaths: [],
      privateKeyHex: PRIVATE_KEY_HEX, keyId: "routes-2026-a",
    });
    const diffMs = new Date(envelope.expires_at).getTime() - new Date(envelope.issued_at).getTime();
    expect(diffMs).toBe(60 * 60 * 1000);
  });

  it("starts directory_version at 1 on the very first call (route_directory_state seeded at 0)", async () => {
    const db = makeFakeSupabase({ route_directory_state: [{ id: true, version: 0, last_payload_hash: null }] });
    const envelope = await signRouteDirectory(db, {
      nodes: NODES, locations: LOCATIONS, allowedPaths: [],
      privateKeyHex: PRIVATE_KEY_HEX, keyId: "routes-2026-a",
    });
    expect(envelope.directory_version).toBe(1);
  });

  it("reuses the same directory_version across two calls with unchanged route content", async () => {
    const db = makeFakeSupabase({ route_directory_state: [{ id: true, version: 0, last_payload_hash: null }] });
    const first = await signRouteDirectory(db, {
      nodes: NODES, locations: LOCATIONS, allowedPaths: [],
      privateKeyHex: PRIVATE_KEY_HEX, keyId: "routes-2026-a",
    });
    const second = await signRouteDirectory(db, {
      nodes: NODES, locations: LOCATIONS, allowedPaths: [],
      privateKeyHex: PRIVATE_KEY_HEX, keyId: "routes-2026-a",
    });
    expect(second.directory_version).toBe(first.directory_version);
    // issued_at still advances -- the validity window is refreshed even
    // when content (and therefore version) did not change.
    expect(new Date(second.issued_at).getTime()).toBeGreaterThanOrEqual(new Date(first.issued_at).getTime());
  });

  it("bumps directory_version when the underlying route content changes", async () => {
    const db = makeFakeSupabase({ route_directory_state: [{ id: true, version: 0, last_payload_hash: null }] });
    const first = await signRouteDirectory(db, {
      nodes: NODES, locations: LOCATIONS, allowedPaths: [],
      privateKeyHex: PRIVATE_KEY_HEX, keyId: "routes-2026-a",
    });
    const changedNodes = [{ ...NODES[0], transportPort: 8443 }];
    const second = await signRouteDirectory(db, {
      nodes: changedNodes, locations: LOCATIONS, allowedPaths: [],
      privateKeyHex: PRIVATE_KEY_HEX, keyId: "routes-2026-a",
    });
    expect(second.directory_version).toBe(first.directory_version + 1);
  });
});
```

Check `functions/lib/__tests__/fake-supabase.js` for whether
`route_directory_state` needs adding to its base `tables` object — per
that file's own pattern, an extra key passed via `seed` is spread in
regardless (`...structuredClone(seed)`), so no change to `fake-supabase.js`
should be required; confirm by running the tests, and only edit
`fake-supabase.js` if a `from("route_directory_state")` call throws
`unexpected table`.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run functions/lib/__tests__/route-signing.test.js`
Expected: FAIL — `Cannot find module '../route-signing.js'`

- [ ] **Step 4: Implement**

```js
import { ed25519 } from "@noble/curves/ed25519";
import { canonicalJsonString } from "./canonical-json.js";
import { renderRoutes } from "./route-directory.js";

const DIRECTORY_TTL_MS = 60 * 60 * 1000; // 1 hour, matching the contract's own example.

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Signs a fresh route directory envelope, bumping directory_version only
 * when the rendered payload.routes content actually changed since the
 * last call -- issued_at/expires_at is excluded from that comparison
 * deliberately (see functions/lib/__tests__/route-signing.test.js), since
 * it differs on every call regardless of content and would otherwise
 * force a version bump on every single request.
 */
export async function signRouteDirectory(supabase, { nodes, locations, allowedPaths, privateKeyHex, keyId }) {
  const { routes } = renderRoutes({ nodes, locations, allowedPaths });
  const payload = { routes };
  const payloadHash = await sha256Hex(canonicalJsonString(payload));

  const { data: state, error: stateError } = await supabase
    .from("route_directory_state")
    .select("version, last_payload_hash")
    .eq("id", true)
    .single();
  if (stateError) throw new Error(`route_directory_state lookup failed: ${stateError.message}`);

  const version = payloadHash === state.last_payload_hash ? state.version : state.version + 1;
  if (version !== state.version) {
    const { error: updateError } = await supabase
      .from("route_directory_state")
      .update({ version, last_payload_hash: payloadHash })
      .eq("id", true);
    if (updateError) throw new Error(`route_directory_state update failed: ${updateError.message}`);
  }

  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + DIRECTORY_TTL_MS);
  const signed = {
    schema_version: 1,
    directory_version: version,
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    key_id: keyId,
    payload,
  };
  const signature = ed25519.sign(
    new TextEncoder().encode(canonicalJsonString(signed)),
    Buffer.from(privateKeyHex, "hex")
  );
  return { ...signed, signature: Buffer.from(signature).toString("base64") };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run functions/lib/__tests__/route-signing.test.js`
Expected: PASS (5/5)

- [ ] **Step 6: Commit**

```bash
git add functions/lib/route-signing.js functions/lib/__tests__/route-signing.test.js package.json package-lock.json
git commit -m "feat(fleet): sign the route directory envelope with content-hashed versioning"
```

---

### Task 6: `GET /v1/routes` wiring

**Files:**
- Create: `functions/v1/routes.js`
- Test: `functions/v1/__tests__/routes.test.js`

**Interfaces:**
- Consumes: `signRouteDirectory` (Task 5), `withV1User`/`v1Json` from
  `functions/lib/v1-http.js` (`withV1User(context, label, handler)` calls
  `adminClient(context.env)` from `functions/lib/account-http.js` and
  `requireUser(context.request, supabaseAdmin)` from
  `functions/lib/user-auth.js` — `requireUser` returns
  `{ user, claims, response }`; `!user` means unauthenticated).

There is no existing `functions/v1/__tests__/` directory yet (this is the
first `/v1` route with its own test file) — the test below mocks
`account-http.js`/`user-auth.js` directly rather than following a
nonexistent prior convention.

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase } from "../../lib/__tests__/fake-supabase.js";

const requireUser = vi.fn();
vi.mock("../../lib/user-auth.js", () => ({ requireUser }));

let db;
vi.mock("../../lib/account-http.js", () => ({ adminClient: vi.fn(() => db) }));

const signRouteDirectory = vi.fn();
vi.mock("../../lib/route-signing.js", () => ({ signRouteDirectory }));

const { onRequestGet } = await import("../routes.js");

const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://arcana.example.test/v1/routes", {
    headers: { Authorization: "Bearer token" },
  });
}

const ENVELOPE = {
  schema_version: 1,
  directory_version: 1,
  issued_at: "2026-09-26T00:00:00Z",
  expires_at: "2026-09-26T01:00:00Z",
  key_id: "routes-2026-a",
  payload: { routes: [] },
  signature: "c2ln",
};

beforeEach(() => {
  requireUser.mockReset().mockResolvedValue({ user: { id: "user-1" }, claims: { session_id: "sess-1" }, response: null });
  signRouteDirectory.mockReset().mockResolvedValue(ENVELOPE);
  db = makeFakeSupabase({ nodes: [], locations: [], allowed_paths: [] });
});

describe("GET /v1/routes", () => {
  it("returns the signed envelope signRouteDirectory produces", async () => {
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(ENVELOPE);
  });

  it("requires authentication, matching every other /v1 route", async () => {
    requireUser.mockResolvedValue({ user: null, claims: null, response: new Response(null, { status: 401 }) });
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(401);
    expect(signRouteDirectory).not.toHaveBeenCalled();
  });

  it("queries only READY/CANARY nodes and enabled locations/allowed_paths", async () => {
    await onRequestGet({ env, request: makeRequest() });
    expect(signRouteDirectory).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ nodes: [], locations: [], allowedPaths: [] })
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run functions/v1/__tests__/routes.test.js`
Expected: FAIL — `Cannot find module '../routes.js'`

- [ ] **Step 3: Implement**

```js
import { signRouteDirectory } from "../lib/route-signing.js";
import { withV1User, v1Json } from "../lib/v1-http.js";

/**
 * GET /v1/routes -- the signed, versioned route directory tamara-next's
 * RouteDirectoryVerifier already verifies. Requires authentication like
 * every other /v1 route, even though the directory itself carries no
 * per-user data, matching the contract's own auth model.
 */
export const onRequestGet = (context) =>
  withV1User(context, "v1/routes", async (db) => {
    const [{ data: nodes, error: nodesError }, { data: locations, error: locationsError }, { data: allowedPaths, error: pathsError }] =
      await Promise.all([
        db
          .from("nodes")
          .select(
            "node_id, role, location_id, lifecycle_state, configured_users, max_sessions, hostname, failure_domain, transport, transport_port, tls_server_name, reality_public_key, reality_short_id, reality_fingerprint, vless_flow, hysteria2_obfs_type"
          )
          .in("lifecycle_state", ["READY", "CANARY"]),
        db.from("locations").select("id, country_code, display_name").eq("enabled", true),
        db.from("allowed_paths").select("entry_location_id, exit_location_id").eq("enabled", true),
      ]);
    if (nodesError) throw new Error(`nodes lookup failed: ${nodesError.message}`);
    if (locationsError) throw new Error(`locations lookup failed: ${locationsError.message}`);
    if (pathsError) throw new Error(`allowed_paths lookup failed: ${pathsError.message}`);

    const mappedNodes = (nodes ?? []).map((n) => ({
      nodeId: n.node_id,
      role: n.role,
      locationId: n.location_id,
      lifecycleState: n.lifecycle_state,
      configuredUsers: n.configured_users,
      maxSessions: n.max_sessions,
      hostname: n.hostname,
      failureDomain: n.failure_domain,
      transport: n.transport,
      transportPort: n.transport_port,
      tlsServerName: n.tls_server_name,
      realityPublicKey: n.reality_public_key,
      realityShortId: n.reality_short_id,
      realityFingerprint: n.reality_fingerprint,
      vlessFlow: n.vless_flow,
      hysteria2ObfsType: n.hysteria2_obfs_type,
    }));
    const mappedLocations = (locations ?? []).map((l) => ({
      id: l.id,
      countryCode: l.country_code,
      displayName: l.display_name,
    }));
    const mappedPaths = (allowedPaths ?? []).map((p) => ({
      entryLocationId: p.entry_location_id,
      exitLocationId: p.exit_location_id,
    }));

    const envelope = await signRouteDirectory(db, {
      nodes: mappedNodes,
      locations: mappedLocations,
      allowedPaths: mappedPaths,
      privateKeyHex: context.env.ROUTE_SIGNING_PRIVATE_KEY,
      keyId: context.env.ROUTE_SIGNING_KEY_ID,
    });
    return v1Json(envelope);
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run functions/v1/__tests__/routes.test.js`
Expected: PASS (3/3)

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run`
Expected: every test passes, including all pre-existing ones.

- [ ] **Step 6: Commit**

```bash
git add functions/v1/routes.js functions/v1/__tests__/routes.test.js
git commit -m "feat(fleet): wire GET /v1/routes"
```

---

## Final notes for the executor

- `ROUTE_SIGNING_PRIVATE_KEY` and `ROUTE_SIGNING_KEY_ID` are new Pages
  secrets/config this plan assumes exist in `env` — they are not
  generated or provisioned by this plan (per spec §4.3, key rotation
  tooling is an explicit follow-up). For local/CI test purposes, tests
  pass their own fixed test keys directly rather than reading `env`.
- After all tasks, run the whole suite once more and update
  `docs/FLEET_LIFECYCLE_AUTOMATION.md` or `docs/ADR/0002-managed-client-route-contract.md`
  with a short status note (`GET /v1/routes` shipped; `POST
  /v1/vpn/authorize` still pending) if either document is still read by
  whoever picks up Sub-project B next — check both, update whichever
  needs it, as a final small task before finishing the branch.
