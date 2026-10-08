import Link from "next/link";
import { SITE_NAME } from "@/lib/site-config";

/**
 * Chrome for the sign-in pages: brand on the left, one contextual link on the
 * right, and a single centred card. No marketing navigation or footer.
 */
export default function AuthShell({
  title,
  sub,
  corner,
  children,
  foot,
}: {
  title: string;
  sub?: string;
  corner: "login" | "help" | "none";
  children: React.ReactNode;
  foot?: React.ReactNode;
}) {
  return (
    <>
      <header className="auth-top">
        <Link href="/" className="auth-top__brand">
          {SITE_NAME}
        </Link>
        {corner === "login" ? (
          <Link href="/login" className="btn btn-secondary">
            Log in
          </Link>
        ) : corner === "help" ? (
          <Link href="/help" className="dm-nav__link">
            Help
          </Link>
        ) : null}
      </header>
      <main className="auth-page">
        <div className="auth-card">
          <h1 className="auth-card__title">{title}</h1>
          {sub ? <p className="auth-card__sub">{sub}</p> : null}
          {children}
          {foot ? <div className="auth-card__foot">{foot}</div> : null}
        </div>
      </main>
    </>
  );
}
