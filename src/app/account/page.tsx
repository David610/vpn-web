"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AccountShell, useAccount } from "@/components/account/AccountShell";
import { bytes, type VpnLink } from "@/components/account/links";
import UsageChart, { dailyTotals, type UsageRow } from "@/components/account/UsageChart";
import { api, euro, relative } from "@/lib/api";
import { LIVE, monthlyCents } from "@/components/account/types";

type LinkSummary = { links: VpnLink[]; usage: UsageRow[]; failed?: boolean };

function dateLabel(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null;
}

function OverviewBody() {
  const { overview, error, session } = useAccount();
  const [summary, setSummary] = useState<LinkSummary | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([
      api<{ links: VpnLink[] }>(session, "/api/account/links"),
      api<{ usage: UsageRow[] }>(session, "/api/account/links/usage"),
    ])
      .then(([l, u]) => { if (live) setSummary({ links: l.links, usage: u.usage }); })
      .catch(() => { if (live) setSummary({ links: [], usage: [], failed: true }); });
    return () => { live = false; };
  }, [session]);

  const days = useMemo(() => dailyTotals(summary?.usage ?? []), [summary]);
  const total = days.reduce((sum, d) => sum + d.bytes, 0);
  const perLink = useMemo(() => {
    const totals = new Map<string, number>();
    for (const r of summary?.usage ?? []) totals.set(String(r.link_id), (totals.get(String(r.link_id)) ?? 0) + Number(r.rx_bytes) + Number(r.tx_bytes));
    return totals;
  }, [summary]);

  if (error && !overview) return null;
  if (!overview) return <p className="muted">Loading…</p>;

  const { subscriptions, devices, capacity, plan } = overview;
  const sub = subscriptions.find((s) => LIVE.has(s.status)) ?? subscriptions[0] ?? null;
  const activeDevices = devices.filter((d) => d.status !== "REVOKED");
  const activeLinks = (summary?.links ?? []).filter((l) => l.status === "active");

  return (
    <>
      <div className="cards">
        <section className="card">
          <p className="card__label">Subscription</p>
          {sub ? (
            <>
              <p className="card__value">
                {euro(monthlyCents(plan, sub.extraPacks))} <span className="card__unit">/ month</span>
              </p>
              <p className="card__note">
                {sub.cancelAtPeriodEnd ? "Ends" : "Renews"} on {dateLabel(sub.currentPeriodEnd) ?? "—"}
              </p>
            </>
          ) : (
            <p className="card__note">No subscription yet.</p>
          )}
          <Link className="btn btn-secondary btn-block" href="/account/subscription/">Manage</Link>
        </section>
        <section className="card">
          <p className="card__label">Devices</p>
          <p className="card__value">{capacity.used} / {capacity.total}</p>
          <p className="card__note">Places in use</p>
          <Link className="btn btn-secondary btn-block" href="/account/devices/">Manage</Link>
        </section>
        <section className="card">
          <p className="card__label">Links</p>
          <p className="card__value">{summary?.failed ? "—" : summary ? activeLinks.length : "…"}</p>
          <p className="card__note">{summary?.failed ? "Temporarily unavailable" : "Active Links"}</p>
          <Link className="btn btn-secondary btn-block" href="/account/links/">Manage</Link>
        </section>
      </div>

      <section className="panel-lite">
        <div className="panel-lite__head">
          <h2>Usage (30 days)</h2>
          <span className="muted">Links only</span>
        </div>
        {summary?.failed ? (
          <p className="muted">Usage is temporarily unavailable.</p>
        ) : (
          <>
            <p className="card__value">{total > 0 ? bytes(total) : "No usage yet"}</p>
            <UsageChart days={days} />
          </>
        )}
      </section>

      <div className="split">
        <section className="panel-lite">
          <h2>Active devices</h2>
          {activeDevices.length === 0 ? (
            <p className="muted">No devices registered yet.</p>
          ) : (
            <ul className="mini-rows">
              {activeDevices.slice(0, 3).map((d) => (
                <li key={d.id}>
                  <span className="mini-rows__name">{d.name}</span>
                  <span className="muted">{d.platform}</span>
                  <span className="muted mini-rows__end">{d.lastSeenAt ? relative(d.lastSeenAt) : "Not connected yet"}</span>
                </li>
              ))}
            </ul>
          )}
          <Link className="text-link" href="/account/devices/">View all devices →</Link>
        </section>
        <section className="panel-lite">
          <h2>Active links</h2>
          {activeLinks.length === 0 ? (
            <p className="muted">{summary?.failed ? "Links are temporarily unavailable." : "No Links yet."}</p>
          ) : (
            <ul className="mini-rows">
              {activeLinks.slice(0, 3).map((l) => (
                <li key={l.id}>
                  <span className="mini-rows__name">{l.name}</span>
                  <span className="muted">{l.clientCount} {l.clientCount === 1 ? "client" : "clients"}</span>
                  <span className="muted mini-rows__end">{bytes(perLink.get(l.id) ?? 0)}</span>
                </li>
              ))}
            </ul>
          )}
          <Link className="text-link" href="/account/links/">View all links →</Link>
        </section>
      </div>
    </>
  );
}

export default function AccountOverviewPage() {
  return (
    <AccountShell eyebrow="Account" title="Overview" sub="Your VPN, on your terms.">
      <OverviewBody />
    </AccountShell>
  );
}
