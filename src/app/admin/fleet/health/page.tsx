"use client";

import { FleetPage, Empty, when } from "@/components/admin/FleetPage";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { useFleetData } from "@/hooks/useFleetData";

type HealthNode = {
  nodeId: string;
  role: string;
  lifecycleState: string;
  lifecycleStateChangedAt: string | null;
  failedReason: string | null;
  location: string | null;
  probe: { lastAt: string | null; lastOk: boolean | null; consecutiveFailures: number; consecutiveSuccesses: number };
  capacity: { assignedDevices: number; maxSessions: number | null; utilization: number | null; capacityMbps: number | null; cpuPercent: number | null; memoryPercent: number | null };
  revision: { desired: number; observed: number; inSync: boolean };
  versions: { agent: string | null; vpn: string | null; singbox: string | null };
  bootstrap: { stage: string | null; status: string | null };
  protocol?: {
    summary: Record<string, ProtoSummary> | null;
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    hysteria2CertDays: number | null;
  };
  ipReputation?: { value: string | null };
};
type ProtoSummary = {
  ok: boolean | null;
  vantage: string | null;
  latencyMs: number | null;
  lossPct: number | null;
  error: string | null;
  dims: Record<string, string | boolean | null>;
};
type ProbeRow = {
  id: number; at: string; reporter: string; target: string; vantage: string;
  protocol: string; dimension: string; ok: boolean | null; value: number | null; text: string | null;
};
type Health = {
  nodes: HealthNode[];
  revisions: { nodeId: string; revision: number; reason: string | null; createdAt: string }[];
  events: { id: number; action: string; nodeId: string; createdAt: string }[];
  probeHistory?: ProbeRow[];
};

const mark = (v: boolean | null | undefined) => (v == null ? "—" : v ? "ok" : "FAIL");

function ProtocolCell({ p }: { p: HealthNode["protocol"] }) {
  if (!p?.summary || Object.keys(p.summary).length === 0) return <>—</>;
  return (
    <div className="space-y-1 text-xs">
      {Object.entries(p.summary).map(([proto, s]) => (
        <div key={proto}>
          <span className="font-mono">{proto}</span>{" "}
          {s.ok ? "OK" : <strong>FAIL{s.error ? ` (${s.error})` : ""}</strong>}{" "}
          <span className="text-gray-600">
            {s.vantage} · {s.latencyMs ?? "—"} ms · loss {s.lossPct ?? "—"}% · dns {mark(s.dims.dns as boolean | null)} · v6 {String(s.dims.ipv6 ?? "—")}
            {s.dims.egress_ip_match === false ? " · EGRESS IP MISMATCH" : ""}
          </span>
        </div>
      ))}
      <div className="text-gray-600">
        streak {p.consecutiveFailures} / {p.consecutiveSuccesses}
        {p.hysteria2CertDays != null ? ` · hy2 cert ${p.hysteria2CertDays}d` : ""}
      </div>
    </div>
  );
}

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);

