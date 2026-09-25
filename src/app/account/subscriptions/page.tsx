"use client";

import { useState } from "react";
import { AccountShell, Feedback, useAccount } from "@/components/account/AccountShell";
import { api, euro } from "@/lib/api";
import { LIVE, monthlyCents, statusLabel, type Subscription } from "@/components/account/types";

function SubscriptionRow({ sub }: { sub: Subscription }) {
  const { session, overview, reload } = useAccount();
  const plan = overview!.plan;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canRemovePack = sub.extraPacks > 0 && sub.capacity - plan.devicesPerPack >= sub.used;

  async function setPacks(packs: number) {
    setBusy("packs");
    setError(null);
    try {
      await api(session, `/api/account/subscriptions/${sub.id}/packs`, { body: { packs } });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change device capacity.");
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    if (!window.confirm(`Cancel "${sub.name}"? You'll keep access until the end of the current billing period.`)) return;
    setBusy("cancel");
    setError(null);
    try {
      await api(session, `/api/account/subscriptions/${sub.id}/cancel`, { method: "POST" });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel this subscription.");
    } finally {
      setBusy(null);
    }
  }

  async function resume() {
    setBusy("resume");
    setError(null);
    try {
      await api(session, `/api/account/subscriptions/${sub.id}/resume`, { method: "POST" });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resume this subscription.");
    } finally {
      setBusy(null);
    }
  }

  async function rename() {
    const name = window.prompt("Subscription name", sub.name);
    if (!name || name === sub.name) return;
    setBusy("rename");
    setError(null);
    try {
      await api(session, `/api/account/subscriptions/${sub.id}`, { method: "PATCH", body: { name } });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename this subscription.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="row" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
      <div className="row__panel" style={{ padding: 0, background: "none", border: "none" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "var(--space-3)" }}>
          <div>
            <p className="row__title">{sub.name}</p>
            <p className="row__sub">
              {statusLabel(sub)}
              {sub.currentPeriodEnd
                ? sub.cancelAtPeriodEnd
                  ? ` · ends ${new Date(sub.currentPeriodEnd).toLocaleDateString()}`
                  : ` · renews ${new Date(sub.currentPeriodEnd).toLocaleDateString()}`
                : ""}
            </p>
          </div>
          <p className="row__title">{euro(monthlyCents(plan, sub.extraPacks))}/mo</p>
        </div>

        <div className="stats" style={{ margin: "var(--space-4) 0" }}>
          <div className="stats__cell">
            <p className="stats__value">{sub.used}</p>
            <p className="stats__label">Used</p>
          </div>
          <div className="stats__cell">
            <p className="stats__value">{sub.capacity}</p>
            <p className="stats__label">Capacity</p>
          </div>
          <div className="stats__cell">
            <p className="stats__value">{sub.extraPacks}</p>
            <p className="stats__label">Extra packs</p>
          </div>
        </div>

        <div className="row__actions" style={{ justifyContent: "flex-start" }}>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => setPacks(sub.extraPacks + 1)}>
            Add 3 devices
          </button>
          {sub.extraPacks > 0 && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy !== null || !canRemovePack}
              onClick={() => setPacks(sub.extraPacks - 1)}
              title={canRemovePack ? undefined : "Remove or move devices out of this pack first"}
            >
              Remove pack
            </button>
          )}
          <button type="button" className="btn-link" disabled={busy !== null} onClick={rename}>
            Rename
          </button>
          {LIVE.has(sub.status) && !sub.cancelAtPeriodEnd && (
            <button type="button" className="btn-link text-danger" disabled={busy !== null} onClick={cancel}>
              Cancel
            </button>
          )}
          {sub.cancelAtPeriodEnd && (
            <button type="button" className="btn-link" disabled={busy !== null} onClick={resume}>
              Resume
            </button>
          )}
        </div>
        {error && <p className="field-error" style={{ marginTop: "var(--space-2)" }}>{error}</p>}
      </div>
    </li>
  );
}

function SubscriptionsBody() {
  const { session, overview, error } = useAccount();
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  async function createSubscription() {
    const name = window.prompt("Name for the new subscription", "New subscription");
    if (!name) return;
    setCheckoutBusy(true);
    setCheckoutError(null);
    try {
      const data = await api<{ url: string }>(session, "/api/create-checkout-session", {
        body: { trial: false, name },
      });
      window.location.href = data.url;
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : "Could not start checkout.");
      setCheckoutBusy(false);
    }
  }

  if (error && !overview) return null;
  if (!overview) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="block">
        <div className="block__head">
          <h2 className="block__title">Your subscriptions</h2>
        </div>
        {overview.subscriptions.length === 0 ? (
          <p className="muted" style={{ marginTop: "var(--space-4)" }}>No subscriptions yet.</p>
        ) : (
          <ul className="rows">
            {overview.subscriptions.map((s) => (
              <SubscriptionRow key={s.id} sub={s} />
            ))}
          </ul>
        )}
      </div>

      <button type="button" className="btn btn-primary" disabled={checkoutBusy} onClick={createSubscription}>
        {checkoutBusy ? "Redirecting…" : "Create another subscription"}
      </button>
      <Feedback error={checkoutError} />
    </>
  );
}

export default function SubscriptionsPage() {
  return (
    <AccountShell
      eyebrow="Account"
      title="Subscriptions"
      sub="Each subscription covers 3 devices, plus 3 more per paid pack."
    >
      <SubscriptionsBody />
    </AccountShell>
  );
}
