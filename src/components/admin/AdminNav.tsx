"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/customers", label: "Customers" },
  { href: "/admin/subscriptions", label: "Subscriptions" },
  { href: "/admin/nodes", label: "Fleet" },
  { href: "/admin/jobs", label: "Jobs" },
  { href: "/admin/alerts", label: "Alerts" },
  { href: "/admin/abuse", label: "Abuse" },
  { href: "/admin/audit", label: "Audit" },
  { href: "/admin/settings", label: "Settings" },
];

export function AdminNav() {
  const pathname = (usePathname() ?? "").replace(/\/+$/, "") || "/";
  return (
    <nav className="border-b bg-white px-6 py-3 overflow-x-auto">
      <div className="mx-auto flex max-w-6xl gap-6 w-max min-w-full">
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={`whitespace-nowrap ${(pathname === link.href || (link.label === "Fleet" && pathname.startsWith("/admin/fleet"))) ? "font-semibold text-black" : "text-gray-500"}`}
          >
            {link.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
