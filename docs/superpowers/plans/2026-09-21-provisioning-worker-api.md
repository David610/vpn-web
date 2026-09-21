# Provisioning Worker API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Worker-side (Cloudflare Pages Functions) half of the VPS provisioning agent design: the job-queue API the agent polls, the AES-GCM encryption of delivered subscription URLs, Resend-based failure alerting, and `GET /api/vpn/config` for the dashboard to retrieve a provisioned config. This plan produces a fully working, fully locally-testable API — the actual agent binary that calls it is a separate plan in `singbox-vpn`.

**Architecture:** Three new Cloudflare Pages Functions under `functions/api/agent/*` (claim/complete/fail), each authenticated by a per-node shared secret (hashed, stored in a new `nodes` table) rather than a Supabase session — the agent has no Supabase credential. A small, targeted patch to the already-merged Stripe webhook handlers resolves `vpn_account_id`/`vpn_user_id` at job-insertion time for `SET_EXPIRY`/`DISABLE_USER` jobs. `GET /api/vpn/config` reuses the same Supabase-Bearer-token pattern as `create-checkout-session.js`.

**Tech Stack:** Same as the existing Cloudflare Pages Functions in this repo — plain JS, `@supabase/supabase-js` (service-role client), Web Crypto (`crypto.subtle`) for AES-GCM and SHA-256 (both natively available in the Workers runtime, no extra dependency), Resend's HTTP API via plain `fetch` (no SDK dependency).

**Spec:** `docs/superpowers/specs/2026-09-21-vpn-provisioning-agent-design.md` in the sibling repo `singbox-vpn` (absolute path: `D:\ISDA\singbox-vpn\docs\superpowers\specs\2026-09-21-vpn-provisioning-agent-design.md`) — §3 (data model), §4 (Worker API), §5 (`GET /api/vpn/config`), §6 (dispatch table, for the payload shapes this API must accept/produce).

## Global Constraints

- **The agent never receives a Supabase credential.** Every `functions/api/agent/*` endpoint authenticates via a per-node shared secret (`Authorization: Bearer <raw node key>`, sha256-hashed and compared against `nodes.api_key_hash`), never a Supabase session token.
- **Job claiming must be genuinely atomic** — two concurrent claim attempts (a real second node, or a client retry racing a slow first response) must never both receive the same job. Implemented as a Postgres function using `FOR UPDATE SKIP LOCKED`, called via `supabase.rpc(...)`, never a plain REST `UPDATE ... LIMIT 1` (PostgREST cannot express the required atomicity).
- **`vpn_secrets.ciphertext`/`nonce` are `bytea` columns.** PostgREST represents `bytea` as a `"\x"`-prefixed hex string over the wire — both on read and on write. Every encrypt/decrypt helper in this plan works in that hex representation; a raw base64 or ArrayBuffer written directly would silently corrupt the column.
- **`VPN_SECRETS_ENCRYPTION_KEY` is a Worker secret, never stored in Supabase** — matches the parent spec's data-model requirement (§4 of the MVP spec) exactly. It is a 256-bit key, hex-encoded (64 hex characters), generated once via `openssl rand -hex 32` or equivalent.
- **`/api/agent/jobs/:id/complete` and `/fail` must be safe to call twice for the same job** (the agent may retry a request whose response it never saw). `complete` checks `status === "done"` and no-ops; `vpn_accounts` writes use `upsert` on the existing unique index so a retried `CREATE_USER` completion never fails on a duplicate-key error.
- **Error responses never echo internals to the caller.** Same pattern as the existing Stripe webhook/checkout-session code: `console.error` the real reason, return a fixed generic JSON body.
- **A Resend send failure must never fail the request that triggered it.** `/fail`'s job-status update is the important side effect; the email is best-effort, wrapped so any failure there only logs, never throws past the caller.
- Every Cloudflare Pages Function follows the reference/existing shape: `export async function onRequestPost({ env, request, params })` (or `onRequestGet`), JSON responses, `Cache-Control: no-store` on anything touching subscription secrets.

---

## Task 1: `nodes` table, `claim_next_job` function, and the node-registration script

**Files:**
- Create: `supabase/migrations/20260921130000_provisioning_agent.sql`
- Create: `scripts/register-node.mjs`

