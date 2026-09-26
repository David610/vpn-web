import { ed25519 } from "@noble/curves/ed25519.js";
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
