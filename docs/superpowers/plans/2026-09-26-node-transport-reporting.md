# Node Transport-Parameter Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last gap in ADR-0002 Sub-project A: make the node bootstrap script actually report a node's REALITY transport parameters to `POST /api/agent/bootstrap-status`, so `GET /v1/routes` stops returning an empty `routes` array in production.

**Architecture:** No Rust change needed. `deploy/almalinux/install.sh`'s `init_reality_keys` (already shipped, in `singbox-vpn`) writes the REALITY public key and short ID to plain files (`/etc/vpn/compat/reality/public.key`, `short_id.txt`) using a prebuilt `vpn-admin` binary. `vpn-web`'s own generated bootstrap script (`functions/lib/node-bootstrap.js`'s `BOOTSTRAP_SCRIPT`) runs `install.sh` as a subprocess on the same node right after those files are written (`stage_install`) — it just never reads them. This plan reads those two files and the already-known `$REALITY_HANDSHAKE_SERVER` env var, and adds them as the `transport` object `bootstrap-status.js` has accepted (and validated) since Sub-project A shipped, but which nothing has ever populated.

**Tech Stack:** Bash (generated cloud-init script, in a JS template literal), Vitest.

**Spec:** None (bounded change to an already-shipped feature; see the ADR-0002 doc's Status section and `bootstrap-status.js`'s existing `validateTransport` for the target contract this plan fills in).

## Global Constraints

- **Ruling (made during design, before this plan):** every fleet node runs both `vless-reality` and `hysteria2` simultaneously (`deploy/almalinux/templates/deployment.toml.template`'s `[reality]` and `[hysteria2]` sections, same node), but `nodes.transport` is a single value. This pass reports `vless-reality` only, matching the existing test fixtures' assumption (`route-directory.test.js`, the ADR-0002 interop tests) and the ADR's own "vpn-web-only this pass" precedent. Exposing Hysteria2 as a second route hop per node is an explicit follow-up, not in scope here.
- `reality_fingerprint` is always the fixed string `"chrome"` and `vless_flow` is always `"xtls-rprx-vision"` — these are already the values every existing test fixture uses, and sing-box REALITY's client-fingerprint mimicry is a fixed deployment choice, not per-node data.
- `tls_server_name` (the REALITY decoy/masquerade SNI) is `$REALITY_HANDSHAKE_SERVER` — already a known env var in the bootstrap script, set from the same `REALITY_HANDSHAKE_SERVER` value `install.sh --reality-handshake-server` was given.
- `server_port` is always `443` (`deployment.toml.template`'s `[reality]` `listen_port = 443`, fixed across the fleet).
- A missing/unreadable REALITY key file must never fail the INSTALL stage — the existing `report INSTALL OK ...` call must still succeed with no `transport` field, exactly like `bootstrap-status.js`'s own `validateTransport` already treats a missing/malformed transport as silently dropped, not a hard error.
- No new migration, no `bootstrap-status.js` change — `validateTransport` already accepts and persists exactly this shape (`functions/api/agent/bootstrap-status.js`, shipped in ADR-0002 Sub-project A).

## Review Focus

- A node whose `install.sh` run predates `vpn-admin`'s REALITY-file support (or where the files are simply absent for any reason) — the INSTALL stage must still report `OK` and complete bootstrap normally, never blocked on transport data.
- The public key or short ID containing a character that would break naive string interpolation into JSON (e.g. a stray newline from a corrupted file read) — the report must not send malformed JSON that could break the `curl` call or `bootstrap-status.js`'s `JSON.parse`.
- A bootstrap re-run after a crash, where `install.ok` already exists (`stage_install`'s idempotency short-circuit returns before ever building a transport report) — this is an accepted limitation for nodes whose first successful install predates this change, not a bug this plan needs to solve for new installs.
- The generated bash must remain valid under `bash -n` after this change — a template-literal typo here only surfaces on a live VPS otherwise, since nothing executes this script in CI.

---

## Task 1: Report REALITY transport parameters from the INSTALL stage

**Files:**
- Modify: `functions/lib/node-bootstrap.js` (`BOOTSTRAP_SCRIPT` template literal: `report()`, a new `transport_report_json()` helper, and `stage_install()`)
- Test: `functions/lib/__tests__/node-bootstrap.test.js`

**Interfaces:**
- Consumes: nothing new from other modules — this is entirely within `node-bootstrap.js`'s existing `BOOTSTRAP_SCRIPT` string and the already-shipped `bootstrap-status.js`'s `validateTransport` contract (`{transport, server_port, tls_server_name, reality_public_key, reality_short_id, reality_fingerprint, vless_flow}`), which this task is the first real caller of.
- Produces: `report()` gains an optional 4th positional bash argument (a raw JSON object string, or empty) that, when non-empty, is spliced into the reported body as `"transport": <value>`. `stage_install()` calls `report INSTALL OK "..." "$(transport_report_json)"`. No other stage's `report` call sites change.

- [ ] **Step 1: Write the failing tests**

Add to `functions/lib/__tests__/node-bootstrap.test.js` (find the existing `describe("buildNodeBootstrapUserData", ...)` block and add these `it`s inside it, near the existing REALITY_HANDSHAKE_SERVER test):

```javascript
  it("reads the REALITY key files and reports them as the transport on INSTALL OK", () => {
    expect(BOOTSTRAP_SCRIPT).toContain("/etc/vpn/compat/reality/public.key");
    expect(BOOTSTRAP_SCRIPT).toContain("/etc/vpn/compat/reality/short_id.txt");
    expect(BOOTSTRAP_SCRIPT).toContain('"transport":"vless-reality"');
    expect(BOOTSTRAP_SCRIPT).toContain('"reality_fingerprint":"chrome"');
    expect(BOOTSTRAP_SCRIPT).toContain('"vless_flow":"xtls-rprx-vision"');
    // tls_server_name is the REALITY decoy SNI -- the handshake server the
    // node was given, not its own public hostname.
    expect(BOOTSTRAP_SCRIPT).toContain('"tls_server_name":"%s"');
    const installReport = BOOTSTRAP_SCRIPT.indexOf('report INSTALL OK "singbox-vpn');
    expect(installReport).toBeGreaterThan(-1);
    expect(BOOTSTRAP_SCRIPT.slice(installReport, installReport + 200)).toContain(
      "$(transport_report_json)"
    );
  });

  it("never fails the INSTALL stage when the REALITY key files are absent", () => {
    // transport_report_json must fall back to an empty string (falsy in
    // bash's `[ -n "$transport" ]`), not `set -e`-abort the script, when
    // the files don't exist -- 2>/dev/null || true on both reads.
    const fnStart = BOOTSTRAP_SCRIPT.indexOf("transport_report_json()");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = BOOTSTRAP_SCRIPT.slice(fnStart, BOOTSTRAP_SCRIPT.indexOf("\n}", fnStart) + 2);
    expect(fnBody).toContain("2>/dev/null || true");
    expect(fnBody).toMatch(/echo ""/);
  });

  it("splices a transport object into report()'s body only when given one", () => {
    const reportStart = BOOTSTRAP_SCRIPT.indexOf("report() {");
    const reportBody = BOOTSTRAP_SCRIPT.slice(reportStart, BOOTSTRAP_SCRIPT.indexOf("\n}", reportStart) + 2);
    expect(reportBody).toContain('"transport":%s');
    expect(reportBody).toContain('local stage="$1" status="$2" message="$3" transport="${4:-}"');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- node-bootstrap`
Expected: FAIL — the three new tests fail (`BOOTSTRAP_SCRIPT` does not yet contain any of this text); every pre-existing test in the file still passes.

- [ ] **Step 3: Modify `report()` to accept an optional transport object**

In `functions/lib/node-bootstrap.js`, inside the `BOOTSTRAP_SCRIPT` template literal, replace:

```
report() {
  local stage="$1" status="$2" message="$3" key hdr body
  key="$(agent_key)"
  [ -n "$key" ] || return 0
  [ -f "$STATE_DIR/enrolled" ] || return 0
  message="$(printf '%s' "$message" | tr -cd 'A-Za-z0-9 _.,:/()=+-' | cut -c1-400)"
  body="$(printf '{"stage":"%s","status":"%s","message":"%s"}' "$stage" "$status" "$message")"
  hdr="$(auth_header_file report "$key")"
```

with:

```
report() {
  local stage="$1" status="$2" message="$3" transport="${4:-}" key hdr body
  key="$(agent_key)"
  [ -n "$key" ] || return 0
  [ -f "$STATE_DIR/enrolled" ] || return 0
  message="$(printf '%s' "$message" | tr -cd 'A-Za-z0-9 _.,:/()=+-' | cut -c1-400)"
  if [ -n "$transport" ]; then
    body="$(printf '{"stage":"%s","status":"%s","message":"%s","transport":%s}' "$stage" "$status" "$message" "$transport")"
  else
    body="$(printf '{"stage":"%s","status":"%s","message":"%s"}' "$stage" "$status" "$message")"
  fi
  hdr="$(auth_header_file report "$key")"
```

(the rest of `report()` — the `curl` call — is unchanged).

- [ ] **Step 4: Add `transport_report_json()` and wire it into `stage_install()`**

Directly above `stage_install() {` in the same template literal, add:

```
# REALITY key files are written by install.sh's init_reality_keys (via the
# prebuilt vpn-admin binary) during stage_install, on this same node --
# nothing here regenerates or derives them. tls_server_name is the REALITY
# decoy/masquerade SNI (REALITY_HANDSHAKE_SERVER), never this node's own
# public hostname. reality_fingerprint and vless_flow are fixed deployment
# choices, not per-node data. Every fleet node also runs Hysteria2
# simultaneously (deployment.toml's [hysteria2] section) but nodes.transport
# is a single value -- this reports vless-reality only; Hysteria2 exposure
# via the route directory is a documented follow-up, not this pass.
# Absent/unreadable key files (e.g. an older install.sh) must never fail
# the INSTALL stage: falls back to an empty string, which report() treats
# as "no transport to include".
transport_report_json() {
  local pubkey short_id
  pubkey="$(cat /etc/vpn/compat/reality/public.key 2>/dev/null || true)"
  short_id="$(cat /etc/vpn/compat/reality/short_id.txt 2>/dev/null || true)"
  if [ -z "$pubkey" ] || [ -z "$short_id" ]; then
    echo ""
    return 0
  fi
  printf '{"transport":"vless-reality","server_port":443,"tls_server_name":"%s","reality_public_key":"%s","reality_short_id":"%s","reality_fingerprint":"chrome","vless_flow":"xtls-rprx-vision"}' \
    "$REALITY_HANDSHAKE_SERVER" "$pubkey" "$short_id"
}

```

Then, inside `stage_install()`, change the final line from:

```
  touch "$STATE_DIR/install.ok"
  report INSTALL OK "singbox-vpn $SINGBOX_VPN_VERSION installed"
}
```

to:

```
  touch "$STATE_DIR/install.ok"
  report INSTALL OK "singbox-vpn $SINGBOX_VPN_VERSION installed" "$(transport_report_json)"
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- node-bootstrap`
Expected: PASS — all tests in the file, including the 3 new ones and every pre-existing test (this change is additive to the script text; no existing assertion's substring moves or changes).

Then run: `npm test`
Expected: PASS — the full suite, 0 regressions.

- [ ] **Step 6: Manually verify the generated bash is syntactically valid**

This step is manual verification, not an automated test (this repo's tests are pure-JS; nothing in CI executes `BOOTSTRAP_SCRIPT`). Run:

```bash
node -e "
const { BOOTSTRAP_SCRIPT, AGENT_UNIT } = await import('./functions/lib/node-bootstrap.js');
const fs = await import('node:fs');
fs.writeFileSync('/tmp/bootstrap-check.sh', BOOTSTRAP_SCRIPT.replace('@@AGENT_UNIT@@', AGENT_UNIT));
" --input-type=module
bash -n /tmp/bootstrap-check.sh
```

Expected: no output from `bash -n` (exit code 0) — confirms no syntax error was introduced.

- [ ] **Step 7: Commit**

```bash
git add functions/lib/node-bootstrap.js functions/lib/__tests__/node-bootstrap.test.js
git commit -m "feat(fleet): report node REALITY transport params during INSTALL stage"
```

---

## Task 2: Update ADR-0002's status note

**Files:**
- Modify: `docs/ADR/0002-managed-client-route-contract.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Update Sub-project A's note**

Replace:
```
- **A — Ed25519 signing infrastructure + `GET /v1/routes`: SHIPPED**
  (`docs/superpowers/specs/2026-09-26-adr0002-signed-route-directory-design.md`).
  vpn-web-only this pass — no `singbox-vpn`-side change generates real
  transport data yet (that piece needs a session with a Rust toolchain to
  compile-verify it; none was available here), so the directory correctly
  returns an empty `routes` array until a node actually reports one.
```
with:
```
- **A — Ed25519 signing infrastructure + `GET /v1/routes`: SHIPPED**
  (`docs/superpowers/specs/2026-09-26-adr0002-signed-route-directory-design.md`).
  Nodes now report their `vless-reality` transport parameters during the
  bootstrap script's INSTALL stage (no `singbox-vpn`/Rust change needed —
  the REALITY key files `install.sh` already writes were simply never
  read and sent). Every fleet node also runs Hysteria2 simultaneously,
  but `nodes.transport` is a single value; exposing Hysteria2 as a second
  route hop per node is a documented follow-up, not done here.
```

- [ ] **Step 2: Commit**

```bash
git add docs/ADR/0002-managed-client-route-contract.md
git commit -m "docs: ADR-0002 -- node transport reporting no longer needs a Rust toolchain"
```
