#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { fleetClaimTokenReadiness } from "../functions/lib/node-capabilities.js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const expectedRef = process.env.ARCANA_PROJECT_REF;
const reviewedCommit = process.env.ARCANA_EXPECTED_COMMIT;
if (!url || !key || !expectedRef || !reviewedCommit) {
  console.error("Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ARCANA_PROJECT_REF, and ARCANA_EXPECTED_COMMIT");
  process.exit(2);
}
let actualRef;
try { actualRef = new URL(url).hostname.split(".")[0]; } catch { /* handled below */ }
if (!actualRef || actualRef !== expectedRef || !/^[a-z0-9]{8,40}$/.test(expectedRef)) {
  console.error("Target project identity is uncertain; URL project ref does not exactly match ARCANA_PROJECT_REF");
  process.exit(2);
}
if (!/^[0-9a-f]{40}$/.test(reviewedCommit)) {
  console.error("ARCANA_EXPECTED_COMMIT must be the full reviewed 40-character git SHA");
  process.exit(2);
}

console.log(`Target Supabase project: ${actualRef}`);
const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const result = await fleetClaimTokenReadiness(supabase);
for (const node of result.incompatible_nodes) console.error(`${node.node_id}: ${node.reasons.join("; ")}`);
const artifact = {
  generated_at: new Date().toISOString(), target_project_ref: actualRef,
  reviewed_commit: reviewedCommit,
  capability_contract: result.required_contract,
  provisioning_protocol: result.required_provisioning_protocol,
  server_claim_lease_seconds: result.server_claim_lease_seconds,
  eligible_node_ids: result.eligible_node_ids,
  eligible_node_versions: result.eligible_node_versions,
  incompatible_nodes: result.incompatible_nodes,
  result: result.ready ? "PASS" : "FAIL",
};
const outputArg = process.argv.find((arg) => arg.startsWith("--evidence="));
if (outputArg) {
  const path = outputArg.slice("--evidence=".length);
  if (!path) throw new Error("--evidence requires a path");
  await writeFile(path, JSON.stringify(artifact, null, 2) + "\n", { mode: 0o600 });
  console.log(`Non-secret evidence written: ${path}`);
}
console.log(`Eligible: ${result.eligible_nodes}; compatible: ${result.compatible_nodes}`);
console.log(`CLAIM TOKEN FLEET READINESS: ${result.ready ? "PASS" : "FAIL"}`);
process.exit(result.ready ? 0 : 1);
