"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS: { href: string; label: string; match?: (pathname: string) => boolean }[] = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/customers", label: "Customers", match: (p) => p.startsWith("/admin/customers") },
  { href: "/admin/subscriptions", label: "Subscriptions" },
  { href: "/admin/nodes", label: "Fleet", match: (p) => p === "/admin/nodes" || p.startsWith("/admin/fleet") },
  { href: "/admin/jobs", label: "Jobs" },
  { href: "/admin/alerts", label: "Alerts" },
  { href: "/admin/abuse", label: "Abuse" },
  { href: "/admin/audit", label: "Audit" },
  { href: "/admin/settings", label: "Settings" },
];

export function AdminNav() {
  const pathname = (usePathname() ?? "").replace(/\/+$/, "") || "/";
  const isActive = (link: (typeof LINKS)[number]) => (link.match ? link.match(pathname) : pathname === link.href);
  const current = LINKS.find(isActive) ?? LINKS[0];

  return (
    <>
      <nav className="area__nav" aria-label="Admin">
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href} aria-current={isActive(link) ? "page" : undefined}>
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
