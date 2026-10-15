import { decryptSecret } from "./crypto.js";

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

function isDnsName(host) {
  return typeof host === "string" && host.length > 0 && !host.includes(":") && !IPV4_LITERAL.test(host);
}

/**
 * Hysteria2 link material for an external (share-link) subscription.
 *
 * `nodes.tls_server_name` is the REALITY decoy for a VLESS node, so it cannot
 * name the Hysteria2 certificate. A node that serves both protocols presents
 * its certificate for its public hostname, and publishes its Salamander
 * password in `node_transport_secrets`. Returns null, and never throws, when
 * any of that is unknown: a link that cannot authenticate is worse than none.
 */
export async function hysteria2Material(db, env, node) {
  if (node.transport === "hysteria2") {
    if (!isDnsName(node.tls_server_name)) return null;
    if (!node.hysteria2_obfs_type) return { serverName: node.tls_server_name };
    const password = await storedObfsPassword(db, env, node.node_id);
    return password ? { serverName: node.tls_server_name, obfs: { type: node.hysteria2_obfs_type, password } } : null;
  }
  if (!isDnsName(node.hostname)) return null;
  const password = await storedObfsPassword(db, env, node.node_id);
  return password ? { serverName: node.hostname, obfs: { type: "salamander", password } } : null;
}

async function storedObfsPassword(db, env, nodeId) {
  try {
    const { data, error } = await db.from("node_transport_secrets")
      .select("hysteria2_obfs_ciphertext, hysteria2_obfs_nonce").eq("node_id", nodeId).maybeSingle();
    if (error || !data?.hysteria2_obfs_ciphertext) return null;
    return await decryptSecret(data.hysteria2_obfs_ciphertext, data.hysteria2_obfs_nonce, env.VPN_SECRETS_ENCRYPTION_KEY);
  } catch {
    return null;
  }
}
