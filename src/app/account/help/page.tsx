"use client";

import { useEffect, useState } from "react";
import { AccountShell, useAccount } from "@/components/account/AccountShell";

type Setup =
  | { phase: "loading" }
  | { phase: "none" }
  | { phase: "ready"; setupUrl: string };

function SetupLinkBlock() {
  const { session } = useAccount();
  const [setup, setSetup] = useState<Setup>({ phase: "loading" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/vpn/config", {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (cancelled) return;
        if (res.status !== 200) {
          setSetup({ phase: "none" });
          return;
        }
        const data = await res.json();
        setSetup({ phase: "ready", setupUrl: data.preferred_setup_url ?? data.subscription_url });
      } catch {
        if (!cancelled) setSetup({ phase: "none" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — the field itself is still selectable.
    }
  }

  if (setup.phase === "loading") return <p className="muted">Loading…</p>;
  if (setup.phase === "none") {
    return <p className="muted">Subscribe first to get your setup link — see Subscriptions.</p>;
  }

  return (
    <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", maxWidth: "32rem" }}>
      <input
        className="field"
        readOnly
        value={setup.setupUrl}
        onFocus={(e) => e.currentTarget.select()}
        style={{ flex: 1, fontSize: "0.85em" }}
      />
      <button type="button" className="btn btn-primary" onClick={() => copy(setup.setupUrl)}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export default function HelpPage() {
  return (
    <AccountShell eyebrow="Account" title="Help" sub="Set up a device, or reach support.">
      <div className="block">
        <div className="block__head"><h2 className="block__title">Setup link</h2></div>
        <p className="section-sub" style={{ margin: "var(--space-3) 0" }}>
          Import this into a supported VPN client to connect a device.
        </p>
        <SetupLinkBlock />
      </div>

      <div className="block">
        <div className="block__head"><h2 className="block__title">Connect a device</h2></div>
        <div className="section-sub" style={{ marginTop: "var(--space-3)" }}>
          <p><strong>iPhone / iPad:</strong> open your supported VPN client, choose import/add subscription, and paste the setup link.</p>
          <p><strong>Android:</strong> use a compatible client and import the link.</p>
          <p><strong>Windows / macOS:</strong> open the compatible client, add a subscription/profile from URL, then connect.</p>
        </div>
      </div>

      <div className="block">
        <div className="block__head"><h2 className="block__title">Diagnostics</h2></div>
        <p className="section-sub" style={{ marginTop: "var(--space-3)" }}>
          Arcana does not log browsing activity, domains or destination history. If something
          isn&apos;t connecting, check Devices for the device&apos;s status, or Connections for the
          selected route, before contacting support.
        </p>
      </div>

      <div className="block">
        <div className="block__head"><h2 className="block__title">Contact support</h2></div>
        <p className="section-sub" style={{ marginTop: "var(--space-3)" }}>
          Reach us at <a className="text-link" href="mailto:support@arcana.example">support@arcana.example</a>.
        </p>
      </div>
    </AccountShell>
  );
}
