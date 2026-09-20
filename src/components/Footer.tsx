import { SITE_NAME } from "@/lib/site-config";

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="dm-footer">
      <div className="dm-footer__top">
        <span className="dm-footer__brand">{SITE_NAME}</span>
        <div className="dm-footer__links">
          <a href="/privacy/" className="dm-footer__link">
            Privacy
          </a>
          <a href="/terms/" className="dm-footer__link">
            Terms
          </a>
          <a href="/impressum/" className="dm-footer__link">
            Impressum
          </a>
        </div>
      </div>
      <div className="dm-footer__bottom">
        <span className="text-tiny">
          © {year} {SITE_NAME}
        </span>
      </div>
    </footer>
  );
}
