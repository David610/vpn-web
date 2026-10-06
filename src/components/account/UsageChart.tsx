export type UsageRow = { link_id?: string; bucket_date: string; rx_bytes: number | string; tx_bytes: number | string };

const DAY = 86_400_000;

/** Total bytes per day for the last `days` days (oldest first). */
export function dailyTotals(rows: UsageRow[], days = 30, now = Date.now()) {
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const key = String(r.bucket_date).slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + Number(r.rx_bytes) + Number(r.tx_bytes));
  }
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(now - (days - 1 - i) * DAY).toISOString().slice(0, 10);
    return { date, bytes: byDay.get(date) ?? 0 };
  });
}

function label(bytes: number) {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export default function UsageChart({ days, width = 820 }: { days: Array<{ date: string; bytes: number }>; width?: number }) {
  const max = Math.max(1, ...days.map((d) => d.bytes));
  const W = width;
  const H = 110;
  const step = W / days.length;
  const ticks = [days[0], days[Math.floor(days.length / 3)], days[Math.floor((2 * days.length) / 3)], days[days.length - 1]];
  return (
    <svg className="usage-chart" viewBox={`0 0 ${W} ${H + 22}`} role="img" aria-label="Transfer per day over the last 30 days">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1="0" x2={W} y1={H - f * H} y2={H - f * H} className="usage-chart__grid" />
          <text x="0" y={H - f * H - 4} className="usage-chart__label">
            {f === 0 ? "0" : label(max * f)}
          </text>
        </g>
      ))}
      {days.map((d, i) => {
        const h = (d.bytes / max) * H;
        return <rect key={d.date} x={i * step + step * 0.2} y={H - h} width={step * 0.6} height={Math.max(h, d.bytes ? 1 : 0)} className="usage-chart__bar" />;
      })}
      {ticks.map((t, i) => (
        <text key={t.date} x={(days.indexOf(t) + 0.5) * step} y={H + 16} textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"} className="usage-chart__label">
          {new Date(t.date).toLocaleDateString("en", { day: "numeric", month: "short" })}
        </text>
      ))}
    </svg>
  );
}
