"use client";

import { useState } from "react";
import { FleetPage, Empty, when } from "@/components/admin/FleetPage";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { useFleetData } from "@/hooks/useFleetData";

type Step = { index: number; name: string | null; status: string; nodeId: string | null; attempts: number; error: string | null; startedAt: string | null; completedAt: string | null };
type Operation = {
  id: string;
  type: string;
  status: string;
  nodeId: string | null;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  deadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
  steps: Step[];
};

const STATUSES = ["", "PENDING", "RUNNING", "COMPLETED", "PARTIAL_FAILURE", "ROLLING_BACK", "FAILED"];

export default function FleetOperationsPage() {
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const { data, error } = useFleetData<{ operations: Operation[] }>(`/api/admin/fleet/operations?status=${status}`, 10_000);
  return (
    <FleetPage title="Operations & saga steps" note="Driven by the fleet reconciler · refresh 10s" error={error} loading={!data}>
      <label className="mb-3 flex items-center text-xs text-gray-600">
        Status
        <select className="ml-2 border border-gray-400 px-2 py-1 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => <option key={s} value={s}>{s || "All"}</option>)}
        </select>
      </label>
      {data && (data.operations.length === 0 ? (
        <Empty>No operations.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Operation</th><th>Type</th><th>Node</th><th>Status</th><th>Progress</th><th className="num">Attempts</th><th>Last error</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {data.operations.map((op) => {
                const done = op.steps.filter((s) => s.status === "COMPLETED").length;
                const expanded = open === op.id;
                return [
                  <tr key={op.id}>
                    <td>
                      <button type="button" aria-expanded={expanded} className="min-h-6 py-1 font-mono text-xs underline" onClick={() => setOpen(expanded ? null : op.id)}>
                        {op.id.slice(0, 8)}
                      </button>
                    </td>
                    <td className="font-mono text-xs">{op.type}</td>
                    <td className="font-mono">{op.nodeId ?? "—"}</td>
                    <td><StatusBadge status={op.status} /></td>
                    <td className="tabular-nums">{done}/{op.steps.length}</td>
                    <td className="num">{op.attempts}</td>
                    <td className="max-w-xs truncate text-xs text-gray-700" title={op.lastError ?? ""}>{op.lastError ?? "—"}</td>
                    <td className="text-gray-600">{when(op.updatedAt)}</td>
                  </tr>,
                  expanded && (
                    <tr key={`${op.id}-steps`}>
                      <td colSpan={8} className="bg-white">
                        <ol className="space-y-1 border-l border-black pl-4 text-xs">
                          {op.steps.map((s) => (
                            <li key={s.index} className="flex flex-wrap gap-3">
                              <span className="w-6 tabular-nums text-gray-600">{s.index}</span>
                              <span className="w-48 font-mono">{s.name ?? "step"}</span>
                              <span className="w-24 font-semibold">{s.status}</span>
                              <span className="text-gray-600">attempts {s.attempts}</span>
                              <span className="text-gray-600">{when(s.completedAt ?? s.startedAt)}</span>
                              {s.error && <span className="text-red-700">{s.error}</span>}
                            </li>
                          ))}
                        </ol>
                        <p className="mt-2 text-xs text-gray-600">Created {when(op.createdAt)} · next attempt {when(op.nextAttemptAt)} · deadline {when(op.deadlineAt)}</p>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      ))}
    </FleetPage>
  );
}
