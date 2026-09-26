import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../../lib/node-auth.js";
import { encryptSecret } from "../../../lib/crypto.js";
import { LEASE_LIMITS } from "../../../lib/vpn-authorize.js";

/**
 * POST /api/agent/leases/sync -- ADR-0003 lease-pool reconciliation.
 *
 * The provisioning agent reports its full local lease pool every poll:
 *   { slots: [{ slot, generation, valid_until, vless_uuid?, hysteria2_password? }],
 *     hysteria2_obfs_password?: string | null,
 *     policy?: { rotation_batch_interval_secs, slot_lifetime_secs } }
 * `policy` is the node's rotation grid and slot lifetime; renewals are
 * computed on it so the returned expires_at is what the node enforces.
 * A slot generation is reported only AFTER vpn-admin applied it to the live
 * sing-box config, so a new generation becomes leasable immediately. Secrets
 * are sent only for generations the control plane has not stored yet (the
 * agent learns which from `need_secret` / the returned generations) and are
 * encrypted here before they reach Postgres. Nothing here is ever logged.
 *
 * Response: { as_of, min_remaining_seconds, obfs_stored, need_secret: [slot],
 *             slots: [{ slot, generation, state, urgent, extend_to }] }
 * where state is active | leased | revoked. The agent rotates `revoked`
 * slots at its next batch boundary (immediately when `urgent`), adopts
 * `extend_to` for leased slots (renewal; no sing-box restart), and never
 * relies on this response for expiry: every slot's valid_until is enforced
 * on the node regardless.
 */
export const MAX_SLOTS = 1024;
// A node must not mint credentials that outlive this, whatever its clock
// or config says; keeps a buggy agent from publishing long-lived secrets.
export const MAX_SLOT_LIFETIME_MS = 2 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASSWORD_RE = /^[\x21-\x7e]{16,128}$/;

export function validatePolicy(policy) {
  if (policy === undefined || policy === null) return { policy: null };
  const grid = policy.rotation_batch_interval_secs;
  const life = policy.slot_lifetime_secs;
  if (!Number.isInteger(grid) || grid < 60 || grid > 3600 || !Number.isInteger(life) || life < 900 || life > 7200) {
    return { error: "policy must be {rotation_batch_interval_secs: 60..3600, slot_lifetime_secs: 900..7200}" };
  }
  return { policy: { rotation_batch_interval_secs: grid, slot_lifetime_secs: life } };
}

export function validateSlots(body, now = Date.now()) {
  const slots = body?.slots;
  if (!Array.isArray(slots) || slots.length > MAX_SLOTS) return { error: `slots must be an array of at most ${MAX_SLOTS}` };
  const seen = new Set();
  const out = [];
  for (const item of slots) {
    const { slot, generation, valid_until: validUntil, vless_uuid: uuid, hysteria2_password: password } = item ?? {};
    if (!Number.isInteger(slot) || slot < 0 || slot >= 4096 || seen.has(slot)) return { error: "slot must be a unique integer in [0, 4096)" };
    seen.add(slot);
    if (!Number.isSafeInteger(generation) || generation < 1) return { error: "generation must be a positive integer" };
    const until = typeof validUntil === "string" ? new Date(validUntil).getTime() : NaN;
    if (!Number.isFinite(until) || until > now + MAX_SLOT_LIFETIME_MS) return { error: "valid_until must be an RFC3339 time at most 2h ahead" };
    const hasSecret = uuid !== undefined || password !== undefined;
    if (hasSecret && (!UUID_RE.test(uuid ?? "") || !PASSWORD_RE.test(password ?? ""))) {
      return { error: "vless_uuid/hysteria2_password are malformed" };
    }
    out.push({ slot, generation, validUntil: new Date(until).toISOString(), secret: hasSecret ? { vless_uuid: uuid.toLowerCase(), hysteria2_password: password } : null });
  }
  return { slots: out };
}

export async function onRequestPost({ env, request }) {
  const json = (body, status) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const nodeId = await authenticateNode(request, supabaseAdmin);
  if (!nodeId) return json({ error: "Unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const { slots, error: validationError } = validateSlots(body);
  if (validationError) return json({ error: validationError }, 400);
  const { policy, error: policyError } = validatePolicy(body.policy);
  if (policyError) return json({ error: policyError }, 400);
  const obfs = body.hysteria2_obfs_password;
  if (obfs !== undefined && obfs !== null && !PASSWORD_RE.test(obfs)) {
    return json({ error: "hysteria2_obfs_password is malformed" }, 400);
  }

  try {
    const payload = [];
    for (const s of slots) {
      const row = { slot: s.slot, generation: s.generation, valid_until: s.validUntil };
      if (s.secret) {
        const { ciphertext, nonce } = await encryptSecret(JSON.stringify(s.secret), env.VPN_SECRETS_ENCRYPTION_KEY);
        row.credential_ciphertext = ciphertext;
        row.credential_nonce = nonce;
      }
      payload.push(row);
    }
    let obfsStored = false;
    if (obfs !== undefined) {
      const secret = obfs === null ? { ciphertext: null, nonce: null } : await encryptSecret(obfs, env.VPN_SECRETS_ENCRYPTION_KEY);
      const { error: obfsError } = await supabaseAdmin.from("node_transport_secrets").upsert(
        {
          node_id: nodeId,
          hysteria2_obfs_ciphertext: secret.ciphertext,
          hysteria2_obfs_nonce: secret.nonce,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "node_id" }
      );
      if (obfsError) {
        console.error("agent/leases/sync: obfs upsert failed:", obfsError.message);
        return json({ error: "Internal error" }, 500);
      }
      obfsStored = true;
    }
    const { data, error } = await supabaseAdmin.rpc("agent_sync_lease_slots", {
      p_node_id: nodeId,
      p_slots: payload,
      p_policy: policy,
    });
    if (error) {
      console.error("agent/leases/sync: rpc failed:", error.message);
      return json({ error: "Internal error" }, 500);
    }
    return json({ ...data, min_remaining_seconds: LEASE_LIMITS.minRemainingSeconds, obfs_stored: obfsStored }, 200);
  } catch (err) {
    console.error("agent/leases/sync: failed:", err.message);
    return json({ error: "Internal error" }, 500);
  }
}
