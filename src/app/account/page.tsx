"use client";

import Link from "next/link";
import { AccountShell, useAccount } from "@/components/account/AccountShell";
import { euro } from "@/lib/api";
import { monthlyCents, statusLabel } from "@/components/account/types";

function OverviewBody() {
  const { overview, error } = useAccount();
  if (error && !overview) return null;
  if (!overview) return <p className="muted">Loading…</p>;

  const { subscriptions, devices, capacity, plan } = overview;

  return (
    <>
      <div className="stats" style={{ marginBottom: "var(--space-12)" }}>
        <div className="stats__cell">
          <p className="stats__value">{capacity.used} / {capacity.total}</p>
          <p className="stats__label">Devices used</p>
        </div>
        <div className="stats__cell">
          <p className="stats__value">{subscriptions.length}</p>
          <p className="stats__label">Subscriptions</p>
        </div>
        <div className="stats__cell">
          <p className="stats__value">{devices.length}</p>
          <p className="stats__label">Registered devices</p>
        </div>
      </div>

      <div className="block">
        <div className="block__head">
          <h2 className="block__title">Subscriptions</h2>
          <Link href="/account/subscriptions/" className="text-link">Manage</Link>
        </div>
        {subscriptions.length === 0 ? (
          <p className="muted" style={{ marginTop: "var(--space-4)" }}>No subscriptions yet.</p>
        ) : (
          <ul className="rows">
            {subscriptions.map((s) => (
              <li key={s.id} className="row">
                <div>
                  <p className="row__title">{s.name}</p>
                  <p className="row__sub">
                    {statusLabel(s)} · {s.used}/{s.capacity} devices · {euro(monthlyCents(plan, s.extraPacks))}/mo
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="block">
        <div className="block__head">
          <h2 className="block__title">Devices</h2>
          <Link href="/account/devices/" className="text-link">Manage</Link>
        </div>
        {devices.length === 0 ? (
          <p className="muted" style={{ marginTop: "var(--space-4)" }}>No devices registered yet.</p>
        ) : (
          <ul className="rows">
            {devices.slice(0, 5).map((d) => (
              <li key={d.id} className="row">
                <div>
                  <p className="row__title">{d.name}</p>
                  <p className="row__sub">{d.platform} · {d.status === "REVOKED" ? "Revoked" : "Active"}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export default function AccountOverviewPage() {
  return (
    <AccountShell eyebrow="Account" title="Overview" sub="Your subscriptions, devices and capacity at a glance.">
      <OverviewBody />
    </AccountShell>
  );
}
