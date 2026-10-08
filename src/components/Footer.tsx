import { SITE_NAME, SUPPORT_EMAIL } from "@/lib/site-config";

const LINKS = [
  { href: "/privacy/", label: "Privacy" },
  { href: "/privacy/policy/", label: "Privacy Policy" },
  { href: "/terms/", label: "Terms of Service" },
  { href: "/impressum/", label: "Impressum" },
  { href: `mailto:${SUPPORT_EMAIL}`, label: "Contact" },
];

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="dm-footer">
      <div className="dm-footer__top">
        <p className="dm-footer__lead">
          <span className="dm-footer__brand">{SITE_NAME}</span>
          <span className="text-tiny">
            © {year} {SITE_NAME}. All rights reserved.
          </span>
        </p>
        <nav className="dm-footer__links" aria-label="Legal">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className="dm-footer__link">
              {l.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
