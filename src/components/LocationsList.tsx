"use client";

import { useEffect, useMemo, useState } from "react";
import Flag from "@/components/Flag";
import { REGIONS, countryName, regionOf, type Region } from "@/lib/regions";
import { apiUrl } from "@/lib/api-base";

type Location = { countryCode: string; city: string | null; name: string };
type Country = { code: string; name: string; region: Region | null; cities: string[] };

function groupByCountry(locations: Location[]): Country[] {
  const byCode = new Map<string, Country>();
  for (const l of locations) {
    const code = l.countryCode.toUpperCase();
    let country = byCode.get(code);
    if (!country) {
      country = { code, name: countryName(code), region: regionOf(code), cities: [] };
      byCode.set(code, country);
    }
    if (l.city && !country.cities.includes(l.city)) country.cities.push(l.city);
  }
  return [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Locations Arcana can serve right now, from GET /api/locations. Nothing is
 * listed until the service says so — no placeholder countries.
 */
export default function LocationsList() {
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [region, setRegion] = useState<Region | "All">("All");

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl("/api/locations"))
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: { locations?: Location[] }) => {
        if (!cancelled) setLocations(body.locations ?? []);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const countries = useMemo(() => groupByCountry(locations ?? []), [locations]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return countries.filter(
      (c) =>
        (region === "All" || c.region === region) &&
        (!q || c.name.toLowerCase().includes(q) || c.cities.some((city) => city.toLowerCase().includes(q))),
    );
  }, [countries, query, region]);

  if (failed) {
    return <p className="muted">The location list is unavailable right now.</p>;
  }
  if (locations === null) {
    return (
      <p className="muted" aria-live="polite">
        Loading locations…
      </p>
    );
  }
  if (locations.length === 0) {
    return <p className="muted">No locations are open yet.</p>;
  }

  const total = locations.length;
  return (
    <div className="loc-explorer">
      <label className="searchbar">
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
          <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M14 14l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          placeholder="Search countries or cities…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search countries or cities"
        />
      </label>

      <div className="tabs" role="tablist" aria-label="Region">
        {(["All", ...REGIONS] as const).map((r) => (
          <button
            key={r}
            type="button"
            role="tab"
            aria-selected={region === r}
            className={`tabs__tab${region === r ? " tabs__tab--active" : ""}`}
            onClick={() => setRegion(r)}
          >
            {r}
          </button>
        ))}
        <span className="tabs__count">
          {total} {total === 1 ? "location" : "locations"}
        </span>
      </div>

      {shown.length === 0 ? (
        <p className="muted">No locations match your search.</p>
      ) : (
        <table className="loc-table">
          <thead>
            <tr>
              <th scope="col">Country</th>
              <th scope="col">Cities</th>
              <th scope="col"><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.code}>
                <td>
                  <span className="loc-table__country">
                    <Flag code={c.code} />
                    {c.name}
                  </span>
                </td>
                <td className="muted">{c.cities.join(", ") || "—"}</td>
                <td className="loc-table__chev" aria-hidden="true">
                  <svg viewBox="0 0 20 20" width="16" height="16"><path d="M7 4l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
