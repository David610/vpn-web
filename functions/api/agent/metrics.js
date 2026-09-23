import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../lib/node-auth.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function validCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Ingests cumulative per-user counters from a node capability that can
 * actually attribute traffic to sing-box users. The server maps vpn_user_id
 * to this authenticated node before recording anything; a node cannot write
 * another node's users.
 */
export async function onRequestPost({ env, request }) {
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

  const samples = Array.isArray(body?.users) ? body.users : null;
  if (!samples || samples.length > 500) {
    return json({ error: "users must be an array with at most 500 samples" }, 400);
  }

  const normalized = [];
  for (const sample of samples) {
    const vpnUserId =
      typeof sample?.vpn_user_id === "string" && sample.vpn_user_id.length <= 128
        ? sample.vpn_user_id
        : null;
    const sampledAt = typeof sample?.sampled_at === "string" ? sample.sampled_at : body.sampled_at;
    const sampleMs = Date.parse(sampledAt);
    if (
      !vpnUserId ||
      !Number.isFinite(sampleMs) ||
      sampleMs > Date.now() + 10 * 60_000 ||
      sampleMs < Date.now() - 24 * 60 * 60_000 ||
      !validCounter(sample.download_bytes_total) ||
      !validCounter(sample.upload_bytes_total)
    ) {
      return json({ error: "Invalid usage sample" }, 400);
    }
    const lastSeenAt =
      sample.last_seen_at && Number.isFinite(Date.parse(sample.last_seen_at))
        ? sample.last_seen_at
        : null;
    normalized.push({
      vpnUserId,
      sampledAt: new Date(sampleMs).toISOString(),
      download: sample.download_bytes_total,
      upload: sample.upload_bytes_total,
      lastSeenAt,
    });
  }

  if (normalized.length === 0) {
    await supabaseAdmin
      .from("nodes")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("node_id", nodeId);
    return json({ ok: true, accepted: 0, unknown: 0 });
  }

  const ids = [...new Set(normalized.map((s) => s.vpnUserId))];
  const { data: accounts, error: accountsError } = await supabaseAdmin
    .from("vpn_accounts")
    .select("id, vpn_user_id")
    .eq("node_id", nodeId)
    .in("vpn_user_id", ids);
  if (accountsError) {
    console.error("agent/metrics: account mapping failed:", accountsError.message);
    return json({ error: "Internal error" }, 500);
  }
  const byVpnUser = new Map((accounts ?? []).map((a) => [a.vpn_user_id, a.id]));

  let accepted = 0;
  let unknown = 0;
  try {
    for (const sample of normalized) {
      const vpnAccountId = byVpnUser.get(sample.vpnUserId);
      if (!vpnAccountId) {
        unknown += 1;
        continue;
      }
      const { error } = await supabaseAdmin.rpc("record_vpn_usage_sample", {
        p_vpn_account_id: vpnAccountId,
        p_sampled_at: sample.sampledAt,
        p_download_bytes_total: sample.download,
        p_upload_bytes_total: sample.upload,
        p_last_seen_at: sample.lastSeenAt,
      });
      if (error) throw new Error(`usage RPC failed: ${error.message}`);
      accepted += 1;
    }

    await supabaseAdmin
      .from("nodes")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("node_id", nodeId);
    return json({ ok: true, accepted, unknown });
  } catch (err) {
    console.error("agent/metrics: failed:", err.message);
    return json({ error: "Internal error" }, 500);
  }
}
