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
  const pathname = usePathname();
  return (
    <nav className="border-b bg-white px-6 py-3">
      <div className="mx-auto flex max-w-6xl gap-6">
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={pathname === link.href ? "font-semibold text-black" : "text-gray-500"}
          >
            {link.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
