"use client";

import { useState } from "react";
import { AccountShell, Feedback, useAccount } from "@/components/account/AccountShell";
import { api, euro } from "@/lib/api";
import { monthlyCents, statusLabel } from "@/components/account/types";

function BillingBody() {
  const { session, overview, error } = useAccount();
  const [busy, setBusy] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);

  async function openPortal() {
    setBusy(true);
    setPortalError(null);
    try {
      const data = await api<{ url: string }>(session, "/api/billing/portal", { method: "POST" });
      window.location.href = data.url;
    } catch (err) {
      setPortalError(err instanceof Error ? err.message : "Could not open billing management.");
      setBusy(false);
    }
  }

  if (error && !overview) return null;
  if (!overview) return <p className="muted">Loading…</p>;

  const isOwner = overview.role === "owner";

  return (
    <>
      <div className="block">
        <div className="block__head"><h2 className="block__title">Charges</h2></div>
        {overview.subscriptions.length === 0 ? (
          <p className="muted" style={{ marginTop: "var(--space-4)" }}>No active subscriptions.</p>
        ) : (
          <ul className="rows">
            {overview.subscriptions.map((s) => (
              <li key={s.id} className="row">
                <div>
                  <p className="row__title">{s.name}</p>
                  <p className="row__sub">{statusLabel(s)}</p>
                </div>
                <p className="row__title">{euro(monthlyCents(overview.plan, s.extraPacks))}/mo</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {isOwner ? (
        <>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={openPortal}>
            {busy ? "Opening…" : "Manage billing"}
          </button>
          <p className="muted" style={{ marginTop: "var(--space-3)" }}>
            Opens Stripe&apos;s secure billing portal to update payment methods, view invoices, or change plans.
          </p>
          <Feedback error={portalError} />
        </>
      ) : (
        <p className="muted">Only the account owner can manage billing.</p>
      )}
    </>
  );
}

export default function BillingPage() {
  return (
    <AccountShell eyebrow="Account" title="Billing" sub="Payment methods and invoices, managed securely through Stripe.">
      <BillingBody />
    </AccountShell>
  );
}
