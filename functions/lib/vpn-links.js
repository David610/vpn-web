import { hmacSha256Hex } from "./crypto.js";

export const LINK_NAME = /^[\p{L}\p{N} ._'()-]{1,80}$/u;
export const CLIENT_NAME = /^[\p{L}\p{N} ._'()-]{1,40}$/u;

export function validLinkInput(body) {
  const name = String(body?.name ?? "").trim();
  const routeId = body?.routeId;
  const maxClients = body?.maxClients;
  if (!LINK_NAME.test(name) || !/^route_[a-z0-9_]{3,60}$/.test(routeId ?? "") ||
      !Number.isInteger(maxClients) || maxClients < 1 || maxClients > 100) return null;
  return { name, routeId, maxClients };
}

export function validLinkUpdate(body) {
  const name = String(body?.name ?? "").trim();
  const maxClients = body?.maxClients;
  if (!LINK_NAME.test(name) || !Number.isInteger(maxClients) || maxClients < 1 || maxClients > 100) return null;
  return { name, maxClients };
}

export async function idempotencyHash(request, env) {
  const key = request.headers.get("Idempotency-Key");
  if (!key || key.length < 16 || key.length > 200) return null;
  return hmacSha256Hex(`link-client-idempotency:v1:${key}`, env.SUBSCRIPTION_TOKEN_HASH_KEY);
}

export function publicLink(row, clientCount = 0, routeLabel = null) {
  return {
    id: row.id, name: row.name, configurationFamily: row.configuration_family,
    routeId: row.desired_route_id, routeLabel: routeLabel ?? row.desired_route_id, maxClients: row.max_clients, status: row.status,
    clientCount, createdAt: row.created_at, revokedAt: row.revoked_at,
  };
}

export function publicClient(row) {
  return {
    id: row.device_id, linkId: row.link_id, name: row.devices?.name,
    clientType: row.client_type, routeId: row.desired_route_id,
    status: row.revoked_at ? "revoked" : "active", createdAt: row.created_at,
    lastSeenAt: row.last_subscription_fetch_at, revokedAt: row.revoked_at,
  };
}
