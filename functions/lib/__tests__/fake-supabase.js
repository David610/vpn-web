import { vi } from "vitest";

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
export function makeFakeSupabase(seed = {}) {
  const tables = {
    customer_accounts: [],
    account_members: [],
    subscriptions: [],
    vpn_accounts: [],
    provisioning_jobs: [],
    ...structuredClone(seed),
  };

  // Mirrors provisioning_jobs.idempotency_key's UNIQUE constraint, which is
  // what makes a redelivered Stripe webhook a no-op rather than a second
  // round of provisioning jobs.
  const UNIQUE = { provisioning_jobs: "idempotency_key" };

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
      eq(col, val) {
        state.filters.push((r) => r[col] === val);
        return chain;
      },
      in(col, vals) {
        state.filters.push((r) => vals.includes(r[col]));
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
      then: (resolve, reject) => Promise.resolve(exec(false)).then(resolve, reject),
    };
    return chain;
  }

  return { from: vi.fn(from), _tables: tables };
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
    vpn_accounts: provisioned.map((p, i) => ({
      id: i + 1,
      user_id: p.userId,
      vpn_user_id: p.vpnUserId,
      node_id: p.nodeId ?? "node-1",
      enabled: true,
    })),
    provisioning_jobs: [],
  };
}
