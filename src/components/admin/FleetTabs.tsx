"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const FLEET_TABS = [
  { href: "/admin/nodes", label: "Nodes" },
  { href: "/admin/fleet/locations", label: "Locations & routes" },
  { href: "/admin/fleet/assignments", label: "Assignments" },
  { href: "/admin/fleet/operations", label: "Operations" },
  { href: "/admin/fleet/health", label: "Health & capacity" },
  { href: "/admin/fleet/readiness", label: "Flags & readiness" },
];

/** Internal tab strip for the Fleet area (not top-level nav items). */
export function FleetTabs() {
  const pathname = (usePathname() ?? "").replace(/\/+$/, "") || "/";
  return (
    <nav
      aria-label="Fleet sections"
      className="mb-6"
    >
      <div className="flex flex-wrap gap-x-5 border-b border-gray-300 text-sm">
        {FLEET_TABS.map((tab) => {
          const active = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`inline-block whitespace-nowrap border-b-2 py-2 ${active ? "border-black font-semibold text-black" : "border-transparent text-gray-600 hover:text-black"}`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
