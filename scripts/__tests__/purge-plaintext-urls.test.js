import { describe, it, expect } from "vitest";
import { sanitize, scan } from "../purge-plaintext-urls.mjs";

/**
 * Minimal fake Supabase client covering only what scan()/purge-plaintext-
 * urls.mjs actually issues against provisioning_jobs: .select().not().gt()
 * .order().limit() (read) and .update().eq() (write). Not the shared
 * functions/lib/__tests__/fake-supabase.js because that one's .order() is a
 * no-op and this script depends on id-ascending order to make its cursor
 * correct.
 */
function makeFakeJobsTable(rows) {
  const table = rows.map((r) => ({ ...r }));
  return {
    from(name) {
      if (name !== "provisioning_jobs") throw new Error(`unexpected table ${name}`);
      const state = { filters: [{ col: "id", op: "gt", val: 0 }], limit: 1000, op: "select" };
      const chain = {
        select() {
          return chain;
        },
        not(col, op, val) {
          if (op !== "is") throw new Error("unsupported");
          state.filters.push({ col, op: "not-is", val });
          return chain;
        },
        gt(col, val) {
          state.filters = state.filters.filter((f) => f.col !== col);
          state.filters.push({ col, op: "gt", val });
          return chain;
        },
        eq(col, val) {
          state.filters.push({ col, op: "eq", val });
          return chain;
        },
        order() {
          return chain;
        },
        limit(n) {
          state.limit = n;
          return chain;
        },
        update(payload) {
          state.op = "update";
          state.payload = payload;
          return chain;
        },
        then(resolve, reject) {
          const matches = (row) =>
            state.filters.every((f) => {
              if (f.op === "gt") return row[f.col] > f.val;
              if (f.op === "eq") return row[f.col] === f.val;
              if (f.op === "not-is") return (row[f.col] ?? null) !== f.val;
              throw new Error("unsupported filter");
            });
          if (state.op === "update") {
            const hit = table.find(matches);
            if (hit) Object.assign(hit, state.payload);
            return Promise.resolve({ data: hit ? [hit] : [], error: null }).then(resolve, reject);
          }
          const rows2 = table.filter(matches).sort((a, b) => a.id - b.id).slice(0, state.limit);
          return Promise.resolve({ data: rows2, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

describe("sanitize()", () => {
  it("drops sensitive-shaped keys and marks reported flags", () => {
    const { result, changed } = sanitize({
      subscription_url: "https://node.example/sub/deadbeef",
      provisioning_url: "https://node.example/setup/deadbeef",
      some_token: "abc123",
      status: "ok",
    });
    expect(changed).toBe(true);
    expect(result).toEqual({ subscription_url_reported: true, provisioning_url_reported: true, status: "ok" });
  });

  it("is a no-op on an already-clean result (idempotent)", () => {
    const clean = { status: "ok", subscription_url_reported: true };
    const { changed } = sanitize(clean);
    expect(changed).toBe(false);
  });

  it("passes through null/non-object results untouched", () => {
    expect(sanitize(null)).toEqual({ result: null, changed: false });
  });
});

describe("scan()", () => {
  const seedRows = () => [
    { id: 1, created_at: new Date().toISOString(), result: { subscription_url: "https://a/1" } },
    { id: 2, created_at: new Date().toISOString(), result: { status: "ok" } },
    { id: 3, created_at: new Date().toISOString(), result: { provisioning_url: "https://a/3" } },
  ];

  it("dry-run mode (no onMatch) reports matches without mutating rows", async () => {
    const rows = seedRows();
    const client = makeFakeJobsTable(rows);
    const { scanned, matched } = await scan(client, { afterId: 0, onMatch: null });
    expect(scanned).toBe(3);
    expect(matched).toBe(2);
    // Nothing was mutated.
    expect(rows[0].result).toEqual({ subscription_url: "https://a/1" });
    expect(rows[2].result).toEqual({ provisioning_url: "https://a/3" });
  });

  it("live mode (onMatch writes) sanitizes matched rows and a re-scan finds zero", async () => {
    const client = makeFakeJobsTable(seedRows());
    const live = await scan(client, {
      afterId: 0,
      onMatch: async (row, cleanResult) => {
        await client.from("provisioning_jobs").update({ result: cleanResult }).eq("id", row.id);
      },
    });
    expect(live.matched).toBe(2);

    const verify = await scan(client, { afterId: 0, onMatch: null });
    expect(verify.matched).toBe(0);
    expect(verify.scanned).toBe(3);
  });

  it("resumes correctly from an --after-id cursor", async () => {
    const client = makeFakeJobsTable(seedRows());
    const { scanned, matched, lastId } = await scan(client, { afterId: 1, onMatch: null });
    // Row 1 is skipped; rows 2 and 3 remain, one of which matches.
    expect(scanned).toBe(2);
    expect(matched).toBe(1);
    expect(lastId).toBe(3);
  });
});
