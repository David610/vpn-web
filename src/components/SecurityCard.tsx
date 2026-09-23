"use client";

import { useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

export function SecurityCard({ session }: { session: Session }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/account/password", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 && data.code === "reauth_required") {
        window.location.href = "/login/?next=/dashboard/&reauth=1";
        return;
      }
      if (!res.ok) throw new Error(data.error || "Could not change password.");

      // JavaScript signOut defaults to global scope: revoke refresh tokens
      // for every session after a password change, then require a fresh login.
      await supabase.auth.signOut();
      window.location.href = "/login/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change password.");
      setBusy(false);
    }
  }

  return (
    <div className="dm-card" style={{ maxWidth: "26rem", marginTop: "var(--space-6)" }}>
      <div className="dm-card-header">
        <span className="dm-card-title">Security</span>
      </div>
      <div style={{ padding: "var(--space-6)" }}>
        <form onSubmit={changePassword}>
          <label className="field-label" htmlFor="new-password">New password</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
            className="field"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <label className="field-label" htmlFor="confirm-password" style={{ marginTop: "var(--space-3)" }}>
            Confirm new password
          </label>
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
            className="field"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {error && <p className="field-error">{error}</p>}
          <button
            type="submit"
            className="btn btn-secondary"
            disabled={busy}
            style={{ width: "100%", marginTop: "var(--space-4)" }}
          >
            {busy ? "Changing…" : "Change password"}
          </button>
        </form>
      </div>
    </div>
  );
}
