"use client";

import { FleetPage, Empty } from "@/components/admin/FleetPage";
import { useFleetData } from "@/hooks/useFleetData";

type Topology = {
  locations: {
    id: string;
    countryCode: string;
    city: string | null;
    displayName: string;
    enabled: boolean;
    nodes: number;
    exitNodes: number;
    relayNodes: number;
    readyNodes: number;
    states: Record<string, number>;
  }[];
  allowedPaths: {
    id: string;
    kind: string;
    entry: string | null;
    exit: string | null;
    enabled: boolean;
    requiredEntitlement: string | null;
  }[];
};

export default function FleetLocationsPage() {
  const { data, error } = useFleetData<Topology>("/api/admin/fleet/topology");
  return (
    <FleetPage title="Locations & allowed routes" note="Read-only" error={error} loading={!data}>
      {data && (
        <div className="space-y-8">
          <section>
            <h3 className="mb-2 font-mono text-xs text-gray-600">LOCATIONS</h3>
            {data.locations.length === 0 ? (
              <Empty>No locations.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Location</th>
                      <th>Enabled</th>
                      <th className="num">Nodes</th>
                      <th className="num">Exit</th>
                      <th className="num">Relay</th>
                      <th className="num">Ready</th>
                      <th>By state</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.locations.map((l) => (
                      <tr key={l.id}>
                        <td className="font-medium">
                          {l.displayName} <span className="text-gray-600">({l.countryCode})</span>
                        </td>
                        <td>{l.enabled ? "Yes" : "No"}</td>
                        <td className="num">{l.nodes}</td>
                        <td className="num">{l.exitNodes}</td>
                        <td className="num">{l.relayNodes}</td>
                        <td className="num">{l.readyNodes}</td>
                        <td className="font-mono text-xs text-gray-600">
                          {Object.entries(l.states).map(([s, n]) => `${s} ${n}`).join(" · ") || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section>
            <h3 className="mb-2 font-mono text-xs text-gray-600">ALLOWED ROUTES</h3>
            {data.allowedPaths.length === 0 ? (
              <Empty>No allowed routes.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Route</th>
                      <th>Kind</th>
                      <th>Enabled</th>
                      <th>Entitlement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.allowedPaths.map((p) => (
                      <tr key={p.id}>
                        <td className="font-medium">{p.entry ? `${p.entry} → ${p.exit}` : `Direct → ${p.exit}`}</td>
                        <td className="font-mono text-xs">{p.kind}</td>
                        <td>{p.enabled ? "Yes" : "No"}</td>
                        <td>{p.requiredEntitlement ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </FleetPage>
  );
}
