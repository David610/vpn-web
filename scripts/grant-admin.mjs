#!/usr/bin/env node
// scripts/grant-admin.mjs — run manually, once, to grant the first
// "owner" admin role. Mirrors scripts/register-node.mjs's shape.
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/grant-admin.mjs <email> [role]
import { createClient } from "@supabase/supabase-js";

const email = process.argv[2];
const role = process.argv[3] ?? "owner";
if (!email) {
  console.error("Usage: node scripts/grant-admin.mjs <email> [owner|operator|readonly]");
  process.exit(1);
}
if (!["owner", "operator", "readonly"].includes(role)) {
  console.error(`Invalid role "${role}" — must be owner, operator, or readonly.`);
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment first.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// auth.users is not exposed via PostgREST even to service_role — the
// GoTrue admin API (auth.admin.*) is the only way to look up a user by
// email from a script like this.
const { data: usersPage, error: listError } = await supabase.auth.admin.listUsers({ perPage: 1000 });
if (listError) {
  console.error("Failed to list users:", listError.message);
  process.exit(1);
}
const user = usersPage.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
if (!user) {
  console.error(`No Supabase auth user found with email "${email}". They must sign up first.`);
  process.exit(1);
}

const { error } = await supabase
  .from("admin_users")
  .upsert({ user_id: user.id, role });
if (error) {
  console.error("Failed to grant admin role:", error.message);
  process.exit(1);
}

console.log(`Granted role "${role}" to ${email} (user_id=${user.id}).`);
