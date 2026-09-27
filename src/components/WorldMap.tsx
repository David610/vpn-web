// Restrained, static decorative world map for the homepage hero: a pale
// dot field roughly tracing land, with a black marker on each location
// Arcana actually serves. It is not the source of truth for availability
// (LocationsList/the /locations page are) and adds no client JS, network
// calls, or interactivity — coordinates are illustrative land-mass shape,
// not survey-accurate coastlines.

// Land/sea mask: 40 columns (lon -180..180, ~9° each) x 16 rows
// (lat 82..-58, ~9° each — arctic/antarctic rows dropped, they're empty at
// this resolution anyway). Each row lists inclusive [startCol, endCol]
// land ranges.
const LAND_RANGES: Array<Array<[number, number]>> = [
  [[2, 4], [14, 17], [20, 22], [25, 39]], // ~78N: Alaska, Greenland, N Scandinavia, N Siberia
  [[3, 14], [15, 17], [19, 22], [25, 39]], // ~69N: Canada, Greenland, N Europe, Siberia
  [[4, 14], [17, 17], [19, 22], [25, 39]], // ~60N: Canada, Iceland, Europe, Russia
  [[6, 14], [19, 22], [25, 35]], // ~51N: US/Canada border, W Europe, Russia/Mongolia
  [[6, 12], [19, 22], [24, 25], [28, 36]], // ~42N: USA, S Europe, Turkey/Caspian, China/Japan
  [[7, 9], [19, 22], [24, 26], [28, 29], [30, 33]], // ~33N: Mexico N, N Africa, Middle East, India N, China S
  [[8, 10], [18, 24], [24, 26], [28, 30], [30, 34]], // ~24N: Mexico, Sahara, Arabia, India, SE Asia/Taiwan
  [[9, 13], [18, 24], [28, 29], [30, 35]], // ~15N: C America/N S.America, Sahel, S India, Indonesia/Philippines
  [[11, 12], [21, 24], [30, 35], [35, 37]], // ~6N: Colombia, Congo, Indonesia, PNG
  [[12, 16], [21, 24], [30, 35], [35, 37]], // ~-3N: Brazil N, E Africa, Indonesia, PNG
  [[11, 16], [21, 26], [33, 36]], // ~-12S: Brazil, Angola/Tanzania/Madagascar, Australia N
  [[13, 16], [22, 26], [32, 37]], // ~-21S: Brazil S, S Africa/Madagascar, Australia
  [[12, 14], [22, 23], [33, 37]], // ~-30S: Argentina, S Africa tip, Australia S
  [[11, 13], [38, 39]], // ~-39S: Chile/Argentina, New Zealand
  [[12, 13]], // ~-48S: S Chile/Argentina tip
  [], // ~-57S: empty at this resolution
];

const COLS = 40;
const ROWS = LAND_RANGES.length;
const VIEW_W = 400;
const VIEW_H = 176;
const DX = VIEW_W / COLS;
const DY = VIEW_H / ROWS;
const DOT_R = 1.0;
/** Interior thinning: a wide contiguous landmass (Russia/Siberia, the
 * Sahara) reads as one dense gray slab at full density; skipping every
 * other column past the edges keeps the silhouette but softens it into
 * dots rather than a fill. */
const THIN_ABOVE_WIDTH = 6;

// Arcana's currently live locations (kept in sync by hand with the two
// locations LocationsList/GET /api/locations report today — decorative
// markers only, never a substitute for the live list).
const MARKERS = [
  { name: "Frankfurt", lat: 50.1, lon: 8.7 },
  { name: "Stockholm", lat: 59.3, lon: 18.1 },
];

function project(lat: number, lon: number) {
  return {
    x: ((lon + 180) / 360) * VIEW_W,
    y: ((90 - lat) / 180) * VIEW_H - (90 - 82) * (VIEW_H / 180),
  };
}

function landDots() {
  const dots: Array<{ x: number; y: number }> = [];
  for (let r = 0; r < ROWS; r++) {
    const ranges = LAND_RANGES[r];
    for (const [start, end] of ranges) {
      const wide = end - start + 1 > THIN_ABOVE_WIDTH;
      for (let c = start; c <= end; c++) {
        const interior = c > start + 1 && c < end - 1;
        if (wide && interior && (c + r) % 2 === 0) continue;
        dots.push({ x: c * DX + DX / 2, y: r * DY + DY / 2 });
      }
    }
  }
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
        return <circle key={m.name} cx={p.x} cy={p.y} r={2.1} className="world-map__marker" />;
      })}
    </svg>
  );
}
