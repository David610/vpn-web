"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { api } from "@/lib/api";

/** Change the sign-in email. Supabase emails a confirmation to the new address; nothing changes until it is used. */
export function ChangeEmailForm({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { supabase } = await import("@/lib/supabase");
      const { error: updateError } = await supabase.auth.updateUser(
        { email: email.trim() },
        { emailRedirectTo: `${window.location.origin}/auth/callback/` }
      );
      if (updateError) {
        // Do not echo the provider's wording: it can reveal whether an address is registered.
        console.error("email change failed:", updateError.message);
        setError("We could not start the email change. Check the address and try again.");
        return;
      }
      setSent(true);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="inline-form" role="status">
        <p>We sent a confirmation link to <strong>{email.trim()}</strong>. Your email changes once you open it.</p>
        <button type="button" className="btn btn-secondary" onClick={onDone}>Close</button>
      </div>
    );
  }
  return (
    <form className="inline-form" onSubmit={submit}>
      <label className="field-label" htmlFor="new-email">New email address</label>
      <input id="new-email" type="email" required autoComplete="email" className="field" value={email} onChange={(e) => setEmail(e.target.value)} />
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Sending…" : "Send confirmation"}</button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

/** Change the password, then sign out everywhere and ask for a fresh login. */
export function ChangePasswordForm({ session, onDone }: { session: Session; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await api(session, "/api/account/password", { body: { password } });
      const { supabase } = await import("@/lib/supabase");
      // Global sign-out revokes every refresh token after a password change.
      await supabase.auth.signOut();
      window.location.href = "/login/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change password.");
      setBusy(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <label className="field-label" htmlFor="new-password">New password</label>
      <input id="new-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required className="field" value={password} onChange={(e) => setPassword(e.target.value)} />
      <label className="field-label" htmlFor="confirm-password">Confirm new password</label>
      <input id="confirm-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required className="field" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      <p className="field-hint">At least 12 characters. You will be signed out everywhere afterwards.</p>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Changing…" : "Change password"}</button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

export function DeleteAccountBlock({ session }: { session: Session }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function deleteAccount(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(session, "/api/account/delete", { body: { password } });
      const { supabase } = await import("@/lib/supabase");
      await supabase.auth.signOut();
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete your account.");
      setBusy(false);
    }
  }

  return (
    <section className="ps-card ps-card--quiet" aria-labelledby="delete-heading">
      <h2 id="delete-heading">Delete account</h2>
      <p className="muted">
        This permanently deletes your Arcana account, subscriptions and VPN links. It is separate from canceling your plan.
      </p>
      {!confirming ? (
        <button type="button" className="btn btn-secondary" onClick={() => setConfirming(true)}>Delete account</button>
      ) : (
        <form className="inline-form" onSubmit={deleteAccount}>
          <label className="field-label" htmlFor="delete-password">Confirm your password</label>
          <input id="delete-password" type="password" autoComplete="current-password" required className="field" value={password} onChange={(e) => setPassword(e.target.value)} />
          {error ? <p className="field-error" role="alert">{error}</p> : null}
          <div className="form-actions">
            <button type="submit" className="btn btn-danger" disabled={busy}>{busy ? "Deleting…" : "Permanently delete my account"}</button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}
