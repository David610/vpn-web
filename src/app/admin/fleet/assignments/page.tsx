"use client";

import { useState } from "react";
import { FleetPage, Empty, when } from "@/components/admin/FleetPage";
import { useFleetData } from "@/hooks/useFleetData";

type Assignments = {
  byNode: { nodeId: string; exit: number; relay: number; total: number }[];
  total: number;
  assignments: {
    deviceId: string;
    nodeId: string;
    hop: string;
    assignedAt: string;
    accountId: string | null;
    subscriptionId: string | null;
    platform: string | null;
    deviceStatus: string | null;
    placementStatus: string | null;
  }[];
};

export default function FleetAssignmentsPage() {
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const { data, error } = useFleetData<Assignments>(`/api/admin/fleet/assignments?q=${encodeURIComponent(applied)}`);
  return (
    <FleetPage title="Device → node assignments" note={data ? `${data.total} placements` : undefined} error={error} loading={!data}>
      {data && (
        <div className="space-y-8">
          <section>
            <h3 className="mb-2 font-mono text-xs text-gray-600">PER NODE</h3>
            {data.byNode.length === 0 ? (
              <Empty>No devices are placed on any node.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>Node</th><th className="num">Exit hop</th><th className="num">Relay hop</th><th className="num">Total</th></tr>
                  </thead>
                  <tbody>
                    {data.byNode.map((n) => (
                      <tr key={n.nodeId}>
                        <td className="font-mono">{n.nodeId}</td>
                        <td className="num">{n.exit}</td>
                        <td className="num">{n.relay}</td>
                        <td className="num font-semibold">{n.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section>
            <form
              className="mb-2 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setApplied(q.trim());
              }}
            >
              <label className="text-xs text-gray-600">
                Filter by device id, account id prefix or node
                <input className="mt-1 grid w-full max-w-xs border border-gray-400 px-2 py-1 font-mono text-sm" value={q} onChange={(e) => setQ(e.target.value)} />
              </label>
              <button type="submit" className="border border-black px-3 py-1 text-sm">Filter</button>
            </form>
            {data.assignments.length === 0 ? (
              <Empty>No matching assignments.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>Device</th><th>Node</th><th>Hop</th><th>Account</th><th>Platform</th><th>Device status</th><th>Placement</th><th>Assigned</th></tr>
                  </thead>
                  <tbody>
                    {data.assignments.map((a) => (
                      <tr key={`${a.deviceId}-${a.hop}`}>
                        <td className="font-mono text-xs">{a.deviceId.slice(0, 8)}</td>
                        <td className="font-mono">{a.nodeId}</td>
                        <td className="font-mono text-xs">{a.hop}</td>
                        <td className="font-mono text-xs">{a.accountId ? a.accountId.slice(0, 8) : "—"}</td>
                        <td>{a.platform ?? "—"}</td>
                        <td>{a.deviceStatus ?? "—"}</td>
                        <td>{a.placementStatus ?? "—"}</td>
                        <td className="text-gray-600">{when(a.assignedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-xs text-gray-600">Devices move between nodes via the scheduler; moving a device between subscriptions is done from the customer.</p>
          </section>
        </div>
      )}
    </FleetPage>
  );
}
