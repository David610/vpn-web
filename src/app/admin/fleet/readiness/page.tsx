"use client";

import { FleetPage } from "@/components/admin/FleetPage";
import { useFleetData } from "@/hooks/useFleetData";

type Variable = { name: string; group: string; sensitive: boolean; required: boolean; purpose: string; present: boolean; enabled?: boolean };
type IncompatibleNode = { nodeId: string; reasons: string[]; agentVersion: string | null; provisioningProtocol: number | null; claimCapabilityVersion: number | null; minimumLeaseSeconds: number | null; capabilitiesReportedAt: string | null };
type Readiness = { flags: { name: string; enabled: boolean; purpose: string }[]; variables: Variable[]; provisioningReady: boolean; missing: string[]; claimEnforcement: { ready: boolean; eligibleNodes: number; compatibleNodes: number; serverLeaseSeconds: number; incompatibleNodes: IncompatibleNode[] } };

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
          <section aria-labelledby="claim-token-heading">
            <h2 id="claim-token-heading" className="mb-2 text-lg font-semibold">Claim-token enforcement</h2>
            <p className="mb-3 border-l-2 border-black pl-3">
              <strong>{data.claimEnforcement.ready ? "Ready for operator enablement" : "Not ready"}</strong>
              {` — ${data.claimEnforcement.compatibleNodes}/${data.claimEnforcement.eligibleNodes} eligible nodes compatible; server lease ${data.claimEnforcement.serverLeaseSeconds}s.`}
            </p>
            <p className="mb-3 text-sm text-gray-700">Evidence only. This page never enables enforcement; an operator must save preflight evidence and explicitly acknowledge the rollout gate.</p>
            {data.claimEnforcement.incompatibleNodes.length > 0 && <table className="table">
              <thead><tr><th>Node</th><th>Reason</th><th>Agent</th><th>Protocol</th><th>Claim capability</th><th>Minimum lease</th><th>Last capability heartbeat</th></tr></thead>
              <tbody>{data.claimEnforcement.incompatibleNodes.map((node) => <tr key={node.nodeId}>
                <td className="font-mono text-xs">{node.nodeId}</td><td>{node.reasons.join(", ")}</td><td>{node.agentVersion ?? "—"}</td><td>{node.provisioningProtocol ?? "—"}</td><td>{node.claimCapabilityVersion ?? "—"}</td><td>{node.minimumLeaseSeconds ?? "—"}</td><td>{node.capabilitiesReportedAt ?? "—"}</td>
              </tr>)}</tbody>
            </table>}
          </section>
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
