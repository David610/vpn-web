// Static decorative world map for the homepage hero: the dotted map from the
// approved landing design, with a black marker on each location Arcana
// actually serves. It is not the source of truth for availability
// (LocationsList/the /locations page are) and adds no client JS, network
// calls, or interactivity.
import { LAND_RUNS, MAP_COLS, MAP_ROWS } from "./world-map-grid";

const PITCH = 8;
const VIEW_W = MAP_COLS * PITCH;
const VIEW_H = MAP_ROWS * PITCH;
const DOT_R = 2.4;
const MARKER_R = 5;

// Arcana's currently live locations (kept in sync by hand with what
// LocationsList/GET /api/locations report — decorative markers only, never a
// substitute for the live list).
const MARKERS = [
  { name: "Frankfurt", lat: 50.1, lon: 8.7 },
  { name: "Stockholm", lat: 59.3, lon: 18.1 },
];

// The design's map is a stylised projection, so markers use a linear fit
// calibrated on the design's own markers (Stockholm, Dubai, Los Angeles,
// Sydney): row 15.5 at 59.3N falling 0.262 rows per degree of latitude, and
// column 45.5 at 18.1E rising 0.24 columns per degree of longitude.
function project(lat: number, lon: number) {
  const col = 45.5 + (lon - 18.1) * 0.24;
  const row = 15.5 + (59.3 - lat) * 0.262;
  return { x: (col + 0.5) * PITCH, y: (row + 0.5) * PITCH };
}

function landDots() {
  const dots: Array<{ x: number; y: number }> = [];
  LAND_RUNS.forEach((runs, r) => {
    for (const [start, end] of runs) {
      for (let c = start; c <= end; c++) {
        dots.push({ x: (c + 0.5) * PITCH, y: (r + 0.5) * PITCH });
      }
    }
  });
  return dots;
}

export default function WorldMap() {
  const dots = landDots();
  return (
    <svg
      className="world-map"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role="img"
      aria-label="Map showing Arcana's server locations in Germany and Sweden"
    >
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={DOT_R} className="world-map__dot" />
      ))}
      {MARKERS.map((m) => {
        const p = project(m.lat, m.lon);
        return <circle key={m.name} cx={p.x} cy={p.y} r={MARKER_R} className="world-map__marker" />;
      })}
    </svg>
  );
}
