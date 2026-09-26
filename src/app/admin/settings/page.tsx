"use client";

import { useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { useAdminSession } from "@/hooks/useAdminSession";
import { adminFetch } from "@/lib/adminFetch";

type Settings = {
  plan: { includedDevices: number; devicesPerPack: number; basePriceCents: number; packPriceCents: number; currency: string };
  billing: { stripeApiKey: boolean; webhookSecret: boolean; basePrice: boolean; packPrice: boolean };
  fleet: {
    multiNodeScheduling: boolean;
    providerHetzner: boolean;
    dnsCloudflare: boolean;
    nodeDomain: string | null;
    singboxVpnVersion: string | null;
    tickSecret: boolean;
  };
  services: { credentialEncryption: boolean; email: boolean; telegram: boolean; siteUrl: string | null };
  readiness?: { name: string; group: string; sensitive: boolean; required: boolean; purpose: string; present: boolean; enabled?: boolean }[];
};

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={`dot ${ok ? "dot--on" : "dot--warn"}`} />;
}

function Row({ label, ok, detail }: { label: string; ok: boolean; detail?: string | null }) {
  return (
    <tr>
      <td>{label}</td>
      <td>
        <StatusDot ok={ok} />
        {ok ? (detail ?? "Configured") : "Missing"}
      </td>
    </tr>
  );
}

export default function AdminSettingsPage() {
  const { session } = useAdminSession();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    adminFetch<Settings>("/api/admin/settings", session.access_token)
      .then((body) => {
        setSettings(body);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, [session]);

  return (
    <AdminShell>
      <h1 className="mb-6 text-xl font-semibold">Settings</h1>
      {error ? (
        <p className="text-red-600">{error}</p>
      ) : !settings ? (
        <p>Loading…</p>
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="mb-2 text-sm font-semibold text-gray-500">Plan</h2>
            <table className="table">
              <tbody>
                <tr>
                  <td>Included devices</td>
                  <td>{settings.plan.includedDevices}</td>
                </tr>
                <tr>
                  <td>Devices per pack</td>
                  <td>{settings.plan.devicesPerPack}</td>
                </tr>
                <tr>
                  <td>Base price</td>
                  <td>{(settings.plan.basePriceCents / 100).toFixed(2)} {settings.plan.currency}</td>
                </tr>
                <tr>
                  <td>Pack price</td>
                  <td>{(settings.plan.packPriceCents / 100).toFixed(2)} {settings.plan.currency}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold text-gray-500">Billing</h2>
            <table className="table">
              <tbody>
                <Row label="Stripe API key" ok={settings.billing.stripeApiKey} />
                <Row label="Stripe webhook secret" ok={settings.billing.webhookSecret} />
                <Row label="Base price" ok={settings.billing.basePrice} />
                <Row label="Device pack price" ok={settings.billing.packPrice} />
              </tbody>
            </table>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold text-gray-500">Fleet</h2>
            <table className="table">
              <tbody>
                <Row label="Multi-node routing" ok={settings.fleet.multiNodeScheduling} detail={settings.fleet.multiNodeScheduling ? "Enabled" : "Disabled"} />
                <Row label="Hetzner" ok={settings.fleet.providerHetzner} />
                <Row label="Cloudflare DNS" ok={settings.fleet.dnsCloudflare} />
                <Row label="Node domain" ok={!!settings.fleet.nodeDomain} detail={settings.fleet.nodeDomain ?? undefined} />
                <Row label="singbox-vpn version" ok={!!settings.fleet.singboxVpnVersion} detail={settings.fleet.singboxVpnVersion ?? undefined} />
                <Row label="Fleet tick secret" ok={settings.fleet.tickSecret} />
              </tbody>
            </table>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold text-gray-500">Services</h2>
            <table className="table">
              <tbody>
                <Row label="Secret encryption" ok={settings.services.credentialEncryption} />
                <Row label="Email" ok={settings.services.email} />
                <Row label="Telegram" ok={settings.services.telegram} />
                <Row label="Site URL" ok={!!settings.services.siteUrl} detail={settings.services.siteUrl ?? undefined} />
              </tbody>
            </table>
          </section>

          {settings.readiness && (
            <section>
              <h2 className="mb-1 text-sm font-semibold text-gray-500">Production readiness</h2>
              <p className="mb-3 text-xs text-gray-500">
                Presence of each runtime variable. Values are never shown. Full inventory: docs/PRODUCTION_CONFIG.md.
              </p>
              {[...new Set(settings.readiness.map((v) => v.group))].map((group) => (
                <div key={group} className="mb-6">
                  <h3 className="mb-1 font-mono text-xs uppercase text-gray-500">{group}</h3>
                  <table className="table">
                    <tbody>
                      {settings.readiness!.filter((v) => v.group === group).map((v) => (
                        <tr key={v.name}>
                          <td className="break-all font-mono text-xs">{v.name}</td>
                          <td className="w-32">
                            <span className={`dot ${v.present ? "dot--on" : v.required ? "dot--warn" : ""}`} />
                            {v.enabled !== undefined ? (v.enabled ? "On" : "Off") : v.present ? "Set" : v.required ? "Missing" : "Not set"}
                          </td>
                          <td className="text-gray-500">{v.required ? "Required" : "Optional"}{v.sensitive ? " · secret" : ""} · {v.purpose}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </AdminShell>
  );
}
