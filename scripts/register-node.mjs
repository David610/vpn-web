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
