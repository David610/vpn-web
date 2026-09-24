/**
 * Connection configurations on the website ("connection_profiles"): a named
 * routing policy — Automatic, one location (1 server) or entry + exit
 * (2 servers) — that devices can be assigned to. Changing one re-places the
 * devices using it; placement stays fail-closed (device-provisioning.js).
 */
import { getAccountForUser, getEffectiveEntitlement } from "./accounts.js";
import { syncAccountProvisioningToEntitlement } from "./provision-entitlement.js";

const MODES = new Set(["AUTO", "DIRECT", "DOUBLE_HOP"]);
const NAME = /^[^\u0000-\u001f]{1,40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_PROFILES = 20;

const ok = (body = { ok: true }, status = 200) => ({ status, body });
const fail = (status, error) => ({ status, body: { error } });

async function enabledLocation(db, id) {
  if (!UUID.test(String(id ?? ""))) return false;
  const { data, error } = await db.from("locations").select("id").eq("id", id).eq("enabled", true).maybeSingle();
  if (error) throw new Error(`locations lookup failed: ${error.message}`);
  return !!data;
}

async function pathAllowed(db, entryId, exitId) {
  let q = db.from("allowed_paths").select("id").eq("exit_location_id", exitId).eq("enabled", true);
  q = entryId ? q.eq("entry_location_id", entryId) : q.is("entry_location_id", null);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`allowed_paths lookup failed: ${error.message}`);
  return !!data;
}

/** Validates a profile body into a row, or returns a user-safe error. */
async function toRow(db, body) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!NAME.test(name)) return { error: "Give the configuration a name of 1–40 characters." };
  const mode = body?.routingMode;
  if (!MODES.has(mode)) return { error: "Choose Automatic, 1 server or 2 servers." };
  const entry = mode === "DOUBLE_HOP" ? body?.entryLocationId ?? null : null;
  const exit = mode === "AUTO" ? null : body?.exitLocationId ?? null;
  if (mode !== "AUTO" && !(await enabledLocation(db, exit))) return { error: "Choose an available location." };
  if (mode === "DOUBLE_HOP") {
    if (!(await enabledLocation(db, entry))) return { error: "Choose an available entry location." };
    if (entry === exit) return { error: "Entry and exit must be different locations." };
  }
  if (mode !== "AUTO" && !(await pathAllowed(db, entry, exit))) {
    return { error: "That route is not offered. Choose another location." };
  }
  return {
    row: {
      name,
      routing_mode: mode,
      preferred_entry_location_id: entry,
      preferred_exit_location_id: exit,
      enabled: body?.enabled === undefined ? true : body.enabled === true,
    },
  };
}

async function reconcile(db, env, accountId, prefix) {
  const entitlement = await getEffectiveEntitlement(db, accountId);
  if (entitlement) await syncAccountProvisioningToEntitlement(db, accountId, entitlement, prefix, env);
}

async function accountOf(db, user) {
  const account = await getAccountForUser(db, user.id);
  if (!account) throw new Error(`user ${user.id} has no account_members row`);
  return account;
}

export async function createProfile(db, env, user, body) {
  const account = await accountOf(db, user);
  const { data: existing, error: countError } = await db
    .from("connection_profiles")
    .select("id")
    .eq("account_id", account.accountId);
  if (countError) throw new Error(`connection_profiles count failed: ${countError.message}`);
  if ((existing ?? []).length >= MAX_PROFILES) return fail(409, `You can keep up to ${MAX_PROFILES} configurations.`);
  const { row, error } = await toRow(db, body);
  if (error) return fail(400, error);
  const { data, error: insertError } = await db
    .from("connection_profiles")
    .insert({ ...row, account_id: account.accountId })
    .select("id")
    .single();
  if (insertError) throw new Error(`connection_profiles insert failed: ${insertError.message}`);
  return ok({ ok: true, id: data.id }, 201);
}

async function ownProfile(db, account, id) {
  if (!UUID.test(String(id ?? ""))) return null;
  const { data, error } = await db
    .from("connection_profiles")
    .select("id, account_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`connection_profiles lookup failed: ${error.message}`);
  return data && data.account_id === account.accountId ? data : null;
}

export async function updateProfile(db, env, user, id, body) {
  const account = await accountOf(db, user);
  const profile = await ownProfile(db, account, id);
  if (!profile) return fail(404, "Configuration not found.");
  const { row, error } = await toRow(db, body);
  if (error) return fail(400, error);
  const { error: updateError } = await db
    .from("connection_profiles")
    .update({ ...row, updated_at: new Date().toISOString() })
    .eq("id", profile.id);
  if (updateError) throw new Error(`connection_profiles update failed: ${updateError.message}`);
  await reconcile(db, env, account.accountId, `profile-updated:${profile.id}:${Date.now()}`);
  return ok();
}

/** Devices using a deleted configuration fall back to Automatic. */
export async function deleteProfile(db, env, user, id) {
  const account = await accountOf(db, user);
  const profile = await ownProfile(db, account, id);
  if (!profile) return fail(404, "Configuration not found.");
  const { error: unassignError } = await db
    .from("device_profile_assignments")
    .delete()
    .eq("profile_id", profile.id);
  if (unassignError) throw new Error(`assignments delete failed: ${unassignError.message}`);
  const { error } = await db.from("connection_profiles").delete().eq("id", profile.id);
  if (error) throw new Error(`connection_profiles delete failed: ${error.message}`);
  await reconcile(db, env, account.accountId, `profile-deleted:${profile.id}`);
  return ok();
}
