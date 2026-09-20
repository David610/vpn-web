import Link from "next/link";
import { SITE_NAME } from "@/lib/site-config";

export default function Nav() {
  return (
    <header className="dm-nav">
      <Link href="/" className="dm-nav__brand">
        {SITE_NAME}
      </Link>
      <nav className="dm-nav__desktop">
        <Link href="/login" className="dm-nav__link">
          Log in
        </Link>
        <Link href="/signup" className="btn btn-primary dm-nav__cta">
          Get started
        </Link>
      </nav>
    </header>
  );
}
