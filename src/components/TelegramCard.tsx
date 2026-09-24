"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";

type Status =
  | { phase: "loading" }
  | { phase: "unlinked" }
  | { phase: "linked"; username: string | null; linkedAt: string }
  | { phase: "error" };

export function TelegramCard({ session }: { session: Session }) {
  const [status, setStatus] = useState<Status>({ phase: "loading" });
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadStatus() {
    try {
      const res = await fetch("/api/account/telegram", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error("Could not load Telegram link status.");
      const data = await res.json();
      setStatus(
        data.linked
          ? { phase: "linked", username: data.telegramUsername, linkedAt: data.linkedAt }
          : { phase: "unlinked" }
      );
    } catch {
      setStatus({ phase: "error" });
    }
  }

  useEffect(() => {
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function generateCode() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/account/telegram/link-code", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 && data.code === "reauth_required") {
        window.location.href = "/login/?next=/dashboard/&reauth=1";
        return;
      }
      if (!res.ok) throw new Error(data.error || "Could not generate a linking code.");
      setCode(data.code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate a linking code.");
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/account/telegram/unlink", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 && data.code === "reauth_required") {
        window.location.href = "/login/?next=/dashboard/&reauth=1";
        return;
      }
      if (!res.ok) throw new Error(data.error || "Could not unlink Telegram.");
      setCode(null);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unlink Telegram.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dm-card" style={{ maxWidth: "26rem", marginTop: "var(--space-6)" }}>
      <div className="dm-card-header">
        <span className="dm-card-title">Telegram</span>
      </div>
      <div style={{ padding: "var(--space-6)" }}>
        {status.phase === "loading" && <p>Loading…</p>}

        {status.phase === "linked" && (
          <>
            <p>
              Linked to {status.username ? `@${status.username}` : "a Telegram account"} on{" "}
              {new Date(status.linkedAt).toLocaleDateString()}.
            </p>
            {error && <p className="field-error">{error}</p>}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={unlink}
              style={{ width: "100%", marginTop: "var(--space-4)" }}
            >
              {busy ? "Unlinking…" : "Unlink Telegram"}
            </button>
          </>
        )}

        {(status.phase === "unlinked" || status.phase === "error") && (
          <>
            <p>
              Link your Telegram account to use the Arcana Mini App with the same devices and
              seats as your dashboard.
            </p>
            {code ? (
              <div style={{ marginTop: "var(--space-4)" }}>
                <p>
                  Open the Arcana bot in Telegram and send this code within 10 minutes:
                </p>
                <p className="dm-card-title" style={{ fontSize: "1.5rem", letterSpacing: "0.1em" }}>
                  {code}
                </p>
              </div>
            ) : (
              <>
                {error && <p className="field-error">{error}</p>}
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={generateCode}
                  style={{ width: "100%", marginTop: "var(--space-4)" }}
                >
                  {busy ? "Generating…" : "Link Telegram"}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
