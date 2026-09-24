/**
 * Hetzner Cloud provider adapter (spec 54 Phase 4). One real provider,
 * chosen for its simple single-token REST API -- no IAM roles, no
 * multi-step credential setup, matching this codebase's existing flat
 * env-var secret convention (env.STRIPE_API_KEY, env.RESEND_API_KEY, ...).
 *
 * createInstance() hands the enrollment token to the VPS via cloud-init
 * user_data, exactly the manual bootstrap path node-enrollment.js already
 * assumes (the token gets "pasted into cloud-init/a bootstrap script") --
 * this adapter just does that paste automatically and calls Hetzner's API
 * instead of a human clicking through its console.
 *
 * https://docs.hetzner.cloud/#servers-create-a-server
 */
const API_BASE = "https://api.hetzner.cloud/v1";
const DEFAULT_SERVER_TYPE = "cpx11";
const DEFAULT_IMAGE = "ubuntu-24.04";

function buildUserData({ siteUrl, enrollmentToken }) {
  // Minimal, auditable cloud-init: install nothing here beyond curl (present
  // on the stock image), redeem the enrollment token, and hand the agent's
  // own install step the returned API key via a local file. The actual
  // agent install/systemd-unit steps are out of scope for this adapter --
  // they belong to the provisioning-agent's own bootstrap docs, not to
  // vpn-web, which never holds SSH access to the box.
  const enrollUrl = `${siteUrl}/api/agent/enroll`;
  return [
    "#cloud-config",
    "runcmd:",
    `  - curl -sf -X POST -H "Authorization: Bearer ${enrollmentToken}" ${enrollUrl} -o /etc/vpn-agent-enroll.json`,
  ].join("\n");
}

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
      throw new Error(message);
    }
    return body;
  }

  return {
    name: "hetzner",
    async createInstance({ nodeId, region, enrollmentToken }) {
      const body = await hetznerFetch("/servers", {
        method: "POST",
        body: JSON.stringify({
          name: nodeId,
          server_type: DEFAULT_SERVER_TYPE,
          image: DEFAULT_IMAGE,
          location: region,
          user_data: buildUserData({ siteUrl: env.SITE_URL, enrollmentToken }),
        }),
      });
      const server = body?.server;
      const ipAddress = server?.public_net?.ipv4?.ip ?? null;
      if (!server?.id || !ipAddress) {
        throw new Error("Hetzner createInstance: unexpected response shape");
      }
      return {
        providerInstanceId: String(server.id),
        ipAddress,
        region: server.datacenter?.location?.name ?? region ?? null,
      };
    },
    async destroyInstance({ providerInstanceId }) {
      await hetznerFetch(`/servers/${encodeURIComponent(providerInstanceId)}`, {
        method: "DELETE",
      });
    },
  };
}
