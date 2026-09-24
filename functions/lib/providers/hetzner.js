/**
 * Hetzner Cloud provider adapter (spec 54 Phase 4). One real provider,
 * chosen for its simple single-token REST API -- no IAM roles, no
 * multi-step credential setup, matching this codebase's existing flat
 * env-var secret convention (env.STRIPE_API_KEY, env.RESEND_API_KEY, ...).
 *
 * Idempotency: every server is labelled with its Arcana node id, and
 * findInstanceByNodeId() looks it up by that label. The fleet reconciler
 * (functions/lib/fleet-operations.js) always calls it before
 * createInstance(), so a create whose response was lost (Worker timeout,
 * crash before the DB write) is adopted on retry instead of creating a
 * second, untracked, billed server.
 *
 * The adapter knows nothing about bootstrap content: the caller builds
 * cloud-init user_data (functions/lib/node-bootstrap.js) and passes it in.
 *
 * https://docs.hetzner.cloud/#servers-create-a-server
 */
const API_BASE = "https://api.hetzner.cloud/v1";
// cx23: 2 vCPU / 4 GB, the smallest shared x86 type available in the EU
// locations. alma-9: singbox-vpn's supported production OS.
const DEFAULT_SERVER_TYPE = "cx23";
const DEFAULT_IMAGE = "alma-9";
const NODE_LABEL = "arcana-node-id";

export function createHetznerProvider(env) {
  const apiToken = env.HETZNER_API_TOKEN;
  if (!apiToken) {
    throw new Error("HETZNER_API_TOKEN is not configured");
  }

  async function hetznerFetch(path, init) {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const message = body?.error?.message ?? `Hetzner API returned ${res.status}`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  function toInstance(server) {
    return {
      providerInstanceId: String(server.id),
      ipAddress: server.public_net?.ipv4?.ip ?? null,
      ipv6Network: server.public_net?.ipv6?.ip ?? null,
      region: server.datacenter?.location?.name ?? null,
      status: server.status ?? null,
    };
  }

  return {
    name: "hetzner",

    async findInstanceByNodeId(nodeId) {
      const selector = encodeURIComponent(`${NODE_LABEL}==${nodeId}`);
      const body = await hetznerFetch(`/servers?label_selector=${selector}`);
      const servers = body?.servers ?? [];
      if (servers.length > 1) {
        throw new Error(`Hetzner: ${servers.length} servers carry node label ${nodeId}`);
      }
      return servers[0] ? toInstance(servers[0]) : null;
    },

    async createInstance({ nodeId, region, userData, serverType, image }) {
      if (!userData) throw new Error("Hetzner createInstance: userData is required");
      const body = await hetznerFetch("/servers", {
        method: "POST",
        body: JSON.stringify({
          name: nodeId,
          server_type: serverType ?? env.FLEET_HETZNER_SERVER_TYPE ?? DEFAULT_SERVER_TYPE,
          image: image ?? env.FLEET_HETZNER_IMAGE ?? DEFAULT_IMAGE,
          location: region,
          user_data: userData,
          labels: { [NODE_LABEL]: nodeId, "arcana-managed": "true" },
          public_net: { enable_ipv4: true, enable_ipv6: true },
        }),
      });
      const server = body?.server;
      if (!server?.id || !server.public_net?.ipv4?.ip) {
        throw new Error("Hetzner createInstance: unexpected response shape");
      }
      const instance = toInstance(server);
      instance.region = instance.region ?? region ?? null;
      return instance;
    },

    async destroyInstance({ providerInstanceId }) {
      try {
        await hetznerFetch(`/servers/${encodeURIComponent(providerInstanceId)}`, {
          method: "DELETE",
        });
      } catch (err) {
        // Already gone is the desired end state.
        if (err.status === 404) return;
        throw err;
      }
    },
  };
}
