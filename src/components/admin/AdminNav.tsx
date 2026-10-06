"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ICONS: Record<string, string> = {
  Overview: "M4 11l8-7 8 7v9h-5v-6H9v6H4z",
  Users: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4.5 20c.8-3.6 3.8-5.5 7.5-5.5s6.7 1.9 7.5 5.5",
  Subscriptions: "M4 6h16v12H4zM4 10h16",
  Nodes: "M5 5h14v5H5zM5 14h14v5H5zM8 7.5h.01M8 16.5h.01",
  Jobs: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  Alerts: "M12 4a5 5 0 0 0-5 5v3l-2 3h14l-2-3V9a5 5 0 0 0-5-5zM10 19a2 2 0 0 0 4 0",
  Abuse: "M12 3l8 15H4zM12 10v4M12 16.5h.01",
  Audit: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5",
  Settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8",
};

const LINKS: { href: string; label: string; match?: (pathname: string) => boolean }[] = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/customers", label: "Users", match: (p) => p.startsWith("/admin/customers") },
  { href: "/admin/subscriptions", label: "Subscriptions" },
  { href: "/admin/nodes", label: "Nodes", match: (p) => p === "/admin/nodes" || p.startsWith("/admin/fleet") },
  { href: "/admin/jobs", label: "Jobs" },
  { href: "/admin/alerts", label: "Alerts" },
  { href: "/admin/abuse", label: "Abuse" },
  { href: "/admin/audit", label: "Audit" },
  { href: "/admin/settings", label: "Settings" },
];

function NavIcon({ label }: { label: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[label]} />
    </svg>
  );
}

export function AdminNav() {
  const pathname = (usePathname() ?? "").replace(/\/+$/, "") || "/";
  const isActive = (link: (typeof LINKS)[number]) => (link.match ? link.match(pathname) : pathname === link.href);
  const current = LINKS.find(isActive) ?? LINKS[0];

  return (
    <>
      <nav className="area__nav" aria-label="Admin">
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href} aria-current={isActive(link) ? "page" : undefined}>
            <NavIcon label={link.label} />
            {link.label}
          </Link>
        ))}
      </nav>
      {/* Below ~860px .area__nav is hidden (see globals.css) in favor of
          this compact disclosure — the same pattern AccountShell uses, so
          the sidebar never just disappears on a narrow viewport. */}
      <details className="area__nav-mobile">
        <summary>
          <span className="area__nav-mobile-label">
            Admin <span aria-hidden="true">/</span> {current.label}
          </span>
          <span className="area__nav-mobile-chevron" aria-hidden="true">⌄</span>
        </summary>
        <nav className="area__nav-mobile-list" aria-label="Admin sections">
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} aria-current={isActive(link) ? "page" : undefined}>
              {link.label}
            </Link>
          ))}
        </nav>
      </details>
    </>
  );
}
