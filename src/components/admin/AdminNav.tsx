"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ICONS = {
  overview: "M4 11l8-7 8 7v9h-5v-6H9v6H4z",
  users: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4.5 20c.8-3.6 3.8-5.5 7.5-5.5s6.7 1.9 7.5 5.5",
  servers: "M5 5h14v5H5zM5 14h14v5H5zM8 7.5h.01M8 16.5h.01",
  operations: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  payments: "M3 6h18v12H3zM3 10h18",
  audit: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8",
  back: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
} as const;

type Item = { href: string; label: string; icon: keyof typeof ICONS; match?: (pathname: string) => boolean };

const MAIN: Item[] = [
  { href: "/admin", label: "Overview", icon: "overview" },
  { href: "/admin/customers", label: "Users", icon: "users", match: (p) => p.startsWith("/admin/customers") },
  { href: "/admin/nodes", label: "Servers", icon: "servers", match: (p) => p === "/admin/nodes" || p.startsWith("/admin/fleet") },
  {
    href: "/admin/jobs",
    label: "Operations",
    icon: "operations",
    match: (p) => p.startsWith("/admin/jobs") || p.startsWith("/admin/alerts") || p.startsWith("/admin/abuse"),
  },
  { href: "/admin/subscriptions", label: "Payments", icon: "payments" },
];

const SECONDARY: Item[] = [
  { href: "/admin/audit", label: "Audit log", icon: "audit" },
  { href: "/admin/settings", label: "Settings", icon: "settings" },
  { href: "/account/", label: "Back to account", icon: "back" },
];

function NavIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

export function AdminNav() {
  const pathname = (usePathname() ?? "").replace(/\/+$/, "") || "/";
  const isActive = (item: Item) => (item.match ? item.match(pathname) : pathname === item.href.replace(/\/+$/, ""));

  return (
    <nav className="ps-side" aria-label="Administration">
      <p className="ps-side__label">Administration</p>
      {MAIN.map((item) => (
        <Link key={item.href} href={item.href} aria-current={isActive(item) ? "page" : undefined}>
          <NavIcon name={item.icon} />
          {item.label}
        </Link>
      ))}
      <hr className="ps-side__rule" />
      {SECONDARY.map((item) => (
        <Link key={item.href} href={item.href} aria-current={isActive(item) ? "page" : undefined}>
          <NavIcon name={item.icon} />
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