**Interfaces:**
- Produces: `public.nodes(node_id, api_key_hash, created_at, revoked_at)`, `public.claim_next_job(p_node_id text) returns setof provisioning_jobs`. Later tasks (`functions/lib/node-auth.js`, `functions/api/agent/claim.js`) consume both directly.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260921130000_provisioning_agent.sql`:

```sql
-- nodes — one row per VPS the provisioning agent runs on. Only the sha256
-- hash of each node's shared secret is stored; the raw key is generated
-- once by scripts/register-node.mjs and pasted into that VPS's agent
-- config. service_role only — never exposed to anon/authenticated, same
-- revoke-by-default pattern as vpn_secrets/stripe_events.
create table public.nodes (
  node_id text primary key,
  api_key_hash text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

alter table public.nodes enable row level security;
revoke all on public.nodes from anon, authenticated;

-- claim_next_job — atomically claims the oldest pending job for a given
-- node_id. FOR UPDATE SKIP LOCKED is what makes this safe under
-- concurrent callers (two nodes, or a client retrying a slow request):
-- a row already locked by another in-flight claim is simply skipped,
-- never double-claimed. security definer is standard practice for this
-- row-skipping pattern; there is no grant for anon/authenticated to call
-- it directly (revoked below), so this is not a client-facing privilege
-- escalation — only the Worker's service-role code calls it, and only
-- after authenticating the caller's node key itself.
create or replace function public.claim_next_job(p_node_id text)
returns setof public.provisioning_jobs
language sql
security definer
set search_path = ''
as $$
  update public.provisioning_jobs
  set status = 'claimed', claimed_at = now()
  where id = (
    select id from public.provisioning_jobs
    where node_id = p_node_id and status = 'pending'
    order by created_at asc
    limit 1
    for update skip locked
  )
  returning *;
$$;

revoke all on function public.claim_next_job(text) from anon, authenticated, public;

revoke all on all sequences in schema public from anon, authenticated;
```

- [ ] **Step 2: Apply the migration locally and verify**

Run: `npx supabase db reset` (applies all migrations + seed from scratch — this repo's established way of verifying a new migration, per the schema plan).

Expected: succeeds with no errors. Then verify the objects exist:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "\d public.nodes"
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "\df public.claim_next_job"
```

Expected: `nodes` table with the 4 columns; `claim_next_job` listed with `security definer`.

- [ ] **Step 3: Verify anon/authenticated cannot read `nodes` or call `claim_next_job`**

With the local anon key (`npx supabase status` prints it):

```bash
ANON_KEY="<paste local ANON_KEY>"
curl -s "http://127.0.0.1:54321/rest/v1/nodes" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
curl -s -X POST "http://127.0.0.1:54321/rest/v1/rpc/claim_next_job" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H "Content-Type: application/json" -d '{"p_node_id":"node-1"}'
```

Expected: both return an empty/error response — `nodes` is not in the anon-visible schema (revoked), and the RPC is not callable (no grant). Neither call succeeds. Report the actual output.

- [ ] **Step 4: Write the node-registration script**

Create `scripts/register-node.mjs`:

```js
#!/usr/bin/env node
// scripts/register-node.mjs — run manually, once per VPS node, to
// register a provisioning agent's API key. Prints the RAW key exactly
// once; only its sha256 hash is stored server-side from this point on.
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/register-node.mjs <node_id>
import { createClient } from "@supabase/supabase-js";
import { randomBytes, createHash } from "node:crypto";

const nodeId = process.argv[2];
if (!nodeId) {
  console.error("Usage: node scripts/register-node.mjs <node_id>");
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment first.");
  process.exit(1);
}

const rawKey = randomBytes(32).toString("hex");
const keyHash = createHash("sha256").update(rawKey).digest("hex");

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { error } = await supabase
  .from("nodes")
  .upsert({ node_id: nodeId, api_key_hash: keyHash, revoked_at: null });
if (error) {
  console.error("Failed to register node:", error.message);
  process.exit(1);
}

console.log(`Node "${nodeId}" registered.`);
console.log("Raw API key (save this now — it is never shown again, only its hash is stored):");
console.log(rawKey);
```

- [ ] **Step 5: Run it against local Supabase and verify**

```bash
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY="<paste local SERVICE_ROLE_KEY>" node scripts/register-node.mjs node-1
```

Expected: prints "Node \"node-1\" registered." and a 64-hex-character raw key. Save that key — it's used by Task 2's tests as the "known-good" node credential. Verify the row landed: `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "select node_id, revoked_at from public.nodes;"` shows `node-1` with `revoked_at` null.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260921130000_provisioning_agent.sql scripts/register-node.mjs
git commit -m "Add nodes table, claim_next_job function, and node-registration script

Per the VPS provisioning agent design (singbox-vpn spec, §3): a
per-node shared secret (hashed, never the raw key) authenticates the
agent's Worker API calls, and claim_next_job gives genuinely atomic
job claiming via FOR UPDATE SKIP LOCKED — a plain PostgREST UPDATE
cannot express this. Verified locally that anon/authenticated can
neither read nodes nor call the function.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Crypto and node-auth helper libraries

**Files:**
- Create: `functions/lib/crypto.js`
- Create: `functions/lib/node-auth.js`

**Interfaces:**
- Consumes: `public.nodes` table from Task 1.
- Produces: `encryptSecret(plaintext, keyHex) -> Promise<{ ciphertext: string, nonce: string }>`, `decryptSecret(ciphertextHex, nonceHex, keyHex) -> Promise<string>`, `authenticateNode(request, supabaseAdmin) -> Promise<string | null>` (returns the authenticated `node_id`, or `null` if unauthenticated/revoked). Tasks 3-6 and 8 all consume these.

- [ ] **Step 1: Write `functions/lib/crypto.js`**

```js
// AES-GCM encrypt/decrypt for vpn_secrets.ciphertext/nonce, and sha256
// hex for node API key verification. Uses the Workers runtime's native
// Web Crypto (crypto.subtle) — no extra dependency.
//
// vpn_secrets.ciphertext/nonce are Postgres bytea columns. PostgREST
// represents bytea as a "\x"-prefixed hex string over the wire, on both
// read and write — every function here works in that representation, not
// base64 or raw ArrayBuffer, or writes would silently corrupt the column.

function hexToBytes(hex) {
  const clean = hex.startsWith("\\x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToPgHex(bytes) {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `\\x${hex}`;
}

async function importAesKey(keyHex) {
  const keyBytes = hexToBytes(keyHex);
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * @param {string} plaintext
 * @param {string} keyHex - 64-hex-char (256-bit) VPN_SECRETS_ENCRYPTION_KEY
 * @returns {Promise<{ ciphertext: string, nonce: string }>} both as
 *   Postgres-bytea-compatible "\x..." hex strings, ready to insert
 *   directly into vpn_secrets.
 */
export async function encryptSecret(plaintext, keyHex) {
  const key = await importAesKey(keyHex);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    new TextEncoder().encode(plaintext)
  );
  return {
    ciphertext: bytesToPgHex(new Uint8Array(ciphertextBuf)),
    nonce: bytesToPgHex(nonce),
  };
}

/**
 * @param {string} ciphertextHex - "\x..."-prefixed hex, as read back from vpn_secrets
 * @param {string} nonceHex - "\x..."-prefixed hex, as read back from vpn_secrets
 * @param {string} keyHex - 64-hex-char (256-bit) VPN_SECRETS_ENCRYPTION_KEY
 * @returns {Promise<string>} the decrypted plaintext
 */
export async function decryptSecret(ciphertextHex, nonceHex, keyHex) {
  const key = await importAesKey(keyHex);
  const ciphertext = hexToBytes(ciphertextHex);
  const nonce = hexToBytes(nonceHex);
  const plaintextBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext);
  return new TextDecoder().decode(plaintextBuf);
}

/**
 * @param {string} text
 * @returns {Promise<string>} lowercase hex sha256 digest, no "\x" prefix
 *   (this is a lookup key, not a bytea column value).
 */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
```

- [ ] **Step 2: Write `functions/lib/node-auth.js`**

```js
import { sha256Hex } from "./crypto.js";

/**
 * Authenticates a provisioning-agent request via its per-node shared
 * secret (never a Supabase session — the agent has no Supabase
 * credential, per the design's "no inbound admin surface added to the
 * VPS" property applying in reverse: the Worker API is the only thing
 * the agent trusts, and it authenticates with a secret scoped to itself).
 *
 * @param {Request} request
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @returns {Promise<string | null>} the authenticated node_id, or null if
 *   the request has no/invalid/revoked credentials.
 */
export async function authenticateNode(request, supabaseAdmin) {
  const authHeader = request.headers.get("Authorization");
  const rawKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!rawKey) return null;

  const keyHash = await sha256Hex(rawKey);
  const { data, error } = await supabaseAdmin
    .from("nodes")
    .select("node_id, revoked_at")
    .eq("api_key_hash", keyHash)
    .maybeSingle();
  if (error) {
    console.error("authenticateNode: lookup failed:", error.message);
    return null;
  }
  if (!data || data.revoked_at) return null;
  return data.node_id;
}
```

- [ ] **Step 3: Write a throwaway local verification script (not committed) for the crypto round-trip**

```js
// scratch-verify-crypto.mjs (throwaway, not committed) — run with plain
// `node scratch-verify-crypto.mjs`, no Workers runtime needed since
// crypto.subtle is also available in Node 19+.
import { encryptSecret, decryptSecret, sha256Hex } from "./functions/lib/crypto.js";

const key = "00112233445566778899aabbccddeeff00112233445566778899aabbccddee"; // 64 hex chars = 32 bytes
const plaintext = "https://example.com/sub/deadbeef?format=uri";

const { ciphertext, nonce } = await encryptSecret(plaintext, key);
console.log("ciphertext:", ciphertext);
console.log("nonce:", nonce);
console.log("both start with \\x:", ciphertext.startsWith("\\x"), nonce.startsWith("\\x"));

const decrypted = await decryptSecret(ciphertext, nonce, key);
console.log("round-trip matches:", decrypted === plaintext);

const hash = await sha256Hex("some-raw-node-key");
console.log("sha256Hex length (must be 64):", hash.length);
```

Run: `node scratch-verify-crypto.mjs`. Expected: `both start with \x: true true`, `round-trip matches: true`, `sha256Hex length (must be 64): 64`. Report the actual output. Delete the script when done (`rm scratch-verify-crypto.mjs`).

- [ ] **Step 4: Commit**

```bash
git add functions/lib/crypto.js functions/lib/node-auth.js
git commit -m "Add AES-GCM crypto and node-auth helper libraries

encryptSecret/decryptSecret work in Postgres's bytea hex wire format
(\"\\\\x\"-prefixed) directly, since that's what PostgREST expects on
both read and write for vpn_secrets.ciphertext/nonce. authenticateNode
verifies a provisioning agent's per-node shared secret against the
nodes table's hash — the agent never receives a Supabase credential.
Verified the crypto round-trip and hash length locally.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: `POST /api/agent/claim`

**Files:**
- Create: `functions/api/agent/claim.js`

**Interfaces:**
- Consumes: `authenticateNode` (Task 2), `claim_next_job` RPC (Task 1).
- Produces: `POST /api/agent/claim` → `{ job: null }` or `{ job: { id, job_type, payload } }`. The provisioning-agent plan (`singbox-vpn`) consumes this exact response shape.

- [ ] **Step 1: Write `functions/api/agent/claim.js`**

```js
import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../lib/node-auth.js";

export async function onRequestPost({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const nodeId = await authenticateNode(request, supabaseAdmin);
  if (!nodeId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { data, error } = await supabaseAdmin.rpc("claim_next_job", { p_node_id: nodeId });
    if (error) {
      console.error("agent/claim: rpc failed:", error.message);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    const job = data?.[0] ?? null;
    return new Response(
      JSON.stringify({
        job: job ? { id: job.id, job_type: job.job_type, payload: job.payload } : null,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("agent/claim: unexpected error:", err.message);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`. Expected: passes (Functions aren't build-checked, but this confirms nothing else broke).

- [ ] **Step 3: Commit**

```bash
git add functions/api/agent/claim.js
git commit -m "Add POST /api/agent/claim endpoint

Authenticates via the requesting node's shared secret, then calls
claim_next_job to atomically claim that node's oldest pending job.
Returns { job: null } when nothing's pending — no long-polling, the
agent's own poll loop is the interval.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: `POST /api/agent/jobs/:id/complete`

**Files:**
- Create: `functions/api/agent/jobs/[id]/complete.js`

**Interfaces:**
- Consumes: `authenticateNode`, `encryptSecret` (Task 2). Consumes `provisioning_jobs`/`vpn_accounts`/`vpn_secrets` schema (already merged) and `vpn_accounts_user_node_uniq` unique index (already merged, on `user_id, node_id`) for the idempotent upsert.
- Produces: `POST /api/agent/jobs/:id/complete`, body `{ result }`. `result` shape by `job_type`: `CREATE_USER`/`ROTATE_SUBSCRIPTION_TOKEN` → `{ vpn_user_id?, subscription_url }` (`vpn_user_id` required for `CREATE_USER`, not needed for `ROTATE_SUBSCRIPTION_TOKEN` since the account already exists); `SET_EXPIRY`/`ENABLE_USER`/`DISABLE_USER` → `{}`. The provisioning-agent plan produces requests matching this shape.

- [ ] **Step 1: Write `functions/api/agent/jobs/[id]/complete.js`**

```js
import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../../../lib/node-auth.js";
import { encryptSecret } from "../../../../lib/crypto.js";

export async function onRequestPost({ env, request, params }) {
  const jobId = params.id;
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const nodeId = await authenticateNode(request, supabaseAdmin);
  if (!nodeId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const result = body.result ?? {};

  try {
    const { data: job, error: jobError } = await supabaseAdmin
      .from("provisioning_jobs")
      .select("id, job_type, payload, vpn_account_id, node_id, status")
      .eq("id", jobId)
      .maybeSingle();
    if (jobError) {
      console.error("agent/complete: job lookup failed:", jobError.message);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!job || job.node_id !== nodeId) {
      return new Response(JSON.stringify({ error: "Job not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (job.status === "done") {
      // Duplicate report (agent retried a request whose response it
      // never saw) — idempotent no-op, not an error.
      return new Response(JSON.stringify({ ok: true, duplicate: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    let vpnAccountId = job.vpn_account_id;

    if (job.job_type === "CREATE_USER") {
      const { vpn_user_id, subscription_url } = result;
      if (!vpn_user_id || !subscription_url) {
        throw new Error("CREATE_USER complete missing vpn_user_id/subscription_url");
      }
      // upsert, not insert: a retried completion (same job, same
      // user_id+node_id) must not fail on the unique index.
      const { data: account, error: acctError } = await supabaseAdmin
        .from("vpn_accounts")
        .upsert(
          { user_id: job.payload.user_id, vpn_user_id, node_id: job.node_id },
          { onConflict: "user_id,node_id" }
        )
        .select("id")
        .single();
      if (acctError) throw new Error(`vpn_accounts upsert failed: ${acctError.message}`);
      vpnAccountId = account.id;

      const { ciphertext, nonce } = await encryptSecret(subscription_url, env.VPN_SECRETS_ENCRYPTION_KEY);
      const { error: secretError } = await supabaseAdmin
        .from("vpn_secrets")
        .insert({ vpn_account_id: vpnAccountId, ciphertext, nonce });
      if (secretError) throw new Error(`vpn_secrets insert failed: ${secretError.message}`);
    } else if (job.job_type === "ROTATE_SUBSCRIPTION_TOKEN") {
      const { subscription_url } = result;
      if (!subscription_url) {
        throw new Error("ROTATE_SUBSCRIPTION_TOKEN complete missing subscription_url");
      }
      if (!vpnAccountId) {
        throw new Error(`ROTATE_SUBSCRIPTION_TOKEN job ${jobId} has no vpn_account_id`);
      }
      // Append-only: old ciphertext rows are left in place on purpose
      // (an append-only secret history costs nothing and means a bug
      // here can't silently destroy the only working config).
      const { ciphertext, nonce } = await encryptSecret(subscription_url, env.VPN_SECRETS_ENCRYPTION_KEY);
      const { error: secretError } = await supabaseAdmin
        .from("vpn_secrets")
        .insert({ vpn_account_id: vpnAccountId, ciphertext, nonce });
      if (secretError) throw new Error(`vpn_secrets insert failed: ${secretError.message}`);
    }
    // SET_EXPIRY / ENABLE_USER / DISABLE_USER: no additional writes here.

    const { error: updateError } = await supabaseAdmin
      .from("provisioning_jobs")
      .update({
        status: "done",
        completed_at: new Date().toISOString(),
        result,
        vpn_account_id: vpnAccountId,
      })
      .eq("id", jobId);
    if (updateError) throw new Error(`provisioning_jobs update failed: ${updateError.message}`);

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(`agent/complete: failed for job ${jobId}:`, err.message);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`. Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add "functions/api/agent/jobs/[id]/complete.js"
git commit -m "Add POST /api/agent/jobs/:id/complete endpoint

CREATE_USER upserts vpn_accounts (idempotent under a retried
completion) and encrypts the delivered subscription URL into
vpn_secrets. ROTATE_SUBSCRIPTION_TOKEN appends a new vpn_secrets row
without touching old ones. SET_EXPIRY/ENABLE_USER/DISABLE_USER just
mark the job done. Already-done jobs no-op rather than erroring, since
the agent may retry a request whose response it never received.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: `POST /api/agent/jobs/:id/fail` and Resend email alerting

**Files:**
- Create: `functions/lib/resend.js`
- Create: `functions/api/agent/jobs/[id]/fail.js`
- Modify: `.dev.vars.example` (add `RESEND_API_KEY`, `ALERT_FROM_EMAIL`, `VPN_SECRETS_ENCRYPTION_KEY`)

**Interfaces:**
- Consumes: `authenticateNode` (Task 2).
- Produces: `POST /api/agent/jobs/:id/fail`, body `{ error: string }`. `sendFailureAlert(env, { jobId, jobType, userId, error }) -> Promise<void>` (never throws).

- [ ] **Step 1: Write `functions/lib/resend.js`**

```js
// Resend's HTTP API via plain fetch — no SDK dependency, works
// identically under the Workers runtime. Sending is best-effort: a
// failure here must never fail the request that triggered it, since the
// job's status update (already committed by the caller) is the part
// that actually matters.
export async function sendFailureAlert(env, { jobId, jobType, userId, error }) {
  if (!env.RESEND_API_KEY) {
    console.error("resend: RESEND_API_KEY not configured, cannot send failure alert");
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.ALERT_FROM_EMAIL || "onboarding@resend.dev",
        to: "platte-kantig.0o@icloud.com",
        subject: `Arcana provisioning job failed: ${jobType} (job ${jobId})`,
        text: `Job ${jobId} (${jobType}) failed.\nUser: ${userId ?? "unknown"}\nError: ${error}`,
      }),
    });
    if (!res.ok) {
      console.error("resend: failed to send failure alert:", res.status, await res.text());
    }
  } catch (err) {
    console.error("resend: failed to send failure alert:", err.message);
  }
}
```

- [ ] **Step 2: Write `functions/api/agent/jobs/[id]/fail.js`**

```js
import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../../../lib/node-auth.js";
import { sendFailureAlert } from "../../../../lib/resend.js";

export async function onRequestPost({ env, request, params }) {
  const jobId = params.id;
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const nodeId = await authenticateNode(request, supabaseAdmin);
  if (!nodeId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const errorMessage = typeof body.error === "string" ? body.error : "Unknown error";

  try {
    const { data: job, error: jobError } = await supabaseAdmin
      .from("provisioning_jobs")
      .select("id, job_type, payload, node_id, status")
      .eq("id", jobId)
      .maybeSingle();
    if (jobError) {
      console.error("agent/fail: job lookup failed:", jobError.message);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!job || job.node_id !== nodeId) {
      return new Response(JSON.stringify({ error: "Job not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { error: updateError } = await supabaseAdmin
      .from("provisioning_jobs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        result: { error: errorMessage },
      })
      .eq("id", jobId);
    if (updateError) throw new Error(`provisioning_jobs update failed: ${updateError.message}`);

    await sendFailureAlert(env, {
      jobId,
      jobType: job.job_type,
      userId: job.payload?.user_id ?? null,
      error: errorMessage,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(`agent/fail: failed for job ${jobId}:`, err.message);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
```

- [ ] **Step 3: Update `.dev.vars.example`**

Add these lines (after the existing `SITE_URL` line):

```
# VPS provisioning agent (docs/superpowers/specs/2026-09-21-vpn-provisioning-agent-design.md)
VPN_SECRETS_ENCRYPTION_KEY=<64 hex chars — generate with `openssl rand -hex 32`, real value only in production>
RESEND_API_KEY=<paste from Resend dashboard>
# onboarding@resend.dev works without a verified domain, for local/test
# sends only — replace with a real from-address once a domain exists.
ALERT_FROM_EMAIL=onboarding@resend.dev
```

- [ ] **Step 4: Write a throwaway local verification script (not committed)**

Requires local Supabase running with Task 1's migration applied, and a registered node (Task 1 Step 5's raw key), plus the built site served via `npx wrangler pages dev out --port 8788` with `.dev.vars` populated (real or placeholder `RESEND_API_KEY` is fine for this step — a placeholder will just log a failed-send, which is expected and doesn't fail the test).

```js
// scratch-verify-agent-api.mjs (throwaway, not committed)
const ENDPOINT = "http://127.0.0.1:8788";
const NODE_KEY = process.env.NODE_KEY; // the raw key Task 1 Step 5 printed
if (!NODE_KEY) {
  console.error("Set NODE_KEY to the raw key scripts/register-node.mjs printed.");
  process.exit(1);
}

async function call(path, body) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${NODE_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

console.log("=== claim with WRONG key (expect 401) ===");
const wrongRes = await fetch(`${ENDPOINT}/api/agent/claim`, {
  method: "POST",
  headers: { Authorization: "Bearer not_a_real_key" },
});
console.log({ status: wrongRes.status });

console.log("=== claim with no pending jobs (expect { job: null }) ===");
console.log(await call("/api/agent/claim"));

console.log("TEST_USER_ID and job-insert steps: run these via psql before continuing —");
console.log("insert a fresh auth.users row is out of scope for this script; instead use");
console.log("an existing seeded user id from the schema plan's seed.sql, or insert a");
console.log("provisioning_jobs row directly referencing it:");
console.log(`
  insert into public.provisioning_jobs (idempotency_key, node_id, job_type, payload)
  values ('test-create-1', 'node-1', 'CREATE_USER', '{"user_id":"<a real auth.users id>","expires_at":"2027-01-01T00:00:00Z"}');
`);
console.log("Then re-run this script's claim call to fetch it, and manually POST to");
console.log("/api/agent/jobs/<id>/complete and /fail to exercise both paths.");
```

Run it, follow its printed instructions to insert a synthetic job and exercise `claim` → `complete` and a second synthetic job through `claim` → `fail`. Verify via `psql`:
- The 401 case returns 401 with no job claimed.
- `claim` with no pending jobs returns `{ job: null }`.
- After inserting a `CREATE_USER` job and claiming it, `provisioning_jobs.status` is `claimed`.
- After `complete` with `{ result: { vpn_user_id: "test-vpn-user", subscription_url: "https://example.com/sub/test" } }`: `provisioning_jobs.status = 'done'`, a `vpn_accounts` row exists for that user, and a `vpn_secrets` row exists with non-null `ciphertext`/`nonce` starting with `\x`.
- Re-POSTing the same `complete` call returns `{ ok: true, duplicate: true }` and does NOT create a second `vpn_accounts`/`vpn_secrets` row.
- After inserting and claiming a second job, then POSTing `/fail` with `{ error: "test failure" }`: `provisioning_jobs.status = 'failed'`, `result.error = 'test failure'`, and the Function's terminal output shows either a successful Resend call or (with a placeholder key) a logged "resend: failed to send failure alert" — either is fine for this step, the point is the job-status write is correct and unaffected by the email outcome.

Report the actual output and SQL results. Delete the scratch script when done. Stop `wrangler pages dev` and `npx supabase stop` when finished.

- [ ] **Step 5: Commit**

```bash
git add functions/lib/resend.js "functions/api/agent/jobs/[id]/fail.js" .dev.vars.example
git commit -m "Add POST /api/agent/jobs/:id/fail endpoint with Resend failure alerting

A failed job is marked failed (not retried automatically — someone
fixes the underlying cause and manually resets it to pending) and
triggers one best-effort email via Resend's HTTP API. Email-send
failure never fails the request — the job-status write already
committed is what matters. Verified locally end to end: claim ->
complete (including idempotent duplicate handling) and claim -> fail.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Webhook patch — resolve `vpn_account_id`/`vpn_user_id` for `SET_EXPIRY`/`DISABLE_USER`

**Files:**
- Modify: `functions/lib/stripe-events.js`

**Interfaces:**
- Consumes: `public.vpn_accounts` (already merged schema).
- Produces: `SET_EXPIRY`/`DISABLE_USER` `provisioning_jobs` rows now carry `vpn_account_id` and `payload.vpn_user_id`, which Task 3's agent-facing job shape and the provisioning-agent plan both depend on.

This is a small, targeted change to already-merged, already-reviewed code — not a redesign of it. Read the current file in full before editing (it has the `invoice.paid`-driven provisioning logic from the earlier Stripe billing plan).

- [ ] **Step 1: Patch `handleInvoicePaid`'s `SET_EXPIRY` branch**

In `functions/lib/stripe-events.js`, find the block that builds `jobType`/`idempotencyKey`/`payload` for the renewal (non-first-invoice) case. Before that `provisioning_jobs` insert, add a `vpn_accounts` lookup, and change the renewal payload/`vpn_account_id` to use it:

```js
  const isFirstInvoice = invoice.billing_reason === "subscription_create";
  const jobType = isFirstInvoice ? "CREATE_USER" : "SET_EXPIRY";
  const idempotencyKey = isFirstInvoice
    ? `create-user:${subscriptionId}`
    : `set-expiry:${subscriptionId}:${currentPeriodEnd}`;

  let vpnAccountId = null;
  let payload;
  if (isFirstInvoice) {
    payload = { user_id: sub.user_id, expires_at: currentPeriodEnd };
  } else {
    // A renewal targets an existing vpn_accounts row — resolve it now so
    // the provisioning agent's job payload carries vpn_user_id directly
    // rather than needing its own Supabase lookup (it has no Supabase
    // credential at all, by design).
    const { data: vpnAccount, error: vpnAccountError } = await supabaseAdmin
      .from("vpn_accounts")
      .select("id, vpn_user_id")
      .eq("user_id", sub.user_id)
      .eq("node_id", "node-1")
      .maybeSingle();
    if (vpnAccountError) {
      throw new Error(`vpn_accounts lookup failed: ${vpnAccountError.message}`);
    }
    if (!vpnAccount) {
      // The account's CREATE_USER job hasn't been processed by the agent
      // yet — a real race (Stripe can fire a renewal before the first
      // job is claimed). Throw so this retries, same transient-vs-
      // permanent reasoning already used elsewhere in this file, rather
      // than enqueueing a job with no vpn_user_id to act on.
      throw new Error(`no vpn_accounts row for user_id=${sub.user_id} yet`);
    }
    vpnAccountId = vpnAccount.id;
    payload = { vpn_user_id: vpnAccount.vpn_user_id, expires_at: currentPeriodEnd };
  }

  const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
    idempotency_key: idempotencyKey,
    node_id: "node-1",
    job_type: jobType,
    vpn_account_id: vpnAccountId,
    payload,
  });
  if (jobError && jobError.code !== "23505") {
    throw new Error(`provisioning_jobs insert failed: ${jobError.message}`);
  }
```

This replaces the existing `const payload = isFirstInvoice ? {...} : {...}` ternary and the `provisioning_jobs` insert immediately after it — keep everything above it (the `sub`/`currentPeriodEnd` lookup) unchanged.

- [ ] **Step 2: Patch `handleSubscriptionUpdated`'s `DISABLE_USER` branch**

Find the block inside `if (subscription.status === "canceled" || subscription.status === "unpaid")` that inserts the `DISABLE_USER` job. Add the same kind of lookup before it:

```js
  if (subscription.status === "canceled" || subscription.status === "unpaid") {
    const { data: vpnAccount, error: vpnAccountError } = await supabaseAdmin
      .from("vpn_accounts")
      .select("id, vpn_user_id")
      .eq("user_id", updated.user_id)
      .eq("node_id", "node-1")
      .maybeSingle();
    if (vpnAccountError) {
      throw new Error(`vpn_accounts lookup failed: ${vpnAccountError.message}`);
    }
    if (!vpnAccount) {
      // Same transient-vs-permanent reasoning as handleInvoicePaid: the
      // account may not be provisioned yet. Throw so this retries.
      throw new Error(`no vpn_accounts row for user_id=${updated.user_id} yet`);
    }

    const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
      idempotency_key: `disable-user:${subscription.id}`,
      node_id: "node-1",
      job_type: "DISABLE_USER",
      vpn_account_id: vpnAccount.id,
      payload: {
        vpn_user_id: vpnAccount.vpn_user_id,
        user_id: updated.user_id,
        stripe_subscription_id: subscription.id,
      },
    });
    if (jobError && jobError.code !== "23505") {
      throw new Error(`provisioning_jobs insert failed: ${jobError.message}`);
    }
  }
```

- [ ] **Step 3: Patch `handleSubscriptionDeleted`'s `DISABLE_USER` insert the same way**

Find the `provisioning_jobs` insert near the end of `handleSubscriptionDeleted` (after the `if (!updated) { ... return; }` early-return block). Apply the identical lookup-then-insert pattern as Step 2, using `updated.user_id` from that function's own `subscriptions` update result.

- [ ] **Step 4: Write a throwaway local verification script (not committed) extending the Stripe billing plan's original webhook test**

Requires local Supabase running with all migrations applied (including this plan's Task 1 migration) and `npx wrangler pages dev out --port 8788` running with `.dev.vars` populated (placeholder Stripe values are fine, same as the original Stripe webhook plan — this only exercises the local webhook endpoint with synthetic signed events, no real Stripe account needed).

```js
// scratch-verify-vpn-account-resolution.mjs (throwaway, not committed)
import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const SIGNING_SECRET = "whsec_test_local_secret_for_synthetic_events_only"; // must match .dev.vars
const ENDPOINT = "http://127.0.0.1:8788/api/stripe-webhook";
const TEST_USER_ID = randomUUID();
const SUB_ID = `sub_synthetic_${TEST_USER_ID.slice(0, 8)}`;

const supabaseAdmin = createClient(
  "http://127.0.0.1:54321",
  process.env.SERVICE_ROLE_KEY, // paste from `npx supabase status`
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const webCrypto = Stripe.createSubtleCryptoProvider();
async function post(event) {
  const payload = JSON.stringify(event);
  const header = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: SIGNING_SECRET,
    cryptoProvider: webCrypto,
  });
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Stripe-Signature": header, "Content-Type": "application/json" },
    body: payload,
  });
  return { status: res.status, body: await res.text() };
}

const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

console.log("=== checkout.session.completed ===");
console.log(
  await post({
    id: "evt_vpn_checkout_1",
    type: "checkout.session.completed",
    data: {
      object: {
        mode: "subscription",
        client_reference_id: TEST_USER_ID,
        customer: "cus_synthetic_test",
        subscription: SUB_ID,
      },
    },
  })
);

console.log("=== invoice.paid, subscription_create (before any vpn_accounts row exists — must succeed, vpn_account_id null in the job) ===");
console.log(
  await post({
    id: "evt_vpn_invoice_1",
    type: "invoice.paid",
    data: {
      object: {
        id: "in_synthetic_1",
        billing_reason: "subscription_create",
        parent: { subscription_details: { subscription: SUB_ID } },
        lines: { data: [{ period: { start: periodEnd - 30 * 24 * 3600, end: periodEnd } }] },
      },
    },
  })
);

console.log("Now manually insert a vpn_accounts row simulating the agent's CREATE_USER completion:");
const { data: account, error } = await supabaseAdmin
  .from("vpn_accounts")
  .insert({ user_id: TEST_USER_ID, vpn_user_id: "test-vpn-user-1", node_id: "node-1" })
  .select("id")
  .single();
if (error) throw error;
console.log("vpn_accounts row created:", account.id);

const renewalPeriodEnd = periodEnd + 30 * 24 * 3600;
console.log("=== invoice.paid, subscription_cycle (renewal — must resolve vpn_account_id/vpn_user_id now) ===");
console.log(
  await post({
    id: "evt_vpn_invoice_2",
    type: "invoice.paid",
    data: {
      object: {
        id: "in_synthetic_2",
        billing_reason: "subscription_cycle",
        parent: { subscription_details: { subscription: SUB_ID } },
        lines: { data: [{ period: { start: periodEnd, end: renewalPeriodEnd } }] },
      },
    },
  })
);

console.log("=== customer.subscription.updated, status=unpaid (-> DISABLE_USER, must resolve vpn_account_id/vpn_user_id) ===");
console.log(
  await post({
    id: "evt_vpn_updated_1",
    type: "customer.subscription.updated",
    data: {
      object: { id: SUB_ID, status: "unpaid", items: { data: [{ current_period_end: renewalPeriodEnd }] } },
    },
  })
);

console.log("TEST_USER_ID:", TEST_USER_ID, "SUB_ID:", SUB_ID, "vpn_account_id:", account.id);
```

Run: `SERVICE_ROLE_KEY="<paste>" node scratch-verify-vpn-account-resolution.mjs`. Then verify via `psql`:
- The `subscription_create` job (first `invoice.paid`) has `vpn_account_id = null` in its `provisioning_jobs` row (correct — no account exists yet at that point).
- The `subscription_cycle` (renewal) job's `provisioning_jobs` row has `vpn_account_id` matching the manually-inserted account's id, and `payload->>'vpn_user_id' = 'test-vpn-user-1'`.
- The `DISABLE_USER` job's row also has `vpn_account_id` set and `payload->>'vpn_user_id' = 'test-vpn-user-1'`.

Report the actual output and SQL results. Delete the scratch script when done.

- [ ] **Step 5: Commit**

```bash
git add functions/lib/stripe-events.js
git commit -m "Resolve vpn_account_id/vpn_user_id at job-insertion time for renewals/disables

SET_EXPIRY and DISABLE_USER jobs now carry vpn_account_id and
payload.vpn_user_id, resolved via a vpn_accounts lookup at insert
time — the provisioning agent has no Supabase credential, so it can't
do this lookup itself. A missing vpn_accounts row (CREATE_USER job not
yet processed) throws, using the same transient-vs-permanent retry
reasoning already established in this file, rather than enqueueing an
unusable job. Verified locally with synthetic signed events plus a
manually-inserted vpn_accounts row standing in for the agent's own
CREATE_USER completion.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: `GET /api/vpn/config`

**Files:**
- Create: `functions/api/vpn/config.js`

**Interfaces:**
- Consumes: `decryptSecret` (Task 2). Consumes `subscriptions`, `vpn_accounts`, `vpn_secrets` (already merged schema).
- Produces: `GET /api/vpn/config` (Bearer Supabase access token) → `{ subscription_url }` on success, or a 401/403/404 with a fixed error body. A later dashboard-integration task (not part of this plan) consumes this.

- [ ] **Step 1: Write `functions/api/vpn/config.js`**

```js
import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../../lib/crypto.js";

export async function onRequestGet({ env, request }) {
  const noStoreJson = (body, status) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const authHeader = request.headers.get("Authorization");
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) {
    return noStoreJson({ error: "Authorization required" }, 401);
  }

  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const {
      data: { user },
      error: tokenError,
    } = await supabaseAdmin.auth.getUser(accessToken);
    if (tokenError || !user) {
      return noStoreJson({ error: "Invalid or expired token" }, 401);
    }

    const { data: subscription, error: subError } = await supabaseAdmin
      .from("subscriptions")
      .select("status")
      .eq("user_id", user.id)
      .maybeSingle();
    if (subError) throw new Error(`subscriptions lookup failed: ${subError.message}`);
    if (!subscription || subscription.status !== "active") {
      return noStoreJson({ error: "No active subscription" }, 403);
    }

    const { data: vpnAccount, error: vpnAccountError } = await supabaseAdmin
      .from("vpn_accounts")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (vpnAccountError) throw new Error(`vpn_accounts lookup failed: ${vpnAccountError.message}`);
    if (!vpnAccount) {
      return noStoreJson({ error: "Provisioning still in progress" }, 404);
    }

    const { data: secret, error: secretError } = await supabaseAdmin
      .from("vpn_secrets")
      .select("ciphertext, nonce")
      .eq("vpn_account_id", vpnAccount.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (secretError) throw new Error(`vpn_secrets lookup failed: ${secretError.message}`);
    if (!secret) {
      return noStoreJson({ error: "Provisioning still in progress" }, 404);
    }

    const subscriptionUrl = await decryptSecret(secret.ciphertext, secret.nonce, env.VPN_SECRETS_ENCRYPTION_KEY);
    return noStoreJson({ subscription_url: subscriptionUrl }, 200);
  } catch (err) {
    console.error("vpn/config: failed:", err.message);
    return noStoreJson({ error: "Internal error" }, 500);
  }
}
```

- [ ] **Step 2: Write a throwaway local verification script (not committed)**

Requires the state left over from Task 6 Step 4's script (a `TEST_USER_ID` with an `active`-ish `subscriptions` row and a `vpn_accounts` row) — if that state was already torn down, re-run enough of Task 6's script to recreate a `vpn_accounts` row for a fresh user, then manually set that user's `subscriptions.status = 'active'` via `psql`, and insert one `vpn_secrets` row for them using Task 2's crypto helpers directly (or via Task 4's `complete` endpoint against a synthetic `CREATE_USER` job, which is the more realistic path).

```js
// scratch-verify-vpn-config.mjs (throwaway, not committed)
const ENDPOINT = "http://127.0.0.1:8788/api/vpn/config";

console.log("=== no Authorization header (expect 401) ===");
console.log(await (await fetch(ENDPOINT)).text());

console.log("=== garbage bearer token (expect 401) ===");
console.log(
  await (
    await fetch(ENDPOINT, { headers: { Authorization: "Bearer garbage" } })
  ).text()
);

console.log("=== valid token, active subscription, provisioned account (expect 200 + subscription_url matching what was encrypted) ===");
const TOKEN = process.env.ACCESS_TOKEN; // sign in as the test user via /auth/v1/token, same as the Stripe checkout live-verification steps
console.log(await (await fetch(ENDPOINT, { headers: { Authorization: `Bearer ${TOKEN}` } })).text());
```

Run: `ACCESS_TOKEN="<paste a real access token for the test user>" node scratch-verify-vpn-config.mjs`. Expected: both auth-gate cases 401; the valid case returns `{ subscription_url: "..." }` matching exactly what was encrypted for that user's `vpn_secrets` row, with `Cache-Control: no-store` in the response headers (verify with `curl -i` if the script doesn't print headers). Report the actual output. Delete the scratch script when done.

- [ ] **Step 3: Commit**

```bash
git add functions/api/vpn/config.js
git commit -m "Add GET /api/vpn/config for the dashboard to retrieve a provisioned config

Supabase-session-gated (same Bearer pattern as create-checkout-session),
checks subscriptions.status is active, decrypts the latest vpn_secrets
row for the caller's vpn_accounts, returns with Cache-Control: no-store.
404s with a distinct 'still in progress' message when provisioning
hasn't landed yet, rather than a generic error. Verified locally: both
auth-gate failures, and a successful decrypt matching what was encrypted.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Explicitly not in this plan

- The provisioning-agent binary itself (`apps/provisioning-agent` in `singbox-vpn`) that actually calls this API — separate plan in that repo.
- Dashboard UI changes to call `GET /api/vpn/config` and display the result — small follow-up once both this plan and the agent plan are done and can be tested together.
- §7 misuse-detection sampling — confirmed out of scope during brainstorming.
- Deploying to a real VPS/registering a real node in production — `scripts/register-node.mjs` is ready for that once a real VPS exists (spec §9 prerequisite), but running it against production is an operator action, not part of this plan's testing.
