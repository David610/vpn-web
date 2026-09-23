"use client";

import { useState } from "react";
import type { Session } from "@supabase/supabase-js";

export function AccountActionsCard({
  session,
  setupUrl,
}: {
  session: Session;
  setupUrl: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function openBilling() {
    setBusy("billing");
    setError(null);
    try {
      const res = await fetch("/api/billing/portal", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 && data.code === "reauth_required") {
        window.location.href = "/login/?next=/dashboard/&reauth=1";
        return;
      }
      if (!res.ok || !data.url) throw new Error(data.error || "Could not open billing.");
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open billing.");
      setBusy(null);
    }
  }

  async function rotateCredentials() {
    if (
      !window.confirm(
        "Regenerate your VPN credentials? Existing VLESS and Hysteria2 configurations will stop connecting after the change. You must re-import your Arcana setup afterwards."
      )
    ) {
      return;
    }

    setBusy("rotate");
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/vpn/rotate-credentials", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 && data.code === "reauth_required") {
        window.location.href = "/login/?next=/dashboard/&reauth=1";
        return;
      }
      if (!res.ok) throw new Error(data.error || "Could not regenerate VPN credentials.");
      setMessage(
        "Credential rotation is queued. Re-import your setup link after provisioning completes; the old VPN credentials will stop working."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not regenerate VPN credentials.");
    } finally {
      setBusy(null);
    }
  }

  async function copySetup() {
    try {
      await navigator.clipboard.writeText(setupUrl);
      setMessage("Setup link copied.");
      setError(null);
    } catch {
      setError("Copy failed. Select and copy the setup link manually.");
    }
  }

  return (
    <div className="dm-card" style={{ maxWidth: "26rem", marginTop: "var(--space-6)" }}>
      <div className="dm-card-header">
        <span className="dm-card-title">Account & devices</span>
      </div>
      <div style={{ padding: "var(--space-6)" }}>
        <p className="section-sub">
          Use the same private setup link on your own devices. Each plan member has a separate VPN identity.
        </p>

        <div style={{ marginTop: "var(--space-4)" }}>
          <label className="field-label" htmlFor="setup-url">Setup link</label>
          <input
            id="setup-url"
            className="field"
            readOnly
            value={setupUrl}
            onFocus={(e) => e.currentTarget.select()}
            style={{ fontSize: "0.82em" }}
          />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={copySetup}
            style={{ width: "100%", marginTop: "var(--space-2)" }}
          >
            Copy setup link
          </button>
        </div>

        <details style={{ marginTop: "var(--space-4)" }}>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>Connect a device</summary>
          <div className="section-sub" style={{ marginTop: "var(--space-3)" }}>
            <p><strong>iPhone / iPad:</strong> open your supported VPN client, choose import/add subscription, and paste the setup link.</p>
            <p><strong>Android:</strong> use Hiddify or another compatible sing-box client and import the link.</p>
            <p><strong>Windows / macOS:</strong> open the compatible client, add a subscription/profile from URL, then connect.</p>
            <p><strong>Other:</strong> use the subscription URL shown in the VPN card if your client does not support Arcana&apos;s first-party provisioning endpoint.</p>
          </div>
        </details>

        <div style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-5)" }}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy === "billing"}
            onClick={openBilling}
          >
            {busy === "billing" ? "Opening…" : "Manage billing"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy === "rotate"}
            onClick={rotateCredentials}
          >
            {busy === "rotate" ? "Regenerating…" : "Regenerate VPN credentials"}
          </button>
        </div>

        {message && <p className="section-sub" style={{ marginTop: "var(--space-3)" }}>{message}</p>}
        {error && <p className="field-error">{error}</p>}
      </div>
    </div>
  );
}
