// Small round flags for the countries Arcana serves. Unknown countries fall
// back to a neutral two-letter chip, never a wrong flag.
const R = 12;

function stripes(colors: string[], vertical = false) {
  const n = colors.length;
  return colors.map((c, i) =>
    vertical ? (
      <rect key={i} x={(i * 2 * R) / n} y={0} width={(2 * R) / n + 0.5} height={2 * R} fill={c} />
    ) : (
      <rect key={i} x={0} y={(i * 2 * R) / n} width={2 * R} height={(2 * R) / n + 0.5} fill={c} />
    ),
  );
}

function cross(bg: string, fg: string, bar = 4) {
  return (
    <>
      <rect width={2 * R} height={2 * R} fill={bg} />
      <rect x={7} y={0} width={bar} height={2 * R} fill={fg} />
      <rect x={0} y={R - bar / 2} width={2 * R} height={bar} fill={fg} />
    </>
  );
}

const FLAGS: Record<string, React.ReactNode> = {
  DE: stripes(["#000000", "#DD0000", "#FFCE00"]),
  NL: stripes(["#AE1C28", "#FFFFFF", "#21468B"]),
  RU: stripes(["#FFFFFF", "#0039A6", "#D52B1E"]),
  FR: stripes(["#0055A4", "#FFFFFF", "#EF4135"], true),
  IT: stripes(["#009246", "#FFFFFF", "#CE2B37"], true),
  SE: cross("#006AA7", "#FECC00"),
  FI: cross("#FFFFFF", "#003580"),
  CH: (
    <>
      <rect width={2 * R} height={2 * R} fill="#D52B1E" />
      <rect x={10.5} y={5} width={3} height={14} fill="#fff" />
      <rect x={5} y={10.5} width={14} height={3} fill="#fff" />
    </>
  ),
  JP: (
    <>
      <rect width={2 * R} height={2 * R} fill="#FFFFFF" />
      <circle cx={R} cy={R} r={6} fill="#BC002D" />
    </>
  ),
};

export default function Flag({ code, size = 20 }: { code: string; size?: number }) {
  const key = code.toUpperCase();
  const art = FLAGS[key];
  if (!art) {
    return (
      <span className="flag flag--chip" style={{ width: size, height: size }} aria-hidden="true">
        {key}
      </span>
    );
  }
  return (
    <svg
      className="flag"
      width={size}
      height={size}
      viewBox={`0 0 ${2 * R} ${2 * R}`}
      aria-hidden="true"
    >
      <clipPath id={`flag-${key}`}>
        <circle cx={R} cy={R} r={R} />
      </clipPath>
      <g clipPath={`url(#flag-${key})`}>{art}</g>
    </svg>
  );
}
