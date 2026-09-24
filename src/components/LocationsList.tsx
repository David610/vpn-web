"use client";

import { useEffect, useState } from "react";

type Location = { countryCode: string; city: string | null; name: string };

/**
 * Locations Arcana can serve right now, from GET /api/locations. Nothing is
 * listed until the service says so — no placeholder countries.
 */
export default function LocationsList() {
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/locations")
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
  return (
    <ul className="location-list">
      {locations.map((location) => (
        <li key={`${location.countryCode}-${location.city ?? ""}-${location.name}`}>
          <span>
            {location.name}
            {location.city ? <span className="muted"> · {location.city}</span> : null}
          </span>
          <span className="location-list__code">{location.countryCode}</span>
        </li>
      ))}
    </ul>
  );
}
