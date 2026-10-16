import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../lib/node-auth.js";
import { decryptSecret } from "../../lib/crypto.js";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });

const ENTITLEMENT_FALLBACK_CONCURRENCY = 5;
const BATCH_RETRY_MS = 60_000;
let batchUnsupportedUntil = 0;

export function resetEntitlementBatchSupport() {
  batchUnsupportedUntil = 0;
}

function isMissingFunction(error) {
  return error?.code === "PGRST202" || error?.code === "42883" || /could not find the function/i.test(error?.message ?? "");
}

async function entitlementsFor(db, deviceIds) {
  const entitled = new Map();
  if (deviceIds.length === 0) return entitled;
  if (Date.now() >= batchUnsupportedUntil) {
    const { data, error } = await db.rpc("device_entitlements_batch", { p_device_ids: deviceIds });
    if (!error) {
      for (const row of data ?? []) entitled.set(row.device_id, row.entitled === true);
      for (const id of deviceIds) if (!entitled.has(id)) entitled.set(id, false);
      return entitled;
    }
    if (!isMissingFunction(error)) throw new Error("entitlement lookup failed");
    batchUnsupportedUntil = Date.now() + BATCH_RETRY_MS;
  }
  const queue = [...deviceIds];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const { data, error } = await db.rpc("device_entitlement", { p_device_id: id });
      if (error) throw new Error("entitlement lookup failed");
      const row = Array.isArray(data) ? data[0] : data;
      entitled.set(id, row?.entitled === true);
    }
  };
  await Promise.all(Array.from({ length: Math.min(ENTITLEMENT_FALLBACK_CONCURRENCY, queue.length) }, worker));
  return entitled;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Everything that decides what the node must enforce, without any plaintext
// secret: an unchanged ETag lets the node skip the response body, and lets
// this handler skip every decryption.
async function projectAuthorizations(rows, db, { legacy }) {
  const principals = [...new Set(rows.map((row) => row.principal_id))];
  const { data: devices, error: deviceError } = principals.length
    ? await db.from("external_vpn_devices").select("device_id,principal_id,revoked_at").in("principal_id", principals)
    : { data: [], error: null };
  if (deviceError) throw new Error("device lookup failed");
  const deviceByPrincipal = new Map((devices ?? []).map((device) => [device.principal_id, device]));
  const liveDeviceIds = [...new Set(principals.flatMap((principal) => {
    const device = deviceByPrincipal.get(principal);
    return device && !device.revoked_at ? [device.device_id] : [];
  }))];
  const entitledByDevice = await entitlementsFor(db, liveDeviceIds);
  return rows.map((row) => {
    const device = deviceByPrincipal.get(row.principal_id);
    const entitled = !!device && !device.revoked_at && entitledByDevice.get(device.device_id) === true;
    return { row, legacy, revoked: row.revoked || !entitled };
  });
}

async function snapshotEtag(schema, revision, projected) {
  const parts = projected.map(({ row, legacy, revoked }) => [
    row.principal_id, row.credential_id, row.class ?? row.credential_class,
    legacy ? row.logical_route_id : "", row.valid_from, row.valid_until, revoked ? 1 : 0,
    row.credential_ciphertext, row.credential_nonce,
  ].join(""));
  return `"${await sha256Hex([schema, revision, ...parts].join(""))}"`;
}

function etagMatches(header, etag) {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === etag || value === `W/${etag}`;
  });
}

async function renderAuthorizations(projected, env) {
  return Promise.all(projected.map(async ({ row, legacy, revoked }) => ({
    principal_id: row.principal_id,
    credential_id: row.credential_id,
    class: row.class ?? row.credential_class,
    ...(legacy ? { logical_route_id: row.logical_route_id } : {}),
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    revoked,
    protocol: JSON.parse(await decryptSecret(row.credential_ciphertext, row.credential_nonce, env.VPN_SECRETS_ENCRYPTION_KEY)),
  })));
}

async function respondConditionally(request, env, { schema, revision, projected, envelope }) {
  const etag = await snapshotEtag(schema, revision, projected);
  const base = { "Cache-Control": "no-store", ETag: etag };
  if (etagMatches(request.headers.get("If-None-Match"), etag)) return new Response(null, { status: 304, headers: base });
  const authorizations = await renderAuthorizations(projected, env);
  return new Response(JSON.stringify(envelope(authorizations)), { status: 200, headers: { ...headers, ETag: etag } });
}

export async function onRequestGet({ env, request }) {
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const nodeId = await authenticateNode(request, db);
  if (!nodeId) return response({ error: "Unauthorized" }, 401);
  const schema = new URL(request.url).searchParams.get("schema");
  if (schema !== null && schema !== "2") return response({ error: "Unsupported authorization schema" }, 400);
  try {
    if (schema === "2") {
      const { data, error } = await db.rpc("get_compatibility_authorization_snapshot", { p_node_id: nodeId });
      if (error) throw new Error("snapshot lookup failed");
      const snapshot = Array.isArray(data) ? data[0] : data;
      const revision = Number(snapshot?.snapshot_revision ?? 0);
      const projected = await projectAuthorizations(snapshot?.authorizations ?? [], db, { legacy: false });
      return await respondConditionally(request, env, {
        schema: "2", revision, projected,
        envelope: (authorizations) => ({ schema_version: 2, snapshot_revision: revision, authorizations }),
      });
    }

    // Unversioned GET is frozen as the legacy vpn-web contract throughout the
    // transition. In particular it retains logical_route_id and has no schema
    // or snapshot fields.
    const { data, error } = await db.from("compatibility_authorizations")
      .select("principal_id,credential_id,credential_class,logical_route_id,valid_from,valid_until,revoked,credential_ciphertext,credential_nonce")
      .eq("node_id", nodeId);
    if (error) throw new Error("authorization lookup failed");
    const projected = await projectAuthorizations(data ?? [], db, { legacy: true });
    return await respondConditionally(request, env, {
      schema: "legacy", revision: "", projected, envelope: (authorizations) => ({ authorizations }),
    });
  } catch {
    return response({ error: "Internal error" }, 500);
  }
}

export async function onRequestPost({ env, request }) {
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const nodeId = await authenticateNode(request, db);
  if (!nodeId) return response({ error: "Unauthorized" }, 401);
  if (new URL(request.url).searchParams.get("schema") !== "2") return response({ error: "Schema 2 is required" }, 400);
  let body;
  try { body = await request.json(); } catch { return response({ error: "Invalid JSON" }, 400); }
  if (body?.schema_version !== 2 || !Number.isSafeInteger(body?.snapshot_revision) || body.snapshot_revision < 0) {
    return response({ error: "Invalid acknowledgement" }, 400);
  }
  const { data, error } = await db.rpc("ack_compatibility_authorization_snapshot", {
    p_node_id: nodeId, p_snapshot_revision: body.snapshot_revision,
  });
  if (error) {
    if (/future_snapshot_revision/.test(error.message ?? "")) return response({ error: "Snapshot revision is newer than desired" }, 409);
    return response({ error: "Internal error" }, 500);
  }
  const result = Array.isArray(data) ? data[0] : data;
  return response({ schema_version: 2, desired_revision: Number(result.desired_revision), applied_revision: Number(result.applied_revision), state: result.state });
}
