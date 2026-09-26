import { vi } from "vitest";
import { agentSyncLeaseSlots, leaseRouteSlots, revokeDeviceLeases } from "./lease-pool-model.js";

/**
 * A small in-memory stand-in for the PostgREST query builder, covering the
 * chains functions/lib/stripe-events.js actually uses.
 *
 * The Stripe handlers fan out across an account's members — one provisioning
 * job per seat — and their correctness is mostly about *which rows* a filter
 * selects and *how many* jobs come out the other side. Canned per-call
 * responses cannot show that: they would pass just as happily if the fan-out
 * looped once or never. So this executes the filters against real arrays and
 * lets assertions read the resulting rows.
 *
 * Deliberately not general-purpose: it implements the operators these
 * handlers use and throws on anything else, so an untested query shape fails
 * loudly instead of silently returning [].
 */
export function makeFakeSupabase(seed = {}, options = {}) {
  const tables = {
    customer_accounts: [],
    profiles: [],
    account_members: [],
    subscriptions: [],
    vpn_accounts: [],
    provisioning_jobs: [],
    member_invites: [],
    admin_entitlements: [],
    vpn_usage_current: [],
    vpn_usage_hourly: [],
    operational_alerts: [],
    abuse_signals: [],
    nodes: [],
    devices: [],
    connection_profiles: [],
    device_profile_assignments: [],
    telegram_links: [],
    telegram_link_codes: [],
    allowed_paths: [],
    device_node_assignments: [],
    locations: [],
    node_lease_slots: [],
    node_transport_secrets: [],
    vpn_leases: [],
    ...structuredClone(seed),
  };

  // Mirrors provisioning_jobs.idempotency_key's UNIQUE constraint, which is
  // what makes a redelivered Stripe webhook a no-op rather than a second
  // round of provisioning jobs.
  const UNIQUE = { provisioning_jobs: "idempotency_key", telegram_links: "telegram_user_id" };

  function from(table) {
    if (!(table in tables)) throw new Error(`unexpected table ${table}`);

    const state = { op: "select", filters: [], payload: null, limit: null };
    const match = (row) => state.filters.every((f) => f(row));

    function exec(single) {
      if (state.op === "insert") {
        const uniqueCol = UNIQUE[table];
        if (uniqueCol && tables[table].some((r) => r[uniqueCol] === state.payload[uniqueCol])) {
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        // Mirrors provisioning_jobs_one_inflight_create_per_device_node: at
        // most one pending/claimed CREATE_USER per (device, node).
        const p = state.payload;
        if (
          table === "provisioning_jobs" &&
          p.job_type === "CREATE_USER" &&
          p.device_id &&
          tables.provisioning_jobs.some(
            (r) =>
              r.job_type === "CREATE_USER" &&
              r.device_id === p.device_id &&
              r.node_id === p.node_id &&
              ["pending", "claimed"].includes(r.status ?? "pending")
          )
        ) {
          return { data: null, error: { code: "23505", message: "duplicate in-flight create" } };
        }
        const row = { id: tables[table].length + 1, ...state.payload };
        tables[table].push(row);
        return { data: [row], error: null };
      }

      if (state.op === "update") {
        const hit = tables[table].filter(match);
        for (const row of hit) Object.assign(row, state.payload);
        return single
          ? { data: hit[0] ?? null, error: null }
          : { data: hit, error: null };
      }

      if (state.op === "delete") {
        const hit = tables[table].filter(match);
        tables[table] = tables[table].filter((row) => !match(row));
        return single
          ? { data: hit[0] ?? null, error: null }
          : { data: hit, error: null };
      }

      if (state.op === "upsert") {
        // Composite conflict targets ("device_id,hop") and array payloads,
        // both of which PostgREST supports.
        const conflictCols = state.upsertConflictCol.split(",").map((c) => c.trim());
        const payloads = Array.isArray(state.payload) ? state.payload : [state.payload];
        const written = payloads.map((payload) => {
          const existing = tables[table].find((r) => conflictCols.every((c) => r[c] === payload[c]));
          if (existing) return Object.assign(existing, payload);
          const row = { ...payload };
          tables[table].push(row);
          return row;
        });
        return single ? { data: written[0], error: null } : { data: written, error: null };
      }

      let rows = tables[table].filter(match);
      if (state.limit !== null) rows = rows.slice(0, state.limit);
      if (single) {
        if (rows.length > 1) {
          // Faithful to PostgREST: .maybeSingle() errors on a multi-row
          // result rather than picking one.
          return { data: null, error: { code: "PGRST116", message: "multiple rows returned" } };
        }
        return { data: rows[0] ?? null, error: null };
      }
      return { data: rows, error: null, count: rows.length };
    }

    const chain = {
      select(_cols, opts) {
        if (opts?.head) state.head = true;
        return chain;
      },
      insert(payload) {
        state.op = "insert";
        state.payload = payload;
        return chain;
      },
      update(payload) {
        state.op = "update";
        state.payload = payload;
        return chain;
      },
      delete() {
        state.op = "delete";
        return chain;
      },
      upsert(payload, opts) {
        state.op = "upsert";
        state.payload = payload;
        state.upsertConflictCol = opts?.onConflict ?? "id";
        return chain;
      },
      eq(col, val) {
        state.filters.push((r) => r[col] === val);
        return chain;
      },
      in(col, vals) {
        state.filters.push((r) => vals.includes(r[col]));
        return chain;
      },
      is(col, val) {
        // PostgREST .is(col, null) — the null checks the invite queries use
        // to mean "still outstanding".
        state.filters.push((r) => (r[col] ?? null) === val);
        return chain;
      },
      neq(col, val) {
        state.filters.push((r) => r[col] !== val);
        return chain;
      },
      gt(col, val) {
        state.filters.push((r) => r[col] > val);
        return chain;
      },
      lte(col, val) {
        state.filters.push((r) => r[col] <= val);
        return chain;
      },
      like(col, pattern) {
        const rx = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`);
        state.filters.push((r) => rx.test(r[col]));
        return chain;
      },
      order() {
        return chain;
      },
      limit(n) {
        state.limit = n;
        return chain;
      },
      maybeSingle: () => Promise.resolve(exec(true)),
      single: () => {
        const result = exec(true);
        if (!result.error && !result.data) {
          return Promise.resolve({
            data: null,
            error: { code: "PGRST116", message: "no rows returned" },
          });
        }
        // An insert resolves to { data: [row] }; .single() unwraps it.
        if (Array.isArray(result.data)) {
          return Promise.resolve({ data: result.data[0] ?? null, error: result.error });
        }
        return Promise.resolve(result);
      },
      then: (resolve, reject) => Promise.resolve(exec(false)).then(resolve, reject),
    };
    return chain;
  }

  // An insert's exec() returns { data: [row] }; .single() needs the row.
  const rpcHandlers = options.rpc ?? {};

  return {
    from: vi.fn(from),
    rpc: vi.fn(async (name, args) => {
      const handler = rpcHandlers[name];
      if (handler) return handler(args, tables);
      if (name === "lease_route_slots") return leaseRouteSlots(args, tables);
      if (name === "agent_sync_lease_slots") return agentSyncLeaseSlots(args, tables);
      if (name === "revoke_device_leases") return revokeDeviceLeases(args, tables);

      if (name === "customer_dashboard_state") {
        const membership = tables.account_members.find(
          (row) => row.user_id === args.p_user_id
        );
        if (!membership) return { data: null, error: null };

        const account = tables.customer_accounts.find(
          (row) => row.id === membership.account_id
        ) ?? { id: membership.account_id };
        const liveStatuses = new Set(["trialing", "active", "past_due"]);
        const subscription =
          tables.subscriptions.find(
            (row) =>
              row.account_id === membership.account_id &&
              liveStatuses.has(row.status)
          ) ?? null;

        const now = Date.now();
        const grants = tables.admin_entitlements
          .filter((row) => {
            if (row.account_id !== membership.account_id || row.status !== "active") {
              return false;
            }
            const starts = new Date(row.starts_at).getTime();
            const expires = row.expires_at
              ? new Date(row.expires_at).getTime()
              : Infinity;
            return starts <= now && expires > now;
          })
          .sort(
            (a, b) =>
              new Date(b.created_at ?? 0).getTime() -
              new Date(a.created_at ?? 0).getTime()
          );

        const members = tables.account_members
          .filter((row) => row.account_id === membership.account_id)
          .map((row) => ({
            user_id: row.user_id,
            role: row.role,
            created_at: row.created_at,
            email:
              tables.profiles.find((profile) => profile.id === row.user_id)?.email ??
              null,
          }));

        const invites = tables.member_invites
          .filter(
            (row) =>
              row.account_id === membership.account_id &&
              (row.accepted_at ?? null) === null &&
              (row.revoked_at ?? null) === null &&
              new Date(row.expires_at).getTime() > now
          )
          .map((row) => ({
            id: row.id,
            email: row.email,
            expires_at: row.expires_at,
            created_at: row.created_at,
          }));

        const vpnRows = tables.vpn_accounts.filter(
          (row) => row.user_id === args.p_user_id
        );
        const vpn = vpnRows.at(-1) ?? null;

        return {
          data: {
            account: {
              account_id: membership.account_id,
              role: membership.role,
              trial_used_at: account.trial_used_at ?? null,
              trial_reserved_at: account.trial_reserved_at ?? null,
              trial_checkout_session_id: account.trial_checkout_session_id ?? null,
            },
            subscription,
            grants,
            members,
            invites,
            vpn_account: vpn
              ? {
                  id: vpn.id,
                  enabled: vpn.enabled,
                  vpn_user_id: vpn.vpn_user_id,
                  node_id: vpn.node_id,
                }
              : null,
          },
          error: null,
        };
      }

      if (name === "vpn_usage_month_total") {
        const start = new Date(args.p_month_start).getTime();
        const rows = tables.vpn_usage_hourly.filter(
          (row) =>
            row.vpn_account_id === args.p_vpn_account_id &&
            new Date(row.hour).getTime() >= start
        );
        return {
          data: [
            {
              download_bytes: rows.reduce(
                (sum, row) => sum + (Number(row.download_bytes) || 0),
                0
              ),
              upload_bytes: rows.reduce(
                (sum, row) => sum + (Number(row.upload_bytes) || 0),
                0
              ),
            },
          ],
          error: null,
        };
      }

      throw new Error(`unstubbed rpc ${name}`);
    }),
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: options.user ?? { id: "user-1", email: "owner@example.com" } },
        error: options.user === null ? { message: "bad token" } : null,
      })),
      getClaims: vi.fn(async () => {
        if (options.user === null) {
          return { data: { claims: null }, error: { message: "bad token" } };
        }
        const user = options.user ?? { id: "user-1", email: "owner@example.com" };
        return {
          data: {
            claims:
              options.claims ??
              {
                sub: user.id,
                email: user.email,
                role: "authenticated",
                amr: [
                  {
                    method: "password",
                    timestamp: Math.floor(Date.now() / 1000),
                  },
                ],
              },
          },
          error: null,
        };
      }),
      admin: {
        listUsers: vi.fn(async () => ({
          data: { users: options.users ?? [] },
          error: null,
        })),
      },
    },
    _tables: tables,
  };
}

/**
 * An account with one owner, a live subscription, and optionally extra
 * members — the shape every fan-out test starts from.
 */
export function seedAccount({
  accountId = "acct-1",
  subscriptionId = "sub_123",
  status = "active",
  members = [{ userId: "user-1", role: "owner" }],
  provisioned = [],
} = {}) {
  return {
    customer_accounts: [{ id: accountId, stripe_customer_id: null }],
    account_members: members.map((m) => ({
      account_id: accountId,
      user_id: m.userId,
      role: m.role,
    })),
    subscriptions: [
      { id: 1, account_id: accountId, stripe_subscription_id: subscriptionId, status },
    ],
    // Post device_identities migration: every identity belongs to a device.
    devices: provisioned
      .filter((p, i, all) => all.findIndex((q) => (q.deviceId ?? `dev-${q.userId}`) === (p.deviceId ?? `dev-${p.userId}`)) === i)
      .map((p) => ({
        id: p.deviceId ?? `dev-${p.userId}`,
        account_id: accountId,
        user_id: p.userId,
        name: "Legacy device",
        status: p.deviceStatus ?? "ACTIVE",
        // subscription_devices migration: existing devices join the live
        // subscription.
        subscription_id: p.subscriptionRowId === undefined ? 1 : p.subscriptionRowId,
      })),
    vpn_accounts: provisioned.map((p, i) => ({
      id: i + 1,
      user_id: p.userId,
      device_id: p.deviceId ?? `dev-${p.userId}`,
      vpn_user_id: p.vpnUserId,
      node_id: p.nodeId ?? "node-1",
      enabled: p.enabled ?? true,
    })),
    provisioning_jobs: [],
  };
}
