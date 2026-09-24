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

// A plain upsert can't distinguish "brand-new node" from "rotate this
// node's key": lifecycle_state is NOT NULL with no default (deliberately —
// see the fleet-foundations migration), so it must be set on insert, but
// re-running this script against an existing node to rotate its key must
// leave its current lifecycle_state (e.g. READY, DRAINING) untouched
// rather than resetting it back to PROVISIONING.
const { data: existing, error: lookupError } = await supabase
  .from("nodes")
  .select("node_id")
  .eq("node_id", nodeId)
  .maybeSingle();
if (lookupError) {
  console.error("Failed to look up node:", lookupError.message);
  process.exit(1);
}

const { error } = existing
  ? await supabase
      .from("nodes")
      .update({ api_key_hash: keyHash, revoked_at: null })
      .eq("node_id", nodeId)
  : await supabase
      .from("nodes")
      .insert({ node_id: nodeId, api_key_hash: keyHash, revoked_at: null, lifecycle_state: "PROVISIONING" });
if (error) {
  console.error("Failed to register node:", error.message);
  process.exit(1);
}

console.log(`Node "${nodeId}" registered.`);
console.log("Raw API key (save this now — it is never shown again, only its hash is stored):");
console.log(rawKey);
