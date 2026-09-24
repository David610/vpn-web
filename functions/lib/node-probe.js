/**
 * Control-plane readiness probe for a node, run from the Worker.
 *
 * What it proves:
 *   subscription_tls  HTTPS to https://<hostname>:8443/ completes with a
 *                     certificate the Workers runtime trusts for that exact
 *                     name -> DNS points at the node, the Let's Encrypt
 *                     certificate was issued and nginx is serving it.
 *   reality_tcp       a TCP connection to <hostname>:443 opens -> sing-box's
 *                     REALITY/TLS listener is reachable from the Internet.
 *
 * What it deliberately does NOT claim: a completed REALITY handshake or any
 * Hysteria2 (UDP) exchange. Workers cannot speak UDP, and a real REALITY
 * handshake needs a sing-box client; those protocol-level probes run from
 * peer nodes (synthetic health) and are reported separately.
 */
const SUBSCRIPTION_PORT = 8443;
const PROXY_PORT = 443;
const TIMEOUT_MS = 8000;

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function probeSubscriptionTls(hostname) {
  const started = Date.now();
  try {
    const res = await withTimeout(
      fetch(`https://${hostname}:${SUBSCRIPTION_PORT}/`, { method: "GET", redirect: "manual" }),
      TIMEOUT_MS
    );
    // Any HTTP status is fine: completing the request at all means TLS
    // validated for this hostname. The body is irrelevant and discarded.
    await res.body?.cancel?.();
    return { ok: true, latencyMs: Date.now() - started, httpStatus: res.status };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: String(err.message).slice(0, 200) };
  }
}

async function probeTcp(hostname, port) {
  const started = Date.now();
  let socket;
  try {
    const { connect } = await import("cloudflare:sockets");
    socket = connect({ hostname, port });
    await withTimeout(socket.opened, TIMEOUT_MS);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: String(err.message).slice(0, 200) };
  } finally {
    try {
      await socket?.close();
    } catch {
      // Closing a socket that never opened is not an error worth reporting.
    }
  }
}

/** @returns {Promise<{ ok: boolean, checks: Record<string, object> }>} */
export async function probeNodeReadiness(hostname) {
  const [subscriptionTls, realityTcp] = await Promise.all([
    probeSubscriptionTls(hostname),
    probeTcp(hostname, PROXY_PORT),
  ]);
  const checks = { subscription_tls: subscriptionTls, reality_tcp: realityTcp };
  return { ok: Object.values(checks).every((c) => c.ok), checks };
}