export default function FleetHealthPage() {
  const { data, error } = useFleetData<Health>("/api/admin/fleet/health");
  return (
    <FleetPage title="Health, capacity & revisions" note="Probe state from the fleet reconciler" error={error} loading={!data}>
      {data && (
        <div className="space-y-8">
          {data.nodes.length === 0 ? (
            <Empty>No nodes.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Node</th><th>Lifecycle</th><th>Last probe</th><th className="num">Fail / OK streak</th><th>Protocols</th>
                    <th className="num">Devices / max</th><th className="num">Util.</th><th>Revision (obs/des)</th><th>Versions</th><th>Bootstrap</th>
                  </tr>
                </thead>
                <tbody>
                  {data.nodes.map((n) => (
                    <tr key={n.nodeId}>
                      <td>
                        <span className="font-mono font-medium">{n.nodeId}</span>
                        <div className="text-xs text-gray-600">{n.location ?? "unassigned"} · {n.role}</div>
                      </td>
                      <td>
                        <StatusBadge status={n.lifecycleState} />
                        {n.failedReason && <div className="text-xs text-gray-600">{n.failedReason}</div>}
                        <div className="text-xs text-gray-600">since {when(n.lifecycleStateChangedAt)}</div>
                      </td>
                      <td>
                        {n.probe.lastOk == null ? "—" : n.probe.lastOk ? "OK" : <strong>FAIL</strong>}
                        <div className="text-xs text-gray-600">{when(n.probe.lastAt)}</div>
                      </td>
                      <td className="num">{n.probe.consecutiveFailures} / {n.probe.consecutiveSuccesses}</td>
                      <td>
                        <ProtocolCell p={n.protocol} />
                        {n.ipReputation?.value && <div className="text-xs text-gray-600">IP rep. {n.ipReputation.value} (info)</div>}
                      </td>
                      <td className="num">{n.capacity.assignedDevices} / {n.capacity.maxSessions ?? "—"}</td>
                      <td className="num">{pct(n.capacity.utilization)}</td>
                      <td className="tabular-nums">
                        {n.revision.observed}/{n.revision.desired} {n.revision.inSync ? "" : <strong className="text-xs">DRIFT</strong>}
                      </td>
                      <td className="text-xs text-gray-700">
                        agent {n.versions.agent ?? "—"}<br />vpn {n.versions.vpn ?? "—"}<br />sing-box {n.versions.singbox ?? "—"}
                      </td>
                      <td className="text-xs">{n.bootstrap.status ? `${n.bootstrap.status} · ${n.bootstrap.stage ?? ""}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <section>
            <h3 className="mb-2 font-mono text-xs text-gray-600">PROTOCOL PROBE HISTORY (useful egress, newest first)</h3>
            {(data.probeHistory ?? []).filter((r) => r.dimension === "useful_egress").length === 0 ? (
              <Empty>No protocol probe results yet.</Empty>
            ) : (
              <ul className="divide-y divide-gray-200 border-t border-black text-sm">
                {(data.probeHistory ?? [])
                  .filter((r) => r.dimension === "useful_egress")
                  .slice(0, 40)
                  .map((r) => (
                    <li key={r.id} className="flex flex-wrap justify-between gap-x-3 py-2">
                      <span>
                        <span className="font-mono">{r.target}</span> {r.protocol} {r.ok ? "OK" : <strong>FAIL{r.text ? ` (${r.text})` : ""}</strong>}
                        <span className="text-xs text-gray-600"> via {r.vantage === "self" ? "self (loopback)" : r.reporter}</span>
                      </span>
                      <span className="whitespace-nowrap text-xs text-gray-600">{when(r.at)}</span>
                    </li>
                  ))}
              </ul>
            )}
          </section>
          <div className="grid gap-8 md:grid-cols-2">
            <section>
              <h3 className="mb-2 font-mono text-xs text-gray-600">RECENT NODE EVENTS</h3>
              {data.events.length === 0 ? <Empty>No recorded events.</Empty> : (
                <ul className="divide-y divide-gray-200 border-t border-black text-sm">
                  {data.events.slice(0, 25).map((e) => (
                    <li key={e.id} className="flex flex-wrap justify-between gap-x-3 py-2">
                      <span><span className="font-mono">{e.nodeId}</span> {e.action}</span>
                      <span className="whitespace-nowrap text-xs text-gray-600">{when(e.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h3 className="mb-2 font-mono text-xs text-gray-600">RECENT REVISIONS</h3>
              {data.revisions.length === 0 ? <Empty>No revisions pushed.</Empty> : (
                <ul className="divide-y divide-gray-200 border-t border-black text-sm">
                  {data.revisions.slice(0, 25).map((r) => (
                    <li key={`${r.nodeId}-${r.revision}`} className="flex flex-wrap justify-between gap-x-3 py-2">
                      <span><span className="font-mono">{r.nodeId}</span> r{r.revision} {r.reason ? `· ${r.reason}` : ""}</span>
                      <span className="whitespace-nowrap text-xs text-gray-600">{when(r.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </FleetPage>
  );
}
