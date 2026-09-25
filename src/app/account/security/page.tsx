"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AccountShell, useAccount } from "@/components/account/AccountShell";
import { SecurityCard } from "@/components/SecurityCard";
import { TelegramCard } from "@/components/TelegramCard";
import { api } from "@/lib/api";
import { supabase } from "@/lib/supabase";

function DeleteAccountBlock() {
  const { session } = useAccount();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function deleteAccount(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(session, "/api/account/delete", { body: { password } });
      await supabase.auth.signOut();
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete your account.");
      setBusy(false);
    }
  }

  return (
    <div className="block">
      <div className="block__head"><h2 className="block__title">Delete account</h2></div>
      <p className="section-sub" style={{ marginTop: "var(--space-3)" }}>
        This permanently deletes your Arcana account, subscriptions and devices. It is separate
        from canceling a subscription. Uninstalling the app on your devices is a separate step.
      </p>
      {!confirming ? (
        <button
          type="button"
          className="btn btn-secondary"
          style={{ marginTop: "var(--space-4)" }}
          onClick={() => setConfirming(true)}
        >
          Delete account
        </button>
      ) : (
        <form onSubmit={deleteAccount} style={{ marginTop: "var(--space-4)", maxWidth: "24rem" }}>
          <label className="field-label" htmlFor="delete-password">Confirm your password</label>
          <input
            id="delete-password"
            type="password"
            autoComplete="current-password"
            required
            className="field"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="field-error">{error}</p>}
          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-4)" }}>
            <button type="submit" className="btn btn-danger" disabled={busy}>
              {busy ? "Deleting…" : "Permanently delete my account"}
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function SecurityBody() {
  const { session } = useAccount();
  return (
    <>
      <SecurityCard session={session} />
      <TelegramCard session={session} />
      <DeleteAccountBlock />
    </>
  );
}

export default function SecurityPage() {
  return (
    <AccountShell eyebrow="Account" title="Security" sub="Password, linked identities and account deletion.">
      <SecurityBody />
    </AccountShell>
  );
}
