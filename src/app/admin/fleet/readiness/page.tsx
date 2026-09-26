"use client";

import { FleetPage } from "@/components/admin/FleetPage";
import { useFleetData } from "@/hooks/useFleetData";

type Variable = { name: string; group: string; sensitive: boolean; required: boolean; purpose: string; present: boolean; enabled?: boolean };
type Readiness = { flags: { name: string; enabled: boolean; purpose: string }[]; variables: Variable[]; provisioningReady: boolean; missing: string[] };

export default function FleetReadinessPage() {
  const { data, error } = useFleetData<Readiness>("/api/admin/fleet/readiness", 60_000);
  const groups = data ? [...new Set(data.variables.map((v) => v.group))] : [];
  return (
    <FleetPage title="Feature flags & readiness" note="Presence only — values are never shown" error={error} loading={!data}>
      {data && (
        <div className="space-y-8">
          <p className="border-l-2 border-black pl-3 text-sm">
            {data.provisioningReady ? (
              <strong>Automated provisioning is configured.</strong>
            ) : (
              <>
                <strong>Automated provisioning is not ready.</strong> Missing: <span className="break-all font-mono">{data.missing.join(", ")}</span>
              </>
            )}
          </p>
          <section>
            <h3 className="mb-2 font-mono text-xs text-gray-600">FEATURE FLAGS</h3>
            <table className="table">
              <tbody>
                {data.flags.map((f) => (
                  <tr key={f.name}>
                    <td className="break-all font-mono text-xs">{f.name}</td>
                    <td className="w-24 font-semibold">{f.enabled ? "On" : "Off"}</td>
                    <td className="text-gray-700">{f.purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {groups.map((g) => (
            <section key={g}>
              <h3 className="mb-2 font-mono text-xs uppercase text-gray-600">{g}</h3>
              <table className="table">
                <tbody>
                  {data.variables.filter((v) => v.group === g && v.enabled === undefined).map((v) => (
                    <tr key={v.name}>
                      <td className="break-all font-mono text-xs">{v.name}</td>
                      <td className="w-32">
                        <span className={`dot ${v.present ? "dot--on" : v.required ? "dot--warn" : ""}`} />
                        {v.present ? "Set" : v.required ? "Missing" : "Not set"}
                      </td>
                      <td className="text-gray-700">{v.purpose}{v.sensitive ? " · secret" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      )}
    </FleetPage>
  );
}
