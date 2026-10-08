"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin/jobs", label: "Provisioning jobs" },
  { href: "/admin/alerts", label: "Alerts" },
  { href: "/admin/abuse", label: "Abuse flags" },
];

/** The three operational queues share one "Operations" section in the sidebar. */
export function OperationsTabs() {
  const pathname = (usePathname() ?? "").replace(/\/+$/, "") || "/";
  return (
    <nav className="ps-tabs" aria-label="Operations sections">
      {TABS.map((tab) => (
        <Link key={tab.href} href={tab.href} aria-current={pathname === tab.href ? "page" : undefined}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
