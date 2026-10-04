/**
 * Dynamic (users-store) node revisions -- the OTHER shape
 * `POST /api/admin/nodes/:id/revisions` accepts, sibling to
 * functions/lib/static-revision.js's static-config shape.
 *
 * Node-side, a revision whose config is NOT a static-config document
 * (functions/lib/static-revision.js's isStaticRevisionConfig) is handed to
 * `compat_config::store::parse_users_bytes`, which accepts exactly two
 * top-level shapes: a versioned envelope `{"schema_version":N,"users":[...]}`
 * or a bare `[...]` array (crates/compat-config/src/store.rs). Either way,
 * `vpn-admin apply-revision` then performs a FULL ATOMIC REPLACE of the
 * node's entire local users.json with whatever array this document carries
 * -- not a merge, not a diff. A caller that omits even one still-active
 * customer, probe, or lease silently revokes it the moment this revision is
 * applied.
 *
 * As of this writing nothing in vpn-web automatically constructs this
 * document: createNodeRevision() (functions/lib/node-revisions.js) has
 * exactly one caller, this admin endpoint, and no UI or scheduled job posts
 * to it yet (see that file's own "later phases (8, 12)" note). The
 * completeness property above -- that a dynamic revision must always carry
 * every currently-active identity, never a stale or partial snapshot -- is
 * therefore a requirement for whoever builds that automated caller, not
 * something verifiable here today. What IS in scope here, narrowly: refuse
 * a dynamic-revision body that isn't even one of the two shapes the node
 * will accept, so a malformed admin API call fails at creation time with a
 * clear error instead of becoming a desired_revision the node will never
 * converge on (or, worse, one that happens to parse as something else
 * entirely). This does not -- and cannot, from vpn-web alone -- validate
 * that the user list is actually complete; only the as-yet-unbuilt
 * automated caller can own that.
 */

/** Mirrors compat-config's `CompatUser` being a JSON object; deliberately
 * does not check its fields -- see this module's doc comment. */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usersArrayIsWellShaped(users) {
  return Array.isArray(users) && users.every(isPlainObject);
}

/**
 * True when `config` is structurally one of the two shapes
 * `compat_config::store::parse_users_bytes` accepts: a bare array of user
 * objects, or `{schema_version, users: [...]}` with `users` an array of
 * objects. Field-level validation of each user is intentionally not done
 * here -- see module doc comment.
 */
export function isWellShapedDynamicRevisionConfig(config) {
  if (Array.isArray(config)) return usersArrayIsWellShaped(config);
  if (!isPlainObject(config)) return false;
  if (!("users" in config)) return false;
  if (!usersArrayIsWellShaped(config.users)) return false;
  if ("schema_version" in config) {
    const v = config.schema_version;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return false;
  }
  return true;
}

/** `{ ok: true }` or `{ ok: false, error }`, same shape as
 * static-revision.js's `validateStaticRevisionConfig`. */
export function validateDynamicRevisionConfig(config) {
  if (!isWellShapedDynamicRevisionConfig(config)) {
    return {
      ok: false,
      error:
        'config is neither a static revision ({"revision_schema":1,"static_config":{..}}) nor a ' +
        'well-shaped users snapshot (a JSON array of user objects, or {"users":[...]} with an ' +
        "optional integer schema_version)",
    };
  }
  return { ok: true };
}
