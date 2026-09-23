"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";

type Usage =
  | { available: false; reason?: string }
  | {
      available: true;
      sampled_at: string;
      last_seen_at: string | null;
      download_bps: number;
      upload_bps: number;
      month_download_bytes: number;
      month_upload_bytes: number;
      month_total_bytes: number;
    };

function bytes(value: number) {
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function rate(value: number) {
  return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)} Mbps`;
}

export function UsageCard({ session }: { session: Session }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/vpn/usage", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      if (!res.ok) throw new Error("usage request failed");
      setUsage(await res.json());
      setError(false);
    } catch {
      setError(true);
    }
  }, [session.access_token]);

  // Initial load once. If per-user telemetry is unavailable (the normal
  // state on standard sing-box builds), do not keep waking an old phone and
  // hitting the Worker every 15 seconds for the same "unavailable" answer.
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!usage?.available) return;

    const refresh = () => {
      if (document.visibilityState === "visible") load();
    };
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load, usage?.available]);

  return (
    <div className="dm-card" style={{ maxWidth: "26rem", marginTop: "var(--space-6)" }}>
      <div className="dm-card-header">
        <span className="dm-card-title">Usage</span>
      </div>
      <div style={{ padding: "var(--space-6)" }}>
        {error ? (
          <p className="field-error">Could not load usage telemetry.</p>
        ) : !usage ? (
          <p className="section-sub">Loading usage…</p>
        ) : !usage.available ? (
          <p className="section-sub">
            Usage telemetry is not available for this VPN profile yet. This does not affect your connection.
          </p>
        ) : (
          <>
            <p className="text-tiny" style={{ margin: 0, color: "var(--fg-2)" }}>
              Traffic this month
            </p>
            <p style={{ fontSize: "1.6rem", fontWeight: 650, margin: "var(--space-1) 0" }}>
              {bytes(usage.month_total_bytes)}
            </p>
            <p className="section-sub">
              ↓ {bytes(usage.month_download_bytes)} · ↑ {bytes(usage.month_upload_bytes)}
            </p>

            <div style={{ marginTop: "var(--space-5)" }}>
              <p className="text-tiny" style={{ margin: 0, color: "var(--fg-2)" }}>
                Live traffic
              </p>
              <p style={{ margin: "var(--space-1) 0 0" }}>
                ↓ {rate(usage.download_bps)} · ↑ {rate(usage.upload_bps)}
              </p>
              <p className="text-tiny" style={{ marginTop: "var(--space-2)" }}>
                {usage.last_seen_at
                  ? `Last active ${new Date(usage.last_seen_at).toLocaleString()}`
                  : `Last sample ${new Date(usage.sampled_at).toLocaleString()}`}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
