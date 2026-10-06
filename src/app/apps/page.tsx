import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AppMock from "@/components/AppMock";
import { SITE_NAME, SITE_URL } from "@/lib/site-config";

export const metadata = {
  title: `Apps — ${SITE_NAME}`,
  description: `Get the ${SITE_NAME} app for your device. Same account, all your devices.`,
  alternates: { canonical: `${SITE_URL}/apps/` },
};

// Set at build time once a signed Windows installer is published. Until then
// the page says so instead of pointing at a file that does not exist.
const WINDOWS_DOWNLOAD_URL = process.env.NEXT_PUBLIC_WINDOWS_DOWNLOAD_URL || "";

const FEATURES = [
  { title: "Easy to use", text: "Connect in one tap. No complex settings.", d: "M5 3l12 9-5 1-3 5z" },
  { title: "Works in the background", text: "Stays out of your way while keeping you protected.", d: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" },
  { title: "Automatic reconnection", text: "Keeps you secure if your connection drops.", d: "M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3M18 3v4h-4M6 21v-4h4" },
  { title: "Kill switch", text: "Blocks internet if the VPN disconnects.", d: "M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3z" },
];

const PLATFORMS = [
  { name: "Windows", req: "10+", available: true },
  { name: "macOS", req: "11+", available: false },
  { name: "iOS", req: "15+", available: false },
  { name: "Android", req: "8.0+", available: false },
  { name: "Linux", req: "Various distros", available: false },
];

export default function AppsPage() {
  return (
    <>
      <Nav />
      <main className="page">
        <section className="apps-hero">
          <div>
            <p className="eyebrow">Apps</p>
            <h1 className="page__title page__title--md">Apps for all your devices.</h1>
            <p className="page__lede">Connect on your terms.</p>
            <p className="page__body">
              Get the {SITE_NAME} app for your preferred device and enjoy private, secure access to a more
              open internet. Same account. All your devices.
            </p>
            <ul className="feature-list">
              {FEATURES.map((f) => (
                <li key={f.title}>
                  <span className="feature-list__icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d={f.d} />
                    </svg>
                  </span>
                  <span>
                    <strong>{f.title}</strong>
                    <span className="muted">{f.text}</span>
                  </span>
                </li>
              ))}
            </ul>
            {WINDOWS_DOWNLOAD_URL ? (
              <a className="btn btn-primary btn-lg" href={WINDOWS_DOWNLOAD_URL}>
                Download for Windows
              </a>
            ) : (
              <span className="btn btn-primary btn-lg btn--disabled" aria-disabled="true">
                Windows download coming soon
              </span>
            )}
            <p className="fineprint">Requires Windows 10 or later.</p>
          </div>
          <AppMock />
        </section>

        <ul className="platforms">
          {PLATFORMS.map((p) => (
            <li key={p.name} className={`platforms__tile${p.available ? " platforms__tile--on" : ""}`}>
              <strong>{p.name}</strong>
              <span className="muted">{p.available ? p.req : `${p.req} · Coming soon`}</span>
            </li>
          ))}
        </ul>

        <p className="setup-line">
          <strong>Setup in minutes. End with a verified, protected connection.</strong>
          <span className="muted">
            Download the app, sign in, connect, and you’re ready. {SITE_NAME} encrypts your traffic and hides
            your IP address across all your devices.
          </span>
        </p>
      </main>
      <Footer />
    </>
  );
}
